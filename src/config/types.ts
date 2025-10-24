export interface AppConfig {
  googlePhotos: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
  };
  cubbit: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region?: string;
    forcePathStyle?: boolean;
  };
  sync: {
    downloadPath: string;
    maxConcurrentDownloads: number;
    supportedFormats: string[];
    preserveFolderStructure: boolean;
    chunkSize: number;
    retryAttempts: number;
    retryDelay: number;
  };
  logging: {
    level: string;
    file: string;
    console: boolean;
    maxSize: string;
    maxFiles: number;
  };
  database: {
    path: string;
    backupPath?: string;
  };
}

export interface SearchFilters {
  albumId?: string;
  dateRange?: {
    startDate: string;
    endDate: string;
  };
  mediaTypes?: ('PHOTO' | 'VIDEO')[];
}
