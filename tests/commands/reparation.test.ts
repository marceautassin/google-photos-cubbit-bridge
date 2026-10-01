import { CopyObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { S3ArchiveWriter } from '../../src/clients/archive-writer';
import { BucketObject } from '../../src/clients/types';
import { executeCommand, ExecuteDeps } from '../../src/commands/reparation';
import { readPlanInput } from '../../src/commands/plan';
import { AppConfig } from '../../src/config/types';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/connection';
import { InventoryDateModel, ObjectDating } from '../../src/database/inventory-date-model';
import { InventoryModel } from '../../src/database/inventory-model';
import { currentOwner, LOCK_IDLE_MINUTES, RepairExecutionModel } from '../../src/database/repair-execution-model';
import { RepairPlanModel } from '../../src/database/repair-plan-model';
import { buildRepairPlan, RepairPlan } from '../../src/inventory/repair-plan';
import { FakeS3 } from '../fixtures/fake-s3';

const SOURCE = 'marceau';
const DEST = 'marceau-photos';
const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);

// Configuration écrite à la main : `src/config` n'est pas importé (il chargerait le fichier .env).
const config = {
  cubbit: { endpoint: 'https://essai.invalid', accessKeyId: 'id', secretAccessKey: 'secret', bucket: SOURCE },
  sync: { supportedFormats: ['jpg', 'mp4'] },
  repair: {
    sourcePrefixes: ['backup_google_photos/photos/'],
    destinationBucket: DEST,
    keptAlbums: ['mariage'],
    ignoredFileNames: ['.DS_Store'],
    ignoredExtensions: [],
  },
} as unknown as AppConfig;

const objects: BucketObject[] = [
  { key: 'backup_google_photos/photos/2016/IMG_0005.JPG', size: 100, etag: md5('a'), lastModified: null },
  { key: 'backup_google_photos/photos/2025/2025-08/IMG_0005.JPG', size: 100, etag: md5('a'), lastModified: null },
  { key: 'backup_google_photos/photos/mariage/Été & co.jpg'.normalize('NFD'), size: 300, etag: `${md5('b')}-2`, lastModified: null },
  { key: 'backup_google_photos/photos/divers/scan.jpg', size: 50, etag: md5('c'), lastModified: null },
  { key: 'backup_google_photos/photos/.DS_Store', size: 6, etag: md5('d'), lastModified: null },
];

const dating = (o: BucketObject, takenAt: string | null): ObjectDating => ({
  key: o.key,
  size: o.size,
  etag: o.etag,
  source: takenAt ? 'exif' : 'indeterminee',
  takenAt,
  detail: takenAt ? 'DateTimeOriginal' : 'aucune date',
  exifRead: true,
});

const backupZip: BucketObject = { key: 'backups/takeout-20260806-001.zip', size: 9, etag: md5('t'), lastModified: null };

function seedPlan(): RepairPlan {
  new InventoryModel().replace(SOURCE, objects, new Date('2026-09-15T08:00:00Z'));
  new InventoryModel().replace(DEST, [backupZip], new Date('2026-09-15T08:05:00Z'));
  new InventoryDateModel().save(
    SOURCE,
    [dating(objects[0]!, '2016-02-20T10:00:00'), dating(objects[1]!, '2016-02-20T10:00:00'), dating(objects[2]!, '2019-06-01T12:00:00'), dating(objects[3]!, null)],
    new Date('2026-09-15T09:00:00Z'),
  );
  const plan = buildRepairPlan(readPlanInput(config, { destination: DEST }));
  expect(plan.executable).toBe(true);
  new RepairPlanModel().save(plan);
  return plan;
}

