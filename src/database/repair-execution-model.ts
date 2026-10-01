import { DatabaseSync } from 'node:sqlite';
import * as os from 'os';
import { S3_SEND_MAX_DURATION_MS } from '../clients/s3-client';
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
  lastActivityAt: Date; // rafraîchie à chaque ligne traitée
}

/**
 * Durée maximale d'une ligne, entre deux rafraîchissements de l'activité : HEAD, copie serveur, HEAD de vérification, chacun
 * borné par l'échéance d'envoi du point d'accès (délais de connexion et d'inactivité × tentatives du SDK + attentes).
 */
export const MAX_LINE_DURATION_MS = 3 * S3_SEND_MAX_DURATION_MS;

/** Marge pour les écritures du journal et les écarts d'horloge usuels. */
const LOCK_IDLE_MARGIN_MS = 10 * 60_000;

/**
 * Durée sans activité au-delà de laquelle un verrou peut être levé explicitement, quels que soient le poste et le processus.
 * Dérivée des délais S3 : strictement supérieure à la durée maximale d'une ligne, une exécution vivante (même bloquée sur
 * une requête) rafraîchit donc toujours son activité avant ce seuil. Valeur actuelle : 60 min.
 */
export const LOCK_IDLE_MINUTES = Math.ceil((MAX_LINE_DURATION_MS + LOCK_IDLE_MARGIN_MS) / 60_000);

const IDLE_MS = LOCK_IDLE_MINUTES * 60_000;

/** Instant à partir duquel le verrou peut être levé explicitement. */
export const liftableAt = (lock: ExecutionLock): Date => new Date(lock.lastActivityAt.getTime() + IDLE_MS);

const describeLock = (lock: ExecutionLock): string =>
  `plan ${lock.planId.slice(0, 12)}, processus ${lock.pid} sur ${lock.host}, pris le ${lock.acquiredAt.toISOString()}, ` +
  `dernière activité le ${lock.lastActivityAt.toISOString()}`;

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
 * Verrou périmé : posé sur ce poste par un processus qui n'existe plus, ou sans activité depuis `LOCK_IDLE_MINUTES`.
 * Posé sur un autre poste et récent, impossible de savoir : il n'est pas déclaré périmé.
 */
export function isStaleLock(
  lock: ExecutionLock,
  now: Date,
  isAlive: (pid: number) => boolean = isProcessAlive,
  host = os.hostname(),
): boolean {
  return now >= liftableAt(lock) || (lock.host === host && !isAlive(lock.pid));
}

/** Verrou levé, avec la raison qui a permis la levée (pour le message affiché). */
export interface LiftedLock extends ExecutionLock {
  reason: string;
}

export class ExecutionLockedError extends Error {
  constructor(
    readonly lock: ExecutionLock,
    readonly stale: boolean,
  ) {
    const lift =
      `--lever-verrou accepté tout de suite si le processus ${lock.pid} n'existe plus sur ce poste (${lock.host}), sinon à partir du ` +
      `${liftableAt(lock).toISOString()} (${LOCK_IDLE_MINUTES} min sans activité)`;
    super(
      stale
        ? `verrou d'exécution périmé (${describeLock(lock)}) : cette exécution s'est arrêtée sans le libérer. Vérifiez ` +
            `qu'aucune exécution ne tourne, puis relancez avec --lever-verrou (${lift})`
        : `une exécution est déjà en cours ou son verrou n'a pas été libéré (${describeLock(lock)}). Attendez sa fin ; si ` +
            `aucune exécution ne tourne, relancez avec ${lift}`,
    );
    this.name = 'ExecutionLockedError';
  }
}

interface LockRow {
  plan_id: string;
  pid: number;
  host: string;
  acquired_at: string;
  last_activity_at: string | null; // null : verrou antérieur à la migration 8 (jamais en pratique)
}

interface EntryRow {
  source_key: string;
  destination: string;
  state: ExecutionState;
  copy_attempted: number;
  message: string | null;
}

