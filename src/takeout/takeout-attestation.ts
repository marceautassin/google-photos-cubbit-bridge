import { BucketObject } from '../clients/types';
import { StoredTakeoutAnalysis } from '../database/takeout-analysis-model';
import { etagKind, normalizeEtag } from '../inventory/duplicates';
import type { JournalEntry } from '../inventory/plan-execution';
import { csvDocument, QUARANTINE_ROOT } from '../inventory/repair-plan';
import { ageHours, inventoryAgeReason } from '../inventory/repair-report';
import { archivedObjectsFrom, locationKey, storedArchivePlanProblems, TakeoutArchivePlan, TakeoutPlanLine } from './archive-plan';
import { archiveExecutionCommandLine, isArchiveLineDone, linesToSend } from './archive-execution';
import { AnalyzedMedia } from './takeout-analysis';
import { AMBIGUOUS_JSON_REASON, ExportReport, ORPHAN_JSON_REASON } from './takeout-validation';

/**
 * Attestation d'un export Takeout archivé (story 4.5) : feu vert avant que Marceau supprime les zips de `backups/` et
 * les photos dans Google Photos. Calcul pur, sans I/O : rapproche chaque média de l'analyse de l'objet attendu dans
 * l'inventaire du bucket dédié, et revérifie que l'export attesté est bien celui qui a été analysé, planifié et archivé.
 * Modèle : l'attestation de la réparation (`inventory/repair-report.ts`). Doute = refus, avec une raison actionnable.
 */

/** Écart de rapprochement, du plus grave au plus bénin à examiner. */
export type GapType = 'manquant' | 'taille_differente' | 'contenu_different' | 'non_confirmable' | 'sans_destination';
export const GAP_TYPES: readonly GapType[] = ['manquant', 'taille_differente', 'contenu_different', 'non_confirmable', 'sans_destination'];

/** Comment le média est couvert : déposé par la passe, déjà archivé avant, ou doublon interne d'un représentant couvert. */
export type Coverage = 'depose' | 'deja_archive' | 'doublon_interne';

export interface RemoteZipState {
  name: string;
  key: string;
  size: number;
  etag: string | null;
}

export interface AttestationGap {
  type: GapType;
  part: string;
  path: string;
  expectedKey: string | null;
  expected: string;
  found: string;
  action: string; // ce qu'il faut faire
}

export interface AttestationRow {
  media: AnalyzedMedia;
  coverage: Coverage | null; // null : ligne de plan introuvable
  expectedKey: string | null;
  quarantine: boolean;
  gap: AttestationGap | null;
}

export interface AttestationCounts {
  covered: number;
  deposited: number;
  alreadyArchived: number;
  internalDuplicates: number;
  quarantine: number;
}

export interface AttestationReport {
  exportId: string;
  planId: string;
  destinationBucket: string;
  rows: AttestationRow[];
  gaps: AttestationGap[];
  counts: AttestationCounts;
  zips: RemoteZipState[]; // zips distants revérifiés, supprimables si l'attestation est accordée
  executionEnd: Date | null;
  inventoryCompletedAt: Date | null;
  inventoryObjectCount: number;
  inventoryAgeHours: number | null;
  attestation: { granted: boolean; reasons: string[] };
}

export interface AttestationInput {
  exportId: string;
  expectedParts: number; // --parties
  analysis: StoredTakeoutAnalysis;
  plan: TakeoutArchivePlan;
  states: Map<string, JournalEntry>;
  executionEnd: Date | null; // dernière écriture du journal du plan
  lockHeld: boolean;
  remoteZips: RemoteZipState[]; // zips de l'export dans `backups/`, listés en lecture seule
  validation: ExportReport; // validation 4.1 rejouée sur les zips locaux vérifiés
  inventory: { completedAt: Date; objects: BucketObject[] } | null; // bucket dédié
  now: Date;
}

const EXAMPLES = 5;
const examples = (items: string[]): string => items.slice(0, EXAMPLES).join(', ') + (items.length > EXAMPLES ? `, … (${items.length} au total)` : '');
const where = (l: { part: string; path: string }): string => `${l.part}:${l.path}`;

