export enum SyncStatus {
  PENDING = 'pending',
  DOWNLOADING = 'downloading',
  UPLOADING = 'uploading',
  SYNCED = 'synced',
  ERROR = 'error',
  SKIPPED = 'skipped',
}

export interface SyncRecord {
  id?: number;
  googlePhotoId: string;
  filename: string;
  googleUrl: string;
  cubbitPath: string;
  fileSize: number;
  mimeType: string;
  createdDate: Date;
  syncDate?: Date;
  status: SyncStatus;
  errorMessage?: string;
  metadata: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SyncSession {
  id?: number;
  startTime: Date;
  endTime?: Date;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  filesProcessed: number;
  filesSuccess: number;
  filesError: number;
  totalSize: number;
  config?: Record<string, any>;
  createdAt?: Date;
}

/**
 * Objet tel que listé dans un bucket (inventaire, story 2.1).
 */
export interface BucketObject {
  key: string;
  size: number;
  lastModified: Date | null;
  etag: string | null; // sans guillemets
}

/**
 * Une page de listing S3.
 */
export interface BucketObjectPage {
  objects: BucketObject[];
  isTruncated: boolean; // d'autres pages suivent
  nextToken?: string;
}

/**
 * Accès en lecture seule au contenu d'un bucket : lister, et rien d'autre.
 */
export interface BucketLister {
  readonly bucket: string;
  listPage(continuationToken?: string): Promise<BucketObjectPage>;
}

/**
 * Accès en lecture seule à une plage d'octets d'un objet (lecture EXIF, story 2.2) : lire, et rien d'autre.
 */
export interface ObjectRangeReader {
  readonly bucket: string;
  /** Lit les octets `start` à `end` inclus (en-tête HTTP `Range`). */
  readRange(key: string, start: number, end: number): Promise<Uint8Array>;
}

/**
 * Métadonnées d'un objet du bucket dédié, lues par HEAD (story 3.1).
 */
export interface DestinationObject {
  size: number;
  etag: string | null; // sans guillemets
}

/**
 * Seul accès en écriture au stockage (NFR-1, story 3.1) : copie côté serveur du bucket source vers le bucket dédié, et
 * lecture des métadonnées de destination. Aucune suppression, aucun dépôt d'octets.
 */
export interface ArchiveWriter {
  readonly sourceBucket: string;
  readonly sourcePrefixes: readonly string[]; // seules clés source copiables
  readonly destinationBucket: string;
  /** Vérifie l'existence et l'accès au bucket dédié sans rien écrire ; lève une erreur sinon. */
  checkAccess(): Promise<void>;
  /** Métadonnées de l'objet de destination, `null` s'il n'existe pas. */
  headDestination(key: string): Promise<DestinationObject | null>;
  /** Copie côté serveur, conditionnée à l'ETag source (la source n'a pas changé depuis l'inventaire). */
  copyFromSource(sourceKey: string, sourceEtag: string, destinationKey: string): Promise<void>;
}
