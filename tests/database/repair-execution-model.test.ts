import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { DatabaseSync } from 'node:sqlite';
import {
  S3_CONNECTION_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_TIMEOUT_MS,
  S3_SEND_DEADLINE_MS,
  S3_SEND_MAX_DURATION_MS,
  SDK_MAX_RETRY_DELAY_MS,
} from '../../src/clients/s3-client';
import { closeDatabase, getDatabase, initDatabase, MIGRATIONS } from '../../src/database/connection';
import {
  currentOwner,
  ExecutionLock,
  ExecutionLockedError,
  isProcessAlive,
  isStaleLock,
  LOCK_IDLE_MINUTES,
  MAX_LINE_DURATION_MS,
  RepairExecutionModel,
} from '../../src/database/repair-execution-model';

describe('RepairExecutionModel (journal d\'exécution, migrations 7 et 8)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-journal-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  const lines = [
    { sourceKey: 'backup_google_photos/photos/a.jpg', destination: 'photos/2016/2016-02/a.jpg' },
    { sourceKey: 'backup_google_photos/photos/b.jpg', destination: 'quarantaine/backup_google_photos/photos/b.jpg' },
  ];

  it('dernière écriture du journal d\'un plan et plans journalisés (rapport, story 3.3)', () => {
    const journal = new RepairExecutionModel();
    expect(journal.lastUpdate('plan-1')).toBeNull();
    expect(journal.findPlanIds()).toEqual([]);
    journal.prepare('plan-1', lines, new Date('2026-09-15T10:00:00Z'));
    journal.record('plan-1', lines[0]!.sourceKey, 'copie', null, true, new Date('2026-09-15T11:00:00Z'));
    journal.prepare('plan-0', lines, new Date('2026-09-15T12:00:00Z'));
    expect(journal.lastUpdate('plan-1')).toEqual(new Date('2026-09-15T11:00:00Z'));
    expect(journal.findPlanIds()).toEqual(['plan-0', 'plan-1']);
  });

  it('prépare les lignes à faire, enregistre les états au fil de l\'eau, sans écraser à la re-préparation', () => {
    const journal = new RepairExecutionModel();
    journal.prepare('plan-1', lines);
    journal.record('plan-1', lines[0]!.sourceKey, 'copie', null);
    journal.record('plan-1', lines[1]!.sourceKey, 'echec', 'destination déjà occupée');
    journal.prepare('plan-1', lines);
    expect(journal.findStates('plan-1')).toEqual(
      new Map([
        [lines[0]!.sourceKey, { destination: lines[0]!.destination, state: 'copie', copyAttempted: false, message: null }],
        [lines[1]!.sourceKey, { destination: lines[1]!.destination, state: 'echec', copyAttempted: false, message: 'destination déjà occupée' }],
      ]),
    );
  });

  it('est lié à l\'empreinte : le journal d\'un autre plan n\'est jamais lu', () => {
    const journal = new RepairExecutionModel();
    journal.prepare('plan-1', lines);
    journal.record('plan-1', lines[0]!.sourceKey, 'copie', null);
    expect(journal.findStates('plan-2').size).toBe(0);
    journal.prepare('plan-2', lines);
    expect(journal.findStates('plan-2').get(lines[0]!.sourceKey)?.state).toBe('a_faire');
    expect(journal.findStates('plan-1').get(lines[0]!.sourceKey)?.state).toBe('copie');
  });

  it('refuse d\'enregistrer une ligne non préparée ou un état inconnu', () => {
    const journal = new RepairExecutionModel();
    expect(() => journal.record('plan-1', 'inconnue.jpg', 'copie', null)).toThrow('ligne absente');
    journal.prepare('plan-1', lines);
    expect(() => journal.record('plan-1', lines[0]!.sourceKey, 'en_cours' as never, null)).toThrow();
  });

  it('copie_en_cours et copie tentée : persistées ; omise, la tentative est conservée ; false l\'efface (412)', () => {
    const journal = new RepairExecutionModel();
    journal.prepare('plan-1', lines);
    const key = lines[0]!.sourceKey;
    const entry = (): unknown => journal.findStates('plan-1').get(key);
    journal.record('plan-1', key, 'copie_en_cours', null, true);
    expect(entry()).toMatchObject({ state: 'copie_en_cours', copyAttempted: true });
    journal.record('plan-1', key, 'echec', 'copie en échec : TimeoutError: socket hang up');
    expect(entry()).toMatchObject({ state: 'echec', copyAttempted: true });
    journal.record('plan-1', key, 'echec', 'source modifiée', false);
    expect(entry()).toMatchObject({ state: 'echec', copyAttempted: false });
    journal.prepare('plan-1', lines);
    expect(entry()).toMatchObject({ state: 'echec', copyAttempted: false, message: 'source modifiée' });
  });

  describe('verrou d\'exécution exclusif', () => {
    const me = { pid: 1000, host: 'poste' };
    const other = { pid: 2000, host: 'poste' };
    const alive = (pids: number[]) => (pid: number): boolean => pids.includes(pid);
    const T0 = new Date('2026-09-15T20:00:00.000Z');
    const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

    it('refuse une seconde exécution tant que la première tourne, puis se libère', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000, 2000]), T0);
      expect(journal.findLock()).toMatchObject({ planId: 'plan-1', pid: 1000, host: 'poste', acquiredAt: T0, lastActivityAt: T0 });
      let error: unknown;
      try {
        journal.acquireLock('plan-1', other, alive([1000, 2000]), minutes(1));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ExecutionLockedError);
      expect((error as ExecutionLockedError).stale).toBe(false);
      expect((error as Error).message).toMatch('déjà en cours');
      expect((error as Error).message).toMatch(`--lever-verrou accepté à partir du ${minutes(LOCK_IDLE_MINUTES).toISOString()}`);
      journal.releaseLock(other); // un autre processus ne libère pas le verrou d'autrui
      expect(journal.findLock()?.pid).toBe(1000);
      journal.releaseLock(me);
      expect(journal.findLock()).toBeNull();
      expect(() => journal.acquireLock('plan-1', other, alive([2000]), minutes(2))).not.toThrow();
    });

    it('activité rafraîchie par le détenteur seul ; touchLock rend false si le verrou n\'est plus détenu', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000]), T0);
      expect(journal.touchLock(me, minutes(10))).toBe(true);
      expect(journal.findLock()).toMatchObject({ acquiredAt: T0, lastActivityAt: minutes(10) });
      expect(journal.touchLock(other, minutes(11))).toBe(false);
      expect(journal.touchLock({ pid: 1000, host: 'autre-poste' }, minutes(11))).toBe(false);
      expect(journal.findLock()?.lastActivityAt).toEqual(minutes(10));
      journal.forceReleaseLock(minutes(10 + LOCK_IDLE_MINUTES));
      expect(journal.touchLock(me, minutes(40))).toBe(false);
    });

    it('verrou périmé (processus mort) : détecté, jamais levé en silence ; levée refusée tant que l\'activité est récente', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000]), T0);
      expect(() => journal.acquireLock('plan-1', other, alive([2000]), minutes(1))).toThrow('verrou d\'exécution périmé');
      expect(journal.findLock()?.pid).toBe(1000);
      expect(() => journal.forceReleaseLock(minutes(LOCK_IDLE_MINUTES - 1))).toThrow('il est possible qu\'une exécution tourne encore');
      expect(journal.findLock()?.pid).toBe(1000);
      expect(journal.forceReleaseLock(minutes(LOCK_IDLE_MINUTES))).toMatchObject({ pid: 1000 });
      expect(journal.findLock()).toBeNull();
      expect(journal.forceReleaseLock(minutes(60))).toBeNull();
    });

    it.each([
      ['PID vivant sur ce poste', { pid: 1000, host: 'poste' }],
      ['PID mort sur ce poste', { pid: 1001, host: 'poste' }],
      ['autre poste (nom d\'hôte changé, data/ partagé)', { pid: 1000, host: 'autre-poste' }],
    ])('activité récente : levée refusée quel que soit le propriétaire (%s), message explicite', (_label, owner) => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', owner, () => true, T0);
      journal.touchLock(owner, minutes(20));
      let message = '';
      try {
        journal.forceReleaseLock(minutes(20 + LOCK_IDLE_MINUTES - 1));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(`verrou non levé : dernière activité il y a ${LOCK_IDLE_MINUTES - 1} min`);
      expect(message).toMatch(`processus ${owner.pid} sur ${owner.host}`);
      expect(message).toMatch(`dernière activité le ${minutes(20).toISOString()}`);
      expect(message).toMatch(`Levée possible à partir du ${minutes(20 + LOCK_IDLE_MINUTES).toISOString()}`);
      expect(journal.findLock()?.pid).toBe(owner.pid);
    });

    it.each([
      ['PID réutilisé (vivant sur ce poste)', { pid: process.pid, host: currentOwner().host }],
      ['autre poste', { pid: 1, host: 'autre-poste' }],
    ])('activité ancienne : levée autorisée (%s) et verrou périmé', (_label, owner) => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', owner, () => true, T0);
      const lock = journal.findLock() as ExecutionLock;
      expect(isStaleLock(lock, minutes(LOCK_IDLE_MINUTES - 1), () => true, currentOwner().host)).toBe(false);
      expect(isStaleLock(lock, minutes(LOCK_IDLE_MINUTES), () => true, currentOwner().host)).toBe(true);
      expect(journal.forceReleaseLock(minutes(LOCK_IDLE_MINUTES + 30))).toMatchObject(owner);
      expect(journal.findLock()).toBeNull();
    });

    it('seuil de levée dérivé des délais S3, strictement supérieur à la durée maximale d\'une ligne', () => {
      // Une requête : chaque tentative épuise au plus connexion + inactivité, attentes du SDK entre tentatives, et une
      // attente de plus si l'échéance tombe pendant l'une d'elles.
      const oneRequest =
        S3_MAX_ATTEMPTS * (S3_CONNECTION_TIMEOUT_MS + S3_REQUEST_TIMEOUT_MS) + (S3_MAX_ATTEMPTS - 1) * SDK_MAX_RETRY_DELAY_MS;
      expect(S3_SEND_DEADLINE_MS).toBe(oneRequest);
      expect(S3_SEND_MAX_DURATION_MS).toBe(oneRequest + SDK_MAX_RETRY_DELAY_MS);
      // Une ligne : HEAD, copie, HEAD de vérification.
      const oneLine = 3 * (oneRequest + SDK_MAX_RETRY_DELAY_MS);
      expect(MAX_LINE_DURATION_MS).toBe(oneLine);
      expect(LOCK_IDLE_MINUTES * 60_000).toBeGreaterThan(oneLine);
      // Délai d'inactivité compatible avec la copie serveur du plus gros objet (687 Mo) à 2,3 Mo/s.
      expect(687e6 / 2.3e6).toBeLessThan(S3_REQUEST_TIMEOUT_MS / 1000);
      expect(LOCK_IDLE_MINUTES).toBe(60);
    });

    it('levée : verrou repris ou rafraîchi entre la lecture et la suppression → erreur explicite, verrou intact', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000]), T0);
      const stale = journal.findLock()!;
      journal.touchLock(me, minutes(LOCK_IDLE_MINUTES + 5)); // l'exécution se réveille et rafraîchit
      jest.spyOn(journal, 'findLock').mockReturnValueOnce(stale);
      expect(() => journal.forceReleaseLock(minutes(LOCK_IDLE_MINUTES + 1))).toThrow('repris ou rafraîchi pendant la levée');
      expect(journal.findLock()).toMatchObject({ pid: 1000, lastActivityAt: minutes(LOCK_IDLE_MINUTES + 5) });
    });

    it('horloge reculée : dernière activité dans le futur → levée refusée, écart affiché', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000]), minutes(30));
      expect(() => journal.forceReleaseLock(T0)).toThrow('dernière activité datée de 30 min dans le futur par rapport à l\'heure actuelle (horloge reculée ?)');
      expect(journal.findLock()?.pid).toBe(1000);
    });

    it('verrou récent d\'un autre poste : non déclaré périmé', () => {
      const lock: ExecutionLock = { planId: 'p', pid: 1, host: 'autre-poste', acquiredAt: T0, lastActivityAt: T0 };
      expect(isStaleLock(lock, minutes(1), () => false, 'poste')).toBe(false);
    });

    it('isProcessAlive : ce processus existe, un pid libre non', () => {
      expect(isProcessAlive(currentOwner().pid)).toBe(true);
      expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
    });
  });
  describe('migration 8 : journal et verrou d\'une exécution 3.1', () => {
    it('reprend un journal 3.1 tel quel (copie non réputée tentée) et date l\'activité du verrou à sa prise', async () => {
      closeDatabase();
      const file = path.join(dir, 'journal-3-1.db');
      // Base au schéma de la story 3.1 : les vraies migrations 1 à 7, puis un journal et un verrou écrits par la 3.1.
      const old = new DatabaseSync(file);
      old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
      for (const m of MIGRATIONS.filter((m) => m.version <= 7)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name);
      }
      const insert = old.prepare('INSERT INTO repair_execution_lines (plan_id, source_key, destination, state, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('plan-1', lines[0]!.sourceKey, lines[0]!.destination, 'copie', null, '2026-09-15T20:00:00.000Z');
      insert.run('plan-1', lines[1]!.sourceKey, lines[1]!.destination, 'echec', 'copie en échec', '2026-09-15T20:01:00.000Z');
      expect(() => insert.run('plan-1', 'x', 'photos/x', 'copie_en_cours', null, 'x')).toThrow(); // état inconnu en 3.1
      old.prepare('INSERT INTO repair_execution_lock (id, plan_id, pid, host, acquired_at) VALUES (1, ?, ?, ?, ?)').run('plan-1', 42, 'poste', '2026-09-15T20:00:00.000Z');
      old.close();

      await initDatabase({ path: file });
      const version = getDatabase().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
      expect(version.v).toBe(8);
      const journal = new RepairExecutionModel();
      expect(journal.findStates('plan-1')).toEqual(
        new Map([
          [lines[0]!.sourceKey, { destination: lines[0]!.destination, state: 'copie', copyAttempted: false, message: null }],
          [lines[1]!.sourceKey, { destination: lines[1]!.destination, state: 'echec', copyAttempted: false, message: 'copie en échec' }],
        ]),
      );
      const acquired = new Date('2026-09-15T20:00:00.000Z');
      expect(journal.findLock()).toEqual({ planId: 'plan-1', pid: 42, host: 'poste', acquiredAt: acquired, lastActivityAt: acquired });
      journal.record('plan-1', lines[1]!.sourceKey, 'copie_en_cours', null, true);
      expect(journal.findStates('plan-1').get(lines[1]!.sourceKey)).toMatchObject({ state: 'copie_en_cours', copyAttempted: true });
    });
  });
});
