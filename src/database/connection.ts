import { backup, DatabaseSync } from 'node:sqlite';
import * as fs from 'fs-extra';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { getLogger } from '../utils/logger';

let db: DatabaseSync | null = null;

/**
 * Initialise la connexion à la base de données
 */
export async function initDatabase(config: AppConfig['database']): Promise<DatabaseSync> {
  try {
    // S'assurer que le répertoire existe
    await fs.ensureDir(path.dirname(config.path));
    
    // Moteur d'index (Q2) : node:sqlite, intégré à Node ≥ 22.16 (backup() requis) — aucune compilation native, et l'index est reconstructible depuis le bucket.
    db = new DatabaseSync(config.path);
    
    // Configurer la base de données
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    
    // Exécuter les migrations
    await runMigrations(db);
    
    getLogger().info(`Base de données initialisée: ${config.path}`);
    
    return db;
  } catch (error) {
    getLogger().error('Erreur lors de l\'initialisation de la base de données:', error);
    throw error;
  }
}

/**
 * Obtient l'instance de la base de données
 */
export function getDatabase(): DatabaseSync {
  if (!db) {
    throw new Error('Base de données non initialisée. Appelez initDatabase() d\'abord.');
  }
  return db;
}

/**
 * Ferme la connexion à la base de données
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    getLogger().info('Connexion à la base de données fermée');
  }
}

/**
 * Exécute les migrations de la base de données
 */
async function runMigrations(database: DatabaseSync): Promise<void> {
  const migrations = [
    {
      version: 1,
      name: 'create_initial_tables',
      sql: `
        CREATE TABLE IF NOT EXISTS sync_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_photo_id TEXT UNIQUE NOT NULL,
          filename TEXT NOT NULL,
          google_url TEXT NOT NULL,
          cubbit_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          created_date TEXT NOT NULL,
          sync_date TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS sync_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          start_time TEXT NOT NULL,
          end_time TEXT,
          status TEXT NOT NULL,
          files_processed INTEGER DEFAULT 0,
          files_success INTEGER DEFAULT 0,
          files_error INTEGER DEFAULT 0,
          total_size INTEGER DEFAULT 0,
          config TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `,
    },
    {
      version: 2,
      name: 'create_indexes',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_sync_records_status ON sync_records(status);
        CREATE INDEX IF NOT EXISTS idx_sync_records_google_id ON sync_records(google_photo_id);
        CREATE INDEX IF NOT EXISTS idx_sync_records_created_date ON sync_records(created_date);
        CREATE INDEX IF NOT EXISTS idx_sync_sessions_start_time ON sync_sessions(start_time);
        CREATE INDEX IF NOT EXISTS idx_sync_sessions_status ON sync_sessions(status);
      `,
    },
    {
      version: 3,
      name: 'add_triggers',
      sql: `
        CREATE TRIGGER IF NOT EXISTS update_sync_records_timestamp 
        AFTER UPDATE ON sync_records
        BEGIN
          UPDATE sync_records SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        
        CREATE TRIGGER IF NOT EXISTS update_app_metadata_timestamp 
        AFTER UPDATE ON app_metadata
        BEGIN
          UPDATE app_metadata SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
        END;
      `,
    },
  ];

  // Créer la table de versioning si elle n'existe pas
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Obtenir la version actuelle
  const currentVersion = database
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null };

  const startVersion = currentVersion.version || 0;

  // Appliquer les migrations manquantes
  for (const migration of migrations) {
    if (migration.version > startVersion) {
      getLogger().info(`Application de la migration ${migration.version}: ${migration.name}`);
      
      // node:sqlite n'offre pas d'aide aux transactions : BEGIN/COMMIT explicites
      database.exec('BEGIN');
      try {
        database.exec(migration.sql);
        database
          .prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)')
          .run(migration.version, migration.name);
        database.exec('COMMIT');
      } catch (error) {
        // SQLite peut avoir déjà annulé la transaction : ne pas masquer l'erreur d'origine
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
      
      getLogger().info(`Migration ${migration.version} appliquée avec succès`);
    }
  }
}

/**
 * Sauvegarde la base de données
 */
export async function backupDatabase(backupPath: string): Promise<void> {
  if (!db) {
    throw new Error('Base de données non initialisée');
  }

  try {
    await fs.ensureDir(path.dirname(backupPath));
    await backup(db, backupPath);
    getLogger().info(`Sauvegarde de la base de données créée: ${backupPath}`);
  } catch (error) {
    getLogger().error('Erreur lors de la sauvegarde de la base de données:', error);
    throw error;
  }
}

/**
 * Restaure la base de données depuis une sauvegarde
 */
export async function restoreDatabase(backupPath: string, targetPath: string): Promise<void> {
  try {
    if (!(await fs.pathExists(backupPath))) {
      throw new Error(`Fichier de sauvegarde non trouvé: ${backupPath}`);
    }

    // Fermer la connexion actuelle
    if (db) {
      db.close();
      db = null;
    }

    // Copier la sauvegarde
    await fs.copy(backupPath, targetPath);
    
    getLogger().info(`Base de données restaurée depuis: ${backupPath}`);
  } catch (error) {
    getLogger().error('Erreur lors de la restauration de la base de données:', error);
    throw error;
  }
}
