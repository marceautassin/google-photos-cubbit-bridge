import { DatabaseSync } from 'node:sqlite';
import { getDatabase, inTransaction } from './connection';
import { LocalDateTime } from '../utils/local-date-time';

/** Source de la date retenue (story 2.2). */
export type DateSource = 'nom_fichier' | 'exif' | 'indeterminee';

/**
 * Datation d'un objet de l'inventaire. `takenAt` est `null` si et seulement si la source est « indeterminee ».
 */
export interface ObjectDating {
  key: string;
  size: number;
  etag: string | null;
  source: DateSource;
  takenAt: LocalDateTime | null;
  detail: string | null; // champ EXIF retenu, ou raison de l'indétermination
  exifRead: boolean; // l'EXIF a été lu par GET partiel : résultat réutilisable sans nouvelle requête
}

interface DatingRow {
  key: string;
  size: number;
  etag: string | null;
  source: DateSource;
  taken_at: string | null;
  detail: string | null;
  exif_read: number;
}

/**
 * Datations persistées à côté de l'inventaire d'un bucket.
 */
export class InventoryDateModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Supprime les datations dont l'objet n'est plus dans l'inventaire, ou a changé (taille ou ETag).
   * Renvoie le nombre de datations supprimées.
   */
  purgeStale(bucket: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM inventory_dates WHERE bucket = ? AND NOT EXISTS (
           SELECT 1 FROM inventory_objects o
           WHERE o.bucket = inventory_dates.bucket AND o.key = inventory_dates.key
             AND o.size = inventory_dates.size AND o.etag IS inventory_dates.etag)`,
      )
      .run(bucket);
    return Number(result.changes);
  }

  /** Supprime les datations des clés données (objets repartant en lecture), en une transaction. */
  remove(bucket: string, keys: string[]): void {
    if (keys.length === 0) return;
    inTransaction(this.db, () => {
      const remove = this.db.prepare('DELETE FROM inventory_dates WHERE bucket = ? AND key = ?');
      for (const key of keys) remove.run(bucket, key);
    });
  }

  /** Enregistre (ou remplace) des datations, en une transaction. */
  save(bucket: string, datings: ObjectDating[], datedAt: Date = new Date()): void {
    inTransaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO inventory_dates (bucket, key, size, etag, source, taken_at, detail, exif_read, dated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket, key) DO UPDATE SET size = excluded.size, etag = excluded.etag,
           source = excluded.source, taken_at = excluded.taken_at, detail = excluded.detail,
           exif_read = excluded.exif_read, dated_at = excluded.dated_at`,
      );
      for (const dating of datings) {
        upsert.run(
          bucket,
          dating.key,
          dating.size,
          dating.etag,
          dating.source,
          dating.takenAt,
          dating.detail,
          dating.exifRead ? 1 : 0,
          datedAt.toISOString(),
        );
      }
    });
  }

  findAll(bucket: string): ObjectDating[] {
    const rows = this.db
      .prepare(
        'SELECT key, size, etag, source, taken_at, detail, exif_read FROM inventory_dates WHERE bucket = ? ORDER BY key',
      )
      .all(bucket) as unknown as DatingRow[];
    return rows.map((row) => ({
      key: row.key,
      size: row.size,
      etag: row.etag,
      source: row.source,
      takenAt: row.taken_at,
      detail: row.detail,
      exifRead: row.exif_read === 1,
    }));
  }
}
