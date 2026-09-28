import { DatabaseSync } from 'node:sqlite';
import { archivePlanFingerprint, ArchivePlanRefusal, TakeoutPlanAction, TakeoutPlanLine, TakeoutArchivePlan } from '../takeout/archive-plan';
import { getDatabase, inTransaction } from './connection';

/** Issue de l'enregistrement, comme `RepairPlanModel` (2.4/3.1). */
export type ArchivePlanSaveOutcome = 'inchange' | 'cree' | 'remplace' | 'repare';

export interface StoredArchivePlan {
  plan: TakeoutArchivePlan;
  generatedAt: Date;
}

interface PlanRow {
  export_id: string;
  id: string;
  destination_bucket: string;
  kept_albums: string;
  analysis_analyzed_at: string;
  destination_inventory_completed_at: string | null;
  naming_anomalies: string;
  violations: string;
  executable: number;
  generated_at: string;
}

interface LineRow {
  part: string;
  path: string;
  folder: string;
  file_name: string;
  size: number;
  md5: string;
  date_source: string;
  action: TakeoutPlanAction;
  destination: string | null;
  kept_of_part: string | null;
  kept_of_path: string | null;
  archived_etag: string | null;
  reason: string;
}

/**
 * Plan d'archivage courant d'un export Takeout (story 4.3). Un seul plan par export ; régénérer un plan identique ne
 * réécrit rien, un plan différent remplace l'ancien dans une transaction. Une génération refusée est enregistrée à
 * part, sans toucher au plan courant de cet export.
 */
export class TakeoutPlanModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  save(plan: TakeoutArchivePlan, generatedAt: Date = new Date()): ArchivePlanSaveOutcome {
    return inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM takeout_archive_plan_refusals WHERE export_id = ?').run(plan.exportId);
      const existingId = (
        this.db.prepare('SELECT id FROM takeout_archive_plans WHERE export_id = ?').get(plan.exportId) as unknown as { id: string } | undefined
      )?.id;
      const sameId = existingId === plan.id;
      if (sameId) {
        const stored = this.find(plan.exportId)!.plan;
        if (archivePlanFingerprint(stored) === plan.id && stored.executable === plan.executable) return 'inchange';
      }

      this.db.prepare('DELETE FROM takeout_archive_plan_lines WHERE export_id = ?').run(plan.exportId);
      this.db
        .prepare(
          `INSERT INTO takeout_archive_plans (export_id, id, destination_bucket, kept_albums, analysis_analyzed_at,
             destination_inventory_completed_at, naming_anomalies, violations, executable, generated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(export_id) DO UPDATE SET id = excluded.id, destination_bucket = excluded.destination_bucket,
             kept_albums = excluded.kept_albums, analysis_analyzed_at = excluded.analysis_analyzed_at,
             destination_inventory_completed_at = excluded.destination_inventory_completed_at,
             naming_anomalies = excluded.naming_anomalies, violations = excluded.violations,
             executable = excluded.executable, generated_at = excluded.generated_at`,
        )
        .run(
          plan.exportId, plan.id, plan.destinationBucket, JSON.stringify(plan.keptAlbums), plan.analysisAnalyzedAt,
          plan.destinationInventoryCompletedAt, JSON.stringify(plan.namingAnomalies), JSON.stringify(plan.violations),
          plan.executable ? 1 : 0, generatedAt.toISOString(),
        );
      const insert = this.db.prepare(
        `INSERT INTO takeout_archive_plan_lines (export_id, position, part, path, folder, file_name, size, md5,
           date_source, action, destination, kept_of_part, kept_of_path, archived_etag, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      plan.lines.forEach((l: TakeoutPlanLine, position) => {
        insert.run(
          plan.exportId, position, l.part, l.path, l.folder, l.fileName, l.size, l.md5, l.dateSource, l.action,
          l.destination, l.keptOf?.part ?? null, l.keptOf?.path ?? null, l.archivedEtag, l.reason,
        );
      });
      if (sameId) return 'repare';
      return existingId === undefined ? 'cree' : 'remplace';
    });
  }

  recordRefusal(exportId: string, reason: string, refusedAt: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO takeout_archive_plan_refusals (export_id, refused_at, reason) VALUES (?, ?, ?)
         ON CONFLICT(export_id) DO UPDATE SET refused_at = excluded.refused_at, reason = excluded.reason`,
      )
      .run(exportId, refusedAt.toISOString(), reason);
  }

  findLastRefusal(exportId: string): ArchivePlanRefusal | null {
    const row = this.db.prepare('SELECT refused_at, reason FROM takeout_archive_plan_refusals WHERE export_id = ?').get(exportId) as unknown as
      | { refused_at: string; reason: string }
      | undefined;
    return row ? { refusedAt: new Date(row.refused_at), reason: row.reason } : null;
  }

  find(exportId: string): StoredArchivePlan | null {
    const row = this.db.prepare('SELECT * FROM takeout_archive_plans WHERE export_id = ?').get(exportId) as unknown as PlanRow | undefined;
    if (!row) return null;
    const lines = this.db
      .prepare(
        `SELECT part, path, folder, file_name, size, md5, date_source, action, destination, kept_of_part, kept_of_path, archived_etag, reason
         FROM takeout_archive_plan_lines WHERE export_id = ? ORDER BY position`,
      )
      .all(exportId) as unknown as LineRow[];
    return {
      generatedAt: new Date(row.generated_at),
      plan: {
        id: row.id,
        exportId: row.export_id,
        destinationBucket: row.destination_bucket,
        keptAlbums: JSON.parse(row.kept_albums) as string[],
        analysisAnalyzedAt: row.analysis_analyzed_at,
        destinationInventoryCompletedAt: row.destination_inventory_completed_at,
        namingAnomalies: JSON.parse(row.naming_anomalies),
        violations: JSON.parse(row.violations),
        executable: row.executable === 1,
        lines: lines.map(
          (l): TakeoutPlanLine => ({
            part: l.part, path: l.path, folder: l.folder, fileName: l.file_name, size: l.size, md5: l.md5,
            dateSource: l.date_source as TakeoutPlanLine['dateSource'], action: l.action, destination: l.destination,
            keptOf: l.kept_of_part !== null && l.kept_of_path !== null ? { part: l.kept_of_part, path: l.kept_of_path } : null,
            archivedEtag: l.archived_etag,
            reason: l.reason,
          }),
        ),
      },
    };
  }
}
