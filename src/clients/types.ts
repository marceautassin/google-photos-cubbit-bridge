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

export interface Album {
  id: string;
  title: string;
  productUrl: string;
  mediaItemsCount: string;
  coverPhotoBaseUrl?: string;
  coverPhotoMediaItemId?: string;
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
