import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { BucketObject } from '../../src/clients/types';
import { DateSource, ObjectDating } from '../../src/database/inventory-date-model';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/connection';
import { RepairPlanModel } from '../../src/database/repair-plan-model';
import { buildRepairPlan } from '../../src/inventory/repair-plan';

const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);

function dating(o: BucketObject, source: DateSource, takenAt: string | null, detail: string | null): ObjectDating {
  return { key: o.key, size: o.size, etag: o.etag, source, takenAt, detail, exifRead: source !== 'nom_fichier' };
}

function samplePlan(destinationBucket = 'photos') {
  const objects: BucketObject[] = [
    { key: 'backup_google_photos/photos/2016/IMG_0044.JPG', size: 10, etag: md5('a'), lastModified: null },
    { key: '2_Personnel/Photos/google_photos/IMG_0044.JPG', size: 10, etag: md5('a'), lastModified: null },
    { key: '2_Personnel/Photos/google_photos/scan.jpg', size: 5, etag: md5('b'), lastModified: null },
    { key: '2_Personnel/Photos/google_photos/.DS_Store', size: 5, etag: md5('c'), lastModified: null },
  ];
  return buildRepairPlan({
    sourceBucket: 'marceau',
    destinationBucket,
    objects,
    datings: [
      dating(objects[0]!, 'nom_fichier', '2016-02-20T10:00:00', null),
      dating(objects[1]!, 'exif', '2016-02-20T10:00:00', 'CreateDate'),
      dating(objects[2]!, 'indeterminee', null, 'aucune date'),
    ],
    supportedFormats: ['jpg'],
    sourcePrefixes: ['backup_google_photos/photos/', '2_Personnel/Photos/google_photos/'],
    keptAlbums: ['mariage'],
    ignoredFileNames: ['.DS_Store'],
    ignoredExtensions: [],
    index: {
      sourceInventory: { completedAt: '2026-09-15T08:00:00.000Z', objectCount: 4 },
      destinationInventory: null,
      datings: { count: 3, lastDatedAt: '2026-09-15T09:00:00.000Z' },
    },
    occupied: [],
  });
}

const count = (table: string): number =>
  (getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('RepairPlanModel', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-plan-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  it('enregistre puis relit le plan à l\'identique', () => {
    const model = new RepairPlanModel();
    const plan = samplePlan();
    const generatedAt = new Date('2026-09-15T10:00:00Z');
    expect(model.findCurrent()).toBeNull();
    expect(model.save(plan, generatedAt)).toBe('cree');
    expect(model.findCurrent()).toEqual({ plan, generatedAt });
  });

  it('un plan identique ne crée rien et ne change pas la date de génération', () => {
    const model = new RepairPlanModel();
    model.save(samplePlan(), new Date('2026-09-15T10:00:00Z'));
    expect(model.save(samplePlan(), new Date('2026-09-16T10:00:00Z'))).toBe('inchange');
    expect(count('repair_plans')).toBe(1);
    expect(count('repair_plan_lines')).toBe(3);
    expect(model.findCurrent()!.generatedAt.toISOString()).toBe('2026-09-15T10:00:00.000Z');
  });

  it('un plan différent remplace l\'ancien', () => {
    const model = new RepairPlanModel();
    model.save(samplePlan());
    const other = samplePlan('photos-2');
    expect(model.save(other)).toBe('remplace');
    expect(count('repair_plans')).toBe(1);
    expect(count('repair_plan_lines')).toBe(3);
    expect(model.findCurrent()!.plan).toEqual(other);
  });

  it('un plan corrompu en base sous la même empreinte est réécrit par une génération identique', () => {
    const model = new RepairPlanModel();
    const plan = samplePlan();
    model.save(plan);
    getDatabase().prepare('UPDATE repair_plan_lines SET reason = ? WHERE position = 0').run('altéré');
    expect(model.findCurrent()!.plan).not.toEqual(plan);
    expect(model.save(plan)).toBe('repare');
    expect(model.findCurrent()!.plan).toEqual(plan);
    getDatabase().prepare('UPDATE repair_plans SET executable = 0').run();
    expect(model.save(plan)).toBe('repare');
    expect(model.findCurrent()!.plan.executable).toBe(true);
    expect(model.save(plan)).toBe('inchange');
  });

  it('une génération refusée est enregistrée sans toucher au plan courant, puis effacée par la génération suivante', () => {
    const model = new RepairPlanModel();
    const plan = samplePlan();
    model.save(plan);
    expect(model.findLastRefusal()).toBeNull();
    model.recordRefusal('2 média(s) non daté(s)', new Date('2026-09-16T10:00:00Z'));
    model.recordRefusal('3 média(s) non daté(s)', new Date('2026-09-16T11:00:00Z'));
    expect(model.findLastRefusal()).toEqual({ refusedAt: new Date('2026-09-16T11:00:00Z'), reason: '3 média(s) non daté(s)' });
    expect(count('repair_plan_refusals')).toBe(1);
    expect(model.findCurrent()!.plan).toEqual(plan);
    expect(model.save(plan)).toBe('inchange');
    expect(model.findLastRefusal()).toBeNull();
  });

  it('remplacement atomique : une erreur en cours d\'écriture laisse l\'ancien plan intact', () => {
    const model = new RepairPlanModel();
    const plan = samplePlan();
    model.save(plan);
    const broken = samplePlan('photos-2');
    broken.lines = [...broken.lines, broken.lines[0]!]; // clé en double : viole la clé primaire
    expect(() => model.save(broken)).toThrow();
    expect(model.findCurrent()!.plan).toEqual(plan);
  });
});
