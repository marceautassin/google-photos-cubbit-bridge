import * as path from 'path';
import { BucketObject } from '../clients/types';
import { ObjectDating } from '../database/inventory-date-model';
import { LocalDateTime } from '../utils/local-date-time';
import { EXIF_TAGS, isSameObject } from './dating';

/**
 * Doublons et collisions de noms (story 2.3). Calcul pur, rejoué depuis l'inventaire et les datations : rien n'est
 * persisté, rien n'est lu sur le réseau. La story 2.4 réutilise `analyzeDuplicates`, `resolveNames` et
 * `disambiguateNames`.
 *
 * Règle de sûreté : un doublon exige un nom comparable identique, une taille identique ET un ETag identique non nul.
 * Au pire une copie en trop, jamais une photo perdue.
 */

/** Pas d'allongement du suffixe de désambiguïsation, en caractères de l'ETag. */
export const SUFFIX_LENGTH = 8;

/** Règle de désambiguïsation (question Q1 du PRD), affichée telle quelle dans le rapport. */
export const DISAMBIGUATION_RULE =
  'Dans un même dossier de destination (dossier et nom comparés sans casse, Unicode NFC), les noms sont départagés ainsi. Un nom déjà occupé ne change ' +
  'jamais. Un nom libre porté par un seul nouveau contenu est conservé tel quel ; sinon chaque nouveau contenu reçoit ' +
  `le suffixe « _<${SUFFIX_LENGTH} premiers caractères de son ETag> » avant l'extension (ex. IMG_0044_1a2b3c4d.JPG), ` +
  'allongé si nécessaire jusqu\'à l\'ETag complet. Un contenu d\'ETag identique déjà présent est « déjà archivé ». ' +
  'Aucune destination ne reçoit deux objets.';

/**
 * Nature d'un ETag : `md5` pour un objet déposé en une seule requête (32 caractères hexadécimaux) ;
 * `multipart` pour tout autre ETag (dépôt en plusieurs parties `…-N`) ; `absent` sinon.
 */
export type EtagKind = 'md5' | 'multipart' | 'absent';

export function etagKind(etag: string | null): EtagKind {
  const normalized = normalizeEtag(etag);
  if (!normalized) return 'absent';
  return /^[0-9a-f]{32}$/.test(normalized) ? 'md5' : 'multipart';
}

