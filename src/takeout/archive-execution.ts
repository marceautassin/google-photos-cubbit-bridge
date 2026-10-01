import * as crypto from 'crypto';
import { destinationProblem, MULTIPART_UPLOAD_THRESHOLD_BYTES, UPLOAD_PART_SIZE_BYTES, WriterScope } from '../clients/archive-writer';
import { ArchiveWriter, DestinationObject } from '../clients/types';
import { etagKind, normalizeEtag } from '../inventory/duplicates';
import type { ExecutionJournal, ExecutionState, JournalEntry } from '../inventory/plan-execution';
import { describeError } from '../utils/format';
import { computeMultipartEtag } from '../utils/multipart-etag';
import { locationKey, TakeoutArchivePlan, TakeoutPlanLine } from './archive-plan';

/**
 * Exécution du plan d'archivage Takeout (story 4.3) : envoi de chaque ligne `envoyer`, `reclasser_quarantaine` et
 * `quarantaine` vers le bucket dédié, par le seul point d'accès en écriture (`ArchiveWriter.uploadFile`). Chaque média
 * est lu en flux depuis son zip local vérifié (4.2), jamais réextrait sur disque, via `deps.readMedia`.
 *
 * Réutilisation décidée (DRY) : le journal et le verrou d'exécution sont ceux de la réparation
 * (`RepairExecutionModel`, `ExecutionJournal` de `inventory/plan-execution.ts`), déjà génériques — indépendants de la
 * sémantique « copie côté serveur ». Un seul verrou global impose qu'une seule passe d'écriture (réparation OU
 * archivage Takeout) tourne à la fois, cohérent avec le point d'accès en écriture unique (NFR-1) : ne pas créer un
 * second verrou, ce serait réintroduire la possibilité de deux écrivains simultanés que les stories 3.1/3.2 ont
 * explicitement fermée. La clé de ligne du journal (`sourceKey`) est `locationKey` (`<part>␟<path>`).
 *
 * Séquence par ligne : HEAD destination (présent et prouvé identique → déjà présent ; présent et non identique, ou non
 * confirmable → arrêt de sûreté, jamais d'écrasement), lecture du média, dépôt (`uploadFile`), HEAD de vérification
 * (taille, et MD5 comparé quand l'envoi tient en une seule requête ; au-delà du seuil multipart, l'ETag attendu est
 * recalculé sur le contenu déposé avec notre propre taille de partie, qui est connue — contrairement à la source en
 * 3.1/3.2 — puis comparé à l'ETag renvoyé). Premier incident → arrêt. Aucune suppression.
 *
 * Reprise (story 4.4) : avant l'envoi, la ligne est journalisée `copie_en_cours` (dépôt tenté). La passe est relançable
 * après n'importe quelle coupure (Ctrl-C, SIGTERM/SIGHUP, extinction, `kill -9`) : les lignes `copie` / `deja_present` du
 * journal sont sautées ; une ligne `copie_en_cours` dont l'objet est présent est acceptée si c'est un dépôt vérifié
 * (`isVerifiedUpload`, comptée « reprise vérifiée », jamais renvoyée), sinon arrêt « à examiner » ; une ligne dont l'objet
 * est absent est (re)déposée ; une ligne `echec` est retentée. Jamais d'écrasement, quel que soit le point de coupure.
 * Limite documentée : un envoi interrompu EN COURS d'un dépôt multipart (média au-delà de `MULTIPART_UPLOAD_THRESHOLD_BYTES`,
 * 200 Mio, qu'aucun média de l'export n'atteint) repart de zéro pour cette ligne, sans reprise partie par partie ; les
 * parties orphelines sont signalées par le bilan, jamais abandonnées par l'outil. */

/** Ligne qui donne lieu à un envoi. */
export type ArchiveWriteLine = TakeoutPlanLine & { destination: string };

/** Lignes `envoyer`, `reclasser_quarantaine` et `quarantaine`, dans l'ordre du plan. Les autres ne sont jamais écrites. */
export function linesToSend(plan: Pick<TakeoutArchivePlan, 'lines'>): ArchiveWriteLine[] {
  return plan.lines.filter(
    (l): l is ArchiveWriteLine =>
      (l.action === 'envoyer' || l.action === 'reclasser_quarantaine' || l.action === 'quarantaine') && l.destination !== null,
  );
}

/** Longueur minimale de l'empreinte fournie pour confirmer (identique à la réparation). */
export const ARCHIVE_CONFIRMATION_LENGTH = 12;

