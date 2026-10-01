import * as path from 'path';
import { BucketObject } from '../clients/types';
import { formatNumber } from '../utils/format';
import { etagKind, normalizeEtag } from './duplicates';
import {
  ExecutionState,
  ExecutionStop,
  isDone,
  isSameAsSource,
  isVerifiedCopy,
  JournalEntry,
  linesToWrite,
  summarizeExecution,
  VolumeCount,
} from './plan-execution';
import {
  ALBUMS_ROOT,
  assessPlanFreshness,
  CHRONO_ROOT,
  csvDocument,
  normalizePlanConfig,
  objectsInScope,
  occupiedFrom,
  PlanAction,
  PlanInput,
  PlanRefusal,
  QUARANTINE_ROOT,
  RepairPlan,
  storedContentProblems,
  summarizePlan,
} from './repair-plan';

/**
 * Rapport de réparation (story 3.3). Calcul pur depuis le plan courant, son journal d'exécution, l'inventaire source et,
 * sur demande, l'inventaire du bucket dédié : aucune requête réseau, aucune écriture, aucune suppression.
 *
 * Deux niveaux :
 * - rapport du journal : ce que l'exécution dit avoir fait, rapproché du plan ;
 * - vérification de l'arrivée : ce que le bucket dédié contient réellement, d'après un inventaire (listing en lecture
 *   seule, `gpb inventory scan --bucket <dédié>`) terminé après la fin de l'exécution.
 *
 * L'attestation (rappel que la suppression des anciens emplacements appartient à Marceau, et liste de ces emplacements)
 * n'est accordée que si toutes les conditions de `attestationReasons` sont réunies.
 */

/** Relevé du PRD (2026-08-04) : objets sous les deux emplacements historiques. */
export const PRD_START_COUNT = 12_736;

/** Garantie citée (et non mesurée) par la contre-métrique « objets supprimés par l'outil dans le bucket source ». */
export const DELETION_GUARANTEE =
  'garanti par construction : toute écriture passe par le point d\'accès unique src/clients/archive-writer.ts, qui ' +
  'n\'expose que la copie serveur et la lecture de métadonnées vers le bucket dédié ; aucune suppression n\'existe dans le ' +
  'code (analyse statique tests/clients/archive-writer.test.ts)';

/**
 * Âge maximal, en heures, des inventaires source et dédié au moment du rapport pour attester. Au-delà, les buckets ont pu
 * changer depuis leur listing : l'attestation ne vaut que pour un état récent, et la suppression doit suivre sans attendre.
 */
export const MAX_INVENTORY_AGE_HOURS = 24;

export type ExecutionStatus = 'non_executee' | 'complete' | 'incomplete' | 'bloquee';
export type ArrivalStatus = 'conforme' | 'manquant' | 'non_conforme';

export interface JournalReport {
  status: ExecutionStatus;
  expectedCopies: VolumeCount; // lignes `copier`
  expectedQuarantine: VolumeCount; // lignes `quarantaine`
  copied: VolumeCount; // `copie`
  alreadyPresent: VolumeCount; // `deja_present`
  failed: VolumeCount; // `echec`
  inProgress: VolumeCount; // `copie_en_cours`
  notStarted: VolumeCount; // `a_faire` ou absentes du journal
  failures: ExecutionStop[];
  duplicates: VolumeCount; // doublons écartés : leur volume est l'espace économisé
  alreadyArchived: VolumeCount; // `ignorer_deja_archive` : déjà dans le bucket dédié avant l'exécution
}

export interface ArrivalCheck {
  sourceKey: string;
  action: PlanAction;
  destination: string;
  status: ArrivalStatus;
  detail: string | null;
}

export interface VerificationReport {
  inventoryCompletedAt: Date;
  inventoryObjectCount: number;
  afterExecution: boolean; // inventaire terminé après la dernière écriture du journal
  conforming: number;
  missing: ArrivalCheck[];
  nonConforming: ArrivalCheck[];
  checks: ArrivalCheck[];
  unexpected: string[]; // objets sous photos/, albums/, quarantaine/ non prévus par le plan (avertissement)
  sizeOnlyCopies: number; // lignes journalisées `copie` à source multipart, conformes sur la taille seule
}

/** Objet du bucket source tel qu'inventorié (ETag normalisé). */
export interface SourceObjectState {
  key: string;
  size: number;
  etag: string | null;
}

