import { DatabaseSync } from 'node:sqlite';
import { getDatabase, inTransaction } from './connection';
import { planFingerprint } from '../inventory/repair-plan';
import type { PlanAction, PlanLine, PlanRefusal, RepairPlan } from '../inventory/repair-plan';

/** Issue de l'enregistrement : plan identique au plan courant (rien réécrit), nouveau, ou remplaçant un autre plan. */
export type PlanSaveOutcome = 'inchange' | 'cree' | 'remplace' | 'repare';

export interface StoredPlan {
  plan: RepairPlan;
  generatedAt: Date;
}

interface PlanRow {
  id: string;
  source_bucket: string;
  destination_bucket: string;
  config: string;
  index_state: string;
  executable: number;
  exclusions: string;
  unrecognized: string;
  naming_anomalies: string;
  violations: string;
  generated_at: string;
}

interface LineRow {
  source_key: string;
  size: number;
  etag: string | null;
  action: PlanAction;
  destination: string | null;
  kept_key: string | null;
  reason: string;
}

/**
 * Plan de réparation courant. Un seul plan à la fois (KISS) : régénérer un plan identique ne réécrit rien, un plan
 * différent remplace l'ancien dans une transaction (jamais de plan à moitié écrit). Une génération refusée est
 * enregistrée à part, sans toucher au plan courant ; la génération réussie suivante l'efface.
 */
export class RepairPlanModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  save(plan: RepairPlan, generatedAt: Date = new Date()): PlanSaveOutcome {
    return inTransaction(this.db, () => {
      this.db.exec('DELETE FROM repair_plan_refusals');
      const ids = (this.db.prepare('SELECT id FROM repair_plans').all() as unknown as { id: string }[]).map((r) => r.id);
      const sameId = ids.length === 1 && ids[0] === plan.id;
      if (sameId) {
        // « Inchangé » seulement si le plan en base est intact : un contenu altéré sous la même empreinte est réécrit.
        const stored = this.findCurrent()!.plan;
        if (planFingerprint(stored) === plan.id && stored.executable === plan.executable) return 'inchange';
      }

      this.db.exec('DELETE FROM repair_plan_lines; DELETE FROM repair_plans;');
      this.db
        .prepare(
          `INSERT INTO repair_plans (id, source_bucket, destination_bucket, config, index_state, executable,
             exclusions, unrecognized, naming_anomalies, violations, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          plan.id,
          plan.config.sourceBucket,
          plan.config.destinationBucket,
          JSON.stringify(plan.config),
          JSON.stringify(plan.index),
          plan.executable ? 1 : 0,
          JSON.stringify(plan.exclusions),
          JSON.stringify(plan.unrecognized),
          JSON.stringify(plan.namingAnomalies),
          JSON.stringify(plan.violations),
          generatedAt.toISOString(),
        );
      const insert = this.db.prepare(
        `INSERT INTO repair_plan_lines (plan_id, position, source_key, size, etag, action, destination, kept_key, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      plan.lines.forEach((l, position) => {
        insert.run(plan.id, position, l.sourceKey, l.size, l.etag, l.action, l.destination, l.keptKey, l.reason);
      });
      if (sameId) return 'repare';
      return ids.length === 0 ? 'cree' : 'remplace';
    });
  }

  /** Enregistre l'échec de la dernière génération, sans modifier le plan courant. */
  recordRefusal(reason: string, refusedAt: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO repair_plan_refusals (id, refused_at, reason) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET refused_at = excluded.refused_at, reason = excluded.reason`,
      )
      .run(refusedAt.toISOString(), reason);
  }

  findLastRefusal(): PlanRefusal | null {
    const row = this.db.prepare('SELECT refused_at, reason FROM repair_plan_refusals').get() as unknown as
      | { refused_at: string; reason: string }
      | undefined;
    return row ? { refusedAt: new Date(row.refused_at), reason: row.reason } : null;
  }

  findCurrent(): StoredPlan | null {
    const row = this.db.prepare('SELECT * FROM repair_plans').get() as unknown as PlanRow | undefined;
    if (!row) return null;
    const lines = this.db
      .prepare(
        `SELECT source_key, size, etag, action, destination, kept_key, reason FROM repair_plan_lines
         WHERE plan_id = ? ORDER BY position`,
      )
      .all(row.id) as unknown as LineRow[];
    return {
      generatedAt: new Date(row.generated_at),
      plan: {
        id: row.id,
        config: JSON.parse(row.config),
        index: JSON.parse(row.index_state),
        executable: row.executable === 1,
        exclusions: JSON.parse(row.exclusions),
        unrecognized: JSON.parse(row.unrecognized),
        namingAnomalies: JSON.parse(row.naming_anomalies),
        violations: JSON.parse(row.violations),
        lines: lines.map(
          (l): PlanLine => ({
            sourceKey: l.source_key,
            sourceBucket: row.source_bucket,
            size: l.size,
            etag: l.etag,
            action: l.action,
            destination: l.destination,
            keptKey: l.kept_key,
            reason: l.reason,
          }),
        ),
      },
    };
  }
}
