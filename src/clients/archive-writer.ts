// POINT D'ACCÈS EN ÉCRITURE UNIQUE (NFR-1, story 3.1). Seul module de `src/` autorisé à importer une commande S3 qui
// modifie un bucket. Il n'importe que la copie côté serveur et la lecture de métadonnées : aucune suppression, aucun
// dépôt d'octets. Les clés Cubbit donnent accès à tout l'espace de travail : ce module est la seule barrière entre
// l'outil et les exemplaires uniques (`marceau`, `marceau-photos/backups/`). Toute évolution passe par ses tests.
import { CopyObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ALBUMS_ROOT, CHRONO_ROOT, QUARANTINE_ROOT } from '../inventory/repair-plan';
import { bucketNameProblem } from '../utils/bucket-name';
import { S3_SEND_DEADLINE_MS } from './s3-client';
import { ArchiveWriter, DestinationObject } from './types';

/** Espaces du bucket dédié où l'outil peut écrire. Tout le reste (dont `backups/`) est refusé. */
export const WRITABLE_ROOTS: readonly string[] = [CHRONO_ROOT, ALBUMS_ROOT, QUARANTINE_ROOT];

/** Clé sondée par le contrôle d'accès : un HEAD, jamais une écriture. Son absence (404) prouve l'accès en lecture. */
export const ACCESS_PROBE_KEY = `${CHRONO_ROOT}.gpb-controle-acces`;

/** Périmètre du point d'accès : d'où l'on copie (bucket et préfixes du plan), où l'on écrit (bucket dédié configuré). */
export interface WriterScope {
  sourceBucket: string;
  sourcePrefixes: readonly string[];
  destinationBucket: string;
}

/** Erreur de cloisonnement : levée avant tout appel réseau. */
export class WriteRefusedError extends Error {
  constructor(message: string) {
    super(`écriture refusée (cloisonnement) — ${message}`);
    this.name = 'WriteRefusedError';
  }
}

/** Problème du périmètre lui-même, `null` s'il est acceptable. */
function scopeProblem({ sourceBucket, sourcePrefixes, destinationBucket }: WriterScope): string | null {
  if (destinationBucket === '') return 'aucun bucket dédié configuré';
  const badName = bucketNameProblem(destinationBucket) ?? bucketNameProblem(sourceBucket);
  if (badName) return badName;
  if (destinationBucket.toLowerCase() === sourceBucket.toLowerCase()) {
    return `le bucket dédié « ${destinationBucket} » est le bucket source`;
  }
  if (sourcePrefixes.length === 0) return 'aucun préfixe source';
  const badPrefix = sourcePrefixes.find((p) => !p.endsWith('/') || hasInvalidSegment(p.slice(0, -1)));
  if (badPrefix !== undefined) return `préfixe source « ${badPrefix} » invalide`;
  return null;
}

/** Segment vide, `.` ou `..` : une clé qui pourrait être réinterprétée comme un chemin. */
const hasInvalidSegment = (path: string): boolean => path.split('/').some((s) => s === '' || s === '.' || s === '..');

/**
 * Raison de refuser une écriture dans `bucket` sous `key`, `null` si elle est autorisée. Pure : utilisée en pré-vol sur
 * tout le plan et avant chaque requête.
 */
export function destinationProblem(bucket: string, key: string, scope: WriterScope): string | null {
  const problem = scopeProblem(scope);
  if (problem) return problem;
  if (bucket.toLowerCase() === scope.sourceBucket.toLowerCase()) return `bucket source « ${bucket} » : jamais écrit`;
  if (bucket !== scope.destinationBucket) {
    return `bucket « ${bucket} » différent du bucket dédié configuré « ${scope.destinationBucket} »`;
  }
  const root = WRITABLE_ROOTS.find((r) => key.startsWith(r));
  if (!root) {
    const backups = key.startsWith('backups/') ? ' (backups/ : exemplaires uniques, jamais écrits)' : '';
    return `clé « ${key} » hors des espaces ${WRITABLE_ROOTS.join(', ')}${backups}`;
  }
  if (hasInvalidSegment(key.slice(root.length))) {
    return `clé « ${key} » invalide (segment vide, « . » ou « .. », ou clé de dossier)`;
  }
  return null;
}

/** Raison de refuser `key` comme source d'une copie, `null` si elle est sous un préfixe source et bien formée. */
export function sourceKeyProblem(key: string, scope: WriterScope): string | null {
  const problem = scopeProblem(scope);
  if (problem) return problem;
  if (hasInvalidSegment(key)) return `clé source « ${key} » invalide (segment vide, « . » ou « .. »)`;
  if (!scope.sourcePrefixes.some((p) => key.startsWith(p))) {
    return `clé source « ${key} » hors des préfixes source (${scope.sourcePrefixes.join(', ')})`;
  }
  return null;
}