/** Écarts entre le nouvel inventaire source (sous les préfixes du plan) et l'instantané du plan. */
export interface SourceDiff {
  added: SourceObjectState[];
  removed: SourceObjectState[];
  modified: { key: string; before: SourceObjectState; after: SourceObjectState }[];
}

export interface DeletionLocation {
  bucket: string;
  prefix: string;
  count: number;
  size: number;
  topFolder: string | null; // dossier de premier niveau, s'il diffère du préfixe
  otherCount: number; // objets du dossier de premier niveau hors du préfixe : à NE PAS supprimer
  otherSize: number;
  exclusions: { sourceKey: string; reason: string }[]; // non archivées, supprimées avec ce dossier
}

export interface CounterMetrics {
  scopeCount: number; // objets sous les préfixes source, inventaire source actuel
  prdStartCount: number;
  mediaCount: number; // lignes du plan
  duplicates: number;
  exclusions: number;
  unrecognized: number;
  expectedArrivals: number; // médias − doublons
  arrivals: number;
  arrivalsFrom: 'journal' | 'verification';
  quarantine: VolumeCount;
  deletedByTool: 0;
  deletionGuarantee: string;
}

export interface ReportRow {
  sourceKey: string;
  action: PlanAction | 'exclu' | 'non_reconnu';
  size: number;
  destination: string | null;
  journalState: ExecutionState | null;
  arrival: ArrivalStatus | null;
  detail: string | null;
}

export interface RepairReport {
  planId: string;
  sourceBucket: string;
  destinationBucket: string;
  executionEnd: Date | null;
  lockHeld: boolean;
  otherJournaledPlans: string[];
  sourceProblems: string[];
  sourceInventoryCompletedAt: Date | null;
  sourceAfterExecution: boolean; // inventaire source terminé après la dernière écriture du journal
  sourceDiff: SourceDiff;
  inventoryAgesHours: { source: number | null; destination: number | null };
  deletionKeys: SourceObjectState[]; // clés exactes du nouvel inventaire source sous les préfixes (export si attesté)
  journal: JournalReport;
  verificationRequested: boolean;
  verification: VerificationReport | null; // null : non demandée, ou aucun inventaire du bucket dédié
  counterMetrics: CounterMetrics;
  anomalies: string[];
  warnings: string[];
  exclusions: { sourceKey: string; size: number; reason: string }[];
  quarantine: { sourceKey: string; destination: string; size: number }[];
  locations: DeletionLocation[];
  rows: ReportRow[];
  attestation: { granted: boolean; reasons: string[] };
}

export interface ReportInput {
  plan: RepairPlan;
  states: Map<string, JournalEntry>;
  executionEnd: Date | null; // dernière écriture du journal de ce plan
  lockHeld: boolean;
  journaledPlanIds: string[];
  sourceObjects: BucketObject[]; // inventaire source actuel
  sourceProblems: string[]; // `sourceFreshnessProblems`
  sourceInventoryCompletedAt: Date | null;
  verificationRequested: boolean;
  destinationInventory: { completedAt: Date; objects: BucketObject[] } | null;
  now: Date; // heure du rapport (âge des inventaires)
}

const volume = (): VolumeCount => ({ count: 0, size: 0 });
const add = (v: VolumeCount, size: number): void => {
  v.count++;
  v.size += size;
};

/** Inventaire terminé strictement après la fin de l'exécution. */
export const completedAfter = (completedAt: Date | null, executionEnd: Date | null): boolean =>
  completedAt !== null && executionEnd !== null && completedAt > executionEnd;

/**
 * Fraîcheur du plan exécuté, côté source et configuration : raisons de ne pas attester, vide si le plan est cohérent avec
 * l'index actuel. L'exécution change le bucket dédié, et son nouvel inventaire rendrait le plan « périmé » pour
 * `verifyStoredPlan` (tampon d'inventaire dédié, destinations désormais occupées, recalcul en « déjà archivé »). Ici :
 * - le tampon d'inventaire dédié est neutralisé (celui du plan) ;
 * - le tampon d'inventaire source est neutralisé seulement si cet inventaire a été refait après la fin de l'exécution
 *   (`executionEnd`) : c'est ce nouvel inventaire, exigé pour attester, qui est comparé objet par objet à l'instantané du
 *   plan (`compareSourceSnapshot`). Configuration, datations et dernier refus restent vérifiés par `assessPlanFreshness` ;
 * - les invariants sont rejoués sur les lignes relues avec, pour destinations occupées, celles que le plan a déclarées
 *   déjà archivées (l'état du bucket dédié au moment du plan) ;
 * - le recalcul complet n'est pas refait : il dépend de l'inventaire dédié d'avant exécution, qui n'existe plus. Tampons
 *   source et datations identiques, configuration identique et contenu cohérent avec l'empreinte suffisent.
 */
