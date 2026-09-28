jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn() };
});

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { S3Client } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BucketLister, BucketObjectPage, DownloadedObject, ObjectDownloader } from '../../src/clients/types';
import { AppConfig } from '../../src/config/types';
import { listBackupZips, TakeoutSources } from '../../src/commands/takeout';
import { readArchivePlanInput } from '../../src/commands/takeout-plan';
import { closeDatabase, initDatabase } from '../../src/database/connection';
import { InventoryModel } from '../../src/database/inventory-model';
import { TakeoutAnalysisModel } from '../../src/database/takeout-analysis-model';
import { TakeoutPlanModel } from '../../src/database/takeout-plan-model';
import { ArchivePlanRefusedError, buildArchivePlan } from '../../src/takeout/archive-plan';
import { analyzeTakeoutExport } from '../../src/takeout/takeout-analysis';
import { analyzeExport, groupExports } from '../../src/takeout/takeout-validation';
import { localZipSource } from '../../src/takeout/zip-directory';
import { buildJpeg } from '../fixtures/jpeg-exif';
import { buildZip, FakeRangeReader } from '../fixtures/zip-builder';

const config = {
  cubbit: { endpoint: '', accessKeyId: '', secretAccessKey: '', bucket: 'marceau' },
  sync: { supportedFormats: ['jpg', 'mp4'] },
  repair: { destinationBucket: 'marceau-photos' },
  takeout: { keptAlbums: [] as string[] },
  database: { path: '/chemin/inexistant/app.db' },
} as unknown as AppConfig;

