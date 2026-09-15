import { DatabaseSync } from 'node:sqlite';
import { getDatabase, inTransaction } from './connection';
import { BucketObject } from '../clients/types';

export interface InventoryRun {
  bucket: string;
  completedAt: Date;
  objectCount: number;
  totalSize: number;
}

interface ObjectRow {
  key: string;
  size: number;
  last_modified: string | null;
  etag: string | null;
}

interface RunRow {
  bucket: string;
  completed_at: string;
  object_count: number;
  total_size: number;
}

/**
 * Inventaire local d'un bucket : un seul inventaire complet par bucket, remplacé d'un bloc.
 */
export class InventoryModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Remplace l'inventaire du bucket en une seule transaction : soit l'ancien reste intact,
   * soit le nouveau est complet. Jamais d'état intermédiaire.
   */
  replace(bucket: string, objects: BucketObject[], completedAt: Date = new Date()): InventoryRun {
    const run: InventoryRun = {
      bucket,
      completedAt,
      objectCount: objects.length,
      totalSize: objects.reduce((total, object) => total + object.size, 0),
    };

    inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM inventory_objects WHERE bucket = ?').run(bucket);
      const insert = this.db.prepare(
        'INSERT INTO inventory_objects (bucket, key, size, last_modified, etag) VALUES (?, ?, ?, ?, ?)',
      );
      for (const object of objects) {
        insert.run(bucket, object.key, object.size, object.lastModified?.toISOString() ?? null, object.etag);
      }
      this.db
        .prepare(
          `INSERT INTO inventory_runs (bucket, completed_at, object_count, total_size) VALUES (?, ?, ?, ?)
           ON CONFLICT(bucket) DO UPDATE SET completed_at = excluded.completed_at,
             object_count = excluded.object_count, total_size = excluded.total_size`,
        )
        .run(bucket, completedAt.toISOString(), run.objectCount, run.totalSize);
    });

    return run;
  }

  findAll(bucket: string): BucketObject[] {
    const rows = this.db
      .prepare('SELECT key, size, last_modified, etag FROM inventory_objects WHERE bucket = ? ORDER BY key')
      .all(bucket) as unknown as ObjectRow[];
    return rows.map((row) => ({
      key: row.key,
      size: row.size,
      lastModified: row.last_modified ? new Date(row.last_modified) : null,
      etag: row.etag,
    }));
  }

  findRun(bucket: string): InventoryRun | null {
    const row = this.db.prepare('SELECT * FROM inventory_runs WHERE bucket = ?').get(bucket) as unknown as
      | RunRow
      | undefined;
    if (!row) return null;
    return {
      bucket: row.bucket,
      completedAt: new Date(row.completed_at),
      objectCount: row.object_count,
      totalSize: row.total_size,
    };
  }
}