/** Les zips distants sont-ils exactement ceux de l'analyse (même nombre, noms, tailles, ETag) ? */
function zipProblems(input: AttestationInput): string[] {
  const { analysis, remoteZips, expectedParts } = input;
  const problems: string[] = [];
  if (remoteZips.length !== expectedParts) problems.push(`${remoteZips.length} zip(s) distant(s) dans backups/ pour l'export, ${expectedParts} attendu(s) (--parties)`);
  if (analysis.zips.length !== expectedParts) problems.push(`l'analyse porte sur ${analysis.zips.length} zip(s), ${expectedParts} attendu(s) (--parties)`);
  const analyzed = new Map(analysis.zips.map((z) => [z.name, z]));
  const remote = new Map(remoteZips.map((z) => [z.name, z]));
  for (const z of remoteZips) {
    const was = analyzed.get(z.name);
    if (!was) problems.push(`zip ${z.name} présent dans backups/ mais absent de l'analyse : relancez gpb takeout analyser`);
    else if (normalizeEtag(was.etag) === null || normalizeEtag(z.etag) === null) {
      // Sans ETag, le zip ne serait comparé que sur son nom et sa taille : trop faible pour autoriser sa suppression.
      problems.push(`zip ${z.name} sans ETag (analysé : ${was.etag ?? 'absent'} ; distant : ${z.etag ?? 'absent'}) : identité des octets non vérifiable`);
    } else if (was.size !== z.size || normalizeEtag(was.etag) !== normalizeEtag(z.etag)) {
      problems.push(
        `zip ${z.name} différent de celui analysé (analysé : ${was.size} octets, ETag ${was.etag ?? 'absent'} ; distant : ${z.size} octets, ETag ${z.etag ?? 'absent'}) : ` +
          "l'attestation ne porterait pas sur les octets analysés",
      );
    }
  }
  for (const z of analysis.zips) if (!remote.has(z.name)) problems.push(`zip ${z.name} analysé mais absent de backups/ : l'attestation ne porterait pas sur les octets analysés`);
  return problems;
}

/** Validation 4.1 rejouée sur les zips locaux : exploitable, parties confirmées, rien d'inexpliqué, mêmes médias que l'analyse. */
function validationProblems(input: AttestationInput): string[] {
  const { validation, analysis } = input;
  const problems: string[] = [];
  if (!validation.partCountConfirmed) problems.push(`nombre de parties non confirmé par la validation rejouée (--parties ${input.expectedParts})`);
  for (const problem of validation.problems) problems.push(`export non exploitable : ${problem}`);
  for (const item of validation.unrecognized) {
    const label =
      item.reason === ORPHAN_JSON_REASON ? 'JSON orphelin (sans média correspondant)' : item.reason === AMBIGUOUS_JSON_REASON ? 'JSON ambigu' : `fichier non reconnu (${item.reason})`;
    problems.push(`${label} : ${where(item)}`);
  }
  for (const m of validation.media) {
    if (m.metadata === null && m.companion === null) problems.push(`média sans métadonnées (ni image compagnon de Live Photo) : ${where(m)}`);
  }

  const analyzed = new Map(analysis.media.map((m) => [locationKey(m), m.size]));
  const replayed = new Map(validation.media.map((m) => [locationKey(m), m.size]));
  const absent = analysis.media.filter((m) => !replayed.has(locationKey(m))).map(where);
  const added = validation.media.filter((m) => !analyzed.has(locationKey(m))).map(where);
  const resized = analysis.media.filter((m) => replayed.has(locationKey(m)) && replayed.get(locationKey(m)) !== m.size).map(where);
  if (absent.length > 0) problems.push(`${absent.length} média(s) de l'analyse absent(s) des zips locaux : ${examples(absent)}`);
  if (added.length > 0) problems.push(`${added.length} média(s) des zips locaux inconnu(s) de l'analyse : ${examples(added)}`);
  if (resized.length > 0) problems.push(`${resized.length} média(s) de taille différente de l'analyse : ${examples(resized)}`);
  return problems;
}

/** Plan relu sans lui faire confiance, cohérent avec l'analyse. */
function planProblems(input: AttestationInput): string[] {
  const { plan, analysis } = input;
  const problems: string[] = [];
  if (analysis.media.length === 0) problems.push("l'analyse ne contient aucun média");
  if (plan.exportId !== analysis.exportId) problems.push(`le plan ${plan.id.slice(0, 12)} est celui de l'export ${plan.exportId}, pas ${analysis.exportId}`);
  if (plan.analysisAnalyzedAt !== analysis.analyzedAt) {
    problems.push(`plan périmé : l'analyse a changé depuis sa génération (${plan.analysisAnalyzedAt} → ${analysis.analyzedAt}) : relancez gpb takeout planifier`);
  }
  // Destinations « déjà archivées au moment du plan » : l'état du bucket dédié que le plan déclare avoir vu.
  const archivedAtPlan = archivedObjectsFrom(
    plan.lines.filter((l) => l.action === 'ignorer_deja_archive' && l.destination !== null).map((l) => ({ key: l.destination!, size: l.size, etag: l.archivedEtag })),
  );
  problems.push(...storedArchivePlanProblems(plan, analysis.media, archivedAtPlan).map((p) => `plan non fiable : ${p}`));

  const lines = new Map(plan.lines.map((l) => [locationKey(l), l]));
  const inconsistent = analysis.media.filter((m) => {
    const l = lines.get(locationKey(m));
    return l !== undefined && (l.size !== m.size || l.md5 !== m.md5);
  });
  if (inconsistent.length > 0) problems.push(`${inconsistent.length} ligne(s) du plan avec taille ou MD5 différents de l'analyse : ${examples(inconsistent.map(where))}`);
  return problems;
}

