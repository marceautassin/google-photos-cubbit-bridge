export interface AppConfig {
  cubbit: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region?: string;
    forcePathStyle?: boolean;
  };
  sync: {
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
