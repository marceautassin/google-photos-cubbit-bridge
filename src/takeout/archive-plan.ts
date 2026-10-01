import { createHash } from 'crypto';
import {
  comparableName,
  destinationFolder,
  NamingAnomaly,
  NamingEntry,
  normalizeEtag,
  OccupiedDestination,
  resolveNames,
} from '../inventory/duplicates';
import { ALBUMS_ROOT, CHRONO_ROOT, MAX_KEY_BYTES, QUARANTINE_ROOT } from '../inventory/repair-plan';
import { TakeoutDateSource } from './media-dating';
import { AnalyzedMedia } from './takeout-analysis';

/**
 * Plan d'archivage d'un export Takeout (story 4.3). Calcul pur depuis l'analyse enregistrée (story 4.2) et l'inventaire
 * actuel du bucket dédié restreint à `photos/`, `albums/` et `quarantaine/` : aucune lecture réseau, aucune écriture S3.
 * Le plan est exécuté par cette même story, repris par la 4.4, attesté par la 4.5.
 *
 * Une ligne par média de l'export (représentants ET doublons internes). Destinations identiques au schéma de l'epic 3
 * (`photos/AAAA/AAAA-MM/<nom>`, `albums/<album conservé>/<nom>`, `quarantaine/<dossier>/<nom>`), avec la même règle Q1
 * de désambiguïsation (`resolveNames` de `duplicates.ts`, réutilisée telle quelle : un MD5 hexadécimal 32 caractères
 * satisfait déjà le format « ETag simple » qu'elle attend).
 *
 * Décisions explicites (revue de clôture de la story 4.2) :
 * - un contenu `deja_archive` (sous `photos/` ou `albums/`) n'est jamais recopié dans `albums/` au seul motif que le
 *   Takeout le range dans un album conservé : l'archive existante fait foi, sans duplication (FR-12 prime) ;
 * - un contenu nouveau présent à la fois dans un dossier d'année et un album conservé suit le choix déjà fait par
 *   `markInternalDuplicates` (story 4.2, priorité à l'album conservé) : aucune logique supplémentaire ici ;
 * - un média dont le seul objet archivé est sous `quarantaine/` (`archive.status === 'deja_archive'`, tous les
 *   candidats sous `quarantaine/`) est reclassé par date (`reclasser_quarantaine`, destination `photos/…`), jamais
 *   laissé en l'état, SAUF s'il n'a lui-même aucune date connue (0 cas réel, mais couvert : alors laissé en l'état,
 *   un reclassement sans date n'améliorant rien) ;
 * - un statut `non_confirmable` n'a pas d'action dédiée dans les critères d'acceptation : traité comme un homonyme
 *   différent (envoyé sous un nom éventuellement suffixé), cohérent avec FR-12 qui interdit de ré-envoyer un média
 *   **prouvé** déjà présent, jamais un média seulement suspecté tel (0 cas réel, mais couvert).
 */

export type TakeoutPlanAction = 'envoyer' | 'ignorer_deja_archive' | 'ignorer_doublon_interne' | 'reclasser_quarantaine' | 'quarantaine';
export const TAKEOUT_PLAN_ACTIONS: readonly TakeoutPlanAction[] = [
  'envoyer',
  'ignorer_deja_archive',
  'ignorer_doublon_interne',
  'reclasser_quarantaine',
  'quarantaine',
];

/** Racines de destination attendues par action ; vide pour `ignorer_doublon_interne` (aucune destination). */
const EXPECTED_ROOTS: Record<TakeoutPlanAction, string[]> = {
  envoyer: [CHRONO_ROOT, ALBUMS_ROOT],
  ignorer_deja_archive: [CHRONO_ROOT, ALBUMS_ROOT, QUARANTINE_ROOT],
  ignorer_doublon_interne: [],
  reclasser_quarantaine: [CHRONO_ROOT],
  quarantaine: [QUARANTINE_ROOT],
};

export interface MediaLocation {
  part: string;
  path: string;
}

export interface TakeoutPlanLine extends MediaLocation {
  folder: string;
  fileName: string;
  size: number;
  md5: string;
  dateSource: TakeoutDateSource;
  action: TakeoutPlanAction;
  destination: string | null; // nulle seulement pour un doublon interne, ou une anomalie de désambiguïsation
  keptOf: MediaLocation | null; // doublon interne : représentant conservé
  /**
   * Pour `ignorer_deja_archive` seulement (story 4.3, correction) : ETag (normalisé) de l'objet archivé `destination`
   * tel que vu par l'analyse — MD5 égal au MD5 du contenu, ou ETag multipart confirmé, jamais l'un comparé à l'autre.
   * Revérifié par `checkArchivePlanInvariants` contre l'inventaire actuel (même ETag ET même taille). `null` sinon.
   */
  archivedEtag: string | null;
  reason: string;
}