/** Commande qui exécute (ou reprend) l'archivage d'un export. */
export function archiveExecutionCommandLine(exportId: string, planId: string): string {
  return `gpb takeout archiver --export ${exportId} --confirmer ${planId.slice(0, ARCHIVE_CONFIRMATION_LENGTH)}`;
}

/** L'empreinte complète, ou au moins ses 12 premiers caractères. */
export function archiveConfirmationMatches(planId: string, value: string | undefined): boolean {
  const given = value?.trim().toLowerCase() ?? '';
  return given.length >= ARCHIVE_CONFIRMATION_LENGTH && planId.startsWith(given);
}

const DONE_STATES: ReadonlySet<ExecutionState> = new Set(['copie', 'deja_present']);

/** Seuil et taille de partie d'un dépôt (story 4.3, correction) : doivent correspondre exactement à ceux injectés
 * dans le `ArchiveWriter` effectivement utilisé (`ArchiveExecutionDeps`), jamais supposés depuis les constantes de
 * production quand le writer a été construit avec d'autres valeurs (typiquement en test). */
export interface MultipartThresholds {
  multipartThresholdBytes: number;
  partSizeBytes: number;
}

/** Seuil et taille de partie de production (`S3ArchiveWriter` construit sans overrides). */
export const DEFAULT_UPLOAD_THRESHOLDS: MultipartThresholds = {
  multipartThresholdBytes: MULTIPART_UPLOAD_THRESHOLD_BYTES,
  partSizeBytes: UPLOAD_PART_SIZE_BYTES,
};

/**
 * Objet trouvé en destination AVANT notre envoi : considéré comme le même contenu seulement si la taille est
 * identique ET que l'ETag présent est un MD5 simple égal au MD5 attendu. Un ETag multipart ou absent ne prouve rien :
 * traité comme « à examiner », jamais présumé identique. (Objet potentiellement tiers, de taille de partie inconnue :
 * jamais recalculé, contrairement à `isVerifiedUpload` pour notre propre dépôt.)
 */
export function isSameContent(line: Pick<TakeoutPlanLine, 'size' | 'md5'>, object: DestinationObject): boolean {
  if (object.size !== line.size) return false;
  const etag = normalizeEtag(object.etag);
  return etag !== null && etagKind(etag) === 'md5' && etag === line.md5.toLowerCase();
}

/**
 * Vérification APRÈS notre envoi (story 4.3, correction bloquante en revue) : taille, et MD5 quand l'envoi a tenu en
 * une seule requête (ETag alors un MD5 simple). Au-delà du seuil multipart, nous déposons en parties de taille
 * connue (`thresholds.partSizeBytes`) : l'ETag multipart attendu est recalculé sur `body` (le contenu réellement
 * déposé, déjà lu localement) avec cette même taille de partie et comparé à l'ETag renvoyé par le HEAD de
 * vérification — jamais simplement présumé correct du seul fait que la taille correspond.
 */
export async function isVerifiedUpload(
  line: Pick<TakeoutPlanLine, 'size' | 'md5'>,
  object: DestinationObject,
  readBody: () => Promise<Buffer>,
  thresholds: MultipartThresholds = DEFAULT_UPLOAD_THRESHOLDS,
): Promise<boolean> {
  if (object.size !== line.size) return false;
  if (object.size <= thresholds.multipartThresholdBytes) {
    return normalizeEtag(object.etag) === line.md5.toLowerCase();
  }
  const expected = normalizeEtag(object.etag);
  if (expected === null) return false;
  const body = await readBody(); // au-delà du seuil, il faut relire le contenu déposé pour recalculer l'ETag multipart
  return computeMultipartEtag(body, thresholds.partSizeBytes) === expected;
}

const describeObject = (o: { size: number; etag: string | null }): string => `${o.size} octets, ETag ${o.etag ?? 'absent'}`;

export interface ArchiveExecutionProgress {
  sent: { count: number; size: number }; // envoyés et vérifiés pendant cette exécution
  recovered: number; // dépôts tentés lors d'une exécution précédente, vérifiés à la reprise sans renvoi
  alreadyPresent: number; // trouvés identiques en destination pendant cette exécution
  skipped: number; // déjà faits d'après le journal, non retraités
  remaining: number; // lignes restant à traiter
}

export interface ArchiveExecutionStop {
  location: { part: string; path: string };
  destination: string;
  reason: string;
}

export interface ArchiveExecutionResult extends ArchiveExecutionProgress {
  stop: ArchiveExecutionStop | null;
  interrupted: boolean;
}

