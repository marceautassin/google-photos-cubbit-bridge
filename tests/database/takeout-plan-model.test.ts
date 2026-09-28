import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { closeDatabase, initDatabase } from '../../src/database/connection';
import { TakeoutPlanModel } from '../../src/database/takeout-plan-model';
import { buildArchivePlan, TakeoutPlanInput } from '../../src/takeout/archive-plan';
import { AnalyzedMedia } from '../../src/takeout/takeout-analysis';

const MD5_A = 'a'.repeat(32);

function media(overrides: Partial<AnalyzedMedia> & Pick<AnalyzedMedia, 'part' | 'path' | 'fileName' | 'md5'>): AnalyzedMedia {
  return {
    folder: 'Photos de 2020', folderKind: 'annee', size: 100, takenAt: '2020-05-14T10:00:00', dateSource: 'exif',
    dateDetail: null, instant: null, dateWarning: null, metadata: null, companion: null, duplicateOf: null,
    archive: { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize: false },
    ...overrides,
  };
}

function samplePlanInput(overrides: Partial<TakeoutPlanInput> = {}): TakeoutPlanInput {
  return {
    exportId: '20260806T062636Z',
    destinationBucket: 'marceau-photos',
    keptAlbums: ['Baptême Raphaëlle'],
    analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
    media: [media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A })],
    occupied: [],
    destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

describe('TakeoutPlanModel', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-takeout-plan-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  it('enregistre puis relit un plan à l\'identique', () => {
    const model = new TakeoutPlanModel();
    const plan = buildArchivePlan(samplePlanInput());
    expect(model.save(plan)).toBe('cree');
    const stored = model.find(plan.exportId)!;
    expect(stored.plan).toEqual(plan);
  });

  it('un plan identique n\'est pas réécrit ; un plan différent remplace le précédent', () => {
    const model = new TakeoutPlanModel();
    const plan = buildArchivePlan(samplePlanInput());
    model.save(plan);
    expect(model.save(plan)).toBe('inchange');

    const other = buildArchivePlan(samplePlanInput({ media: [media({ part: '002', path: 'b.jpg', fileName: 'b.jpg', md5: 'b'.repeat(32) })] }));
    expect(model.save(other)).toBe('remplace');
    expect(model.find(plan.exportId)!.plan.id).toBe(other.id);
  });

  it('les plans de deux exports différents sont indépendants', () => {
    const model = new TakeoutPlanModel();
    const plan1 = buildArchivePlan(samplePlanInput({ exportId: 'export-1' }));
    const plan2 = buildArchivePlan(samplePlanInput({ exportId: 'export-2', media: [media({ part: '002', path: 'b.jpg', fileName: 'b.jpg', md5: 'b'.repeat(32) })] }));
    model.save(plan1);
    model.save(plan2);
    expect(model.find('export-1')!.plan.id).toBe(plan1.id);
    expect(model.find('export-2')!.plan.id).toBe(plan2.id);
  });

  it('enregistre puis efface le dernier refus (par export) au succès suivant', () => {
    const model = new TakeoutPlanModel();
    model.recordRefusal('export-1', 'analyse invalide');
    expect(model.findLastRefusal('export-1')!.reason).toBe('analyse invalide');
    model.save(buildArchivePlan(samplePlanInput({ exportId: 'export-1' })));
    expect(model.findLastRefusal('export-1')).toBeNull();
  });

  it('find : aucun plan pour un export inconnu', () => {
    expect(new TakeoutPlanModel().find('inconnu')).toBeNull();
  });
});