export function sourceFreshnessProblems(
  plan: RepairPlan,
  current: PlanInput,
  lastRefusal: PlanRefusal | null,
  executionEnd: Date | null,
): string[] {
  const rescanned = completedAfter(new Date(current.index.sourceInventory.completedAt), executionEnd);
  const index = {
    ...current.index,
    destinationInventory: plan.index.destinationInventory,
    sourceInventory: rescanned ? plan.index.sourceInventory : current.index.sourceInventory,
  };
  const archivedAtPlan = occupiedFrom(
    plan.lines
      .filter((l) => l.action === 'ignorer_deja_archive' && l.destination !== null)
      .map((l) => ({ key: l.destination!, size: l.size, etag: l.etag, lastModified: null })),
  );
  return [
    ...assessPlanFreshness(plan, index, normalizePlanConfig(current), lastRefusal),
    ...storedContentProblems(plan, current.objects, archivedAtPlan),
  ];
}

/** Rapport du journal : états rapprochés des lignes du plan. */
export function journalReport(plan: RepairPlan, states: Map<string, JournalEntry>): JournalReport {
  const overview = summarizeExecution(plan, states);
  const summary = summarizePlan(plan);
  const copied = volume();
  const alreadyPresent = volume();
  const lines = linesToWrite(plan);
  for (const l of lines) {
    if (!isDone(l, states)) continue;
    add(states.get(l.sourceKey)!.state === 'copie' ? copied : alreadyPresent, l.size);
  }
  const doneCount = copied.count + alreadyPresent.count;
  const status: ExecutionStatus =
    states.size === 0 ? 'non_executee' : doneCount === lines.length ? 'complete' : overview.failed.count > 0 ? 'bloquee' : 'incomplete';
  return {
    status,
    expectedCopies: overview.copier,
    expectedQuarantine: overview.quarantaine,
    copied,
    alreadyPresent,
    failed: overview.failed,
    inProgress: overview.inProgress,
    notStarted: overview.notStarted,
    failures: overview.failures,
    duplicates: { ...summary.byAction.ignorer_doublon },
    alreadyArchived: { ...summary.byAction.ignorer_deja_archive },
  };
}

/** Lignes attendues dans le bucket dédié : copies, quarantaine et déjà archivés. */
const arrivalLines = (plan: RepairPlan): (RepairPlan['lines'][number] & { destination: string })[] =>
  plan.lines.filter((l): l is RepairPlan['lines'][number] & { destination: string } => l.action !== 'ignorer_doublon' && l.destination !== null);

/**
 * Vérification de l'arrivée sur un inventaire du bucket dédié : pour chaque ligne attendue, objet présent à la clé exacte
 * (sans normalisation), puis :
 * - ligne journalisée `copie` (copie faite par l'outil, conditionnée à l'ETag source) : `isVerifiedCopy` — taille, et ETag
 *   si la source a un MD5 simple (taille seule si multipart, l'ETag d'une copie multipart étant inconnu) ;
 * - ligne `deja_present`, déjà archivée, ou non copiée par l'outil : `isSameAsSource` — taille ET ETag, multipart compris.
 */
export function verifyArrival(plan: RepairPlan, destinationObjects: BucketObject[], states: Map<string, JournalEntry>): ArrivalCheck[] {
  const byKey = new Map(destinationObjects.map((o) => [o.key, o]));
  return arrivalLines(plan).map((l) => {
    const base = { sourceKey: l.sourceKey, action: l.action, destination: l.destination };
    const found = byKey.get(l.destination);
    if (!found) return { ...base, status: 'manquant', detail: 'absent du bucket dédié' };
    const copiedByTool = l.action !== 'ignorer_deja_archive' && states.get(l.sourceKey)?.state === 'copie';
    if (copiedByTool ? isVerifiedCopy(l, found) : isSameAsSource(l, found)) return { ...base, status: 'conforme', detail: null };
    const detail =
      found.size !== l.size
        ? `taille ${found.size} octets au lieu de ${l.size}`
        : `ETag ${normalizeEtag(found.etag) ?? 'absent'} au lieu de ${normalizeEtag(l.etag) ?? 'absent'}` +
          (copiedByTool ? ' (MD5 source)' : ' (objet non copié par l\'outil : taille et ETag exigés)');
    return { ...base, status: 'non_conforme', detail };
  });
}

