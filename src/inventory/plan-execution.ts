import { destinationProblem, isCopyRefusedBeforeWrite, isPreconditionFailed, sourceKeyProblem, WriterScope } from '../clients/archive-writer';
import { ArchiveWriter, DestinationObject } from '../clients/types';
import { describeError } from '../utils/format';
import { etagKind, normalizeEtag } from './duplicates';
import { PlanLine, RepairPlan } from './repair-plan';

/**
 * Exécution du plan de réparation (story 3.1) : copie côté serveur de chaque ligne `copier` et `quarantaine` vers le
 * bucket dédié, par le seul point d'accès en écriture. Ne dépend que des interfaces `ArchiveWriter` et `ExecutionJournal`.
 *
 * Séquence par ligne : HEAD destination (présent identique → déjà présent ; présent différent → arrêt, jamais
 * d'écrasement), copie conditionnée à l'ETag source, HEAD de vérification. Premier incident → arrêt. Aucune suppression.
 *
 * Exécution séquentielle (KISS) : les copies sont faites par le serveur, aucun débit local n'est en jeu ; l'arrêt au
 * premier incident et l'ordre du journal sont triviaux à garantir.
 *
 * Reprise (story 3.2) : avant chaque envoi de copie, la ligne est journalisée `copie_en_cours` (copie tentée). À la
 * relance, un objet présent en destination est jugé selon que l'outil a pu l'écrire ou non :
 * - aucune copie tentée (`a_faire`, `echec` avant envoi) : origine inconnue, `isSameAsSource` exigé (taille ET ETag) ;
 * - copie tentée (`copie_en_cours`, `echec` après envoi) : l'outil a envoyé vers cette destination exacte une copie
 *   conditionnée à l'ETag source ; l'objet est accepté s'il passe `isVerifiedCopy` (la vérification post-copie, différée).
 * Course résiduelle : un écrivain externe déposant entre la tentative et la relance un multipart de même taille serait
 * accepté ; le bucket dédié ne reçoit rien d'autre pendant l'exécution, et le versioning recommandé le rend récupérable.
 */

/**
 * `a_faire` : jamais tenté ; `copie_en_cours` : copie envoyée (ou sur le point de l'être), non vérifiée ; `copie` : copiée
 * et vérifiée ; `deja_present` : identique trouvé en destination ; `echec` : arrêt sur cette ligne, retentée à la relance.
 */
export type ExecutionState = 'a_faire' | 'copie_en_cours' | 'copie' | 'deja_present' | 'echec';

export interface JournalEntry {
  destination: string;
  state: ExecutionState;
  copyAttempted: boolean; // une copie a été envoyée vers la destination (et non refusée par 412)
  message: string | null;
}

/** Journal persistant, lié à l'empreinte du plan. */
export interface ExecutionJournal {
  /** Crée les lignes absentes à l'état `a_faire` ; ne touche pas aux lignes existantes. */
  prepare(planId: string, lines: { sourceKey: string; destination: string }[]): void;
  findStates(planId: string): Map<string, JournalEntry>;
  /** `copyAttempted` omis : inchangé. */
  record(planId: string, sourceKey: string, state: ExecutionState, message: string | null, copyAttempted?: boolean): void;
}

/** Ligne qui donne lieu à une écriture. */
export type WriteLine = PlanLine & { destination: string };

/** Limite de taille d'une copie serveur en une requête (5 Gio). */
export const MAX_COPY_BYTES = 5 * 1024 ** 3;

/** Longueur minimale de l'empreinte fournie pour confirmer. */
export const CONFIRMATION_LENGTH = 12;

const DONE_STATES: ReadonlySet<ExecutionState> = new Set(['copie', 'deja_present']);

/** Lignes `copier` et `quarantaine`, dans l'ordre du plan. Les doublons et déjà archivés ne sont jamais écrits. */
export function linesToWrite(plan: Pick<RepairPlan, 'lines'>): WriteLine[] {
  return plan.lines.filter(
    (l): l is WriteLine => (l.action === 'copier' || l.action === 'quarantaine') && l.destination !== null,
  );
}

/** Commande qui exécute (ou reprend) le plan. */
export function executionCommandLine(planId: string, bucket?: string): string {
  return `gpb reparation executer${bucket ? ` --bucket ${bucket}` : ''} --confirmer ${planId.slice(0, CONFIRMATION_LENGTH)}`;
}