const md5 = (bytes: Uint8Array): string => crypto.createHash('md5').update(bytes).digest('hex');
const NBSP = ' ';
const ROOT = `Takeout/Google${NBSP}Photos`;
const PHOTO = buildJpeg(undefined, 7);
const EXPORT = buildZip([
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_0001.JPG`, data: PHOTO, deflate: true },
]).bytes;
const KEY = 'backups/takeout-20260806T062636Z-1-001.zip';
const EXPORT_ID = '20260806T062636Z-1';

function fakeBucket(objects: Record<string, Uint8Array>): { lister: BucketLister; reader: FakeRangeReader } {
  const reader = new FakeRangeReader('marceau-photos', new Map(Object.entries(objects)));
  const lister: BucketLister = {
    bucket: 'marceau-photos',
    listPage: async (): Promise<BucketObjectPage> => ({
      objects: Object.entries(objects).map(([key, bytes]) => ({ key, size: bytes.length, etag: md5(bytes), lastModified: null })),
      isTruncated: false,
    }),
  };
  return { lister, reader };
}

class FakeDownloader implements ObjectDownloader {
  readonly bucket = 'marceau-photos';
  readonly calls: string[] = [];
  constructor(private readonly objects: Record<string, Uint8Array>) {}
  async download(key: string): Promise<DownloadedObject> {
    this.calls.push(key);
    const bytes = this.objects[key]!;
    return { body: (async function* () { yield bytes; })(), size: bytes.length, etag: md5(bytes) };
  }
}

function sourcesFor(objects: Record<string, Uint8Array>): TakeoutSources {
  const { lister, reader } = fakeBucket(objects);
  const downloader = new FakeDownloader(objects);
  return {
    downloader: () => downloader,
    remoteZips: async () => ({ origin: 'marceau-photos/backups/', zips: await listBackupZips(lister, reader) }),
    localZip: async (file) => {
      const source = await localZipSource(file);
      return { name: path.basename(file), location: file, size: source.size, open: async () => source };
    },
  };
}

describe('gpb takeout planifier : readArchivePlanInput', () => {
  let dir: string;
  let testConfig: AppConfig;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-takeout-plan-'));
    testConfig = { ...config, database: { path: path.join(dir, 'data', 'app.db') } } as AppConfig;
    await initDatabase(testConfig.database);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Analyse valide enregistrée directement (sans repasser par `gpb takeout analyser`, testé ailleurs). */
  async function seedAnalysis(): Promise<void> {
    new InventoryModel().replace('marceau-photos', [], new Date('2026-09-16T09:00:00Z'));
    const { lister, reader } = fakeBucket({ [KEY]: EXPORT });
    const group = groupExports(await listBackupZips(lister, reader))[0]!;
    const report = await analyzeExport(group, testConfig.sync.supportedFormats, 1);
    const media = await analyzeTakeoutExport({
      report,
      zipPaths: new Map([[group.parts[0]!.zip.name, await writeTempZip()]]),
      timeZone: 'Europe/Paris',
      keptAlbums: [],
      archived: [],
    });
    new TakeoutAnalysisModel().replace({
      exportId: EXPORT_ID,
      zips: [{ name: 'takeout-20260806T062636Z-1-001.zip', size: EXPORT.length, etag: md5(EXPORT), verification: 'md5' }],
      timeZone: 'Europe/Paris',
      keptAlbums: [],
      destinationBucket: 'marceau-photos',
      inventoryCompletedAt: '2026-09-16T09:00:00.000Z',
      analyzedAt: '2026-09-16T10:00:00.000Z',
      media,
    });
  }

  async function writeTempZip(): Promise<string> {
    const file = path.join(dir, 'export.zip');
    fs.writeFileSync(file, EXPORT);
    return file;
  }

  it('refuse sans bucket dédié configuré', async () => {
    const noDest = { ...testConfig, repair: { destinationBucket: '' } } as unknown as AppConfig;
    await expect(readArchivePlanInput(noDest, sourcesFor({ [KEY]: EXPORT }), '20260806T062636Z')).rejects.toThrow(ArchivePlanRefusedError);
  });

  it('refuse sans analyse enregistrée pour cet export', async () => {
    new InventoryModel().replace('marceau-photos', [], new Date());
    await expect(readArchivePlanInput(testConfig, sourcesFor({ [KEY]: EXPORT }), '20260806T062636Z')).rejects.toThrow('aucune analyse valide');
  });

  it('refuse si l\'inventaire du bucket dédié est antérieur à celui de l\'analyse', async () => {
    await seedAnalysis();
    new InventoryModel().replace('marceau-photos', [], new Date('2026-09-15T00:00:00Z')); // plus ancien que l'analyse
    await expect(readArchivePlanInput(testConfig, sourcesFor({ [KEY]: EXPORT }), '20260806T062636Z')).rejects.toThrow('antérieur à celui utilisé par l\'analyse');
  });

  it('accepte un inventaire du bucket dédié plus récent que celui de l\'analyse', async () => {
    await seedAnalysis();
    new InventoryModel().replace('marceau-photos', [], new Date('2026-09-20T00:00:00Z')); // plus récent : accepté
    const context = await readArchivePlanInput(testConfig, sourcesFor({ [KEY]: EXPORT }), '20260806T062636Z');
    expect(context.input.destinationInventoryCompletedAt).toBe('2026-09-20T00:00:00.000Z');
    const plan = buildArchivePlan(context.input);
    expect(plan.executable).toBe(true);
    expect(plan.lines).toHaveLength(1);
    // Sans JSON `photoTakenTime` ni date exploitable dans le nom ou l'EXIF, le seul média est daté indéterminé :
    // action « quarantaine », cohérent avec le contenu nouveau (aucune correspondance archivée).
    expect(plan.lines[0]).toMatchObject({ action: 'quarantaine' });
  });

  it('refuse si les albums conservés ont changé depuis l\'analyse', async () => {
    await seedAnalysis();
    new InventoryModel().replace('marceau-photos', [], new Date('2026-09-16T09:00:00Z'));
    const changed = { ...testConfig, takeout: { keptAlbums: ['mariage'] } } as AppConfig;
    await expect(readArchivePlanInput(changed, sourcesFor({ [KEY]: EXPORT }), '20260806T062636Z')).rejects.toThrow('aucune analyse valide');
  });
});

describe('TakeoutPlanModel via gpb takeout planifier : enregistrement', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-takeout-plan-save-'));
    await initDatabase({ path: path.join(dir, 'app.db') } as never);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('un plan généré est enregistré et relu à l\'identique', () => {
    const model = new TakeoutPlanModel();
    const plan = buildArchivePlan({
      exportId: EXPORT_ID,
      destinationBucket: 'marceau-photos',
      keptAlbums: [],
      analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
      media: [
        {
          part: '001', path: 'a.jpg', folder: 'Photos de 2020', folderKind: 'annee', fileName: 'a.jpg', size: 3, md5: 'a'.repeat(32),
          takenAt: '2020-05-14T10:00:00', dateSource: 'exif', dateDetail: null, instant: null, dateWarning: null, metadata: null,
          companion: null, duplicateOf: null, archive: { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize: false },
        },
      ],
      occupied: [],
      destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
    });
    expect(model.save(plan)).toBe('cree');
    expect(model.find(plan.exportId)!.plan.id).toBe(plan.id);
  });
});

describe('S3Client jamais construit par la planification', () => {
  it('ne construit aucun client S3 (uniquement listing distant via TakeoutSources)', async () => {
    expect(S3Client).not.toHaveBeenCalled();
  });
});
