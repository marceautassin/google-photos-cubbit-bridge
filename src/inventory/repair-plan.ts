import { createHash } from 'crypto';
import * as path from 'path';
import { bucketNameProblem } from '../utils/bucket-name';
import { isSupportedFormat, normalizeExtension } from '../utils/file-utils';
import { BucketObject } from '../clients/types';
import { ObjectDating } from '../database/inventory-date-model';
import {
  attachDatings,
  chooseKept,
  comparableName,
  destinationFolder,
  groupSameNameAndSize,
  MediaCopy,
  NamingAnomaly,
  NamingEntry,
  nameOf,
  normalizeEtag,
  OccupiedDestination,
  resolveNames,
  splitContents,
} from './duplicates';

/**
 * Plan de réparation (story 2.4). Calcul pur depuis l'index local (inventaire + datations) et la configuration : aucune
 * lecture réseau, aucune écriture S3. Le plan est exécuté par la story 3.1, repris par la 3.2, rapporté par la 3.3.
 *
 * Périmètre : TOUS les objets sous les préfixes source. Chacun est une ligne du plan (média reconnu), une exclusion
 * déclarée (nom de fichier ou extension ignorés, marqueur de dossier vide) ou un objet non reconnu, qui rend le plan
 * non exécutable.
 *
 * Schéma de destination dans le bucket dédié, sans préfixe racine (D2, D3) :
 * - `photos/AAAA/AAAA-MM/<nom>` : classement chronologique ;
 * - `albums/<album>/<chemin relatif dans l'album>` : albums partagés conservés (D1) ;
 * - `quarantaine/<clé source complète>` : date indéterminée (FR-3). Les clés source sont uniques, mais deux clés peuvent
 *   ne différer que par la casse ou la forme Unicode d'un dossier (`Divers/` et `divers/`) : la règle Q1, qui compare
 *   dossier et nom sans casse, les départage comme partout ailleurs.
 */

export type PlanAction = 'copier' | 'ignorer_doublon' | 'quarantaine' | 'ignorer_deja_archive';
export const PLAN_ACTIONS: readonly PlanAction[] = ['copier', 'ignorer_doublon', 'quarantaine', 'ignorer_deja_archive'];

export const CHRONO_ROOT = 'photos/';
export const ALBUMS_ROOT = 'albums/';
export const QUARANTINE_ROOT = 'quarantaine/';

/** Longueur maximale d'une clé S3, en octets UTF-8. */
export const MAX_KEY_BYTES = 1024;

export interface PlanLine {
  sourceKey: string;
  sourceBucket: string;
  size: number;
  etag: string | null;
  action: PlanAction;
  destination: string | null; // nulle pour un doublon ignoré (ou une anomalie de nommage)
  keptKey: string | null; // doublon ignoré : clé de l'exemplaire conservé
  reason: string;
}

/** Objet sous les préfixes source volontairement hors plan (nom ou extension ignorés, marqueur de dossier vide). */
export interface ExcludedObject {
  sourceKey: string;
  size: number;
  etag: string | null;
  reason: string;
}

/** Objet sous les préfixes source qui n'est ni un média reconnu ni une exclusion déclarée : bloque le plan. */
export interface UnrecognizedObject {
  sourceKey: string;
  size: number;
  etag: string | null;
  extension: string; // `.heic`, ou `(sans extension)`
}

/** Instantané d'un inventaire local : sert à reconnaître un plan périmé. */
export interface InventoryStamp {
  completedAt: string; // ISO
  objectCount: number;
}

/** État de l'index local à partir duquel le plan a été calculé. */
export interface IndexState {
  sourceInventory: InventoryStamp;
  destinationInventory: InventoryStamp | null; // null : bucket dédié non inventorié, destinations supposées vides
  datings: { count: number; lastDatedAt: string | null };
}

/** Configuration dont dépend le plan (buckets, section `repair`, formats de `sync`). */
export interface PlanSettings {
  sourceBucket: string;
  destinationBucket: string;
  sourcePrefixes: string[];
  supportedFormats: string[];
  keptAlbums: string[];
  ignoredFileNames: string[];
  ignoredExtensions: string[];
}

/** Instantané normalisé de la configuration effective, enregistré dans le plan et dans son empreinte. */
export type PlanConfig = PlanSettings;

export interface RepairPlan {
  id: string; // empreinte SHA-256 du contenu
  config: PlanConfig;
  index: IndexState;
  lines: PlanLine[]; // triées par clé source
  exclusions: ExcludedObject[];
  unrecognized: UnrecognizedObject[];
  namingAnomalies: NamingAnomaly[];
  violations: string[]; // invariants en échec
  executable: boolean; // aucun objet non reconnu, aucune anomalie, aucun invariant en échec
}