/** ETag comparable par chaîne : sans espaces ni guillemets, en minuscules ; `null` s'il est absent. */
export function normalizeEtag(etag: string | null): string | null {
  const normalized = etag?.trim().replace(/"/g, '').toLowerCase();
  return normalized ? normalized : null;
}

/** Dossier chronologique de destination (D2) : `photos/AAAA/AAAA-MM/`, par simple découpage, sans fuseau. */
export function destinationFolder(takenAt: LocalDateTime): string {
  return `photos/${takenAt.slice(0, 4)}/${takenAt.slice(0, 7)}/`;
}

/** Nom comparé : NFC (accents décomposés de macOS) et minuscules (systèmes insensibles à la casse). */
export function comparableName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Base et extension d'un nom ; un nom commençant par un point (`.jpg`) n'a pas de base, tout est extension. */
export function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? { base: name, extension: '' } : { base: name.slice(0, dot), extension: name.slice(dot) };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface NamingEntry {
  id: string; // identifiant de l'objet (clé source)
  folder: string; // dossier de destination
  name: string; // nom de fichier d'origine
  etag: string | null;
}

/** Destination déjà présente dans l'archive (passe précédente). */
export interface OccupiedDestination {
  folder: string;
  name: string;
  etag: string | null;
}

export interface NamingAnomaly {
  id: string;
  destination: string; // dossier + nom d'origine
  reason: string;
}

export interface NamingResult {
  names: Map<string, string>; // id → nom de la nouvelle destination
  alreadyArchived: Map<string, string>; // id → clé exacte (casse, forme Unicode) de l'objet d'ETag identique déjà présent
  anomalies: NamingAnomaly[]; // entrées sans destination possible (aucune écriture ne doit les concerner)
}

/** Clé de conflit : dossier et nom comparés sans casse ni différence de forme Unicode (un système de fichiers insensible
 * à la casse fusionnerait `Divers/` et `divers/`). */
const conflictKey = (folder: string, name: string): string => `${comparableName(folder)}\u0000${comparableName(name)}`;

/** `occupied` est-il le nom d'origine ou une variante suffixée (`base_<id>ext`) de `name` ? */
function isNameOrVariant(occupied: string, name: string): boolean {
  const target = comparableName(name);
  const candidate = comparableName(occupied);
  if (candidate === target) return true;
  const { base, extension } = splitName(target);
  const middle = candidate.slice(base.length + 1, candidate.length - extension.length);
  return (
    candidate.length > base.length + 1 + extension.length &&
    candidate.startsWith(`${base}_`) &&
    candidate.endsWith(extension) &&
    /^[0-9a-z]+$/.test(middle)
  );
}

/** Identifiant de suffixe : caractères alphanumériques de l'ETag normalisé. */
function contentId(etag: string | null): string {
  return normalizeEtag(etag)?.replace(/[^0-9a-z]/g, '') ?? '';
}

/** Suffixe un groupe d'arrivants au même nom, en allongeant le suffixe jusqu'à l'ETag complet si nécessaire. */
function suffixGroup(group: NamingEntry[], taken: Set<string>, result: NamingResult): void {
  const withId: { entry: NamingEntry; id: string }[] = [];
  for (const entry of [...group].sort((a, b) => compareStrings(a.id, b.id))) {
    const id = contentId(entry.etag);
    if (id) withId.push({ entry, id });
    else result.anomalies.push({ id: entry.id, destination: entry.folder + entry.name, reason: 'ETag absent : suffixe impossible' });
  }
  const maxLength = Math.max(0, ...withId.map(({ id }) => id.length));
  for (let length = SUFFIX_LENGTH; ; length += SUFFIX_LENGTH) {
    const candidates = withId.map(({ entry, id }) => {
      const { base, extension } = splitName(entry.name);
      const name = `${base}_${id.slice(0, length)}${extension}`;
      return { entry, name, key: conflictKey(entry.folder, name) };
    });
    const keys = candidates.map((c) => c.key);
    if (new Set(keys).size === keys.length && keys.every((key) => !taken.has(key))) {
      for (const { entry, name, key } of candidates) {
        result.names.set(entry.id, name);
        taken.add(key);
      }
      return;
    }
    if (length >= maxLength) {
      for (const { entry } of withId) {
        result.anomalies.push({
          id: entry.id,
          destination: entry.folder + entry.name,
          reason: 'aucun suffixe libre, même avec l\'ETag complet (ETag identiques ou noms déjà occupés)',
        });
      }
      return;
    }
  }
}

/**
 * Clé de conflit du nom d'origine dont `occupied` est une variante suffixée par un ETag (`base_<hex multiple de
 * SUFFIX_LENGTH>ext`), `null` si ce n'en est pas une.
 * Faux positif assumé : un nom d'origine de cette forme (`IMG_20230415.jpg`) est pris pour une variante, et un
 * homonyme nu arrivant seul (`IMG.jpg`) est alors suffixé au lieu d'être conservé tel quel. Sans perte ; ne pas
 * resserrer en comparant le suffixe à l'ETag de l'objet : le suffixe vient du MD5, l'ETag d'un gros objet est multipart.
 */
function suffixedVariantOf(occupied: OccupiedDestination): string | null {
  const { base, extension } = splitName(comparableName(occupied.name));
  const match = /^(.+)_([0-9a-f]+)$/.exec(base);
  if (!match || match[2]!.length % SUFFIX_LENGTH !== 0) return null;
  return conflictKey(occupied.folder, `${match[1]}${extension}`);
}

/**
 * Nom de destination de chaque entrée selon `DISAMBIGUATION_RULE`, sans jamais lever d'erreur : les cas impossibles
 * sont collectés dans `anomalies` (chemin « rapport »). Pur, déterministe, indépendant de l'ordre d'entrée.
 * `occupied` : destinations déjà présentes dans l'archive, jamais renommées.
 *
 * `variantsCountAsHomonyms` (archivage Takeout, story 4.4) : une variante suffixée déjà présente d'un nom compte comme un
 * autre porteur de ce nom, donc le seul nouvel arrivant est suffixé lui aussi. Sans cela, une passe interrompue entre deux
 * homonymes puis replanifiée donnerait au second le nom nu, alors que la passe ininterrompue l'aurait suffixé.
 */
export function resolveNames(entries: NamingEntry[], occupied: OccupiedDestination[] = [], variantsCountAsHomonyms = false): NamingResult {
  const result: NamingResult = { names: new Map(), alreadyArchived: new Map(), anomalies: [] };
  const taken = new Set(occupied.map((o) => conflictKey(o.folder, o.name)));
  const occupiedByEtag = groupBy(
    occupied.filter((o) => normalizeEtag(o.etag)),
    (o) => `${comparableName(o.folder)}\u0000${normalizeEtag(o.etag)}`,
  );

  const occupiedVariants = new Set(variantsCountAsHomonyms ? occupied.map(suffixedVariantOf).filter((k) => k !== null) : []);
  const arrivals: NamingEntry[] = [];
  for (const entry of entries) {
    const etag = normalizeEtag(entry.etag);
    const existing = etag
      ? occupiedByEtag.get(`${comparableName(entry.folder)}\u0000${etag}`)?.find((o) => isNameOrVariant(o.name, entry.name))
      : undefined;
    if (existing) result.alreadyArchived.set(entry.id, existing.folder + existing.name);
    else arrivals.push(entry);
  }

  // Noms libres d'abord (ils ne dépendent de rien), puis suffixes dans l'ordre des clés : résultat indépendant de l'ordre.
  const groups = [...groupBy(arrivals, (e) => conflictKey(e.folder, e.name)).entries()].sort(([a], [b]) => compareStrings(a, b));
  const toSuffix: NamingEntry[][] = [];
  for (const [key, group] of groups) {
    if (group.length === 1 && !taken.has(key) && !occupiedVariants.has(key)) {
      result.names.set(group[0]!.id, group[0]!.name);
      taken.add(key);
    } else {
      toSuffix.push(group);
    }
  }
  for (const group of toSuffix) suffixGroup(group, taken, result);
  return result;
}

/** Variante stricte de `resolveNames`, pour les chemins qui écriront (2.4, 3.1) : erreur à la moindre anomalie. */
export function disambiguateNames(entries: NamingEntry[], occupied: OccupiedDestination[] = []): NamingResult {
  const result = resolveNames(entries, occupied);
  if (result.anomalies.length > 0) {
    const details = result.anomalies.map((a) => `${a.destination} (${a.id}) : ${a.reason}`).join(' ; ');
    throw new Error(`Désambiguïsation impossible, aucune écriture ne doit avoir lieu : ${details}`);
  }
  return result;
}

export interface MediaCopy {
  object: BucketObject;
  dating: ObjectDating | null; // null : non daté (lancer « gpb inventory dates »)
}

/** Doublons confirmés : même nom comparable, même taille, même ETag non nul. */
export interface DuplicateGroup {
  name: string;
  size: number;
  kept: MediaCopy; // exemplaire conservé
  others: MediaCopy[]; // copies en trop, triées par clé
  dateMismatch: boolean; // dates ou sources de date différentes entre les copies
}

/** Même nom comparable et même taille, mais ETag distincts ou absents : copies jamais fusionnées. */
export interface SameNameAndSize {
  name: string;
  size: number;
  copies: MediaCopy[];
}

export interface NameCollision {
  folder: string;
  entries: { copy: MediaCopy; finalName: string | null }[]; // null : anomalie
}

export interface DuplicateReport {
  mediaCount: number;
  contentCount: number; // contenus distincts = exemplaires conservés
  groups: DuplicateGroup[];
  extraCopyCount: number;
  recoverableSize: number; // doublons confirmés uniquement
  etagConflicts: SameNameAndSize[]; // au moins deux MD5 différents : contenus différents, certain
  unconfirmed: SameNameAndSize[]; // ETag absent ou multipart différent : doublons présumés non confirmables
  unconfirmedSize: number; // volume au plus récupérable s'ils étaient identiques — hors volume récupérable
  homonyms: MediaCopy[][]; // noms portés par plusieurs contenus, quelle que soit la destination
  collisions: NameCollision[]; // même nom dans le même dossier de destination
  destinations: Map<string, string>; // clé de l'exemplaire → nouvelle destination complète
  alreadyArchived: Map<string, string>; // clé de l'exemplaire → destination existante de même contenu
  namingAnomalies: NamingAnomaly[]; // bloquantes : aucune destination possible
  withoutFolder: MediaCopy[]; // exemplaires sans date : aucun dossier daté (quarantaine, story 2.4)
  undatedCount: number; // médias sans datation valide
}

/**
 * Rang de fiabilité de la date d'une copie (plus petit = plus fiable) : nom de fichier, EXIF DateTimeOriginal,
 * CreateDate, ModifyDate, EXIF à champ inconnu, indéterminée, non datée.
 */
export function datingRank(dating: ObjectDating | null): number {
  const unknownExif = EXIF_TAGS.length + 1;
  if (!dating) return unknownExif + 2;
  if (dating.source === 'nom_fichier') return 0;
  if (dating.source === 'exif') {
    const index = (EXIF_TAGS as readonly string[]).indexOf(dating.detail ?? '');
    return index < 0 ? unknownExif : index + 1;
  }
  return unknownExif + 1;
}

const byKey = (a: MediaCopy, b: MediaCopy): number => compareStrings(a.object.key, b.object.key);

/** Nom de fichier d'une copie (dernier segment de sa clé). */
export const nameOf = (c: MediaCopy): string => path.basename(c.object.key);

/** Associe à chaque média sa datation, si elle vaut pour lui (même clé, taille, ETag) ; triés par clé. */
export function attachDatings(media: BucketObject[], datings: ObjectDating[]): MediaCopy[] {
  const datingByKey = new Map(datings.map((row) => [row.key, row]));
  return media
    .map((object) => {
      const row = datingByKey.get(object.key);
      return { object, dating: isSameObject(row, object) ? row : null };
    })
    .sort(byKey);
}

/** Copies de même nom comparable et de même taille (candidates au doublon). */
export function groupSameNameAndSize(copies: MediaCopy[]): MediaCopy[][] {
  return [...groupBy(copies, (c) => `${c.object.size}\u0000${comparableName(nameOf(c))}`).values()];
}

/** Contenus distincts d'un groupe de même nom et taille : même ETag non nul. Un ETag absent ne se fusionne avec rien. */
export function splitContents(sameNameAndSize: MediaCopy[]): MediaCopy[][] {
  return [...groupBy(sameNameAndSize, (c) => normalizeEtag(c.object.etag) ?? `\u0000${c.object.key}`).values()];
}

/**
 * Exemplaire conservé : la date la plus fiable, puis la plus petite clé. La destination dépend de la date et non de
 * l'emplacement source : la clé ne sert qu'à rendre le choix déterministe.
 */
export function chooseKept(copies: MediaCopy[]): MediaCopy {
  return [...copies].sort((a, b) => datingRank(a.dating) - datingRank(b.dating) || byKey(a, b))[0]!;
}

function datingSignature(dating: ObjectDating | null): string {
  if (!dating) return 'non_datee';
  return `${dating.source}|${dating.source === 'exif' ? dating.detail : ''}|${dating.takenAt}`;
}

/**
 * Analyse les médias : doublons confirmés, présumés non confirmables, incohérences, homonymes, collisions et
 * destination de chaque exemplaire daté. Pur, indépendant de l'ordre d'entrée, ne lève pas d'erreur.
 * `occupied` : destinations déjà présentes dans l'archive (vide tant que le bucket dédié n'est pas inventorié).
 */
export function analyzeDuplicates(
  media: BucketObject[],
  datings: ObjectDating[],
  occupied: OccupiedDestination[] = [],
): DuplicateReport {
  const copies = attachDatings(media, datings);

  const report: DuplicateReport = {
    mediaCount: media.length,
    contentCount: 0,
    groups: [],
    extraCopyCount: 0,
    recoverableSize: 0,
    etagConflicts: [],
    unconfirmed: [],
    unconfirmedSize: 0,
    homonyms: [],
    collisions: [],
    destinations: new Map(),
    alreadyArchived: new Map(),
    namingAnomalies: [],
    withoutFolder: [],
    undatedCount: copies.filter((c) => c.dating === null).length,
  };

  const kept: MediaCopy[] = [];
  for (const sameNameAndSize of groupSameNameAndSize(copies)) {
    const name = nameOf(sameNameAndSize[0]!);
    const size = sameNameAndSize[0]!.object.size;
    const contents = splitContents(sameNameAndSize);
    if (contents.length > 1) {
      const md5 = new Set(sameNameAndSize.filter((c) => etagKind(c.object.etag) === 'md5').map((c) => normalizeEtag(c.object.etag)));
      if (md5.size > 1) report.etagConflicts.push({ name, size, copies: sameNameAndSize });
      if (sameNameAndSize.some((c) => etagKind(c.object.etag) !== 'md5')) {
        report.unconfirmed.push({ name, size, copies: sameNameAndSize });
        report.unconfirmedSize += (sameNameAndSize.length - 1) * size;
      }
    }

    for (const content of contents) {
      const exemplar = chooseKept(content);
      kept.push(exemplar);
      if (content.length === 1) continue;
      const group: DuplicateGroup = {
        name,
        size,
        kept: exemplar,
        others: content.filter((c) => c !== exemplar),
        dateMismatch: new Set(content.map((c) => datingSignature(c.dating))).size > 1,
      };
      report.groups.push(group);
      report.extraCopyCount += group.others.length;
      report.recoverableSize += group.others.length * size;
    }
  }
  report.contentCount = kept.length;
  report.homonyms = [...groupBy(kept, (c) => comparableName(nameOf(c))).values()].filter((g) => g.length > 1);

  report.withoutFolder = kept.filter((c) => !c.dating?.takenAt);
  const entries = kept
    .filter((c) => c.dating?.takenAt)
    .map((c) => ({
      copy: c,
      naming: { id: c.object.key, folder: destinationFolder(c.dating!.takenAt!), name: nameOf(c), etag: c.object.etag },
    }));
  const naming = resolveNames(entries.map((e) => e.naming), occupied);
  report.namingAnomalies = naming.anomalies;
  const folderOf = new Map(entries.map((e) => [e.naming.id, e.naming.folder]));
  for (const [id, name] of naming.names) report.destinations.set(id, folderOf.get(id)! + name);
  for (const [id, key] of naming.alreadyArchived) report.alreadyArchived.set(id, key);
  for (const group of groupBy(entries, (e) => conflictKey(e.naming.folder, e.naming.name)).values()) {
    if (group.length < 2) continue;
    report.collisions.push({
      folder: group[0]!.naming.folder,
      entries: group.map((e) => ({ copy: e.copy, finalName: naming.names.get(e.naming.id) ?? null })),
    });
  }
  return report;
}