/** Objets du bucket dédié sous `photos/`, `albums/`, `quarantaine/` qu'aucune ligne du plan n'y attend. */
export function unexpectedDestinationObjects(plan: RepairPlan, destinationObjects: BucketObject[]): string[] {
  const expected = new Set(arrivalLines(plan).map((l) => l.destination));
  return destinationObjects
    .filter((o) => [CHRONO_ROOT, ALBUMS_ROOT, QUARANTINE_ROOT].some((root) => o.key.startsWith(root)) && !expected.has(o.key))
    .map((o) => o.key);
}

const stateOf = (o: { size: number; etag: string | null }, key: string): SourceObjectState => ({ key, size: o.size, etag: normalizeEtag(o.etag) });

/**
 * Compare les objets de l'inventaire source sous les préfixes du plan à l'instantané du plan (lignes, exclusions, non
 * reconnus) : clé exacte, taille, ETag normalisé, comparaison stricte (multipart compris). Tout écart est un objet que le
 * plan n'a pas archivé tel qu'il est aujourd'hui.
 */
export function compareSourceSnapshot(plan: RepairPlan, sourceObjects: BucketObject[]): SourceDiff {
  const snapshot = new Map([...plan.lines, ...plan.exclusions, ...plan.unrecognized].map((o) => [o.sourceKey, stateOf(o, o.sourceKey)]));
  const current = objectsInScope(sourceObjects, plan.config.sourcePrefixes).map((o) => stateOf(o, o.key));
  const currentKeys = new Set(current.map((o) => o.key));
  const diff: SourceDiff = { added: [], removed: [], modified: [] };
  for (const after of current) {
    const before = snapshot.get(after.key);
    if (!before) diff.added.push(after);
    else if (before.size !== after.size || before.etag !== after.etag) diff.modified.push({ key: after.key, before, after });
  }
  for (const [key, before] of snapshot) if (!currentKeys.has(key)) diff.removed.push(before);
  return diff;
}

/** Emplacements historiques à supprimer par Marceau : chaque préfixe source, et ce que son dossier de premier niveau contient d'autre. */
export function deletionLocations(plan: RepairPlan, sourceObjects: BucketObject[]): DeletionLocation[] {
  return plan.config.sourcePrefixes.map((prefix) => {
    const inPrefix = objectsInScope(sourceObjects, [prefix]);
    const top = `${prefix.split('/')[0]}/`;
    const others = top === prefix ? [] : objectsInScope(sourceObjects, [top]).filter((o) => !o.key.startsWith(prefix));
    const sum = (objects: BucketObject[]): number => objects.reduce((total, o) => total + o.size, 0);
    return {
      bucket: plan.config.sourceBucket,
      prefix,
      count: inPrefix.length,
      size: sum(inPrefix),
      topFolder: top === prefix ? null : top,
      otherCount: others.length,
      otherSize: sum(others),
      exclusions: plan.exclusions.filter((e) => e.sourceKey.startsWith(prefix)).map((e) => ({ sourceKey: e.sourceKey, reason: e.reason })),
    };
  });
}

/** Incohérences du journal avec le plan : ligne inconnue, ou destination différente de celle du plan. */
function journalAnomalies(plan: RepairPlan, states: Map<string, JournalEntry>): string[] {
  const lines = new Map(linesToWrite(plan).map((l) => [l.sourceKey, l]));
  const anomalies: string[] = [];
  for (const [sourceKey, entry] of states) {
    const line = lines.get(sourceKey);
    if (!line) anomalies.push(`journal : ligne ${sourceKey} (${entry.state}) absente des lignes à écrire du plan`);
    else if (line.destination !== entry.destination) {
      anomalies.push(`journal : ${sourceKey} journalisé vers ${entry.destination} au lieu de ${line.destination}`);
    }
  }
  return anomalies;
}

/** Raison de refuser un inventaire daté dans le futur ou de plus de `MAX_INVENTORY_AGE_HOURS`, `null` s'il est assez récent. */
export function inventoryAgeReason(label: string, hours: number | null, scan: string): string | null {
  if (hours === null) return null;
  if (hours < 0) return `inventaire ${label} daté dans le futur (${(-hours).toFixed(1)} h) : horloge à vérifier, relancez « ${scan} »`;
  if (hours > MAX_INVENTORY_AGE_HOURS) return `inventaire ${label} vieux de ${hours.toFixed(1)} h (plus de ${MAX_INVENTORY_AGE_HOURS} h) : relancez « ${scan} »`;
  return null;
}