const refuseIf = (problem: string | null): void => {
  if (problem) throw new WriteRefusedError(problem);
};

/**
 * En-tête `x-amz-copy-source` : `<bucket>/<clé encodée>`. Chaque segment est encodé en URI (espaces, `&`, `#`, `+`, `?`,
 * accents), les `/` sont conservés. La clé n'est jamais normalisée : une clé NFD reste NFD, sinon ce serait un autre objet.
 */
export function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

const statusOf = (error: unknown): { name?: string; status?: number; attempts?: number } => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number; attempts?: number } } | null;
  return { name: e?.name, status: e?.$metadata?.httpStatusCode, attempts: e?.$metadata?.attempts };
};

/** Objet absent : 404 (`NotFound` pour un HEAD, qui n'a pas de corps d'erreur). */
export function isNotFound(error: unknown): boolean {
  const { name, status } = statusOf(error);
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

/** Copie conditionnelle refusée : l'ETag de la source ne correspond plus (412). */
export function isPreconditionFailed(error: unknown): boolean {
  const { name, status } = statusOf(error);
  return name === 'PreconditionFailed' || status === 412;
}

/**
 * La copie n'a certainement rien écrit (story 3.2) :
 * - refus du garde (`WriteRefusedError`) : levé avant tout appel réseau ;
 * - réponse du serveur à une tentative unique (`$metadata.attempts` = 1) qui refuse la copie avant de l'effectuer :
 *   412 (source modifiée : condition évaluée avant la copie), 403 (droits vérifiés avant toute opération), 404
 *   `NoSuchKey` / `NoSuchBucket` (source ou bucket introuvable : rien à copier).
 * Si le SDK a fait plusieurs tentatives, une tentative précédente (délai dépassé, réponse perdue) a pu écrire : doute.
 * Toute autre erreur (réseau, délai, 5xx, abandon) laisse un doute : la copie a pu aboutir côté serveur.
 */
export function isCopyRefusedBeforeWrite(error: unknown): boolean {
  if (error instanceof WriteRefusedError) return true;
  const { name, status, attempts } = statusOf(error);
  if (attempts !== 1) return false;
  return isPreconditionFailed(error) || name === 'AccessDenied' || status === 403 || name === 'NoSuchKey' || name === 'NoSuchBucket';
}

const unquote = (etag: string | undefined): string | null => (etag ? etag.replace(/^"|"$/g, '') : null);

export class S3ArchiveWriter implements ArchiveWriter {
  readonly sourceBucket: string;
  readonly sourcePrefixes: readonly string[];
  readonly destinationBucket: string;

  /** `sendDeadlineMs` : échéance de chaque envoi, retentatives comprises (injectée par les tests). */
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    scope: WriterScope,
    private readonly sendDeadlineMs: number = S3_SEND_DEADLINE_MS,
  ) {
    refuseIf(scopeProblem(scope));
    this.sourceBucket = scope.sourceBucket;
    this.sourcePrefixes = [...scope.sourcePrefixes];
    this.destinationBucket = scope.destinationBucket;
  }

  async checkAccess(): Promise<void> {
    // Bucket dédié existant et accessible (un 404 ici est une erreur, pas une absence d'objet), puis HEAD d'une clé.
    await this.client.send(new HeadBucketCommand({ Bucket: this.destinationBucket }), this.deadline());
    await this.headDestination(ACCESS_PROBE_KEY);
  }

  async headDestination(key: string): Promise<DestinationObject | null> {
    refuseIf(destinationProblem(this.destinationBucket, key, this));
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.destinationBucket, Key: key }), this.deadline());
      if (response.ContentLength === undefined) {
        throw new Error(`Réponse S3 incomplète : taille absente pour ${key}`);
      }
      return { size: response.ContentLength, etag: unquote(response.ETag) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async copyFromSource(sourceKey: string, sourceEtag: string, destinationKey: string): Promise<void> {
    refuseIf(sourceKeyProblem(sourceKey, this));
    refuseIf(destinationProblem(this.destinationBucket, destinationKey, this));
    if (sourceEtag.trim() === '') throw new WriteRefusedError(`ETag source absent pour ${sourceKey} : copie conditionnelle impossible`);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.destinationBucket,
        Key: destinationKey,
        CopySource: encodeCopySource(this.sourceBucket, sourceKey),
        CopySourceIfMatch: `"${unquote(sourceEtag)}"`,
      }),
      this.deadline(),
    );
  }

  /**
   * Signal d'abandon à l'échéance : borne la durée d'un envoi côté client, donc d'une ligne (seuil de levée du verrou).
   * Limite : une copie déjà entièrement reçue par le serveur peut aboutir après l'abandon ; l'échéance ne borne pas
   * la date d'écriture côté serveur.
   */
  private deadline(): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(this.sendDeadlineMs) };
  }
}
