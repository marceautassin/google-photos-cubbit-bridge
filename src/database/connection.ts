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
      PRAGMA synchronous = FULL; -- story 3.2 : une écriture validée du journal (copie_en_cours) survit à une coupure de courant
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
 * Exécute `work` dans une transaction : tout est validé, ou rien.
 * node:sqlite n'offre pas d'aide aux transactions : BEGIN/COMMIT/ROLLBACK explicites. Si le ROLLBACK échoue
 * (SQLite peut avoir déjà annulé), l'erreur d'origine prime et est relancée.
 */
export function inTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      if (database.isTransaction) database.exec('ROLLBACK');
    } catch {
      // L'erreur d'origine prime : elle est relancée ci-dessous.
    }
    throw error;
  }
}

/**
 * Migrations du schéma, appliquées dans l'ordre, chacune une seule fois. Une migration livrée n'est jamais modifiée :
 * toute évolution est une nouvelle migration.
 */
export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
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
    {
      version: 4,
      name: 'create_inventory_tables',
      sql: `
        CREATE TABLE IF NOT EXISTS inventory_objects (
          bucket TEXT NOT NULL,
          key TEXT NOT NULL,
          size INTEGER NOT NULL,
          last_modified TEXT,
          etag TEXT,
          PRIMARY KEY (bucket, key)
        );

        CREATE TABLE IF NOT EXISTS inventory_runs (
          bucket TEXT PRIMARY KEY,
          completed_at TEXT NOT NULL,
          object_count INTEGER NOT NULL,
          total_size INTEGER NOT NULL
        );
      `,
    },
    {
      version: 5,
      name: 'create_inventory_dates',
      sql: `
        -- Datation de chaque média inventorié (story 2.2). taken_at : heure locale nominale sans fuseau
        -- (AAAA-MM-JJTHH:MM:SS), NULL si indéterminée. size/etag : identité de l'objet daté, pour ne réutiliser
        -- une lecture EXIF que si l'objet n'a pas changé.
        CREATE TABLE IF NOT EXISTS inventory_dates (
          bucket TEXT NOT NULL,
          key TEXT NOT NULL,
          size INTEGER NOT NULL,
          etag TEXT,
          source TEXT NOT NULL CHECK (source IN ('nom_fichier', 'exif', 'indeterminee')),
          taken_at TEXT,
          detail TEXT,
          exif_read INTEGER NOT NULL DEFAULT 0,
          dated_at TEXT NOT NULL,
          PRIMARY KEY (bucket, key),
          CHECK ((source = 'indeterminee') = (taken_at IS NULL)),
          CHECK (taken_at IS NULL OR taken_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]')
        );
      `,
    },
    {
      version: 6,
      name: 'create_repair_plan',
      sql: `
        -- Plan de réparation courant (story 2.4) : un seul plan, identifié par son empreinte (SHA-256 du contenu).
        -- Remplacé d'un bloc par un plan différent ; les comptes et volumes se recalculent depuis les lignes.
        CREATE TABLE IF NOT EXISTS repair_plans (
          id TEXT PRIMARY KEY,
          source_bucket TEXT NOT NULL,
          destination_bucket TEXT NOT NULL,
          config TEXT NOT NULL, -- JSON : instantané normalisé de la configuration effective (plan périmé)
          index_state TEXT NOT NULL, -- JSON : inventaires source et dédié, datations (plan périmé)
          executable INTEGER NOT NULL,
          exclusions TEXT NOT NULL, -- JSON
          unrecognized TEXT NOT NULL, -- JSON
          naming_anomalies TEXT NOT NULL, -- JSON
          violations TEXT NOT NULL, -- JSON
          generated_at TEXT NOT NULL
        );

        -- Dernière génération refusée (une ligne au plus), effacée par la génération réussie suivante.
        CREATE TABLE IF NOT EXISTS repair_plan_refusals (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          refused_at TEXT NOT NULL,
          reason TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS repair_plan_lines (
          plan_id TEXT NOT NULL REFERENCES repair_plans(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          source_key TEXT NOT NULL,
          size INTEGER NOT NULL,
          etag TEXT,
          action TEXT NOT NULL CHECK (action IN ('copier', 'ignorer_doublon', 'quarantaine', 'ignorer_deja_archive')),
          destination TEXT,
          kept_key TEXT,
          reason TEXT NOT NULL,
          PRIMARY KEY (plan_id, source_key)
        );
      `,
    },
    {
      version: 7,
      name: 'create_repair_execution_journal',
      sql: `
        -- Journal d'exécution du plan de réparation (story 3.1) : état de chaque ligne à écrire, lié à l'empreinte du plan.
        -- Sans clé étrangère vers repair_plans : régénérer un plan n'efface pas la trace de ce qui a été copié (3.3).
        -- 'copie' n'est écrit qu'après vérification réussie de la copie.
        CREATE TABLE IF NOT EXISTS repair_execution_lines (
          plan_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          destination TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('a_faire', 'copie', 'deja_present', 'echec')),
          message TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (plan_id, source_key)
        );

        -- Verrou d'exécution exclusif (une ligne au plus) : deux exécutions concurrentes pourraient toutes deux
        -- constater une destination libre puis copier. La clé primaire fait échouer la seconde prise de verrou.
        CREATE TABLE IF NOT EXISTS repair_execution_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          plan_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          host TEXT NOT NULL,
          acquired_at TEXT NOT NULL
        );
      `,
    },
    {
      version: 8,
      name: 'resume_repair_execution',
      sql: `
        -- Reprise d'une réparation interrompue (story 3.2).
        -- État 'copie_en_cours' : écrit et validé AVANT l'envoi d'une copie. copy_attempted = 1 : une copie serveur,
        -- conditionnée à l'ETag source, a été envoyée vers cette destination (remis à 0 si le serveur l'a refusée, 412).
        -- SQLite ne sait pas modifier un CHECK : la table est reconstruite. Lignes existantes (journal 3.1) : copy_attempted = 0,
        -- c'est-à-dire les règles strictes de la story 3.1.
        CREATE TABLE repair_execution_lines_v8 (
          plan_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          destination TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('a_faire', 'copie_en_cours', 'copie', 'deja_present', 'echec')),
          copy_attempted INTEGER NOT NULL DEFAULT 0 CHECK (copy_attempted IN (0, 1)),
          message TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (plan_id, source_key)
        );
        INSERT INTO repair_execution_lines_v8 (plan_id, source_key, destination, state, copy_attempted, message, updated_at)
          SELECT plan_id, source_key, destination, state, 0, message, updated_at FROM repair_execution_lines;
        DROP TABLE repair_execution_lines;
        ALTER TABLE repair_execution_lines_v8 RENAME TO repair_execution_lines;

        -- Dernière activité de l'exécution qui détient le verrou, rafraîchie à chaque ligne : la levée explicite est
        -- refusée tant qu'elle est récente, quels que soient le poste et le processus.
        ALTER TABLE repair_execution_lock ADD COLUMN last_activity_at TEXT;
        UPDATE repair_execution_lock SET last_activity_at = acquired_at;
      `,
    },
];

/**
 * Exécute les migrations de la base de données
 */
async function runMigrations(database: DatabaseSync): Promise<void> {
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
  for (const migration of MIGRATIONS) {
    if (migration.version > startVersion) {
      getLogger().info(`Application de la migration ${migration.version}: ${migration.name}`);
      
      inTransaction(database, () => {
        database.exec(migration.sql);
        database
          .prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)')
          .run(migration.version, migration.name);
      });
      
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