/** Raisons de refuser l'attestation, vide si elle est accordée. */
export function attestationReasons(report: Omit<RepairReport, 'attestation'>): string[] {
  const reasons: string[] = [];
  const { journal, verification, destinationBucket } = report;
  const scan = `gpb inventory scan --bucket ${destinationBucket}`;
  if (journal.status === 'non_executee') {
    const others = report.otherJournaledPlans.length > 0 ? ` (journal d'un autre plan : ${report.otherJournaledPlans.map((id) => id.slice(0, 12)).join(', ')})` : '';
    reasons.push(`aucune exécution journalisée pour le plan courant ${report.planId.slice(0, 12)}${others}`);
  } else if (journal.status !== 'complete') {
    reasons.push(
      `exécution ${journal.status === 'bloquee' ? 'bloquée' : 'incomplète'} : ${journal.notStarted.count} à faire, ` +
        `${journal.inProgress.count} copie(s) en cours, ${journal.failed.count} en échec`,
    );
  }
  if (report.lockHeld) reasons.push('un verrou d\'exécution est présent : une exécution est peut-être en cours');
  for (const problem of report.sourceProblems) reasons.push(`plan exécuté non vérifiable contre l'index source : ${problem}`);
  const sourceScan = `gpb inventory scan --bucket ${report.sourceBucket}`;
  if (!report.sourceAfterExecution) {
    reasons.push(
      `inventaire du bucket source « ${report.sourceBucket} » ${report.sourceInventoryCompletedAt ? `du ${report.sourceInventoryCompletedAt.toISOString()} ` : ''}` +
        `non postérieur à la fin de l'exécution (${report.executionEnd?.toISOString() ?? 'aucune'}) : lancez « ${sourceScan} »`,
    );
  }
  const { added, removed, modified } = report.sourceDiff;
  if (added.length + removed.length + modified.length > 0) {
    reasons.push(
      `bucket source différent de l'instantané du plan sous ses préfixes : ${formatNumber(added.length)} ajouté(s), ` +
        `${formatNumber(removed.length)} retiré(s), ${formatNumber(modified.length)} modifié(s) — non archivés tels quels`,
    );
  }
  for (const reason of [
    inventoryAgeReason('du bucket source', report.inventoryAgesHours.source, sourceScan),
    inventoryAgeReason('du bucket dédié', report.inventoryAgesHours.destination, scan),
  ]) {
    if (reason !== null) reasons.push(reason);
  }
  if (!report.verificationRequested) reasons.push('vérification de l\'arrivée non faite (option --verifier)');
  else if (!verification) reasons.push(`aucun inventaire du bucket dédié « ${destinationBucket} » : lancez « ${scan} »`);
  else {
    if (!verification.afterExecution) {
      reasons.push(
        `inventaire du bucket dédié du ${verification.inventoryCompletedAt.toISOString()} antérieur à la fin de l'exécution ` +
          `(${report.executionEnd?.toISOString() ?? 'aucune'}) : relancez « ${scan} »`,
      );
    }
    if (verification.missing.length > 0) reasons.push(`${formatNumber(verification.missing.length)} objet(s) manquant(s) dans le bucket dédié`);
    if (verification.nonConforming.length > 0) reasons.push(`${formatNumber(verification.nonConforming.length)} objet(s) non conforme(s) dans le bucket dédié`);
  }
  for (const anomaly of report.anomalies) reasons.push(`anomalie : ${anomaly}`);
  return reasons;
}

export const ageHours = (completedAt: Date | null, now: Date): number | null =>
  completedAt === null ? null : (now.getTime() - completedAt.getTime()) / 3_600_000;