export interface PlanInput extends PlanSettings {
  objects: BucketObject[]; // inventaire complet du bucket source
  datings: ObjectDating[];
  index: IndexState;
  occupied: OccupiedDestination[]; // inventaire du bucket dédié (vide s'il n'est pas inventorié)
}

/** Refus de produire un plan : l'entrée ne permet pas un plan complet. */
export class PlanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRefusedError';
  }
}

/** Dernière génération refusée, enregistrée sans toucher au plan courant. */
export interface PlanRefusal {
  refusedAt: Date;
  reason: string;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort(compareStrings);

/** Dossier d'une clé, barre finale comprise (`''` à la racine). */
const folderOfKey = (key: string): string => key.slice(0, key.lastIndexOf('/') + 1);

/** Extension comparable d'un nom de fichier (`''` sans extension ; `.DS_Store` n'en a pas). */
const extensionOf = (name: string): string => normalizeExtension(path.posix.extname(name));

/** Normalise la configuration : listes triées sans doublon, formats et extensions sans point ni casse, noms comparables. */
export function normalizePlanConfig(settings: PlanSettings): PlanConfig {
  return {
    sourceBucket: settings.sourceBucket,
    destinationBucket: settings.destinationBucket,
    sourcePrefixes: uniqueSorted(settings.sourcePrefixes),
    supportedFormats: uniqueSorted(settings.supportedFormats.map(normalizeExtension)),
    keptAlbums: uniqueSorted(settings.keptAlbums),
    ignoredFileNames: uniqueSorted(settings.ignoredFileNames.map(comparableName)),
    ignoredExtensions: uniqueSorted(settings.ignoredExtensions.map(normalizeExtension)),
  };
}

/** Destinations occupées d'après l'inventaire du bucket dédié. */
export function occupiedFrom(objects: BucketObject[]): OccupiedDestination[] {
  return objects.map((o) => ({ folder: folderOfKey(o.key), name: o.key.slice(folderOfKey(o.key).length), etag: o.etag }));
}

/** Objets du périmètre du plan : tous ceux dont la clé commence par un préfixe source. */
export function objectsInScope(objects: BucketObject[], sourcePrefixes: string[]): BucketObject[] {
  return objects.filter((o) => sourcePrefixes.some((p) => o.key.startsWith(p)));
}

/**
 * Raison d'exclure un objet du plan, ou `null` s'il n'est pas excluable : marqueur de dossier vide, nom de fichier
 * ignoré (sans casse) ou extension ignorée. Partagée par le classement et par l'invariant de légitimité des exclusions.
 */
export function exclusionReason(key: string, size: number, config: Pick<PlanConfig, 'ignoredFileNames' | 'ignoredExtensions'>): string | null {
  const name = key.slice(folderOfKey(key).length);
  if (name === '') return size === 0 ? 'marqueur de dossier (clé finissant par « / », 0 octet)' : null;
  if (config.ignoredFileNames.includes(comparableName(name))) {
    return `fichier technique ignoré (repair.ignoredFileNames) : ${JSON.stringify(name)}`;
  }
  const extension = extensionOf(name);
  if (extension !== '' && config.ignoredExtensions.includes(extension)) return `extension ignorée (repair.ignoredExtensions) : .${extension}`;
  return null;
}

/**
 * Album conservé d'une clé : le premier segment après le préfixe source vaut exactement un nom d'album configuré, et il
 * est suivi d'au moins un segment. Le chemin relatif dans l'album est conservé.
 */
export function albumOf(key: string, sourcePrefixes: string[], keptAlbums: string[]): { album: string; folder: string } | null {
  const prefix = sourcePrefixes.filter((p) => key.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  if (prefix === undefined) return null;
  const segments = key.slice(prefix.length).split('/');
  const album = segments[0]!;
  if (segments.length < 2 || !keptAlbums.includes(album)) return null;
  return { album, folder: `${ALBUMS_ROOT}${segments.slice(0, -1).join('/')}/` };
}

function validateInput(input: PlanInput, config: PlanConfig): void {
  const prefixes = input.sourcePrefixes;
  if (prefixes.length === 0) {
    throw new PlanRefusedError(
      'aucun préfixe source configuré (repair.sourcePrefixes) : le bucket source contient aussi des données hors périmètre',
    );
  }
  const badPrefix = prefixes.find((p) => !p.endsWith('/') || p === '/');
  if (badPrefix !== undefined) {
    throw new PlanRefusedError(`préfixe source « ${badPrefix} » invalide : il doit désigner un dossier et finir par « / »`);
  }
  prefixes.forEach((outer, i) => {
    const inner = prefixes.find((p, j) => j !== i && p.startsWith(outer));
    if (inner !== undefined) {
      throw new PlanRefusedError(`préfixes source imbriqués ou répétés : « ${outer} » contient « ${inner} » (repair.sourcePrefixes)`);
    }
  });
  const badAlbum = input.keptAlbums.find((a) => a === '' || a.includes('/'));
  if (badAlbum !== undefined) {
    throw new PlanRefusedError(`nom d'album conservé « ${badAlbum} » invalide (repair.keptAlbums) : un seul segment attendu`);
  }
  const mediaNames = input.ignoredFileNames.filter((name) => config.supportedFormats.includes(extensionOf(comparableName(name))));
  if (mediaNames.length > 0) {
    throw new PlanRefusedError(
      `nom(s) ${mediaNames.map((name) => JSON.stringify(name)).join(', ')} dans repair.ignoredFileNames avec une extension de ` +
        'sync.supportedFormats : un média ne peut pas être exclu du plan',
    );
  }
  if (config.ignoredExtensions.includes('')) {
    throw new PlanRefusedError('extension vide dans repair.ignoredExtensions');
  }
  const excludedMedia = config.ignoredExtensions.filter((e) => config.supportedFormats.includes(e));
  if (excludedMedia.length > 0) {
    throw new PlanRefusedError(
      `extension(s) ${excludedMedia.join(', ')} à la fois dans repair.ignoredExtensions et sync.supportedFormats : ` +
        'un média ne peut pas être exclu du plan',
    );
  }
  if (!input.destinationBucket) {
    throw new PlanRefusedError(
      'bucket dédié non configuré : renseignez CUBBIT_DESTINATION_BUCKET, repair.destinationBucket ou --destination',
    );
  }
  const badBucket = bucketNameProblem(input.sourceBucket) ?? bucketNameProblem(input.destinationBucket);
  if (badBucket) throw new PlanRefusedError(badBucket);
  if (input.destinationBucket === input.sourceBucket) {
    throw new PlanRefusedError(`le bucket dédié doit différer du bucket source (« ${input.sourceBucket} »)`);
  }
}

/** Répartit les objets du périmètre : médias reconnus, exclusions déclarées, objets non reconnus. */
export function classifyScope(objects: BucketObject[], config: PlanConfig): { media: BucketObject[]; exclusions: ExcludedObject[]; unrecognized: UnrecognizedObject[] } {
  const media: BucketObject[] = [];
  const exclusions: ExcludedObject[] = [];
  const unrecognized: UnrecognizedObject[] = [];
  for (const o of objectsInScope(objects, config.sourcePrefixes)) {
    const name = o.key.slice(folderOfKey(o.key).length);
    const extension = extensionOf(name);
    const base = { sourceKey: o.key, size: o.size, etag: o.etag };
    const excluded = exclusionReason(o.key, o.size, config);
    if (excluded !== null) exclusions.push({ ...base, reason: excluded });
    else if (isSupportedFormat(o.key, config.supportedFormats)) media.push(o);
    else unrecognized.push({ ...base, extension: extension ? `.${extension}` : '(sans extension)' });
  }
  const byKey = (a: { sourceKey: string }, b: { sourceKey: string }): number => compareStrings(a.sourceKey, b.sourceKey);
  return { media, exclusions: exclusions.sort(byKey), unrecognized: unrecognized.sort(byKey) };
}

interface KeptCopy {
  copy: MediaCopy;
  album: { album: string; folder: string } | null;
}

function dateReason(dating: ObjectDating): string {
  if (dating.takenAt === null) return `date indéterminée : ${dating.detail ?? 'aucune source'}`;
  const source = dating.source === 'exif' ? `EXIF ${dating.detail ?? '(champ inconnu)'}` : 'nom de fichier';
  return `date : ${source} (${dating.takenAt})`;
}

/**
 * Construit le plan. Lève `PlanRefusedError` plutôt que de produire un plan partiel (configuration invalide, périmètre
 * vide, média non daté ou à datation périmée). Pur, déterministe, indépendant de l'ordre d'entrée.
 */
export function buildRepairPlan(input: PlanInput): RepairPlan {
  const config = normalizePlanConfig(input);
  validateInput(input, config);
  const { media, exclusions, unrecognized } = classifyScope(input.objects, config);
  if (media.length + exclusions.length + unrecognized.length === 0) {
    throw new PlanRefusedError(`aucun objet sous ${config.sourcePrefixes.join(', ')} dans l'inventaire de « ${config.sourceBucket} »`);
  }
  const copies = attachDatings(media, input.datings);
  const undated = copies.filter((c) => c.dating === null);
  if (undated.length > 0) {
    const examples = undated.slice(0, 5).map((c) => c.object.key).join(', ');
    throw new PlanRefusedError(
      `${undated.length} média(s) du périmètre non daté(s) ou à datation périmée (ex. : ${examples}). ` +
        'Lancez « gpb inventory dates » puis régénérez le plan.',
    );
  }

  const lines: PlanLine[] = [];
  const line = (copy: MediaCopy, action: PlanAction, destination: string | null, reason: string, keptKey: string | null = null): void => {
    const { key, size, etag } = copy.object;
    lines.push({ sourceKey: key, sourceBucket: config.sourceBucket, size, etag, action, destination, keptKey, reason });
  };
  const ignoreDuplicate = (copy: MediaCopy, kept: MediaCopy): void =>
    line(copy, 'ignorer_doublon', null, `doublon de ${kept.object.key}`, kept.object.key);

  // Doublons : un exemplaire par album conservé contenant le contenu ; si au moins un album le contient, aucune copie
  // chronologique (D1 : ni éclaté, ni dupliqué) ; sinon un exemplaire chronologique.
  const kept: KeptCopy[] = [];
  for (const content of groupSameNameAndSize(copies).flatMap(splitContents)) {
    const byAlbum = new Map<string, KeptCopy[]>();
    const chrono: MediaCopy[] = [];
    for (const copy of content) {
      const album = albumOf(copy.object.key, config.sourcePrefixes, config.keptAlbums);
      if (album) byAlbum.set(album.album, [...(byAlbum.get(album.album) ?? []), { copy, album }]);
      else chrono.push(copy);
    }
    const albumExemplars = [...byAlbum.keys()].sort(compareStrings).map((name) => {
      const members = byAlbum.get(name)!;
      const exemplar = chooseKept(members.map((m) => m.copy));
      for (const m of members) if (m.copy !== exemplar) ignoreDuplicate(m.copy, exemplar);
      kept.push(members.find((m) => m.copy === exemplar)!);
      return exemplar;
    });
    const chronoExemplar = albumExemplars[0] ?? chooseKept(chrono);
    if (albumExemplars.length === 0) kept.push({ copy: chronoExemplar, album: null });
    for (const copy of chrono) if (copy !== chronoExemplar) ignoreDuplicate(copy, chronoExemplar);
  }

  // Désambiguïsation (Q1) de chaque dossier de destination, avec les destinations occupées.
  const folderOf = ({ copy, album }: KeptCopy): string =>
    album ? album.folder : copy.dating!.takenAt ? destinationFolder(copy.dating!.takenAt) : QUARANTINE_ROOT + folderOfKey(copy.object.key);
  const entries: NamingEntry[] = kept.map((k) => ({ id: k.copy.object.key, folder: folderOf(k), name: nameOf(k.copy), etag: k.copy.object.etag }));
  const naming = resolveNames(entries, input.occupied);
  const anomalies = new Map(naming.anomalies.map((a) => [a.id, a]));

  kept.forEach((k, index) => {
    const { id, folder, name } = entries[index]!;
    const quarantined = !k.album && k.copy.dating!.takenAt === null;
    const action: PlanAction = quarantined ? 'quarantaine' : 'copier';
    const reason = k.album ? `album conservé : ${k.album.album}` : dateReason(k.copy.dating!);
    const archivedKey = naming.alreadyArchived.get(id); // clé exacte de l'objet déjà présent
    const finalName = naming.names.get(id);
    if (archivedKey !== undefined) {
      line(k.copy, 'ignorer_deja_archive', archivedKey, `déjà archivé (même ETag dans le bucket dédié) ; ${reason}`);
    } else if (finalName !== undefined) {
      line(k.copy, action, folder + finalName, finalName === name ? reason : `${reason} ; nom suffixé (collision de noms)`);
    } else {
      line(k.copy, action, null, `${reason} ; anomalie de nommage : ${anomalies.get(id)?.reason ?? 'aucune destination'}`);
    }
  });

  lines.sort((a, b) => compareStrings(a.sourceKey, b.sourceKey));
  const namingAnomalies = [...naming.anomalies].sort((a, b) => compareStrings(a.id, b.id));
  const scopeKeys = objectsInScope(input.objects, config.sourcePrefixes).map((o) => o.key);
  const violations = checkPlanInvariants({ lines, exclusions, unrecognized }, scopeKeys, input.occupied, config);
  const content: Omit<RepairPlan, 'id' | 'executable'> = {
    config,
    index: input.index,
    lines,
    exclusions,
    unrecognized,
    namingAnomalies,
    violations,
  };
  return {
    id: planFingerprint(content),
    ...content,
    executable: violations.length === 0 && namingAnomalies.length === 0 && unrecognized.length === 0,
  };
}

/** Empreinte SHA-256 du contenu du plan (sans horodatage de génération) : même contenu, même empreinte. */
export function planFingerprint(content: Omit<RepairPlan, 'id' | 'executable'>): string {
  const { config, index } = content;
  const stamp = (s: InventoryStamp | null): unknown[] | null => (s ? [s.completedAt, s.objectCount] : null);
  const canonical = {
    config: [
      config.sourceBucket,
      config.destinationBucket,
      config.sourcePrefixes,
      config.supportedFormats,
      config.keptAlbums,
      config.ignoredFileNames,
      config.ignoredExtensions,
    ],
    index: [stamp(index.sourceInventory), stamp(index.destinationInventory), index.datings.count, index.datings.lastDatedAt],
    lines: content.lines.map((l) => [l.sourceKey, l.sourceBucket, l.size, l.etag, l.action, l.destination, l.keptKey, l.reason]),
    exclusions: content.exclusions.map((e) => [e.sourceKey, e.size, e.etag, e.reason]),
    unrecognized: content.unrecognized.map((u) => [u.sourceKey, u.size, u.etag, u.extension]),
    namingAnomalies: content.namingAnomalies.map((a) => [a.id, a.destination, a.reason]),
    violations: content.violations,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const EXPECTED_ROOTS: Record<PlanAction, string[]> = {
  copier: [CHRONO_ROOT, ALBUMS_ROOT],
  quarantaine: [QUARANTINE_ROOT],
  ignorer_deja_archive: [CHRONO_ROOT, ALBUMS_ROOT, QUARANTINE_ROOT],
  ignorer_doublon: [],
};

/**
 * Invariants de conservation des comptes (contre-métrique principale du PRD). Renvoie les violations, vide si tout va
 * bien. `scopeKeys` : clés de tous les objets sous les préfixes source ; `occupied` : inventaire du bucket dédié ;
 * `config` : noms et extensions ignorés, qui seuls justifient une exclusion (avec le marqueur de dossier vide), et formats
 * des médias, qu'aucune exclusion ne peut porter (règle indépendante de `exclusionReason`).
 */
export function checkPlanInvariants(
  plan: Pick<RepairPlan, 'lines' | 'exclusions' | 'unrecognized'>,
  scopeKeys: string[],
  occupied: OccupiedDestination[],
  config: Pick<PlanConfig, 'ignoredFileNames' | 'ignoredExtensions' | 'supportedFormats'>,
): string[] {
  const { lines, exclusions, unrecognized } = plan;
  const violations: string[] = [];
  const declared = lines.length + exclusions.length + unrecognized.length;
  if (declared !== scopeKeys.length) {
    violations.push(
      `lignes (${lines.length}) + exclusions (${exclusions.length}) + non reconnus (${unrecognized.length}) différent du ` +
        `nombre d'objets sous les préfixes source (${scopeKeys.length})`,
    );
  }
  const occurrences = new Map<string, number>();
  for (const { sourceKey } of [...lines, ...exclusions, ...unrecognized]) {
    occurrences.set(sourceKey, (occurrences.get(sourceKey) ?? 0) + 1);
  }
  for (const [key, count] of occurrences) {
    if (count > 1) violations.push(`objet source présent ${count} fois (lignes, exclusions, non reconnus) : ${key}`);
  }
  const scope = new Set(scopeKeys);
  for (const key of scopeKeys) if (!occurrences.has(key)) violations.push(`objet source absent du plan : ${key}`);
  for (const key of occurrences.keys()) if (!scope.has(key)) violations.push(`objet hors périmètre dans le plan : ${key}`);

  const mediaFormats = new Set(config.supportedFormats.map(normalizeExtension));
  for (const e of exclusions) {
    // Garde-fou indépendant de `exclusionReason` : un média n'est jamais exclu, quelle que soit la raison invoquée.
    const extension = extensionOf(e.sourceKey.slice(folderOfKey(e.sourceKey).length));
    if (extension !== '' && mediaFormats.has(extension)) {
      violations.push(`exclusion d'un média : ${e.sourceKey} (extension .${extension} de sync.supportedFormats)`);
    }
    if (exclusionReason(e.sourceKey, e.size, config) === null) {
      violations.push(
        `exclusion non justifiée : ${e.sourceKey} (${e.size} octets) — ni marqueur de dossier vide, ni nom ou extension ignorés`,
      );
    }
  }

  const counted = PLAN_ACTIONS.reduce((total, action) => total + lines.filter((l) => l.action === action).length, 0);
  if (counted !== lines.length) violations.push(`somme des actions (${counted}) différente du total (${lines.length})`);

  const occupiedEtags = new Map<string, (string | null)[]>();
  for (const o of occupied) {
    const key = comparableName(o.folder + o.name);
    occupiedEtags.set(key, [...(occupiedEtags.get(key) ?? []), normalizeEtag(o.etag)]);
  }
  const byKey = new Map(lines.map((l) => [l.sourceKey, l]));
  const assigned = new Map<string, string>();
  for (const l of lines) {
    const roots = (EXPECTED_ROOTS as Record<string, string[] | undefined>)[l.action];
    if (!roots) {
      violations.push(`${l.sourceKey} : action inconnue « ${l.action} »`);
      continue;
    }
    if (l.action === 'ignorer_doublon') {
      const kept = l.keptKey === null ? undefined : byKey.get(l.keptKey);
      if (l.destination !== null) violations.push(`doublon ignoré avec une destination : ${l.sourceKey}`);
      if (!kept || kept.action === 'ignorer_doublon' || kept.destination === null) {
        violations.push(`doublon ${l.sourceKey} : l'exemplaire « ${l.keptKey} » n'est pas conservé avec une destination`);
      } else {
        const etag = normalizeEtag(l.etag);
        if (etag === null || etag !== normalizeEtag(kept.etag) || l.size !== kept.size) {
          violations.push(`doublon ${l.sourceKey} : taille ou ETag différent de l'exemplaire conservé « ${kept.sourceKey} »`);
        }
      }
      continue;
    }
    if (l.destination === null) {
      violations.push(`${l.sourceKey} (${l.action}) sans destination`);
      continue;
    }
    if (Buffer.byteLength(l.destination, 'utf8') > MAX_KEY_BYTES) {
      violations.push(`${l.sourceKey} : destination de plus de ${MAX_KEY_BYTES} octets (limite des clés S3)`);
    }
    if (!roots.some((root) => l.destination!.startsWith(root))) {
      violations.push(`${l.sourceKey} (${l.action}) : destination hors de ${roots.join(' ou ')} (${l.destination})`);
    }
    const comparable = comparableName(l.destination);
    const previous = assigned.get(comparable);
    if (previous !== undefined) violations.push(`destination ${l.destination} attribuée deux fois (${previous}, ${l.sourceKey})`);
    else assigned.set(comparable, l.sourceKey);
    const present = occupiedEtags.get(comparable);
    if (l.action === 'ignorer_deja_archive') {
      const etag = normalizeEtag(l.etag);
      if (!present) violations.push(`${l.sourceKey} déclaré déjà archivé sous ${l.destination}, absent du bucket dédié`);
      else if (etag === null || !present.includes(etag)) {
        violations.push(`${l.sourceKey} déclaré déjà archivé sous ${l.destination}, mais l'ETag de l'objet présent diffère`);
      }
    } else if (present) {
      violations.push(`${l.sourceKey} copié vers une destination occupée : ${l.destination}`);
    }
  }
  return violations;
}

/**
 * Fraîcheur d'un plan enregistré : raisons de ne pas l'exécuter, vide s'il est utilisable. Un plan est périmé si l'index
 * local (inventaires source et dédié, datations) ou la configuration effective ont changé depuis sa génération, ou si
 * la dernière génération a été refusée. `currentIndex` : `null` si l'inventaire source a disparu. Pure.
 */
export function assessPlanFreshness(
  plan: RepairPlan,
  currentIndex: IndexState | null,
  currentConfig: PlanConfig,
  lastRefusal: PlanRefusal | null,
): string[] {
  const reasons: string[] = [];
  const changedFields = (Object.keys(plan.config) as (keyof PlanConfig)[]).filter(
    (field) => JSON.stringify(plan.config[field]) !== JSON.stringify(currentConfig[field]),
  );
  if (changedFields.length > 0) reasons.push(`plan périmé : la configuration a changé : ${changedFields.join(', ')}`);

  const describe = (s: InventoryStamp | null): string =>
    s ? `inventaire du ${s.completedAt}, ${s.objectCount} objets` : 'non inventorié';
  if (!currentIndex) {
    reasons.push(`plan périmé : l'inventaire local du bucket source « ${currentConfig.sourceBucket} » n'existe pas`);
  } else {
    const same = (a: InventoryStamp | null, b: InventoryStamp | null): boolean =>
      a === b || (a !== null && b !== null && a.completedAt === b.completedAt && a.objectCount === b.objectCount);
    if (!same(plan.index.sourceInventory, currentIndex.sourceInventory)) {
      reasons.push(
        `plan périmé : l'index a changé depuis sa génération — bucket source (${describe(plan.index.sourceInventory)} → ` +
          `${describe(currentIndex.sourceInventory)})`,
      );
    }
    if (!same(plan.index.destinationInventory, currentIndex.destinationInventory)) {
      reasons.push(
        `plan périmé : l'index a changé depuis sa génération — bucket dédié (${describe(plan.index.destinationInventory)} → ` +
          `${describe(currentIndex.destinationInventory)})`,
      );
    }
    const { count, lastDatedAt } = plan.index.datings;
    if (count !== currentIndex.datings.count || lastDatedAt !== currentIndex.datings.lastDatedAt) {
      reasons.push(
        `plan périmé : l'index a changé depuis sa génération — datations (${count}, dernière le ${lastDatedAt ?? '—'} → ` +
          `${currentIndex.datings.count}, dernière le ${currentIndex.datings.lastDatedAt ?? '—'})`,
      );
    }
  }
  if (lastRefusal) {
    reasons.push(`la dernière génération a été refusée le ${lastRefusal.refusedAt.toISOString()} : ${lastRefusal.reason}`);
  }
  return reasons;
}

/**
 * Vérification complète d'un plan relu de la base avant toute exécution (story 3.1) : raisons de refuser, vide si le
 * plan peut être exécuté. Ne fait confiance à rien de stocké : fraîcheur (index, configuration, dernier refus),
 * cohérence du contenu avec son empreinte, exécutabilité recalculée, invariants rejoués sur les lignes relues, et
 * recalcul du plan depuis l'index et la configuration actuels, dont l'empreinte doit être identique. Pure.
 */
export function verifyStoredPlan(plan: RepairPlan, current: PlanInput, lastRefusal: PlanRefusal | null): string[] {
  const config = normalizePlanConfig(current);
  const reasons = assessPlanFreshness(plan, current.index, config, lastRefusal);
  if (planFingerprint(plan) !== plan.id) reasons.push('contenu du plan stocké incohérent avec son empreinte');
  if (!plan.executable || plan.violations.length > 0) {
    reasons.push(`plan stocké marqué non exécutable (${plan.violations.length} invariant(s) en échec enregistré(s))`);
  }
  if (plan.unrecognized.length > 0) reasons.push(`${plan.unrecognized.length} objet(s) non reconnu(s) dans le plan stocké`);
  if (plan.namingAnomalies.length > 0) reasons.push(`${plan.namingAnomalies.length} anomalie(s) de nommage dans le plan stocké`);
  const scopeKeys = objectsInScope(current.objects, plan.config.sourcePrefixes).map((o) => o.key);
  for (const violation of checkPlanInvariants(plan, scopeKeys, current.occupied, plan.config)) {
    reasons.push(`invariant en échec sur le plan stocké : ${violation}`);
  }
  try {
    if (buildRepairPlan(current).id !== plan.id) {
      reasons.push('l\'empreinte du plan recalculé depuis l\'index et la configuration actuels diffère de celle du plan stocké');
    }
  } catch (error) {
    if (!(error instanceof PlanRefusedError)) throw error;
    reasons.push(`le recalcul du plan depuis l'index et la configuration actuels est refusé : ${error.message}`);
  }
  return reasons;
}

/**
 * Consigne à ajouter quand les buckets demandés diffèrent de ceux du plan : la vérification doit reprendre les mêmes
 * `--bucket` / `--destination` qu'à la génération. `null` si les buckets correspondent.
 */
export function bucketMismatchHint(plan: Pick<RepairPlan, 'config'>, sourceBucket: string, destinationBucket: string): string | null {
  const { sourceBucket: planSource, destinationBucket: planDestination } = plan.config;
  if (sourceBucket === planSource && destinationBucket === planDestination) return null;
  return (
    `les buckets vérifiés (source « ${sourceBucket} », dédié « ${destinationBucket} ») diffèrent de ceux du plan : ` +
    `repassez les mêmes options qu'à la génération (--bucket ${planSource} --destination ${planDestination})`
  );
}

export interface PlanSummary {
  total: number;
  byAction: Record<PlanAction, { count: number; size: number }>;
  albums: { album: string; count: number; size: number }[]; // médias copiés dans chaque album, par nom
  renamedCount: number; // noms suffixés par la désambiguïsation
  exclusionsByReason: { reason: string; keys: string[]; size: number }[]; // par raison (nom, extension, marqueur)
  unrecognizedByExtension: { extension: string; keys: string[] }[]; // par extension
}

function groupKeys<T extends { sourceKey: string }>(items: T[], labelOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(labelOf(item), [...(groups.get(labelOf(item)) ?? []), item]);
  return new Map([...groups.entries()].sort(([a], [b]) => compareStrings(a, b)));
}

/** Comptes et volumes, recalculés depuis le plan. */
export function summarizePlan(plan: Pick<RepairPlan, 'lines' | 'exclusions' | 'unrecognized'>): PlanSummary {
  const byAction = Object.fromEntries(PLAN_ACTIONS.map((a) => [a, { count: 0, size: 0 }])) as PlanSummary['byAction'];
  const albums = new Map<string, { album: string; count: number; size: number }>();
  let renamedCount = 0;
  for (const l of plan.lines) {
    byAction[l.action].count++;
    byAction[l.action].size += l.size;
    if (l.destination === null || l.action === 'ignorer_deja_archive') continue;
    if (l.destination.startsWith(ALBUMS_ROOT)) {
      const album = l.destination.slice(ALBUMS_ROOT.length).split('/')[0]!;
      const entry = albums.get(album) ?? { album, count: 0, size: 0 };
      entry.count++;
      entry.size += l.size;
      albums.set(album, entry);
    }
    if (path.posix.basename(l.destination) !== path.posix.basename(l.sourceKey)) renamedCount++;
  }
  return {
    total: plan.lines.length,
    byAction,
    albums: [...albums.values()].sort((a, b) => compareStrings(a.album, b.album)),
    renamedCount,
    exclusionsByReason: [...groupKeys(plan.exclusions, (e) => e.reason).entries()].map(([reason, items]) => ({
      reason,
      keys: items.map((e) => e.sourceKey),
      size: items.reduce((total, e) => total + e.size, 0),
    })),
    unrecognizedByExtension: [...groupKeys(plan.unrecognized, (u) => u.extension).entries()].map(([extension, items]) => ({
      extension,
      keys: items.map((u) => u.sourceKey),
    })),
  };
}

/** Consigne affichée et exportée pour chaque objet non reconnu. */
export const UNRECOGNIZED_HINT =
  'ajoutez l\'extension à sync.supportedFormats (média à archiver), ou le nom de fichier à repair.ignoredFileNames ou ' +
  'l\'extension à repair.ignoredExtensions (fichier à ne pas archiver)';

const CSV_HEADER = ['cle_source', 'bucket_source', 'taille_octets', 'etag', 'action', 'destination', 'cle_conservee', 'raison'];

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Plan complet en CSV (séparateur « ; », UTF-8 avec BOM pour les tableurs) : une ligne par objet sous les préfixes
 * source — lignes du plan, puis exclusions (`exclu`) et objets non reconnus (`non_reconnu`).
 */
export function planToCsv(plan: RepairPlan): string {
  const bucket = plan.config.sourceBucket;
  const rows: (string | number | null)[][] = [
    ...plan.lines.map((l) => [l.sourceKey, l.sourceBucket, l.size, l.etag, l.action, l.destination, l.keptKey, l.reason]),
    ...plan.exclusions.map((e) => [e.sourceKey, bucket, e.size, e.etag, 'exclu', null, null, e.reason]),
    ...plan.unrecognized.map((u) => [
      u.sourceKey, bucket, u.size, u.etag, 'non_reconnu', null, null, `extension ${u.extension} non reconnue : ${UNRECOGNIZED_HINT}`,
    ]),
  ];
  const bom = String.fromCharCode(0xfeff);
  return bom + [CSV_HEADER, ...rows].map((row) => row.map(csvField).join(';')).join('\n') + '\n';
}

/** Plan complet en JSON, clés en français. */
export function planToJson(plan: RepairPlan, generatedAt: Date | null = null): string {
  const summary = summarizePlan(plan);
  const { config } = plan;
  const stamp = (s: InventoryStamp | null): unknown => (s ? { termine_le: s.completedAt, objets: s.objectCount } : null);
  return (
    JSON.stringify(
      {
        empreinte: plan.id,
        genere_le: generatedAt?.toISOString() ?? null,
        bucket_source: config.sourceBucket,
        bucket_destination: config.destinationBucket,
        configuration: {
          prefixes_source: config.sourcePrefixes,
          formats_medias: config.supportedFormats,
          albums_conserves: config.keptAlbums,
          noms_ignores: config.ignoredFileNames,
          extensions_ignorees: config.ignoredExtensions,
        },
        etat_index: {
          inventaire_source: stamp(plan.index.sourceInventory),
          inventaire_destination: stamp(plan.index.destinationInventory),
          datations: { nombre: plan.index.datings.count, derniere_le: plan.index.datings.lastDatedAt },
        },
        executable: plan.executable,
        resume: {
          total: summary.total,
          par_action: Object.fromEntries(PLAN_ACTIONS.map((a) => [a, { nombre: summary.byAction[a].count, octets: summary.byAction[a].size }])),
          albums: summary.albums.map((a) => ({ album: a.album, nombre: a.count, octets: a.size })),
          noms_suffixes: summary.renamedCount,
          exclusions: summary.exclusionsByReason.map((e) => ({ raison: e.reason, nombre: e.keys.length, octets: e.size })),
          non_reconnus: plan.unrecognized.length,
        },
        non_reconnus: summary.unrecognizedByExtension.map((u) => ({ extension: u.extension, cles: u.keys, consigne: UNRECOGNIZED_HINT })),
        exclusions: plan.exclusions.map((e) => ({ cle_source: e.sourceKey, taille_octets: e.size, etag: e.etag, raison: e.reason })),
        anomalies_de_nommage: plan.namingAnomalies.map((a) => ({ cle_source: a.id, destination: a.destination, raison: a.reason })),
        invariants_en_echec: plan.violations,
        lignes: plan.lines.map((l) => ({
          cle_source: l.sourceKey,
          bucket_source: l.sourceBucket,
          taille_octets: l.size,
          etag: l.etag,
          action: l.action,
          destination: l.destination,
          cle_conservee: l.keptKey,
          raison: l.reason,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/** Contenu d'export selon l'extension du fichier (`.csv` ou `.json`). */
export function planExport(plan: RepairPlan, fileName: string, generatedAt: Date | null = null): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.csv') return planToCsv(plan);
  if (extension === '.json') return planToJson(plan, generatedAt);
  throw new Error(`format d'export non reconnu pour « ${fileName} » : extension .csv ou .json attendue`);
}
