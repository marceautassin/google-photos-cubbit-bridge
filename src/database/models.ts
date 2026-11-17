import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './connection';

/**
 * Modèle pour les métadonnées de l'application
 */
export class AppMetadataModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Définit une valeur de métadonnées
   */
  async set(key: string, value: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)
    `);
    stmt.run(key, value);
  }

  /**
   * Obtient une valeur de métadonnées
   */
  async get(key: string): Promise<string | null> {
    const stmt = this.db.prepare('SELECT value FROM app_metadata WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  /**
   * Supprime une métadonnée
   */
  async delete(key: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM app_metadata WHERE key = ?');
    stmt.run(key);
  }

  /**
   * Obtient toutes les métadonnées
   */
  async getAll(): Promise<Record<string, string>> {
    const stmt = this.db.prepare('SELECT key, value FROM app_metadata');
    const rows = stmt.all() as { key: string; value: string }[];
    
    const result: Record<string, string> = {};
    rows.forEach(row => {
      result[row.key] = row.value;
    });
    
    return result;
  }
}