/** Rapport complet et attestation. Pur. */
export function buildRepairReport(input: ReportInput): RepairReport {
  const { plan, states } = input;
  const journal = journalReport(plan, states);

  let verification: VerificationReport | null = null;
  if (input.verificationRequested && input.destinationInventory) {
    const checks = verifyArrival(plan, input.destinationInventory.objects, states);
    const etagByKey = new Map(plan.lines.map((l) => [l.sourceKey, l.etag]));
    const { completedAt } = input.destinationInventory;
    verification = {
      inventoryCompletedAt: completedAt,
      inventoryObjectCount: input.destinationInventory.objects.length,
      afterExecution: input.executionEnd !== null && completedAt > input.executionEnd,
      conforming: checks.filter((c) => c.status === 'conforme').length,
      missing: checks.filter((c) => c.status === 'manquant'),
      nonConforming: checks.filter((c) => c.status === 'non_conforme'),
      checks,
      unexpected: unexpectedDestinationObjects(plan, input.destinationInventory.objects),
      sizeOnlyCopies: checks.filter(
        (c) => c.status === 'conforme' && c.action !== 'ignorer_deja_archive' && states.get(c.sourceKey)?.state === 'copie' &&
          etagKind(etagByKey.get(c.sourceKey) ?? null) !== 'md5',
      ).length,
    };
  }

  // Arrivées : constatées par la vérification si elle est à jour, sinon déclarées par le journal.
  const verified = verification !== null && verification.afterExecution;
  const arrivals = verified
    ? verification!.conforming
    : journal.copied.count + journal.alreadyPresent.count + journal.alreadyArchived.count;
  const scopeCount = objectsInScope(input.sourceObjects, plan.config.sourcePrefixes).length;
  const quarantine = arrivalLines(plan).filter((l) => l.action === 'quarantaine');
  const counterMetrics: CounterMetrics = {
    scopeCount,
    prdStartCount: PRD_START_COUNT,
    mediaCount: plan.lines.length,
    duplicates: journal.duplicates.count,
    exclusions: plan.exclusions.length,
    unrecognized: plan.unrecognized.length,
    expectedArrivals: plan.lines.length - journal.duplicates.count,
    arrivals,
    arrivalsFrom: verified ? 'verification' : 'journal',
    quarantine: journal.expectedQuarantine,
    deletedByTool: 0,
    deletionGuarantee: DELETION_GUARANTEE,
  };

  const anomalies = journalAnomalies(plan, states);
  const m = counterMetrics;
  if (m.arrivals + m.duplicates !== m.mediaCount) {
    anomalies.push(
      `conservation des comptes : ${formatNumber(m.arrivals)} objet(s) à l'arrivée (${verified ? 'vérifiés' : 'd\'après le journal'}) + ` +
        `${formatNumber(m.duplicates)} doublon(s) écarté(s) = ${formatNumber(m.arrivals + m.duplicates)} ≠ ${formatNumber(m.mediaCount)} ` +
        `médias inventoriés (écart : ${formatNumber(m.mediaCount - m.arrivals - m.duplicates)})`,
    );
  }
  if (m.mediaCount + m.exclusions + m.unrecognized !== m.scopeCount) {
    anomalies.push(
      `conservation des comptes : ${formatNumber(m.mediaCount)} médias + ${formatNumber(m.exclusions)} exclusion(s) + ` +
        `${formatNumber(m.unrecognized)} non reconnu(s) ≠ ${formatNumber(m.scopeCount)} objets sous les préfixes source dans l'inventaire source`,
    );
  }
  const warnings: string[] = [];
  if (verification && verification.unexpected.length > 0) {
    warnings.push(
      `${formatNumber(verification.unexpected.length)} objet(s) du bucket dédié sous photos/, albums/ ou quarantaine/ non prévu(s) ` +
        'par le plan (non bloquant, à examiner)',
    );
  }
  if (scopeCount !== PRD_START_COUNT) {
    warnings.push(
      `${formatNumber(scopeCount)} objets sous les préfixes source, contre ${formatNumber(PRD_START_COUNT)} au relevé du PRD (2026-08-04) : écart à expliquer ` +
        '(bucket source modifié depuis le relevé ?)',
    );
  }

  const checksByKey = new Map((verification?.checks ?? []).map((c) => [c.sourceKey, c]));
  const writeKeys = new Set(linesToWrite(plan).map((l) => l.sourceKey));
  const rows: ReportRow[] = [
    ...plan.lines.map((l): ReportRow => {
      const check = checksByKey.get(l.sourceKey);
      const entry = states.get(l.sourceKey);
      const journalState = writeKeys.has(l.sourceKey) ? (entry?.state ?? 'a_faire') : null;
      return {
        sourceKey: l.sourceKey,
        action: l.action,
        size: l.size,
        destination: l.destination,
        journalState,
        arrival: check?.status ?? null,
        detail: check?.detail ?? entry?.message ?? null,
      };
    }),
    ...plan.exclusions.map((e): ReportRow => ({ sourceKey: e.sourceKey, action: 'exclu', size: e.size, destination: null, journalState: null, arrival: null, detail: e.reason })),
    ...plan.unrecognized.map((u): ReportRow => ({ sourceKey: u.sourceKey, action: 'non_reconnu', size: u.size, destination: null, journalState: null, arrival: null, detail: u.extension })),
  ];

  const report: Omit<RepairReport, 'attestation'> = {
    planId: plan.id,
    sourceBucket: plan.config.sourceBucket,
    destinationBucket: plan.config.destinationBucket,
    executionEnd: input.executionEnd,
    lockHeld: input.lockHeld,
    otherJournaledPlans: input.journaledPlanIds.filter((id) => id !== plan.id),
    sourceProblems: input.sourceProblems,
    sourceInventoryCompletedAt: input.sourceInventoryCompletedAt,
    sourceAfterExecution: completedAfter(input.sourceInventoryCompletedAt, input.executionEnd),
    sourceDiff: compareSourceSnapshot(plan, input.sourceObjects),
    inventoryAgesHours: {
      source: ageHours(input.sourceInventoryCompletedAt, input.now),
      destination: verification ? ageHours(verification.inventoryCompletedAt, input.now) : null,
    },
    deletionKeys: objectsInScope(input.sourceObjects, plan.config.sourcePrefixes).map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
    journal,
    verificationRequested: input.verificationRequested,
    verification,
    counterMetrics,
    anomalies,
    warnings,
    exclusions: plan.exclusions.map((e) => ({ sourceKey: e.sourceKey, size: e.size, reason: e.reason })),
    quarantine: quarantine.map((l) => ({ sourceKey: l.sourceKey, destination: l.destination, size: l.size })),
    locations: deletionLocations(plan, input.sourceObjects),
    rows,
  };
  const reasons = attestationReasons(report);
  return { ...report, attestation: { granted: reasons.length === 0, reasons } };
}

