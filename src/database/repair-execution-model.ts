import { DatabaseSync } from 'node:sqlite';
import * as os from 'os';
import { getDatabase, inTransaction } from './connection';
import type { ExecutionJournal, ExecutionState, JournalEntry } from '../inventory/plan-execution';

/** Processus propriétaire du verrou d'exécution. */
export interface LockOwner {
  pid: number;
  host: string;
}

export interface ExecutionLock extends LockOwner {
  planId: string;
  acquiredAt: Date;
}

export const currentOwner = (): LockOwner => ({ pid: process.pid, host: os.hostname() });

/** Le processus existe-t-il encore sur ce poste ? (`EPERM` : il existe, sous un autre utilisateur.) */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Verrou périmé : posé sur ce poste par un processus qui n'existe plus. Posé sur un autre poste, il est impossible de le
 * savoir : il n'est pas déclaré périmé, mais peut être levé explicitement.
 */
export function isStaleLock(lock: LockOwner, isAlive: (pid: number) => boolean = isProcessAlive, host = os.hostname()): boolean {
  return lock.host === host && !isAlive(lock.pid);
}

export class ExecutionLockedError extends Error {
  constructor(
    readonly lock: ExecutionLock,
    readonly stale: boolean,
  ) {
    const since = `plan ${lock.planId.slice(0, 12)}, processus ${lock.pid} sur ${lock.host}, depuis le ${lock.acquiredAt.toISOString()}`;
    super(
      stale
        ? `verrou d'exécution périmé (${since}) : cette exécution s'est arrêtée sans le libérer. Vérifiez qu'aucune ` +
            'exécution ne tourne, puis relancez avec --lever-verrou'
        : `une exécution est déjà en cours ou son verrou n'a pas été libéré (${since}). Attendez sa fin ; si aucune ` +
            'exécution ne tourne, relancez avec --lever-verrou',
    );
    this.name = 'ExecutionLockedError';
  }
}

interface LockRow {
  plan_id: string;
  pid: number;
  host: string;
  acquired_at: string;
}

interface EntryRow {
  source_key: string;
  destination: string;
  state: ExecutionState;
  message: string | null;
}

/**
 * Journal d'exécution du plan de réparation (story 3.1), persistant et écrit ligne par ligne. Toujours filtré par
 * empreinte : le journal d'un autre plan n'est jamais lu.
 */
export class RepairExecutionModel implements ExecutionJournal {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  prepare(planId: string, lines: { sourceKey: string; destination: string }[], at: Date = new Date()): void {
    inTransaction(this.db, () => {
      const insert = this.db.prepare(
        `INSERT INTO repair_execution_lines (plan_id, source_key, destination, state, message, updated_at)
         VALUES (?, ?, ?, 'a_faire', NULL, ?) ON CONFLICT(plan_id, source_key) DO NOTHING`,
      );
      for (const line of lines) insert.run(planId, line.sourceKey, line.destination, at.toISOString());
    });
  }

  findStates(planId: string): Map<string, JournalEntry> {
    const rows = this.db
      .prepare('SELECT source_key, destination, state, message FROM repair_execution_lines WHERE plan_id = ?')
      .all(planId) as unknown as EntryRow[];
    return new Map(rows.map((r) => [r.source_key, { destination: r.destination, state: r.state, message: r.message }]));
  }

  findLock(): ExecutionLock | null {
    const row = this.db.prepare('SELECT plan_id, pid, host, acquired_at FROM repair_execution_lock').get() as unknown as LockRow | undefined;
    return row ? { planId: row.plan_id, pid: row.pid, host: row.host, acquiredAt: new Date(row.acquired_at) } : null;
  }

  /**
   * Prend le verrou d'exécution exclusif ; lève `ExecutionLockedError` s'il est déjà pris (par une exécution en cours ou
   * périmée : jamais levé en silence). La clé primaire départage deux prises simultanées.
   */
  acquireLock(planId: string, owner: LockOwner = currentOwner(), isAlive: (pid: number) => boolean = isProcessAlive, at = new Date()): void {
    const refuse = (): never => {
      const lock = this.findLock()!;
      throw new ExecutionLockedError(lock, isStaleLock(lock, isAlive, owner.host));
    };
    if (this.findLock()) refuse();
    try {
      this.db
        .prepare('INSERT INTO repair_execution_lock (id, plan_id, pid, host, acquired_at) VALUES (1, ?, ?, ?, ?)')
        .run(planId, owner.pid, owner.host, at.toISOString());
    } catch (error) {
      if (this.findLock()) refuse();
      throw error;
    }
  }

  /** Libère le verrou s'il appartient à `owner`. */
  releaseLock(owner: LockOwner = currentOwner()): void {
    this.db.prepare('DELETE FROM repair_execution_lock WHERE pid = ? AND host = ?').run(owner.pid, owner.host);
  }

  /**
   * Levée explicite (`--lever-verrou`) : refusée si le propriétaire tourne encore sur ce poste. Rend le verrou levé, ou
   * `null` s'il n'y en avait pas.
   */
  forceReleaseLock(isAlive: (pid: number) => boolean = isProcessAlive, host = os.hostname()): ExecutionLock | null {
    const lock = this.findLock();
    if (!lock) return null;
    if (lock.host === host && isAlive(lock.pid)) {
      throw new Error(`verrou non levé : le processus ${lock.pid} qui l'a pris tourne encore sur ce poste`);
    }
    this.db.exec('DELETE FROM repair_execution_lock');
    return lock;
  }

  record(planId: string, sourceKey: string, state: ExecutionState, message: string | null, at: Date = new Date()): void {
    const result = this.db
      .prepare('UPDATE repair_execution_lines SET state = ?, message = ?, updated_at = ? WHERE plan_id = ? AND source_key = ?')
      .run(state, message, at.toISOString(), planId, sourceKey);
    if (Number(result.changes) !== 1) {
      throw new Error(`journal d'exécution : ligne absente pour ${sourceKey} (plan ${planId})`);
    }
  }
}
