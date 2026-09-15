export interface AppConfig {
  cubbit: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region?: string;
    forcePathStyle?: boolean;
    // Paire optionnelle dédiée aux écritures dans le bucket dédié (story 3.1) ; repli sur la paire principale si absente.
    destinationAccessKeyId?: string;
    destinationSecretAccessKey?: string;
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
  /** Réparation de l'archive existante (epics 2 et 3). */
  repair: {
    sourcePrefixes: string[]; // emplacements des photos dans le bucket source (D4) ; le reste du bucket est hors périmètre
    destinationBucket: string; // bucket dédié aux photos (D3)
    keptAlbums: string[]; // albums partagés conservés tels quels (D1), reconnus par le premier segment après le préfixe
    ignoredFileNames: string[]; // fichiers techniques exclus du plan (comparés sans casse), comptés et listés
    ignoredExtensions: string[]; // extensions exclues du plan (sans casse, avec ou sans point), jamais un format média
  };
}
