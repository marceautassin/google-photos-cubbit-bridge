export interface MediaItem {
  id: string;
  filename: string;
  mimeType: string;
  creationTime: Date;
  width?: number;
  height?: number;
  description?: string;
  baseUrl: string;
  productUrl: string;
}

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

export interface FileInfo {
  path: string;
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface DownloadProgress {
  mediaItemId: string;
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  speed?: number; // bytes per second
}

export interface UploadProgress {
  filename: string;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  speed?: number; // bytes per second
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
