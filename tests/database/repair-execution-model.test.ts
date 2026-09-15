import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { closeDatabase, initDatabase } from '../../src/database/connection';
import {
  currentOwner,
  ExecutionLockedError,
  isProcessAlive,
  isStaleLock,
  RepairExecutionModel,
} from '../../src/database/repair-execution-model';

describe('RepairExecutionModel (journal d\'exécution, migration 7)', () => {
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

  it('prépare les lignes à faire, enregistre les états au fil de l\'eau, sans écraser à la re-préparation', () => {
    const journal = new RepairExecutionModel();
    journal.prepare('plan-1', lines);
    journal.record('plan-1', lines[0]!.sourceKey, 'copie', null);
    journal.record('plan-1', lines[1]!.sourceKey, 'echec', 'destination déjà occupée');
    journal.prepare('plan-1', lines);
    expect(journal.findStates('plan-1')).toEqual(
      new Map([
        [lines[0]!.sourceKey, { destination: lines[0]!.destination, state: 'copie', message: null }],
        [lines[1]!.sourceKey, { destination: lines[1]!.destination, state: 'echec', message: 'destination déjà occupée' }],
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

  describe('verrou d\'exécution exclusif', () => {
    const me = { pid: 1000, host: 'poste' };
    const other = { pid: 2000, host: 'poste' };
    const alive = (pids: number[]) => (pid: number): boolean => pids.includes(pid);

    it('refuse une seconde exécution tant que la première tourne, puis se libère', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000, 2000]));
      expect(journal.findLock()).toMatchObject({ planId: 'plan-1', pid: 1000, host: 'poste' });
      let error: unknown;
      try {
        journal.acquireLock('plan-1', other, alive([1000, 2000]));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ExecutionLockedError);
      expect((error as ExecutionLockedError).stale).toBe(false);
      expect((error as Error).message).toMatch('déjà en cours');
      journal.releaseLock(other); // un autre processus ne libère pas le verrou d'autrui
      expect(journal.findLock()?.pid).toBe(1000);
      journal.releaseLock(me);
      expect(journal.findLock()).toBeNull();
      expect(() => journal.acquireLock('plan-1', other, alive([2000]))).not.toThrow();
    });

    it('verrou périmé (processus mort) : détecté, jamais levé en silence, levable explicitement', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000]));
      expect(() => journal.acquireLock('plan-1', other, alive([2000]))).toThrow('verrou d\'exécution périmé');
      expect(journal.findLock()?.pid).toBe(1000);
      expect(journal.forceReleaseLock(alive([2000]), 'poste')).toMatchObject({ pid: 1000 });
      expect(journal.findLock()).toBeNull();
      expect(journal.forceReleaseLock(alive([]), 'poste')).toBeNull();
    });

    it('levée explicite refusée si le propriétaire tourne encore sur ce poste', () => {
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', me, alive([1000]));
      expect(() => journal.forceReleaseLock(alive([1000]), 'poste')).toThrow('tourne encore');
      expect(journal.findLock()?.pid).toBe(1000);
    });

    it('verrou d\'un autre poste : non déclaré périmé, mais levable explicitement', () => {
      expect(isStaleLock({ pid: 1, host: 'autre-poste' }, () => false, 'poste')).toBe(false);
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-1', { pid: 1, host: 'autre-poste' }, () => true);
      expect(journal.forceReleaseLock(() => true, 'poste')).toMatchObject({ host: 'autre-poste' });
    });

    it('isProcessAlive : ce processus existe, un pid libre non', () => {
      expect(isProcessAlive(currentOwner().pid)).toBe(true);
      expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
    });
  });
});