describe('gpb reparation executer', () => {
  let dir: string;
  let s3: FakeS3;
  let deps: ExecuteDeps & { createWriter: jest.Mock };
  let output: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-reparation-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
    s3 = new FakeS3();
    for (const o of objects) s3.put(SOURCE, o.key, { size: o.size, etag: o.etag! });
    s3.put(DEST, 'backups/takeout-20260806-001.zip', { size: 9, etag: md5('t') });
    deps = { createWriter: jest.fn((_config, scope) => new S3ArchiveWriter(s3.asClient(), scope)) };
    output = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    closeDatabase();
    await fs.remove(dir);
  });

  const journalCount = (): number =>
    (getDatabase().prepare('SELECT COUNT(*) AS n FROM repair_execution_lines').get() as { n: number }).n;
  const text = (): string => output.join('\n');
  const copyCount = (): number => s3.commandNames().filter((n) => n === 'CopyObjectCommand').length;

  it('sans plan enregistré : refus, code 1', async () => {
    expect(await executeCommand(config, {}, deps)).toBe(1);
    expect(text()).toMatch('aucun plan de réparation enregistré');
    expect(deps.createWriter).not.toHaveBeenCalled();
  });

  it('sans confirmation : simulation, résumé et commande à lancer, aucun client S3, rien écrit, code 0', async () => {
    const plan = seedPlan();
    expect(await executeCommand(config, {}, deps)).toBe(0);
    expect(text()).toMatch('Simulation : rien n\'a été écrit');
    expect(text()).toMatch(`gpb reparation executer --confirmer ${plan.id.slice(0, 12)}`);
    expect(text()).toMatch(/À copier \(photos\/, albums\/\) : 2/);
    expect(text()).toMatch(/En quarantaine \(quarantaine\/\) : 1/);
    expect(deps.createWriter).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
    expect(journalCount()).toBe(0);
  });

  it('empreinte fausse ou trop courte : refus, rien écrit, code 1', async () => {
    const plan = seedPlan();
    for (const confirmer of ['0000000000000', plan.id.slice(0, 11)]) {
      expect(await executeCommand(config, { confirmer }, deps)).toBe(1);
      expect(text()).toMatch('ne correspond pas à l\'empreinte');
    }
    expect(deps.createWriter).not.toHaveBeenCalled();
    expect(journalCount()).toBe(0);
  });

  it('plan périmé (inventaire modifié depuis la génération) : refus même confirmé, rien écrit', async () => {
    const plan = seedPlan();
    new InventoryModel().replace(SOURCE, [...objects, { key: 'backup_google_photos/photos/2020/new.jpg', size: 1, etag: md5('n'), lastModified: null }]);
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
    expect(text()).toMatch('plan périmé');
    expect(text()).toMatch('Exécution refusée, rien n\'a été écrit');
    expect(deps.createWriter).not.toHaveBeenCalled();
    expect(journalCount()).toBe(0);
  });

  it('plan modifié en base (contenu incohérent avec l\'empreinte) : refus', async () => {
    const plan = seedPlan();
    getDatabase().prepare("UPDATE repair_plan_lines SET destination = 'backups/vol.jpg' WHERE action = 'copier'").run();
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
    expect(text()).toMatch('incohérent avec son empreinte');
    expect(deps.createWriter).not.toHaveBeenCalled();
  });

  it('dernière génération refusée : refus', async () => {
    const plan = seedPlan();
    new RepairPlanModel().recordRefusal('média non daté');
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
    expect(text()).toMatch('dernière génération a été refusée');
  });

  it('bucket dédié configuré différent de celui du plan : refus', async () => {
    const plan = seedPlan();
    const other = { ...config, repair: { ...config.repair, destinationBucket: 'marceau-autre' } } as AppConfig;
    expect(await executeCommand(other, { confirmer: plan.id }, deps)).toBe(1);
    expect(text()).toMatch('le plan vise le bucket dédié « marceau-photos »');
    expect(deps.createWriter).not.toHaveBeenCalled();
  });

  it('confirmé : copie côté serveur vers les seuls espaces autorisés, journal, relance idempotente', async () => {
    const plan = seedPlan();
    expect(await executeCommand(config, { confirmer: plan.id.slice(0, 12).toUpperCase() }, deps)).toBe(0);
    expect(deps.createWriter).toHaveBeenCalledWith(config, {
      sourceBucket: SOURCE,
      sourcePrefixes: ['backup_google_photos/photos/'],
      destinationBucket: DEST,
    });
    expect(new RepairExecutionModel().findLock()).toBeNull();
    expect(s3.keys(DEST)).toEqual([
      'albums/mariage/Été & co.jpg'.normalize('NFD'),
      'backups/takeout-20260806-001.zip',
      'photos/2016/2016-02/IMG_0005.JPG',
      'quarantaine/backup_google_photos/photos/divers/scan.jpg',
    ].sort());
    expect(s3.get(DEST, 'backups/takeout-20260806-001.zip')).toEqual({ size: 9, etag: md5('t') });
    expect(s3.keys(SOURCE)).toEqual(objects.map((o) => o.key).sort());
    expect(new Set(s3.commandNames())).toEqual(new Set(['HeadBucketCommand', 'HeadObjectCommand', 'CopyObjectCommand']));
    expect([...new RepairExecutionModel().findStates(plan.id).values()].map((e) => e.state)).toEqual(['copie', 'copie', 'copie']);
    expect(text()).toMatch('Plan exécuté');

    s3.commands.length = 0;
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(0);
    expect(s3.commands).toHaveLength(0);
    expect(text()).toMatch(/Déjà faits d'après le journal : 3/);
  });

  it('confirmé, destination occupée par un objet différent : arrêt de sûreté, rien écrasé, code 1', async () => {
    const plan = seedPlan();
    s3.put(DEST, 'photos/2016/2016-02/IMG_0005.JPG', { size: 1, etag: md5('x') });
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
    expect(text()).toMatch('Arrêt de sûreté');
    expect(text()).toMatch('jamais écrasé');
    expect(s3.get(DEST, 'photos/2016/2016-02/IMG_0005.JPG')).toEqual({ size: 1, etag: md5('x') });
  });

  it('identifiants du bucket dédié incomplets : refus avant toute requête (paire par défaut)', async () => {
    const plan = seedPlan();
    const partial = { ...config, cubbit: { ...config.cubbit, destinationAccessKeyId: 'dest-id' } } as AppConfig;
    expect(await executeCommand(partial, { confirmer: plan.id })).toBe(1);
    expect(text()).toMatch('identifiants du bucket dédié incomplets');
    expect(text()).not.toMatch('dest-id');
    expect(journalCount()).toBe(0);
  });

  it('plan généré sans inventaire du bucket dédié : refus, rien écrit', async () => {
    new InventoryModel().replace(SOURCE, objects, new Date('2026-09-15T08:00:00Z'));
    new InventoryDateModel().save(
      SOURCE,
      [dating(objects[0]!, '2016-02-20T10:00:00'), dating(objects[1]!, '2016-02-20T10:00:00'), dating(objects[2]!, '2019-06-01T12:00:00'), dating(objects[3]!, null)],
    );
    const plan = buildRepairPlan(readPlanInput(config, { destination: DEST }));
    new RepairPlanModel().save(plan);
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
    expect(text()).toMatch('sans inventaire du bucket dédié');
    expect(copyCount()).toBe(0);
  });

  describe('verrou d\'exécution', () => {
    it('une exécution concurrente en cours (processus vivant) : refus, rien écrit, verrou d\'autrui intact', async () => {
      const plan = seedPlan();
      new RepairExecutionModel().acquireLock(plan.id, { pid: process.ppid, host: currentOwner().host });
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      expect(text()).toMatch('une exécution est déjà en cours');
      expect(s3.send).not.toHaveBeenCalled();
      expect(new RepairExecutionModel().findLock()?.pid).toBe(process.ppid);
      // Levée refusée : le propriétaire tourne encore.
      expect(await executeCommand(config, { confirmer: plan.id, leverVerrou: true }, deps)).toBe(1);
      expect(text()).toMatch('tourne encore');
    });

    it('verrou d\'un processus disparu de ce poste : refus explicite, puis levée immédiate (story 4.4) et exécution', async () => {
      const plan = seedPlan();
      const lockedAt = new Date('2026-09-15T20:00:00.000Z');
      const dead = 2 ** 22 + 12345;
      new RepairExecutionModel().acquireLock(plan.id, { pid: dead, host: currentOwner().host }, () => false, lockedAt);
      const at = (minutes: number): (() => Date) => () => new Date(lockedAt.getTime() + minutes * 60_000);
      expect(await executeCommand(config, { confirmer: plan.id }, { ...deps, now: at(1) })).toBe(1);
      expect(text()).toMatch('verrou d\'exécution périmé');
      expect(text()).toMatch('--lever-verrou');
      expect(s3.send).not.toHaveBeenCalled();
      expect(await executeCommand(config, { confirmer: plan.id, leverVerrou: true }, { ...deps, now: at(1) })).toBe(0);
      expect(text()).toMatch(`Verrou levé (processus ${dead} absent de ce poste)`);
      expect(new RepairExecutionModel().findLock()).toBeNull();
    });

    it('verrou d\'un processus vivant : levée refusée tant que l\'activité est récente, puis levée et exécution', async () => {
      const plan = seedPlan();
      const lockedAt = new Date('2026-09-15T20:00:00.000Z');
      const alive = { pid: process.pid, host: currentOwner().host };
      new RepairExecutionModel().acquireLock(plan.id, alive, () => true, lockedAt);
      const at = (minutes: number): (() => Date) => () => new Date(lockedAt.getTime() + minutes * 60_000);
      expect(await executeCommand(config, { confirmer: plan.id, leverVerrou: true }, { ...deps, now: at(LOCK_IDLE_MINUTES - 1) })).toBe(1);
      expect(text()).toMatch(`verrou non levé : dernière activité il y a ${LOCK_IDLE_MINUTES - 1} min`);
      expect(s3.send).not.toHaveBeenCalled();
      expect(await executeCommand(config, { confirmer: plan.id, leverVerrou: true }, { ...deps, now: at(LOCK_IDLE_MINUTES) })).toBe(0);
      expect(text()).toMatch(`Verrou levé (${LOCK_IDLE_MINUTES} min sans activité)`);
      expect(text()).toMatch(`processus ${process.pid} sur ${currentOwner().host}`);
      expect(text()).toMatch(`dernière activité le ${lockedAt.toISOString()}`);
      expect(new RepairExecutionModel().findLock()).toBeNull();
    });

    it('activité rafraîchie à chaque ligne ; verrou levé pendant l\'exécution → arrêt « verrou perdu », code 1', async () => {
      const plan = seedPlan();
      let tick = 0;
      const clock = (): Date => new Date(Date.UTC(2026, 8, 15, 20, tick++));
      const activity: Date[] = [];
      s3.afterCopy = () => {
        const lock = new RepairExecutionModel().findLock();
        if (lock) activity.push(lock.lastActivityAt);
        if (activity.length === 2) getDatabase().exec('DELETE FROM repair_execution_lock');
      };
      expect(await executeCommand(config, { confirmer: plan.id }, { ...deps, now: clock })).toBe(1);
      expect(activity).toHaveLength(2);
      expect(activity[1]!.getTime()).toBeGreaterThan(activity[0]!.getTime());
      expect(text()).toMatch('verrou d\'exécution perdu');
      expect(copyCount()).toBe(2);
    });

    it('verrou libéré aussi sur refus en cours d\'exécution (bucket dédié inaccessible)', async () => {
      const plan = seedPlan();
      s3.buckets.delete(DEST);
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      expect(text()).toMatch('accès au bucket dédié');
      expect(new RepairExecutionModel().findLock()).toBeNull();
    });
  });

  describe('reprise (story 3.2)', () => {
    it('second Ctrl-C sur une vidéo multipart dont Cubbit change l\'ETag : la relance affiche la reprise et termine sans recopier', async () => {
      const plan = seedPlan();
      s3.copyEtag = (source) => (source.etag.includes('-') ? md5('9') : source.etag);
      // Second Ctrl-C : sortie immédiate. Le processus est mort : plus aucune écriture de journal ni requête n'aboutit.
      let dead = false;
      const exit = jest.spyOn(process, 'exit').mockImplementation(((): void => {
        dead = true;
      }) as never);
      const record = RepairExecutionModel.prototype.record;
      jest.spyOn(RepairExecutionModel.prototype, 'record').mockImplementation(function (this: RepairExecutionModel, ...args) {
        if (dead) throw new Error('processus tué');
        return record.apply(this, args);
      });
      s3.afterCopy = (_bucket, key) => {
        if (key.startsWith('albums/')) {
          process.emit('SIGINT');
          process.emit('SIGINT');
          throw new Error('processus tué');
        }
      };
      await expect(executeCommand(config, { confirmer: plan.id }, deps)).rejects.toThrow('processus tué');
      expect(exit).toHaveBeenCalledWith(130);
      jest.mocked(RepairExecutionModel.prototype.record).mockRestore();
      const before = new RepairExecutionModel().findStates(plan.id);
      expect([...before.values()].filter((e) => e.state === 'copie_en_cours')).toHaveLength(1);

      s3.afterCopy = null;
      output.length = 0;
      const copiesBefore = copyCount();
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(0);
      expect(text()).toMatch('Reprise d\'une exécution précédente de ce plan');
      expect(text()).toMatch(/copies en cours, à vérifier .*: 1/);
      expect(text()).toMatch(/Copies d'une exécution précédente vérifiées à la reprise \(non recopiées\) : 1/);
      expect(text()).toMatch('Plan exécuté');
      // Une seule copie de la vidéo, toutes exécutions confondues.
      expect(s3.commands.filter((c) => c instanceof CopyObjectCommand && c.input.Key!.startsWith('albums/'))).toHaveLength(1);
      expect(copyCount()).toBe(copiesBefore + [...before.values()].filter((e) => e.state === 'a_faire').length);
      expect(s3.overwrites).toEqual([]);
      expect([...new RepairExecutionModel().findStates(plan.id).values()].map((e) => e.state)).toEqual(['copie', 'copie', 'copie']);
    });

    it('arrêt de sûreté précédent : la relance l\'affiche au début et s\'arrête à nouveau sur la même ligne', async () => {
      const plan = seedPlan();
      s3.put(DEST, 'photos/2016/2016-02/IMG_0005.JPG', { size: 1, etag: md5('x') });
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      output.length = 0;
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      expect(text()).toMatch(/en échec, à retenter : 1/);
      expect(text()).toMatch(/⚠️ {2}backup_google_photos\/photos\/2016\/IMG_0005.JPG → photos\/2016\/2016-02\/IMG_0005.JPG : destination déjà occupée/);
      expect(text()).toMatch('Arrêt de sûreté sur backup_google_photos/photos/2016/IMG_0005.JPG');
      expect(s3.get(DEST, 'photos/2016/2016-02/IMG_0005.JPG')).toEqual({ size: 1, etag: md5('x') });
    });
  });

  describe('Ctrl-C', () => {
    it('premier SIGINT : la ligne en cours finit (copie vérifiée), arrêt, code 1, verrou et écouteur libérés', async () => {
      const plan = seedPlan();
      const listeners = process.listenerCount('SIGINT');
      let emitted = false;
      s3.afterCopy = () => {
        if (!emitted) {
          emitted = true;
          process.emit('SIGINT');
        }
      };
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      expect(text()).toMatch('Exécution interrompue');
      expect(copyCount()).toBe(1);
      const states = [...new RepairExecutionModel().findStates(plan.id).values()].map((e) => e.state).sort();
      expect(states).toEqual(['a_faire', 'a_faire', 'copie']);
      expect(new RepairExecutionModel().findLock()).toBeNull();
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    });

    it('second SIGINT : sortie 130 immédiate, verrou libéré avant de sortir, aucune ligne « copie » non vérifiée', async () => {
      const plan = seedPlan();
      const listeners = process.listenerCount('SIGINT');
      const lockAtExit: unknown[] = [];
      const statesAtSecondSignal: string[] = [];
      const exit = jest.spyOn(process, 'exit').mockImplementation(((code: number) => {
        lockAtExit.push(new RepairExecutionModel().findLock(), code);
      }) as never);
      let emitted = false;
      s3.afterCopy = () => {
        if (!emitted) {
          emitted = true;
          process.emit('SIGINT');
          // Au second signal, la ligne en cours n'est pas encore vérifiée : elle ne doit pas être « copie ».
          statesAtSecondSignal.push(...[...new RepairExecutionModel().findStates(plan.id).values()].map((e) => e.state));
          process.emit('SIGINT');
        }
      };
      await executeCommand(config, { confirmer: plan.id }, deps);
      expect(exit).toHaveBeenCalledWith(130);
      expect(lockAtExit).toEqual([null, 130]);
      // Story 3.2 : la ligne en cours est « copie_en_cours » (copie envoyée, non vérifiée), jamais « copie ».
      expect(statesAtSecondSignal.sort()).toEqual(['a_faire', 'a_faire', 'copie_en_cours']);
      expect(text()).not.toMatch('copie en échec');
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    });
  });
});