const CSV_HEADER = ['type', 'cle_source', 'action', 'taille_octets', 'destination', 'etat_journal', 'verification_arrivee', 'detail'];

/** Rapport en CSV : une ligne par objet du périmètre, puis une ligne par anomalie et par raison de refus d'attestation. */
export function reportToCsv(report: RepairReport): string {
  return csvDocument(CSV_HEADER, [
    ...report.rows.map((r) => ['objet', r.sourceKey, r.action, r.size, r.destination, r.journalState, r.arrival, r.detail]),
    ...report.anomalies.map((a) => ['anomalie', null, null, null, null, null, null, a]),
    ...report.attestation.reasons.map((reason) => ['refus_attestation', null, null, null, null, null, null, reason]),
  ]);
}

/**
 * Liste exacte des clés à supprimer : objets du nouvel inventaire source sous les préfixes du plan. Refusée sans
 * attestation. Format : CSV « ; » avec BOM, une ligne d'en-tête, puis une ligne par clé ; chaque ligne porte aussi
 * l'empreinte du plan, la date de l'inventaire source et la date de génération (colonnes répétées plutôt que lignes de
 * commentaire : un tableur ou un script lit le fichier tel quel, et une ligne extraite garde son contexte).
 */
export function deletionKeysCsv(report: RepairReport, generatedAt: Date): string {
  if (!report.attestation.granted) throw new Error('liste de suppression refusée : la réparation n\'est pas attestée');
  const context = [report.planId, report.sourceInventoryCompletedAt?.toISOString() ?? null, generatedAt.toISOString()];
  return csvDocument(
    ['bucket', 'cle', 'taille_octets', 'etag', 'empreinte_plan', 'inventaire_source_du', 'genere_le'],
    report.deletionKeys.map((o) => [report.sourceBucket, o.key, o.size, o.etag, ...context]),
  );
}

const volumeJson = (v: VolumeCount): { nombre: number; octets: number } => ({ nombre: v.count, octets: v.size });
const checkJson = (c: ArrivalCheck): unknown => ({ cle_source: c.sourceKey, action: c.action, destination: c.destination, detail: c.detail });