/** L'empreinte complète, ou au moins ses 12 premiers caractères. */
export function confirmationMatches(planId: string, value: string | undefined): boolean {
  const given = value?.trim().toLowerCase() ?? '';
  return given.length >= CONFIRMATION_LENGTH && planId.startsWith(given);
}

/**
 * Contrôles préalables sur tout le plan, avant la moindre requête : raisons de refuser, vide si l'exécution peut
 * démarrer. `scope` : périmètre du point d'accès (bucket et préfixes source, bucket dédié configuré).
 */
export function preflightExecution(plan: RepairPlan, scope: WriterScope): string[] {
  const problems: string[] = [];
  if (plan.config.sourceBucket !== scope.sourceBucket) {
    problems.push(`bucket source du plan « ${plan.config.sourceBucket} » différent de « ${scope.sourceBucket} »`);
  }
  if (plan.index.destinationInventory === null) {
    // Sans inventaire du bucket dédié, le plan a supposé toutes les destinations libres : il n'a pas pu tenir compte de
    // ce qui s'y trouve déjà.
    problems.push(
      `le plan a été généré sans inventaire du bucket dédié : lancez « gpb inventory scan --bucket ${plan.config.destinationBucket} » ` +
        'puis « gpb plan generer »',
    );
  }
  const lines = plan.lines.filter((l) => l.action === 'copier' || l.action === 'quarantaine');
  for (const l of lines) {
    if (l.destination === null) {
      problems.push(`${l.sourceKey} (${l.action}) : aucune destination`);
      continue;
    }
    const problem = destinationProblem(plan.config.destinationBucket, l.destination, scope);
    if (problem) problems.push(`${l.sourceKey} → ${l.destination} : ${problem}`);
    const sourceProblem = sourceKeyProblem(l.sourceKey, scope);
    if (sourceProblem) problems.push(`${l.sourceKey} : ${sourceProblem}`);
    if (l.sourceBucket !== scope.sourceBucket) problems.push(`${l.sourceKey} : bucket source « ${l.sourceBucket} » inattendu`);
    if (normalizeEtag(l.etag) === null) problems.push(`${l.sourceKey} : ETag source absent, copie conditionnelle impossible`);
    if (l.size > MAX_COPY_BYTES) problems.push(`${l.sourceKey} : ${l.size} octets, au-delà de la limite d'une copie serveur (5 Gio)`);
  }
  return problems;
}

/**
 * Objet trouvé en destination AVANT copie : considéré comme la même photo seulement si taille ET ETag sont identiques,
 * y compris pour une source multipart (sans copie conditionnelle, rien d'autre ne garantit le contenu).
 */
export function isSameAsSource(line: Pick<PlanLine, 'size' | 'etag'>, object: DestinationObject): boolean {
  const etag = normalizeEtag(line.etag);
  return object.size === line.size && etag !== null && normalizeEtag(object.etag) === etag;
}

/**
 * Vérification APRÈS notre copie, conditionnée à l'ETag source (contenu garanti) : taille, et ETag quand la source a un MD5 simple.
 * Source multipart : son ETag dépend du découpage et l'ETag renvoyé par Cubbit après copie est inconnu : taille seule.
 */
export function isVerifiedCopy(line: Pick<PlanLine, 'size' | 'etag'>, object: DestinationObject): boolean {
  if (object.size !== line.size) return false;
  if (etagKind(line.etag) !== 'md5') return true;
  return normalizeEtag(object.etag) === normalizeEtag(line.etag);
}

const describeObject = (o: { size: number; etag: string | null }): string => `${o.size} octets, ETag ${o.etag ?? 'absent'}`;

export interface VolumeCount {
  count: number;
  size: number;
}

export interface ExecutionOverview {
  copier: VolumeCount;
  quarantaine: VolumeCount;
  done: VolumeCount; // déjà faites d'après le journal de ce plan
  remaining: VolumeCount; // toutes les lignes non faites : inProgress + failed + notStarted
  inProgress: VolumeCount; // `copie_en_cours` : copie tentée, à vérifier par HEAD
  failed: VolumeCount; // `echec` : à retenter
  notStarted: VolumeCount; // `a_faire` ou absentes du journal
  failures: ExecutionStop[]; // lignes en échec et leur dernier message
}

const add = (v: VolumeCount, size: number): void => {
  v.count++;
  v.size += size;
};