/** Exécution terminée : toutes les lignes à déposer faites, aucun verrou. */
function executionProblems(input: AttestationInput): string[] {
  const { plan, states } = input;
  const problems: string[] = [];
  const toSend = linesToSend(plan);
  const remaining = toSend.filter((l) => !isArchiveLineDone(l, states));
  if (remaining.length > 0) {
    problems.push(`exécution incomplète : ${remaining.length} ligne(s) à déposer restante(s) sur ${toSend.length} : relancez « ${archiveExecutionCommandLine(plan.exportId, plan.id)} »`);
  }
  if (input.lockHeld) problems.push("un verrou d'exécution est présent : une exécution est peut-être en cours");
  return problems;
}

/**
 * L'inventaire du bucket dédié doit être postérieur à la dernière écriture du journal (sans écriture à attendre,
 * à l'inventaire utilisé par le plan) et assez récent.
 */
function inventoryProblems(input: AttestationInput): string[] {
  const { inventory, plan, executionEnd, now } = input;
  const scan = `gpb inventory scan --bucket ${plan.destinationBucket}`;
  if (!inventory) return [`aucun inventaire local du bucket dédié « ${plan.destinationBucket} » : lancez « ${scan} »`];
  const problems: string[] = [];
  const since = executionEnd ?? (plan.destinationInventoryCompletedAt ? new Date(plan.destinationInventoryCompletedAt) : null);
  const after = since !== null && (executionEnd !== null ? inventory.completedAt > since : inventory.completedAt >= since);
  if (!after) {
    problems.push(
      `inventaire du bucket dédié du ${inventory.completedAt.toISOString()} non postérieur à ${executionEnd ? "la dernière écriture du journal" : "l'inventaire du plan"} ` +
        `(${since?.toISOString() ?? 'aucune'}) : il ne prouve rien, lancez « ${scan} »`,
    );
  }
  const tooOld = inventoryAgeReason('du bucket dédié', ageHours(inventory.completedAt, now), scan);
  if (tooOld !== null) problems.push(tooOld);
  return problems;
}

const describeMedia = (m: AnalyzedMedia): string => `${m.size} octets, MD5 ${m.md5}`;
const describeFound = (o: { size: number; etag: string | null }): string => `${o.size} octets, ETag ${normalizeEtag(o.etag) ?? 'absent'}`;

function gapAction(type: GapType, input: AttestationInput): string {
  const scan = `gpb inventory scan --bucket ${input.plan.destinationBucket}`;
  switch (type) {
    case 'manquant':
      return `réinventorier (« ${scan} ») ; si l'objet reste absent, ne rien supprimer : régénérez le plan (gpb takeout planifier --export ${input.exportId}) puis relancez l'archivage`;
    case 'taille_differente':
    case 'contenu_different':
      return "examiner : l'objet du bucket n'est pas celui de l'export, ne rien supprimer avant de l'avoir compris";
    case 'non_confirmable':
      return `réinventorier (« ${scan} ») ; si l'ETag reste non confirmable, examiner à la main avant toute suppression`;
    case 'sans_destination':
      return `régénérer le plan (gpb takeout planifier --export ${input.exportId}) : aucune destination n'est prévue pour ce média`;
  }
}