export interface ArchiveExecutionDeps {
  writer: ArchiveWriter;
  journal: ExecutionJournal;
  /** Lit le contenu entier du média (flux depuis le zip local vérifié, jamais réextrait sur disque). */
  readMedia: (line: ArchiveWriteLine) => Promise<Buffer>;
  shouldStop?: () => boolean;
  /** Appelé avant chaque ligne : rafraîchit l'activité du verrou ; `false` si le verrou n'est plus détenu → arrêt. */
  keepAlive?: () => boolean;
  onProgress?: (progress: ArchiveExecutionProgress) => void;
  /**
   * Seuil et taille de partie EFFECTIFS de `writer` (story 4.3, correction) : par défaut les constantes de
   * production (`DEFAULT_UPLOAD_THRESHOLDS`), qui correspondent à un `S3ArchiveWriter` construit sans overrides. Un
   * writer construit avec d'autres valeurs (typiquement en test) doit passer ici les mêmes, sinon la vérification
   * post-envoi comparerait un MD5 simple à un ETag multipart (ou l'inverse).
   */
  uploadThresholds?: MultipartThresholds;
}

export class ArchiveExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveExecutionRefusedError';
  }
}

/** Ligne faite d'après le journal : état « fait », vers la destination du plan. */
export function isArchiveLineDone(line: ArchiveWriteLine, states: Map<string, JournalEntry>): boolean {
  const entry = states.get(locationKey(line));
  return entry !== undefined && DONE_STATES.has(entry.state) && entry.destination === line.destination;
}

/**
 * Contrôles préalables sur tout le plan, avant la moindre requête : raisons de refuser, vide si l'exécution peut
 * démarrer.
 */
export function preflightArchiveExecution(plan: TakeoutArchivePlan, scope: WriterScope): string[] {
  const problems: string[] = [];
  if (plan.destinationBucket !== scope.destinationBucket) {
    problems.push(`bucket dédié du plan « ${plan.destinationBucket} » différent de « ${scope.destinationBucket} »`);
  }
  for (const l of linesToSend(plan)) {
    const problem = destinationProblem(scope.destinationBucket, l.destination, scope);
    if (problem) problems.push(`${locationKey(l)} → ${l.destination} : ${problem}`);
  }
  return problems;
}

type LineOutcome =
  | { state: 'copie' | 'deja_present'; recovered: boolean }
  | { state: 'echec'; reason: string; sendAttempted: boolean };

async function processLine(
  line: ArchiveWriteLine,
  sendAttempted: boolean,
  writer: ArchiveWriter,
  readMedia: (line: ArchiveWriteLine) => Promise<Buffer>,
  markSendStarted: () => void,
  uploadThresholds: MultipartThresholds,
): Promise<LineOutcome> {
  let attempted = sendAttempted;
  const fail = (reason: string): LineOutcome => ({ state: 'echec', reason, sendAttempted: attempted });
  let existing: DestinationObject | null;
  try {
    existing = await writer.headDestination(line.destination);
  } catch (error) {
    return fail(`lecture de la destination impossible : ${describeError(error)}`);
  }
  if (existing) {
    if (attempted) {
      // Reprise (story 4.4 à venir) : l'objet présent peut être un dépôt de cette ligne, terminé par une exécution
      // précédente avant la coupure. `isVerifiedUpload` ne relit le média local (`readMedia`) que si nécessaire (objet
      // au-delà du seuil multipart, pour recalculer son ETag) : jamais pour un dépôt en une seule requête, dont
      // l'ETag présent (MD5 simple) suffit à vérifier.
      let verified: boolean;
      try {
        verified = await isVerifiedUpload(line, existing, () => readMedia(line), uploadThresholds);
      } catch (error) {
        return fail(`relecture du média pour vérifier le dépôt antérieur impossible : ${describeError(error)}`);
      }
      if (verified) return { state: 'copie', recovered: true };
      return fail(`dépôt antérieur non conforme, à examiner (${describeObject(existing)} ; attendu : ${line.size} octets, MD5 ${line.md5}) — jamais écrasé`);
    }
    if (isSameContent(line, existing)) return { state: 'deja_present', recovered: false };
    return fail(`destination déjà occupée, objet différent ou non confirmable (${describeObject(existing)} ; attendu : ${line.size} octets, MD5 ${line.md5}) — jamais écrasé`);
  }

  let body: Buffer;
  try {
    body = await readMedia(line);
  } catch (error) {
    return fail(`lecture du média impossible : ${describeError(error)}`);
  }
  const actualMd5 = crypto.createHash('md5').update(body).digest('hex');
  if (body.length !== line.size || actualMd5 !== line.md5.toLowerCase()) {
    return fail(`contenu lu différent de celui de l'analyse (${body.length} octets, MD5 ${actualMd5} ; attendu : ${line.size} octets, MD5 ${line.md5}) — zip modifié depuis l'analyse ? rien n'a été envoyé`);
  }

  markSendStarted();
  attempted = true;
  try {
    await writer.uploadFile(line.destination, body);
  } catch (error) {
    return fail(`envoi en échec : ${describeError(error)}`);
  }

  let sent: DestinationObject | null;
  try {
    sent = await writer.headDestination(line.destination);
  } catch (error) {
    return fail(`vérification de l'envoi impossible : ${describeError(error)}`);
  }
  if (!sent) return fail('vérification en échec : envoi introuvable en destination');
  if (!(await isVerifiedUpload(line, sent, () => Promise.resolve(body), uploadThresholds))) {
    return fail(`vérification en échec : objet différent de l'envoi (${describeObject(sent)} ; attendu : ${line.size} octets, MD5 ${line.md5}) — objet laissé en place, à examiner`);
  }
  return { state: 'copie', recovered: false };
}