/** Rapport complet en JSON, clés en français. */
export function reportToJson(report: RepairReport, generatedAt: Date): string {
  const { journal, verification, counterMetrics: m } = report;
  return (
    JSON.stringify(
      {
        rapport_genere_le: generatedAt.toISOString(),
        empreinte_plan: report.planId,
        bucket_source: report.sourceBucket,
        bucket_destination: report.destinationBucket,
        attestation: { accordee: report.attestation.granted, raisons_de_refus: report.attestation.reasons },
        anomalies: report.anomalies,
        avertissements: report.warnings,
        journal: {
          statut: journal.status,
          fin_execution: report.executionEnd?.toISOString() ?? null,
          verrou_present: report.lockHeld,
          autres_plans_journalises: report.otherJournaledPlans,
          attendus_copier: volumeJson(journal.expectedCopies),
          attendus_quarantaine: volumeJson(journal.expectedQuarantine),
          copie: volumeJson(journal.copied),
          deja_present: volumeJson(journal.alreadyPresent),
          echec: volumeJson(journal.failed),
          copie_en_cours: volumeJson(journal.inProgress),
          a_faire: volumeJson(journal.notStarted),
          lignes_en_echec: journal.failures.map((f) => ({ cle_source: f.sourceKey, destination: f.destination, raison: f.reason })),
          doublons_ecartes: volumeJson(journal.duplicates),
          espace_economise_octets: journal.duplicates.size,
          deja_archives: volumeJson(journal.alreadyArchived),
        },
        fraicheur_source: report.sourceProblems,
        inventaire_source: {
          termine_le: report.sourceInventoryCompletedAt?.toISOString() ?? null,
          posterieur_a_l_execution: report.sourceAfterExecution,
          age_heures: report.inventoryAgesHours.source,
          ecarts_avec_le_plan: {
            ajoutes: report.sourceDiff.added,
            retires: report.sourceDiff.removed,
            modifies: report.sourceDiff.modified.map((d) => ({ cle: d.key, avant: d.before, apres: d.after })),
          },
        },
        age_maximal_inventaires_heures: MAX_INVENTORY_AGE_HOURS,
        verification_arrivee: {
          demandee: report.verificationRequested,
          inventaire_destination:
            verification === null
              ? null
              : {
                  termine_le: verification.inventoryCompletedAt.toISOString(),
                  objets: verification.inventoryObjectCount,
                  posterieur_a_l_execution: verification.afterExecution,
                  age_heures: report.inventoryAgesHours.destination,
                },
          objets_non_prevus: verification?.unexpected ?? null,
          conformes: verification?.conforming ?? null,
          manquants: verification?.missing.map(checkJson) ?? null,
          non_conformes: verification?.nonConforming.map(checkJson) ?? null,
        },
        contre_metriques: {
          objets_perimetre_source: m.scopeCount,
          releve_prd: m.prdStartCount,
          medias_inventories: m.mediaCount,
          doublons_ecartes: m.duplicates,
          exclusions: m.exclusions,
          non_reconnus: m.unrecognized,
          arrivees_attendues: m.expectedArrivals,
          arrivees: m.arrivals,
          arrivees_selon: m.arrivalsFrom,
          quarantaine: volumeJson(m.quarantine),
          objets_supprimes_par_l_outil: m.deletedByTool,
          garantie_suppression: m.deletionGuarantee,
        },
        exclusions: report.exclusions.map((e) => ({ cle_source: e.sourceKey, taille_octets: e.size, raison: e.reason })),
        quarantaine: report.quarantine.map((q) => ({ cle_source: q.sourceKey, destination: q.destination, taille_octets: q.size })),
        emplacements_a_supprimer_par_marceau: report.attestation.granted
          ? report.locations.map((l) => ({
              bucket: l.bucket,
              prefixe: l.prefix,
              objets: l.count,
              octets: l.size,
              dossier_parent: l.topFolder,
              autres_objets_du_dossier_parent_a_ne_pas_supprimer: l.otherCount,
              exclusions_non_archivees_supprimees_avec_le_dossier: l.exclusions.map((e) => ({ cle_source: e.sourceKey, raison: e.reason })),
            }))
          : null,
        lignes: report.rows.map((r) => ({
          cle_source: r.sourceKey,
          action: r.action,
          taille_octets: r.size,
          destination: r.destination,
          etat_journal: r.journalState,
          verification_arrivee: r.arrival,
          detail: r.detail,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/** Contenu d'export selon l'extension (`.csv` ou `.json`). */
export function reportExport(report: RepairReport, fileName: string, generatedAt: Date): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.csv') return reportToCsv(report);
  if (extension === '.json') return reportToJson(report, generatedAt);
  throw new Error(`format d'export non reconnu pour « ${fileName} » : extension .csv ou .json attendue`);
}