/** Résumé de ce qui serait fait, compte tenu du journal de ce plan. */
export function summarizeExecution(plan: Pick<RepairPlan, 'lines'>, states: Map<string, JournalEntry>): ExecutionOverview {
  const overview: ExecutionOverview = {
    copier: { count: 0, size: 0 },
    quarantaine: { count: 0, size: 0 },
    done: { count: 0, size: 0 },
    remaining: { count: 0, size: 0 },
    inProgress: { count: 0, size: 0 },
    failed: { count: 0, size: 0 },
    notStarted: { count: 0, size: 0 },
    failures: [],
  };
  for (const l of linesToWrite(plan)) {
    add(l.action === 'copier' ? overview.copier : overview.quarantaine, l.size);
    if (isDone(l, states)) {
      add(overview.done, l.size);
      continue;
    }
    add(overview.remaining, l.size);
    const entry = states.get(l.sourceKey);
    if (entry?.state === 'copie_en_cours') add(overview.inProgress, l.size);
    else if (entry?.state === 'echec') {
      add(overview.failed, l.size);
      overview.failures.push({ sourceKey: l.sourceKey, destination: l.destination, reason: entry.message ?? 'raison inconnue' });
    } else add(overview.notStarted, l.size);
  }
  return overview;
}

/** Ligne faite d'après le journal : état `copie` ou `deja_present`, vers la destination du plan. */
export function isDone(line: WriteLine, states: Map<string, JournalEntry>): boolean {
  const entry = states.get(line.sourceKey);
  return entry !== undefined && DONE_STATES.has(entry.state) && entry.destination === line.destination;
}

export interface ExecutionProgress {
  copied: VolumeCount; // copiés et vérifiés pendant cette exécution
  recovered: number; // copies tentées lors d'une exécution précédente, vérifiées à la reprise sans recopie
  alreadyPresent: number; // trouvés identiques en destination pendant cette exécution
  skipped: number; // déjà faits d'après le journal, non retraités
  remaining: number; // lignes restant à traiter
}

export interface ExecutionStop {
  sourceKey: string;
  destination: string;
  reason: string;
}

export interface ExecutionResult extends ExecutionProgress {
  stop: ExecutionStop | null; // arrêt de sûreté : collision, copie ou vérification en échec, verrou perdu
  interrupted: boolean; // arrêt demandé (Ctrl-C) entre deux lignes
}

export interface ExecutionDeps {
  writer: ArchiveWriter;
  journal: ExecutionJournal;
  shouldStop?: () => boolean;
  /** Appelé avant chaque ligne : rafraîchit l'activité du verrou ; `false` si le verrou n'est plus détenu → arrêt. */
  keepAlive?: () => boolean;
  onProgress?: (progress: ExecutionProgress) => void;
}

/** Refus d'exécuter, levé avant toute écriture. */
export class ExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRefusedError';
  }
}

type LineOutcome = { state: 'copie' | 'deja_present'; recovered: boolean } | { state: 'echec'; reason: string; copyAttempted: boolean };

/**
 * Traite une ligne. `copyAttempted` : une copie a déjà été envoyée vers cette destination par une exécution précédente.
 * `markCopyStarted` journalise `copie_en_cours` ; il est appelé, et doit avoir abouti, AVANT l'envoi de la copie.
 */
async function processLine(
  line: WriteLine,
  copyAttempted: boolean,
  writer: ArchiveWriter,
  markCopyStarted: () => void,
): Promise<LineOutcome> {
  let attempted = copyAttempted;
  const fail = (reason: string): LineOutcome => ({ state: 'echec', reason, copyAttempted: attempted });
  let existing: DestinationObject | null;
  try {
    existing = await writer.headDestination(line.destination);
  } catch (error) {
    return fail(`lecture de la destination impossible : ${describeError(error)}`);
  }
  if (existing) {
    if (attempted) {
      // Copie envoyée par l'outil lors d'une exécution précédente, conditionnée à l'ETag source : vérification différée.
      if (isVerifiedCopy(line, existing)) return { state: 'copie', recovered: true };
      return fail(
        `copie antérieure non conforme, à examiner (${describeObject(existing)} ; source : ${describeObject(line)}) — ` +
          'jamais écrasée',
      );
    }
    if (isSameAsSource(line, existing)) return { state: 'deja_present', recovered: false };
    const kind = existing.size === line.size && etagKind(line.etag) === 'multipart' ? 'objet existant à examiner' : 'objet différent';
    return fail(
      `destination déjà occupée : ${kind} (${describeObject(existing)} ; source : ${describeObject(line)}) — jamais écrasé`,
    );
  }

  markCopyStarted();
  attempted = true;
  try {
    await writer.copyFromSource(line.sourceKey, line.etag!, line.destination);
  } catch (error) {
    // Refus certain avant écriture (garde, 412, 403, 404 à la première tentative) : rien n'a été écrit, et la destination
    // était libre juste avant → la copie n'est plus réputée tentée. Toute autre erreur laisse un doute : tentée.
    const nothingWritten = isCopyRefusedBeforeWrite(error);
    if (nothingWritten) attempted = false;
    const written = nothingWritten ? ', rien n\'a été écrit' : '';
    if (isPreconditionFailed(error)) {
      return fail(`source modifiée depuis l'inventaire (ETag différent de ${line.etag}) : copie refusée${written}`);
    }
    return fail(`copie en échec : ${describeError(error)}${nothingWritten ? ' (refusée avant écriture, rien n\'a été écrit)' : ''}`);
  }

  let copied: DestinationObject | null;
  try {
    copied = await writer.headDestination(line.destination);
  } catch (error) {
    return fail(`vérification de la copie impossible : ${describeError(error)}`);
  }
  if (!copied) return fail('vérification en échec : copie introuvable en destination');
  if (!isVerifiedCopy(line, copied)) {
    return fail(
      `vérification en échec : copie différente de la source (${describeObject(copied)} ; source : ${describeObject(line)}) — ` +
        'objet laissé en place, à examiner',
    );
  }
  return { state: 'copie', recovered: false };
}

