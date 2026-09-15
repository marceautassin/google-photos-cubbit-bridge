import * as fs from 'fs-extra';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { AppConfig } from './types';

// Charger les variables d'environnement depuis le répertoire racine du projet
const PROJECT_ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

// Essayer aussi de charger depuis config/.env si le fichier principal n'existe pas
if (!fs.existsSync(path.join(PROJECT_ROOT, '.env')) && fs.existsSync(path.join(PROJECT_ROOT, 'config', '.env'))) {
  dotenv.config({ path: path.join(PROJECT_ROOT, 'config', '.env') });
}

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'config.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

/**
 * Configuration par défaut de l'application
 */
const defaultConfig: AppConfig = {
  cubbit: {
    endpoint: process.env.CUBBIT_ENDPOINT || '',
    accessKeyId: process.env.CUBBIT_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.CUBBIT_SECRET_ACCESS_KEY || '',
    bucket: process.env.CUBBIT_BUCKET || 'photos-backup',
    region: process.env.CUBBIT_REGION || 'us-east-1',
    forcePathStyle: true, // Nécessaire pour la plupart des implémentations S3 compatibles
    destinationAccessKeyId: process.env.CUBBIT_DESTINATION_ACCESS_KEY_ID || '',
    destinationSecretAccessKey: process.env.CUBBIT_DESTINATION_SECRET_ACCESS_KEY || '',
  },
  sync: {
    maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3'),
    supportedFormats: [
      'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif', 'dng',
      'mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm', 'mts',
    ],
    preserveFolderStructure: true,
    chunkSize: 1024 * 1024, // 1MB
    retryAttempts: 3,
    retryDelay: 1000, // 1 seconde
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: path.join(LOGS_DIR, 'app.log'),
    console: process.env.NODE_ENV !== 'production',
    maxSize: '10m',
    maxFiles: 5,
  },
  database: {
    path: path.join(DATA_DIR, 'app.db'),
    backupPath: path.join(DATA_DIR, 'app.backup.db'),
  },
  repair: {
    // Les deux emplacements historiques de l'archive photo (PRD, D4). Surchargeables dans config/config.json.
    sourcePrefixes: ['backup_google_photos/photos/', '2_Personnel/Photos/google_photos/'],
    destinationBucket: process.env.CUBBIT_DESTINATION_BUCKET || '',
    keptAlbums: ['mariage'],
    // Fichiers techniques de systèmes ou de logiciels photo, exclus du plan mais comptés et listés. « Icon » suivi d'un
    // retour chariot : icône de dossier personnalisée de macOS.
    ignoredFileNames: ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.picasa.ini', 'Picasa.ini', `Icon${String.fromCharCode(13)}`],
    // Extensions à ne pas archiver (ex. sidecars « json », « xmp », « aae ») : vide par défaut, à décider sur inventaire réel.
    ignoredExtensions: [],
  },
};

/**
 * Charge la configuration depuis le fichier et les variables d'environnement
 */
export async function loadConfig(): Promise<AppConfig> {
  // Créer les répertoires nécessaires
  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(LOGS_DIR);

  let fileConfig: Partial<AppConfig> = {};

  // Charger le fichier de configuration s'il existe
  if (await fs.pathExists(CONFIG_PATH)) {
    try {
      fileConfig = await fs.readJson(CONFIG_PATH);
    } catch (error) {
      console.warn(`Erreur lors du chargement de ${CONFIG_PATH}:`, error);
    }
  }

  // Fusionner la configuration par défaut avec le fichier de config
  const config: AppConfig = {
    ...defaultConfig,
    ...fileConfig,
    cubbit: {
      ...defaultConfig.cubbit,
      ...fileConfig.cubbit,
    },
    sync: {
      ...defaultConfig.sync,
      ...fileConfig.sync,
    },
    logging: {
      ...defaultConfig.logging,
      ...fileConfig.logging,
    },
    database: {
      ...defaultConfig.database,
      ...fileConfig.database,
    },
    repair: {
      ...defaultConfig.repair,
      ...fileConfig.repair,
    },
  };

  return config;
}

/**
 * Sauvegarde la configuration dans le fichier
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.ensureDir(path.dirname(CONFIG_PATH));
  await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
}

/**
 * Valide que la configuration est complète
 */
export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  if (!config.cubbit.endpoint) {
    errors.push('Cubbit endpoint manquant');
  }
  if (!config.cubbit.accessKeyId) {
    errors.push('Cubbit Access Key ID manquant');
  }
  if (!config.cubbit.secretAccessKey) {
    errors.push('Cubbit Secret Access Key manquant');
  }
  if (!config.cubbit.bucket) {
    errors.push('Cubbit bucket manquant');
  }

  return errors;
}

/**
 * Obtient le répertoire racine du projet
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