/** Rapprochement d'un média : objet attendu à la clé exacte, même taille, preuve d'identité. */
function reconcile(media: AnalyzedMedia, lines: Map<string, TakeoutPlanLine>, objects: Map<string, BucketObject>, input: AttestationInput): AttestationRow {
  const line = lines.get(locationKey(media));
  const isDuplicate = line?.action === 'ignorer_doublon_interne';
  const owner = isDuplicate ? (line.keptOf ? lines.get(locationKey(line.keptOf)) : undefined) : line;
  const coverage: Coverage | null = !line ? null : isDuplicate ? 'doublon_interne' : line.action === 'ignorer_deja_archive' ? 'deja_archive' : 'depose';
  const expectedKey = owner?.destination ?? null;
  const row: AttestationRow = { media, coverage, expectedKey, quarantine: expectedKey?.startsWith(QUARANTINE_ROOT) === true, gap: null };
  const fail = (type: GapType, expected: string, found: string): AttestationRow => ({
    ...row,
    gap: { type, part: media.part, path: media.path, expectedKey, expected, found, action: gapAction(type, input) },
  });

  if (!line) return fail('sans_destination', 'une ligne dans le plan', 'aucune ligne du plan pour ce média');
  if (expectedKey === null) {
    return fail('sans_destination', describeMedia(media), isDuplicate ? 'doublon dont le représentant n\'a pas de destination' : 'ligne du plan sans destination');
  }
  const found = objects.get(expectedKey);
  if (!found) return fail('manquant', describeMedia(media), 'objet absent de l\'inventaire du bucket dédié');
  if (found.size !== media.size) return fail('taille_differente', describeMedia(media), describeFound(found));

  const etag = normalizeEtag(found.etag);
  if (etag === null) return fail('non_confirmable', describeMedia(media), describeFound(found));
  if (etagKind(etag) === 'md5') return etag === media.md5.toLowerCase() ? row : fail('contenu_different', describeMedia(media), describeFound(found));
  // ETag multipart : seule preuve admise, celle enregistrée par l'analyse pour une ligne déjà archivée. Limite connue :
  // un média déposé par la passe au-delà du seuil multipart (200 Mio) reste « non confirmable » et bloque l'attestation
  // (refus, jamais une attestation à tort). Aucun cas dans l'export du 6 août ; à traiter si un export en contient
  // (recalcul de l'ETag sur le média lu dans le zip local, comme `isVerifiedUpload`).
  const proof = owner?.action === 'ignorer_deja_archive' ? owner.archivedEtag : null;
  if (proof === null) return fail('non_confirmable', describeMedia(media), `${describeFound(found)} (ETag multipart sans preuve enregistrée)`);
  if (etag === proof) return row;
  return fail('contenu_different', `${describeMedia(media)} ou ETag ${proof}`, describeFound(found));
}

function countRows(rows: AttestationRow[]): AttestationCounts {
  const covered = rows.filter((r) => r.gap === null);
  const of = (coverage: Coverage): number => covered.filter((r) => r.coverage === coverage).length;
  return {
    covered: covered.length,
    deposited: of('depose'),
    alreadyArchived: of('deja_archive'),
    internalDuplicates: of('doublon_interne'),
    quarantine: covered.filter((r) => r.quarantine).length,
  };
}

/** Attestation complète. Pure : accordée seulement si aucune raison de refus. */
export function buildAttestation(input: AttestationInput): AttestationReport {
  const { analysis, plan, inventory } = input;
  const lines = new Map(plan.lines.map((l) => [locationKey(l), l]));
  const objects = new Map((inventory?.objects ?? []).map((o) => [o.key, o]));
  // Sans inventaire, tout paraîtrait « manquant » : le rapprochement n'a pas de sens, la raison de refus est l'inventaire.
  const rows = inventory ? analysis.media.map((m) => reconcile(m, lines, objects, input)) : [];
  const gaps = rows.flatMap((r) => (r.gap ? [r.gap] : []));

  const reasons = [
    ...zipProblems(input),
    ...validationProblems(input),
    ...planProblems(input),
    ...executionProblems(input),
    ...inventoryProblems(input),
    ...(gaps.length > 0 ? [`${gaps.length} média(s) non couvert(s) ou non confirmable(s) dans le bucket dédié (détail ci-dessous)`] : []),
  ];
  return {
    exportId: input.exportId,
    planId: plan.id,
    destinationBucket: plan.destinationBucket,
    rows,
    gaps,
    counts: countRows(rows),
    zips: [...input.remoteZips].sort((a, b) => a.name.localeCompare(b.name)),
    executionEnd: input.executionEnd,
    inventoryCompletedAt: inventory?.completedAt ?? null,
    inventoryObjectCount: inventory?.objects.length ?? 0,
    inventoryAgeHours: inventory ? ageHours(inventory.completedAt, input.now) : null,
    attestation: { granted: reasons.length === 0, reasons },
  };
}

/** Liste des médias couverts (une ligne par média de l'export), à n'écrire que si l'attestation est accordée. */
export function coveredMediaCsv(report: AttestationReport): string {
  return csvDocument(
    ['nom', 'date_prise_de_vue', 'source_date', 'album', 'dossier_takeout', 'cle_archive', 'taille', 'md5'],
    report.rows.map(({ media: m, expectedKey }) => [
      m.fileName, m.takenAt, m.dateSource, m.folderKind === 'album' ? m.folder : null, m.folder, expectedKey, m.size, m.md5,
    ]),
  );
}

/** Écarts de rapprochement, complets (l'écran n'en montre que quelques exemples par type). */
export function gapsCsv(report: AttestationReport): string {
  return csvDocument(
    ['type', 'partie', 'chemin', 'cle_attendue', 'attendu', 'trouve', 'action'],
    report.gaps.map((g) => [g.type, g.part, g.path, g.expectedKey, g.expected, g.found, g.action]),
  );
}
