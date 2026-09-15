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
import { currentOwner, RepairExecutionModel } from '../../src/database/repair-execution-model';
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

    it('verrou périmé : refus explicite, puis levée par --lever-verrou et exécution', async () => {
      const plan = seedPlan();
      new RepairExecutionModel().acquireLock(plan.id, { pid: 2 ** 22 + 12345, host: currentOwner().host });
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      expect(text()).toMatch('verrou d\'exécution périmé');
      expect(text()).toMatch('--lever-verrou');
      expect(s3.send).not.toHaveBeenCalled();
      expect(await executeCommand(config, { confirmer: plan.id, leverVerrou: true }, deps)).toBe(0);
      expect(text()).toMatch('Verrou levé');
      expect(new RepairExecutionModel().findLock()).toBeNull();
    });

    it('verrou libéré aussi sur refus en cours d\'exécution (bucket dédié inaccessible)', async () => {
      const plan = seedPlan();
      s3.buckets.delete(DEST);
      expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(1);
      expect(text()).toMatch('accès au bucket dédié');
      expect(new RepairExecutionModel().findLock()).toBeNull();
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
          // Au second signal, la ligne en cours n'est pas encore vérifiée : elle doit rester « a_faire ».
          statesAtSecondSignal.push(...[...new RepairExecutionModel().findStates(plan.id).values()].map((e) => e.state));
          process.emit('SIGINT');
        }
      };
      await executeCommand(config, { confirmer: plan.id }, deps);
      expect(exit).toHaveBeenCalledWith(130);
      expect(lockAtExit).toEqual([null, 130]);
      expect(statesAtSecondSignal).toEqual(['a_faire', 'a_faire', 'a_faire']);
      expect(text()).not.toMatch('copie en échec');
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    });
  });
});
