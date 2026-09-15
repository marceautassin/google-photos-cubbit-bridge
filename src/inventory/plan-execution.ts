import { destinationProblem, isPreconditionFailed, sourceKeyProblem, WriterScope } from '../clients/archive-writer';
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
 */

export type ExecutionState = 'a_faire' | 'copie' | 'deja_present' | 'echec';

export interface JournalEntry {
  destination: string;
  state: ExecutionState;
  message: string | null;
}

/** Journal persistant, lié à l'empreinte du plan. */
export interface ExecutionJournal {
  /** Crée les lignes absentes à l'état `a_faire` ; ne touche pas aux lignes existantes. */
  prepare(planId: string, lines: { sourceKey: string; destination: string }[]): void;
  findStates(planId: string): Map<string, JournalEntry>;
  record(planId: string, sourceKey: string, state: ExecutionState, message: string | null): void;
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
  remaining: VolumeCount;
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
  };
  for (const l of linesToWrite(plan)) {
    add(l.action === 'copier' ? overview.copier : overview.quarantaine, l.size);
    add(isDone(l, states) ? overview.done : overview.remaining, l.size);
  }
  return overview;
}

function isDone(line: WriteLine, states: Map<string, JournalEntry>): boolean {
  const entry = states.get(line.sourceKey);
  return entry !== undefined && DONE_STATES.has(entry.state) && entry.destination === line.destination;
}

export interface ExecutionProgress {
  copied: VolumeCount; // copiés et vérifiés pendant cette exécution
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
  stop: ExecutionStop | null; // arrêt de sûreté : collision, copie ou vérification en échec
  interrupted: boolean; // arrêt demandé (Ctrl-C) entre deux lignes
}

export interface ExecutionDeps {
  writer: ArchiveWriter;
  journal: ExecutionJournal;
  shouldStop?: () => boolean;
  onProgress?: (progress: ExecutionProgress) => void;
}

/** Refus d'exécuter, levé avant toute écriture. */
export class ExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRefusedError';
  }
}

type LineOutcome = { state: 'copie' | 'deja_present' } | { state: 'echec'; reason: string };

async function processLine(line: WriteLine, writer: ArchiveWriter): Promise<LineOutcome> {
  const fail = (reason: string): LineOutcome => ({ state: 'echec', reason });
  let existing: DestinationObject | null;
  try {
    existing = await writer.headDestination(line.destination);
  } catch (error) {
    return fail(`lecture de la destination impossible : ${describeError(error)}`);
  }
  if (existing) {
    if (isSameAsSource(line, existing)) return { state: 'deja_present' };
    const kind = existing.size === line.size && etagKind(line.etag) === 'multipart' ? 'objet existant à examiner' : 'objet différent';
    return fail(
      `destination déjà occupée : ${kind} (${describeObject(existing)} ; source : ${describeObject(line)}) — jamais écrasé`,
    );
  }

  try {
    await writer.copyFromSource(line.sourceKey, line.etag!, line.destination);
  } catch (error) {
    if (isPreconditionFailed(error)) {
      return fail(`source modifiée depuis l'inventaire (ETag différent de ${line.etag}) : copie refusée, rien n'a été écrit`);
    }
    return fail(`copie en échec : ${describeError(error)}`);
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
  return { state: 'copie' };
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
    const outcome = await processLine(line, writer);
    if (outcome.state === 'echec') {
      journal.record(plan.id, line.sourceKey, 'echec', outcome.reason);
      result.stop = { sourceKey: line.sourceKey, destination: line.destination, reason: outcome.reason };
      break;
    }
    // `copie` n'est enregistré qu'ici, après vérification réussie.
    journal.record(plan.id, line.sourceKey, outcome.state, null);
    if (outcome.state === 'copie') add(result.copied, line.size);
    else result.alreadyPresent++;
    result.remaining--;
    deps.onProgress?.({ copied: result.copied, alreadyPresent: result.alreadyPresent, skipped: result.skipped, remaining: result.remaining });
  }
  return result;
}