/** Objet archivé actuel (`photos/`, `albums/`, `quarantaine/`), avec sa taille — nécessaire pour revérifier qu'un
 * objet désigné « déjà archivé » par l'analyse (preuve MD5 ou ETag multipart) n'a pas changé depuis (story 4.3). */
export interface ArchivedObjectSnapshot extends OccupiedDestination {
  size: number;
}

const folderOfKey = (key: string): string => key.slice(0, key.lastIndexOf('/') + 1);

/** Instantané de l'inventaire actuel du bucket dédié, avec taille (à passer en `TakeoutPlanInput.occupied`). */
export function archivedObjectsFrom(objects: readonly { key: string; size: number; etag: string | null }[]): ArchivedObjectSnapshot[] {
  return objects.map((o) => ({ folder: folderOfKey(o.key), name: o.key.slice(folderOfKey(o.key).length), etag: o.etag, size: o.size }));
}

export interface TakeoutArchivePlan {
  id: string; // empreinte SHA-256 du contenu
  exportId: string;
  destinationBucket: string;
  keptAlbums: string[]; // normalisés (NFC, sans casse), triés
  analysisAnalyzedAt: string; // horodatage de l'analyse source (plan périmé si elle change)
  destinationInventoryCompletedAt: string | null; // inventaire du bucket dédié utilisé pour les destinations occupées
  lines: TakeoutPlanLine[]; // triées par (part, path)
  namingAnomalies: NamingAnomaly[];
  violations: string[];
  executable: boolean;
}

export interface TakeoutPlanInput {
  exportId: string;
  destinationBucket: string;
  keptAlbums: string[];
  analysisAnalyzedAt: string;
  media: AnalyzedMedia[];
  /** Inventaire actuel du bucket dédié restreint à `photos/`, `albums/`, `quarantaine/` (peut être plus récent que l'analyse). */
  occupied: ArchivedObjectSnapshot[];
  destinationInventoryCompletedAt: string | null;
}

/** Refus de produire un plan : l'entrée ne permet pas un plan complet. */
export class ArchivePlanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePlanRefusedError';
  }
}