/**
 * Exécute le plan (déjà vérifié par `verifyStoredPlan` et confirmé). Lève `ExecutionRefusedError` avant toute écriture
 * si le pré-vol échoue ; sinon rend le bilan, arrêt de sûreté ou interruption compris.
 */
export async function executePlan(plan: RepairPlan, deps: ExecutionDeps): Promise<ExecutionResult> {
  const { writer, journal } = deps;
  const problems = preflightExecution(plan, writer);
  if (problems.length > 0) {
    throw new ExecutionRefusedError(`${problems.length} problème(s) avant exécution :\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  const lines = linesToWrite(plan);
  journal.prepare(plan.id, lines);
  const states = journal.findStates(plan.id);
  for (const l of lines) {
    const entry = states.get(l.sourceKey);
    if (entry && entry.destination !== l.destination) {
      throw new ExecutionRefusedError(
        `journal incohérent pour ${l.sourceKey} : destination ${entry.destination} au lieu de ${l.destination}`,
      );
    }
  }
  const pending = lines.filter((l) => !isDone(l, states));
  const result: ExecutionResult = {
    copied: { count: 0, size: 0 },
    recovered: 0,
    alreadyPresent: 0,
    skipped: lines.length - pending.length,
    remaining: pending.length,
    stop: null,
    interrupted: false,
  };
  if (pending.length === 0) return result;

  try {
    await writer.checkAccess();
  } catch (error) {
    throw new ExecutionRefusedError(`accès au bucket dédié « ${writer.destinationBucket} » impossible : ${describeError(error)}`);
  }

  for (const line of pending) {
    if (deps.shouldStop?.()) {
      result.interrupted = true;
      break;
    }
    if (deps.keepAlive && !deps.keepAlive()) {
      result.stop = {
        sourceKey: line.sourceKey,
        destination: line.destination,
        reason: 'verrou d\'exécution perdu (levé par une autre commande) : arrêt avant cette ligne, rien n\'a été écrit pour elle',
      };
      break;
    }
    const markCopyStarted = (): void => journal.record(plan.id, line.sourceKey, 'copie_en_cours', null, true);
    const outcome = await processLine(line, states.get(line.sourceKey)?.copyAttempted ?? false, writer, markCopyStarted);
    if (outcome.state === 'echec') {
      journal.record(plan.id, line.sourceKey, 'echec', outcome.reason, outcome.copyAttempted);
      result.stop = { sourceKey: line.sourceKey, destination: line.destination, reason: outcome.reason };
      break;
    }
    // `copie` n'est enregistré qu'ici, après vérification réussie (immédiate, ou différée à la reprise).
    journal.record(plan.id, line.sourceKey, outcome.state, outcome.recovered ? 'copie antérieure vérifiée à la reprise, non recopiée' : null);
    if (outcome.recovered) result.recovered++;
    else if (outcome.state === 'copie') add(result.copied, line.size);
    else result.alreadyPresent++;
    result.remaining--;
    deps.onProgress?.({
      copied: result.copied,
      recovered: result.recovered,
      alreadyPresent: result.alreadyPresent,
      skipped: result.skipped,
      remaining: result.remaining,
    });
  }
  return result;
}