/**
 * Exécute le plan d'archivage (déjà vérifié par `verifyStoredArchivePlan` et confirmé). Lève
 * `ArchiveExecutionRefusedError` avant toute écriture si le pré-vol échoue ; sinon rend le bilan, arrêt de sûreté ou
 * interruption compris.
 */
export async function executeArchivePlan(plan: TakeoutArchivePlan, deps: ArchiveExecutionDeps): Promise<ArchiveExecutionResult> {
  const { writer, journal, readMedia } = deps;
  const uploadThresholds = deps.uploadThresholds ?? DEFAULT_UPLOAD_THRESHOLDS;
  const problems = preflightArchiveExecution(plan, writer);
  if (problems.length > 0) {
    throw new ArchiveExecutionRefusedError(`${problems.length} problème(s) avant exécution :\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  const lines = linesToSend(plan);
  journal.prepare(plan.id, lines.map((l) => ({ sourceKey: locationKey(l), destination: l.destination })));
  const states = journal.findStates(plan.id);
  for (const l of lines) {
    const entry = states.get(locationKey(l));
    if (entry && entry.destination !== l.destination) {
      throw new ArchiveExecutionRefusedError(`journal incohérent pour ${locationKey(l)} : destination ${entry.destination} au lieu de ${l.destination}`);
    }
  }
  const pending = lines.filter((l) => !isArchiveLineDone(l, states));
  const result: ArchiveExecutionResult = {
    sent: { count: 0, size: 0 },
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
    throw new ArchiveExecutionRefusedError(`accès au bucket dédié « ${writer.destinationBucket} » impossible : ${describeError(error)}`);
  }

  for (const line of pending) {
    if (deps.shouldStop?.()) {
      result.interrupted = true;
      break;
    }
    if (deps.keepAlive && !deps.keepAlive()) {
      result.stop = {
        location: { part: line.part, path: line.path },
        destination: line.destination,
        reason: 'verrou d\'exécution perdu (levé par une autre commande) : arrêt avant cette ligne, rien n\'a été envoyé pour elle',
      };
      break;
    }
    const key = locationKey(line);
    const markSendStarted = (): void => journal.record(plan.id, key, 'copie_en_cours', null, true);
    const outcome = await processLine(line, states.get(key)?.copyAttempted ?? false, writer, readMedia, markSendStarted, uploadThresholds);
    if (outcome.state === 'echec') {
      journal.record(plan.id, key, 'echec', outcome.reason, outcome.sendAttempted);
      result.stop = { location: { part: line.part, path: line.path }, destination: line.destination, reason: outcome.reason };
      break;
    }
    journal.record(plan.id, key, outcome.state, outcome.recovered ? 'dépôt antérieur vérifié à la reprise, non renvoyé' : null);
    if (outcome.recovered) result.recovered++;
    else if (outcome.state === 'copie') {
      result.sent.count++;
      result.sent.size += line.size;
    } else result.alreadyPresent++;
    result.remaining--;
    deps.onProgress?.({ sent: result.sent, recovered: result.recovered, alreadyPresent: result.alreadyPresent, skipped: result.skipped, remaining: result.remaining });
  }
  return result;
}