/** Dernière génération refusée, enregistrée sans toucher au plan courant. */
export interface ArchivePlanRefusal {
  refusedAt: Date;
  reason: string;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/**
 * Clé unique d'un média de l'export (`<part><séparateur><path>`). Séparateur : U+241F (symbole visible « unit
 * separator »), jamais un octet NUL (`\u0000`) — cette clé est persistée telle quelle comme `source_key` du journal
 * d'exécution (story 4.3, table `repair_execution_lines` réutilisée) ; un octet NUL y serait tronqué silencieusement
 * par la couche SQLite (chaînes C), ce qui a été constaté et corrigé pendant cette story.
 */
export const locationKey = (l: MediaLocation): string => `${l.part}␟${l.path}`;

/** Albums conservés, sous forme comparable (NFC, sans casse), triés. */
export const normalizedKeptAlbums = (albums: string[]): string[] => [...new Set(albums.map(comparableName))].sort();

const isKeptAlbumFolder = (folder: string, keptAlbums: string[]): boolean => {
  const kept = new Set(normalizedKeptAlbums(keptAlbums));
  return kept.has(comparableName(folder));
};

/** Tous les candidats archivés d'un média correspondent-ils uniquement à `quarantaine/` ? */
const isQuarantineOnly = (m: Pick<AnalyzedMedia, 'archive'>): boolean =>
  m.archive.status === 'deja_archive' && m.archive.candidates.length > 0 && m.archive.candidates.every((k) => k.startsWith(QUARANTINE_ROOT));

const base = (m: AnalyzedMedia): Omit<TakeoutPlanLine, 'action' | 'destination' | 'keptOf' | 'archivedEtag' | 'reason'> => ({
  part: m.part,
  path: m.path,
  folder: m.folder,
  fileName: m.fileName,
  size: m.size,
  md5: m.md5,
  dateSource: m.dateSource,
});

/**
 * Construit le plan d'archivage, pur, sans I/O. Ne lève pas d'erreur pour un contenu incomplet du côté des médias :
 * les cas impossibles à résoudre deviennent des `namingAnomalies` (plan non exécutable). Lève `ArchivePlanRefusedError`
 * seulement si `input` lui-même est incohérent (aucun média).
 */
export function buildArchivePlan(input: TakeoutPlanInput): TakeoutArchivePlan {
  const { media, keptAlbums, occupied } = input;
  if (media.length === 0) throw new ArchivePlanRefusedError('aucun média dans l\'analyse : rien à planifier');

  const lines: TakeoutPlanLine[] = [];
  const toResolve: AnalyzedMedia[] = [];

  for (const m of media) {
    if (m.duplicateOf !== null) {
      lines.push({
        ...base(m),
        action: 'ignorer_doublon_interne',
        destination: null,
        keptOf: { part: m.duplicateOf.part, path: m.duplicateOf.path },
        archivedEtag: null,
        reason: `doublon interne (même contenu) : exemplaire conservé ${m.duplicateOf.part}:${m.duplicateOf.path}`,
      });
      continue;
    }
    if (m.archive.status === 'deja_archive') {
      const quarantineOnly = isQuarantineOnly(m);
      if (quarantineOnly && m.takenAt !== null) {
        toResolve.push(m); // reclassé plus bas (reclasser_quarantaine), destination à calculer
        continue;
      }
      lines.push({
        ...base(m),
        action: 'ignorer_deja_archive',
        destination: m.archive.key,
        keptOf: null,
        archivedEtag: m.archive.archivedEtag,
        reason: quarantineOnly
          ? 'déjà archivé uniquement en quarantaine, date indéterminée : reclassement impossible, laissé en l\'état'
          : `contenu déjà archivé (preuve ${m.archive.proof}) sous ${m.archive.key}`,
      });
      continue;
    }
    // 'nouveau', 'homonyme_different' et 'non_confirmable' (traité comme un homonyme différent, cf. en-tête du module).
    toResolve.push(m);
  }

  const actionFor = (m: AnalyzedMedia): TakeoutPlanAction => {
    if (isQuarantineOnly(m)) return 'reclasser_quarantaine';
    if (m.takenAt === null) return 'quarantaine';
    return 'envoyer';
  };
  const destinationRoot = (m: AnalyzedMedia): string => {
    if (isQuarantineOnly(m)) return destinationFolder(m.takenAt!); // reclassement : toujours daté (filtré ci-dessus sinon)
    if (m.folderKind === 'album' && isKeptAlbumFolder(m.folder, keptAlbums)) return `${ALBUMS_ROOT}${m.folder}/`;
    if (m.takenAt !== null) return destinationFolder(m.takenAt);
    return `${QUARANTINE_ROOT}${m.folder}/`;
  };

  const entries: { media: AnalyzedMedia; naming: NamingEntry }[] = toResolve.map((m) => ({
    media: m,
    naming: { id: locationKey(m), folder: destinationRoot(m), name: m.fileName, etag: m.md5 },
  }));
  const naming = resolveNames(
    entries.map((e) => e.naming),
    occupied,
    true, // replanification après une passe interrompue : les noms suffixés (Q1) restent ceux de la passe ininterrompue
  );

  for (const { media: m, naming: n } of entries) {
    const action = actionFor(m);
    const already = naming.alreadyArchived.get(n.id);
    if (already) {
      lines.push({
        ...base(m),
        action: 'ignorer_deja_archive',
        destination: already,
        keptOf: null,
        archivedEtag: normalizeEtag(m.md5),
        reason: `contenu déjà présent dans le bucket dédié sous ${already} (détecté au moment du plan)`,
      });
      continue;
    }
    const finalName = naming.names.get(n.id);
    if (finalName === undefined) {
      lines.push({
        ...base(m),
        action,
        destination: null,
        keptOf: null,
        archivedEtag: null,
        reason: 'désambiguïsation impossible : voir les anomalies de nommage du plan',
      });
      continue;
    }
    const reason =
      action === 'reclasser_quarantaine'
        ? `déjà archivé uniquement en quarantaine (${m.archive.key}), reclassé par date : jamais laissé en quarantaine`
        : action === 'quarantaine'
          ? 'date indéterminée'
          : m.archive.status === 'nouveau'
            ? 'contenu nouveau, absent de l\'archive'
            : `homonyme de contenu différent (statut ${m.archive.status})`;
    lines.push({ ...base(m), action, destination: n.folder + finalName, keptOf: null, archivedEtag: null, reason });
  }

  lines.sort((a, b) => compareStrings(locationKey(a), locationKey(b)));

  const content: Omit<TakeoutArchivePlan, 'id' | 'executable'> = {
    exportId: input.exportId,
    destinationBucket: input.destinationBucket,
    keptAlbums: normalizedKeptAlbums(keptAlbums),
    analysisAnalyzedAt: input.analysisAnalyzedAt,
    destinationInventoryCompletedAt: input.destinationInventoryCompletedAt,
    lines,
    namingAnomalies: naming.anomalies,
    violations: checkArchivePlanInvariants({ lines }, media, occupied),
  };
  return {
    id: archivePlanFingerprint(content),
    ...content,
    executable: content.violations.length === 0 && content.namingAnomalies.length === 0,
  };
}

/**
 * Invariants de conservation des comptes et de sûreté (story 4.3), rejoués indépendamment (pas de court-circuit).
 * `scope` : médias de l'export (analyse source) ; `occupied` : inventaire actuel du bucket dédié utilisé pour les
 * destinations occupées.
 */
export function checkArchivePlanInvariants(
  plan: Pick<TakeoutArchivePlan, 'lines'>,
  scope: readonly Pick<AnalyzedMedia, 'part' | 'path'>[],
  occupied: ArchivedObjectSnapshot[],
): string[] {
  const { lines } = plan;
  const violations: string[] = [];

  // 1. Total des lignes = médias de l'export.
  if (lines.length !== scope.length) {
    violations.push(`total des lignes du plan (${lines.length}) différent du nombre de médias de l'export (${scope.length})`);
  }

  // 2. Chaque média présent exactement une fois.
  const occurrences = new Map<string, number>();
  for (const l of lines) occurrences.set(locationKey(l), (occurrences.get(locationKey(l)) ?? 0) + 1);
  for (const [key, count] of occurrences) if (count > 1) violations.push(`média présent ${count} fois dans le plan : ${key}`);
  const scopeSet = new Set(scope.map(locationKey));
  for (const key of scopeSet) if (!occurrences.has(key)) violations.push(`média de l'export absent du plan : ${key}`);
  for (const key of occurrences.keys()) if (!scopeSet.has(key)) violations.push(`média hors de l'export présent dans le plan : ${key}`);

  // 3. Somme des actions = total des lignes.
  const counted = TAKEOUT_PLAN_ACTIONS.reduce((total, action) => total + lines.filter((l) => l.action === action).length, 0);
  if (counted !== lines.length) violations.push(`somme des actions (${counted}) différente du total des lignes (${lines.length})`);

  // 4. Aucune destination attribuée deux fois (NFC, sans casse) ; 5. destinations dans les racines attendues ;
  // 7. destination ≤ MAX_KEY_BYTES octets.
  const assigned = new Map<string, string>();
  const byLocation = new Map(lines.map((l) => [locationKey(l), l]));
  const occupiedObjects = new Map<string, { etag: string | null; size: number }[]>();
  for (const o of occupied) {
    const key = comparableName(o.folder + o.name);
    occupiedObjects.set(key, [...(occupiedObjects.get(key) ?? []), { etag: normalizeEtag(o.etag), size: o.size }]);
  }
  for (const l of lines) {
    const key = locationKey(l);
    const roots = EXPECTED_ROOTS[l.action];
    if (!roots) {
      violations.push(`${key} : action inconnue « ${l.action} »`);
      continue;
    }
    if (l.action === 'ignorer_doublon_interne') {
      if (l.destination !== null) violations.push(`doublon interne avec une destination : ${key}`);
      const kept = l.keptOf === null ? undefined : byLocation.get(locationKey(l.keptOf));
      const KEPT_ACTIONS: ReadonlySet<TakeoutPlanAction> = new Set(['envoyer', 'reclasser_quarantaine', 'ignorer_deja_archive']);
      if (!kept || kept.action === 'ignorer_doublon_interne' || kept.destination === null) {
        violations.push(`doublon interne ${key} : le représentant « ${l.keptOf ? locationKey(l.keptOf) : 'absent'} » n'a pas de destination`);
      } else if (!KEPT_ACTIONS.has(kept.action)) {
        violations.push(
          `doublon interne ${key} : le représentant « ${locationKey(l.keptOf!)} » n'a pas l'action envoyer/reclasser_quarantaine/ignorer_deja_archive`,
        );
      } else if (kept.md5 !== l.md5 || kept.size !== l.size) {
        violations.push(`doublon interne ${key} : MD5 ou taille différents du représentant « ${locationKey(l.keptOf!)} »`);
      }
      continue;
    }
    if (l.destination === null) {
      if (l.action !== 'envoyer' && l.action !== 'quarantaine' && l.action !== 'reclasser_quarantaine') {
        violations.push(`${key} (${l.action}) : aucune destination`);
      }
      continue; // anomalie de désambiguïsation déjà signalée par ailleurs (namingAnomalies)
    }
    if (Buffer.byteLength(l.destination, 'utf8') > MAX_KEY_BYTES) {
      violations.push(`${key} : destination de plus de ${MAX_KEY_BYTES} octets (limite des clés S3) : ${l.destination}`);
    }
    if (!roots.some((root) => l.destination!.startsWith(root))) {
      violations.push(`${key} (${l.action}) : destination hors de ${roots.join(' ou ')} (${l.destination})`);
    }
    const comparable = comparableName(l.destination);
    const previous = assigned.get(comparable);
    if (previous !== undefined) violations.push(`destination ${l.destination} attribuée deux fois (${previous}, ${key})`);
    else assigned.set(comparable, key);

    // 6. Toute ligne ignorée pointe vers un objet archivé existant, de même contenu prouvé (MD5 OU ETag multipart —
    // jamais l'un comparé à l'autre : `l.archivedEtag` porte la preuve telle que vue par l'analyse, sous sa forme
    // d'origine). Correction (revue en exécution réelle du 2026-09-26) : comparer `l.md5` à l'ETag archivé rejetait à
    // tort les 112 médias confirmés uniquement par recalcul d'ETag multipart (`archive_proof = 'etag_multipart'`).
    if (l.action === 'ignorer_deja_archive') {
      const present = occupiedObjects.get(comparable);
      if (l.archivedEtag === null) {
        violations.push(`${key} déclaré déjà archivé sous ${l.destination}, mais aucune preuve (MD5 ou ETag multipart) n'a été enregistrée par l'analyse`);
      } else if (present === undefined) {
        // L'analyse et le plan filtrent tous deux par `archivedScope` sur le même bucket, et le plan exige un
        // inventaire courant au moins aussi récent que celui de l'analyse (`readArchivePlanInput`) : un objet déclaré
        // déjà archivé qui n'apparaît plus dans `occupied` a disparu du bucket dédié depuis l'analyse (supprimé ou
        // déplacé hors des racines archivées), pas seulement changé d'inventaire. Une ligne ignorée dont l'objet a
        // disparu ne doit jamais passer silencieusement : elle ne sera ni renvoyée (exclue de `linesToSend`) ni
        // signalée à l'exécution (aucun HEAD n'y est fait pour une ligne ignorée) — la photo serait perdue au premier
        // nettoyage des zips locaux (story 4.3, revue bloquante).
        violations.push(
          `${key} déclaré déjà archivé sous ${l.destination}, mais cet objet est introuvable dans l'inventaire courant du bucket dédié : ` +
            'relancez gpb takeout analyser',
        );
      } else if (!present.some((o) => o.etag === l.archivedEtag && o.size === l.size)) {
        const found = present.map((o) => `etag ${o.etag ?? 'absent'}, ${o.size} octets`).join(' ; ');
        violations.push(
          `${key} déclaré déjà archivé sous ${l.destination} avec la preuve MD5 ou ETag multipart ${l.archivedEtag} (${l.size} octets), ` +
            `mais l'objet présent a changé depuis l'analyse (trouvé : ${found}) : relancez gpb takeout analyser`,
        );
      }
    }
  }

  return violations;
}

/** Empreinte SHA-256 du contenu du plan (sans horodatage de génération) : même contenu, même empreinte. */
export function archivePlanFingerprint(content: Omit<TakeoutArchivePlan, 'id' | 'executable'>): string {
  const canonical = {
    exportId: content.exportId,
    destinationBucket: content.destinationBucket,
    keptAlbums: content.keptAlbums,
    analysisAnalyzedAt: content.analysisAnalyzedAt,
    destinationInventoryCompletedAt: content.destinationInventoryCompletedAt,
    lines: content.lines.map((l) => [
      l.part,
      l.path,
      l.folder,
      l.fileName,
      l.size,
      l.md5,
      l.dateSource,
      l.action,
      l.destination,
      l.keptOf ? [l.keptOf.part, l.keptOf.path] : null,
      l.archivedEtag,
      l.reason,
    ]),
    namingAnomalies: content.namingAnomalies.map((a) => [a.id, a.destination, a.reason]),
    violations: content.violations,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Fraîcheur d'un plan enregistré : raisons de ne pas l'exécuter, vide s'il est utilisable. Un plan est périmé si
 * l'analyse source ou l'inventaire du bucket dédié utilisé pour les destinations occupées ont changé depuis sa
 * génération, ou si la dernière génération a été refusée.
 */
export function assessArchivePlanFreshness(
  plan: TakeoutArchivePlan,
  current: { analysisAnalyzedAt: string; destinationInventoryCompletedAt: string | null; keptAlbums: string[] },
  lastRefusal: ArchivePlanRefusal | null,
): string[] {
  const reasons: string[] = [];
  if (plan.analysisAnalyzedAt !== current.analysisAnalyzedAt) {
    reasons.push(
      `plan périmé : l'analyse source a changé depuis sa génération (${plan.analysisAnalyzedAt} → ${current.analysisAnalyzedAt}) : relancez gpb takeout planifier`,
    );
  }
  if (plan.destinationInventoryCompletedAt !== current.destinationInventoryCompletedAt) {
    reasons.push(
      `plan périmé : l'inventaire du bucket dédié utilisé a changé depuis la génération (${plan.destinationInventoryCompletedAt ?? '—'} → ` +
        `${current.destinationInventoryCompletedAt ?? '—'}) : relancez gpb takeout planifier`,
    );
  }
  const normalizedCurrent = normalizedKeptAlbums(current.keptAlbums);
  if (JSON.stringify(plan.keptAlbums) !== JSON.stringify(normalizedCurrent)) {
    reasons.push('plan périmé : les albums conservés (takeout.keptAlbums) ont changé depuis la génération : relancez gpb takeout planifier');
  }
  if (lastRefusal) {
    reasons.push(`la dernière génération a été refusée le ${lastRefusal.refusedAt.toISOString()} : ${lastRefusal.reason}`);
  }
  return reasons;
}

/**
 * Contrôles du contenu d'un plan relu de la base, sans lui faire confiance : cohérence avec son empreinte,
 * exécutabilité recalculée, invariants rejoués sur les lignes relues avec le périmètre `media` actuel et les
 * destinations occupées `occupied`. Partagé par la vérification avant exécution et par un futur rapport (4.5). Pure.
 */
export function storedArchivePlanProblems(
  plan: TakeoutArchivePlan,
  media: readonly Pick<AnalyzedMedia, 'part' | 'path'>[],
  occupied: ArchivedObjectSnapshot[],
): string[] {
  const reasons: string[] = [];
  if (archivePlanFingerprint(plan) !== plan.id) reasons.push('contenu du plan stocké incohérent avec son empreinte');
  if (!plan.executable || plan.violations.length > 0) {
    reasons.push(`plan stocké marqué non exécutable (${plan.violations.length} invariant(s) en échec enregistré(s))`);
  }
  if (plan.namingAnomalies.length > 0) reasons.push(`${plan.namingAnomalies.length} anomalie(s) de nommage dans le plan stocké`);
  for (const violation of checkArchivePlanInvariants(plan, media, occupied)) {
    reasons.push(`invariant en échec sur le plan stocké : ${violation}`);
  }
  return reasons;
}

/**
 * Vérification complète d'un plan relu de la base avant toute exécution (story 4.3) : raisons de refuser, vide si le
 * plan peut être exécuté. Ne fait confiance à rien de stocké : fraîcheur, cohérence du contenu avec son empreinte,
 * exécutabilité recalculée, invariants rejoués, et recalcul du plan depuis l'entrée actuelle, dont l'empreinte doit
 * être identique. Pure.
 */
export function verifyStoredArchivePlan(plan: TakeoutArchivePlan, current: TakeoutPlanInput, lastRefusal: ArchivePlanRefusal | null): string[] {
  const reasons = [
    ...assessArchivePlanFreshness(
      plan,
      { analysisAnalyzedAt: current.analysisAnalyzedAt, destinationInventoryCompletedAt: current.destinationInventoryCompletedAt, keptAlbums: current.keptAlbums },
      lastRefusal,
    ),
    ...storedArchivePlanProblems(plan, current.media, current.occupied),
  ];
  try {
    if (buildArchivePlan(current).id !== plan.id) {
      reasons.push('l\'empreinte du plan recalculé depuis l\'entrée actuelle diffère de celle du plan stocké');
    }
  } catch (error) {
    if (!(error instanceof ArchivePlanRefusedError)) throw error;
    reasons.push(`le recalcul du plan depuis l'entrée actuelle est refusé : ${error.message}`);
  }
  return reasons;
}
