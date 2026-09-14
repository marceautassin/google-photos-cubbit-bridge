import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './connection';
import { SyncRecord, SyncSession, SyncStatus } from '../clients/types';
import { getLogger } from '../utils/logger';

/**
 * Modèle pour les enregistrements de synchronisation
 */
export class SyncRecordModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Crée un nouvel enregistrement de synchronisation
   */
  async create(record: Omit<SyncRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO sync_records (
        google_photo_id, filename, google_url, cubbit_path, 
        file_size, mime_type, created_date, sync_date, status, 
        error_message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      record.googlePhotoId,
      record.filename,
      record.googleUrl,
      record.cubbitPath,
      record.fileSize,
      record.mimeType,
      record.createdDate.toISOString(),
      record.syncDate?.toISOString() ?? null,
      record.status,
      record.errorMessage ?? null,
      JSON.stringify(record.metadata)
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Met à jour un enregistrement de synchronisation
   */
  async update(id: number, updates: Partial<SyncRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (key === 'id' || key === 'createdAt' || key === 'updatedAt') return;
      
      let dbKey = key;
      switch (key) {
        case 'googlePhotoId':
          dbKey = 'google_photo_id';
          break;
        case 'googleUrl':
          dbKey = 'google_url';
          break;
        case 'cubbitPath':
          dbKey = 'cubbit_path';
          break;
        case 'fileSize':
          dbKey = 'file_size';
          break;
        case 'mimeType':
          dbKey = 'mime_type';
          break;
        case 'createdDate':
          dbKey = 'created_date';
          value = (value as Date).toISOString();
          break;
        case 'syncDate':
          dbKey = 'sync_date';
          value = (value ? (value as Date).toISOString() : null) as any;
          break;
        case 'errorMessage':
          dbKey = 'error_message';
          break;
        case 'metadata':
          value = JSON.stringify(value);
          break;
      }
      
      fields.push(`${dbKey} = ?`);
      values.push(value ?? null); // node:sqlite refuse de lier undefined
    });

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`
      UPDATE sync_records SET ${fields.join(', ')} WHERE id = ?
    `);
    
    stmt.run(...values);
  }

  /**
   * Trouve un enregistrement par ID Google Photos
   */
  async findByGooglePhotoId(googlePhotoId: string): Promise<SyncRecord | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_records WHERE google_photo_id = ?
    `);
    
    const row = stmt.get(googlePhotoId) as any;
    return row ? this.mapRowToRecord(row) : null;
  }

  /**
   * Trouve un enregistrement par ID
   */
  async findById(id: number): Promise<SyncRecord | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_records WHERE id = ?
    `);
    
    const row = stmt.get(id) as any;
    return row ? this.mapRowToRecord(row) : null;
  }

  /**
   * Trouve des enregistrements par statut
   */
  async findByStatus(status: SyncStatus, limit?: number): Promise<SyncRecord[]> {
    let sql = 'SELECT * FROM sync_records WHERE status = ? ORDER BY created_at DESC';
    if (limit) {
      sql += ' LIMIT ?';
    }
    
    const stmt = this.db.prepare(sql);
    const params = limit ? [status, limit] : [status];
    const rows = stmt.all(...params) as any[];
    
    return rows.map(row => this.mapRowToRecord(row));
  }

  /**
   * Trouve tous les enregistrements avec pagination
   */
  async findAll(offset: number = 0, limit: number = 50): Promise<SyncRecord[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_records 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `);
    
    const rows = stmt.all(limit, offset) as any[];
    return rows.map(row => this.mapRowToRecord(row));
  }

  /**
   * Compte les enregistrements par statut
   */
  async countByStatus(status?: SyncStatus): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM sync_records';
    const params: any[] = [];
    
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  /**
   * Supprime un enregistrement
   */
  async delete(id: number): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM sync_records WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Mappe une ligne de base de données vers un objet SyncRecord
   */
  private mapRowToRecord(row: any): SyncRecord {
    return {
      id: row.id,
      googlePhotoId: row.google_photo_id,
      filename: row.filename,
      googleUrl: row.google_url,
      cubbitPath: row.cubbit_path,
      fileSize: row.file_size,
      mimeType: row.mime_type,
      createdDate: new Date(row.created_date),
      syncDate: row.sync_date ? new Date(row.sync_date) : undefined,
      status: row.status as SyncStatus,
      errorMessage: row.error_message,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

/**
 * Modèle pour les sessions de synchronisation
 */
export class SyncSessionModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Crée une nouvelle session de synchronisation
   */
  async create(session: Omit<SyncSession, 'id' | 'createdAt'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO sync_sessions (
        start_time, end_time, status, files_processed, 
        files_success, files_error, total_size, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      session.startTime.toISOString(),
      session.endTime?.toISOString() ?? null,
      session.status,
      session.filesProcessed,
      session.filesSuccess,
      session.filesError,
      session.totalSize,
      session.config ? JSON.stringify(session.config) : null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Met à jour une session de synchronisation
   */
  async update(id: number, updates: Partial<SyncSession>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (key === 'id' || key === 'createdAt') return;
      
      let dbKey = key;
      switch (key) {
        case 'startTime':
          dbKey = 'start_time';
          value = (value as Date).toISOString() as any;
          break;
        case 'endTime':
          dbKey = 'end_time';
          value = (value ? (value as Date).toISOString() : null) as any;
          break;
        case 'filesProcessed':
          dbKey = 'files_processed';
          break;
        case 'filesSuccess':
          dbKey = 'files_success';
          break;
        case 'filesError':
          dbKey = 'files_error';
          break;
        case 'totalSize':
          dbKey = 'total_size';
          break;
        case 'config':
          value = (value ? JSON.stringify(value) : null) as any;
          break;
      }
      
      fields.push(`${dbKey} = ?`);
      values.push(value ?? null); // node:sqlite refuse de lier undefined
    });

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`
      UPDATE sync_sessions SET ${fields.join(', ')} WHERE id = ?
    `);
    
    stmt.run(...values);
  }

  /**
   * Trouve une session par ID
   */
  async findById(id: number): Promise<SyncSession | null> {
    const stmt = this.db.prepare('SELECT * FROM sync_sessions WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToSession(row) : null;
  }

  /**
   * Trouve la dernière session
   */
  async findLast(): Promise<SyncSession | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_sessions 
      ORDER BY start_time DESC 
      LIMIT 1
    `);
    
    const row = stmt.get() as any;
    return row ? this.mapRowToSession(row) : null;
  }

  /**
   * Trouve les sessions avec pagination
   */
  async findAll(offset: number = 0, limit: number = 20): Promise<SyncSession[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_sessions 
      ORDER BY start_time DESC 
      LIMIT ? OFFSET ?
    `);
    
    const rows = stmt.all(limit, offset) as any[];
    return rows.map(row => this.mapRowToSession(row));
  }

  /**
   * Supprime une session
   */
  async delete(id: number): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM sync_sessions WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Mappe une ligne de base de données vers un objet SyncSession
   */
  private mapRowToSession(row: any): SyncSession {
    return {
      id: row.id,
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : undefined,
      status: row.status,
      filesProcessed: row.files_processed,
      filesSuccess: row.files_success,
      filesError: row.files_error,
      totalSize: row.total_size,
      config: row.config ? JSON.parse(row.config) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}

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