/**
 * Journal d'exécution du plan de réparation (stories 3.1 et 3.2), persistant et écrit ligne par ligne. Toujours filtré par
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
      .prepare('SELECT source_key, destination, state, copy_attempted, message FROM repair_execution_lines WHERE plan_id = ?')
      .all(planId) as unknown as EntryRow[];
    return new Map(
      rows.map((r) => [r.source_key, { destination: r.destination, state: r.state, copyAttempted: r.copy_attempted === 1, message: r.message }]),
    );
  }

  /** Dernière écriture du journal de ce plan (fin de l'exécution, pour le rapport), `null` s'il n'a pas de journal. */
  lastUpdate(planId: string): Date | null {
    const row = this.db.prepare('SELECT MAX(updated_at) AS last FROM repair_execution_lines WHERE plan_id = ?').get(planId) as unknown as {
      last: string | null;
    };
    return row.last ? new Date(row.last) : null;
  }

  /** Empreintes des plans ayant un journal d'exécution. */
  findPlanIds(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT plan_id FROM repair_execution_lines ORDER BY plan_id').all() as unknown as { plan_id: string }[];
    return rows.map((r) => r.plan_id);
  }

  findLock(): ExecutionLock | null {
    const row = this.db
      .prepare('SELECT plan_id, pid, host, acquired_at, last_activity_at FROM repair_execution_lock')
      .get() as unknown as LockRow | undefined;
    if (!row) return null;
    const acquiredAt = new Date(row.acquired_at);
    return { planId: row.plan_id, pid: row.pid, host: row.host, acquiredAt, lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : acquiredAt };
  }

  /**
   * Prend le verrou d'exécution exclusif ; lève `ExecutionLockedError` s'il est déjà pris (par une exécution en cours ou
   * périmée : jamais levé en silence). La clé primaire départage deux prises simultanées.
   */
  acquireLock(planId: string, owner: LockOwner = currentOwner(), isAlive: (pid: number) => boolean = isProcessAlive, at = new Date()): void {
    const refuse = (): never => {
      const lock = this.findLock()!;
      throw new ExecutionLockedError(lock, isStaleLock(lock, at, isAlive, owner.host));
    };
    if (this.findLock()) refuse();
    try {
      this.db
        .prepare('INSERT INTO repair_execution_lock (id, plan_id, pid, host, acquired_at, last_activity_at) VALUES (1, ?, ?, ?, ?, ?)')
        .run(planId, owner.pid, owner.host, at.toISOString(), at.toISOString());
    } catch (error) {
      if (this.findLock()) refuse();
      throw error;
    }
  }

  /**
   * Rafraîchit l'activité du verrou détenu par `owner` ; rend `false` si `owner` ne le détient plus (levé pendant une mise
   * en veille, par exemple) : l'exécution doit alors s'arrêter.
   */
  touchLock(owner: LockOwner = currentOwner(), at: Date = new Date()): boolean {
    const result = this.db
      .prepare('UPDATE repair_execution_lock SET last_activity_at = ? WHERE id = 1 AND pid = ? AND host = ?')
      .run(at.toISOString(), owner.pid, owner.host);
    return Number(result.changes) === 1;
  }

  /** Libère le verrou s'il appartient à `owner`. */
  releaseLock(owner: LockOwner = currentOwner()): void {
    this.db.prepare('DELETE FROM repair_execution_lock WHERE pid = ? AND host = ?').run(owner.pid, owner.host);
  }

  /**
   * Levée explicite (`--lever-verrou`). Immédiate si le verrou a été posé sur CE poste par un processus qui n'existe plus
   * (aucune exécution ne peut tourner depuis ce poste : coupure franche, terminal fermé). Sinon refusée tant que la dernière
   * activité date de moins de `LOCK_IDLE_MINUTES`, quels que soient le poste et le processus (un nom d'hôte changeant ou un
   * PID réutilisé ne prouvent rien) ; au-delà, levée même si le PID existe encore sur ce poste (réutilisé) ou si le verrou
   * vient d'un autre poste. Rend le verrou levé et la raison, ou `null` s'il n'y en avait pas.
   * Limite assumée (outil local, mono-utilisateur) : un processus vivant dans un autre espace de PID au même nom d'hôte
   * (terminal d'éditeur en Flatpak, conteneur `--network host`) paraît absent ; ne pas lancer deux exécutions depuis de
   * tels environnements.
   */
  forceReleaseLock(now: Date = new Date(), isAlive: (pid: number) => boolean = isProcessAlive, host = os.hostname()): LiftedLock | null {
    const lock = this.findLock();
    if (!lock) return null;
    let reason: string;
    if (lock.host === host && !isAlive(lock.pid)) {
      reason = `processus ${lock.pid} absent de ce poste`;
    } else if (now >= liftableAt(lock)) {
      reason = `${LOCK_IDLE_MINUTES} min sans activité`;
    } else {
      // Horodatages de l'horloge système : une activité « dans le futur » signale une horloge reculée (ou un autre poste
      // en avance) ; la levée reste refusée jusqu'à l'échéance, et l'écart est affiché.
      const elapsed = Math.floor((now.getTime() - lock.lastActivityAt.getTime()) / 60_000);
      const since =
        elapsed >= 0
          ? `dernière activité il y a ${elapsed} min`
          : `dernière activité datée de ${-elapsed} min dans le futur par rapport à l'heure actuelle (horloge reculée ?)`;
      throw new Error(
        `verrou non levé : ${since} (${describeLock(lock)}), il est possible qu'une exécution tourne encore. ` +
          `Levée possible à partir du ${liftableAt(lock).toISOString()} (${LOCK_IDLE_MINUTES} min sans activité)`,
      );
    }
    // Suppression conditionnée au verrou lu : un verrou repris ou rafraîchi entre-temps n'est pas levé.
    const result = this.db
      .prepare('DELETE FROM repair_execution_lock WHERE id = 1 AND pid = ? AND host = ? AND acquired_at = ? AND last_activity_at = ?')
      .run(lock.pid, lock.host, lock.acquiredAt.toISOString(), lock.lastActivityAt.toISOString());
    if (Number(result.changes) !== 1) {
      throw new Error('verrou non levé : il a été repris ou rafraîchi pendant la levée, une exécution tourne. Relancez la commande pour réévaluer');
    }
    return { ...lock, reason };
  }

  /** `copyAttempted` omis : inchangé. */
  record(
    planId: string,
    sourceKey: string,
    state: ExecutionState,
    message: string | null,
    copyAttempted?: boolean,
    at: Date = new Date(),
  ): void {
    const attempted = copyAttempted === undefined ? null : copyAttempted ? 1 : 0;
    const result = this.db
      .prepare(
        `UPDATE repair_execution_lines SET state = ?, message = ?, copy_attempted = COALESCE(?, copy_attempted), updated_at = ?
         WHERE plan_id = ? AND source_key = ?`,
      )
      .run(state, message, attempted, at.toISOString(), planId, sourceKey);
    if (Number(result.changes) !== 1) {
      throw new Error(`journal d'exécution : ligne absente pour ${sourceKey} (plan ${planId})`);
    }
  }
}
