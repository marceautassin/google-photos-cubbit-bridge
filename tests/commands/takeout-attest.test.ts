jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn() };
});

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3ArchiveWriter } from '../../src/clients/archive-writer';
import { BucketLister, BucketObjectPage, DownloadedObject, ObjectDownloader } from '../../src/clients/types';
import { AppConfig } from '../../src/config/types';
import { listBackupZips, TakeoutSources } from '../../src/commands/takeout';
import { archiverCommand, ArchiverDeps } from '../../src/commands/takeout-archive';
import { attesterCommand } from '../../src/commands/takeout-attest';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/connection';
import { InventoryModel } from '../../src/database/inventory-model';
import { currentOwner, LOCK_IDLE_MINUTES, RepairExecutionModel } from '../../src/database/repair-execution-model';
import { TakeoutAnalysisModel } from '../../src/database/takeout-analysis-model';
import { TakeoutPlanModel } from '../../src/database/takeout-plan-model';
import { buildArchivePlan, locationKey, TakeoutPlanInput } from '../../src/takeout/archive-plan';
import { analyzeTakeoutExport } from '../../src/takeout/takeout-analysis';
import { analyzeExport, groupExports } from '../../src/takeout/takeout-validation';
import { localZipSource } from '../../src/takeout/zip-directory';
import { buildJpeg } from '../fixtures/jpeg-exif';
import { buildZip } from '../fixtures/zip-builder';
import { FakeS3 } from '../fixtures/fake-s3';

const DEST = 'marceau-photos';
const config = {
  cubbit: { endpoint: 'https://essai.invalid', accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'marceau' },
  sync: { supportedFormats: ['jpg', 'mp4'] },
  repair: { destinationBucket: DEST, sourcePrefixes: ['backup_google_photos/photos/'] },
  takeout: { keptAlbums: [] as string[] },
  database: { path: '/chemin/inexistant/app.db' },
} as unknown as AppConfig;

const md5Hex = (bytes: Uint8Array): string => crypto.createHash('md5').update(bytes).digest('hex');
const NBSP = ' ';
const ROOT = `Takeout/Google${NBSP}Photos`;
const PHOTO = buildJpeg(undefined, 11);
const TAKEN_AT = String(Date.UTC(2020, 4, 14, 10, 0, 0) / 1000);
const EXPORT = buildZip([
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_0001.JPG`, data: PHOTO, deflate: true },
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_0001.JPG.supplemental-metadata.json`, data: JSON.stringify({ photoTakenTime: { timestamp: TAKEN_AT } }) },
]).bytes;
const KEY = 'backups/takeout-20260806T062636Z-1-001.zip';
const EXPORT_ID = '20260806T062636Z-1';
const DESTINATION_KEY = 'photos/2020/2020-05/IMG_0001.JPG';

function fakeBucket(objects: Record<string, Uint8Array>): { lister: BucketLister; downloader: ObjectDownloader } {
  const lister: BucketLister = {
    bucket: DEST,
    listPage: async (): Promise<BucketObjectPage> => ({
      objects: Object.entries(objects).map(([key, bytes]) => ({ key, size: bytes.length, etag: md5Hex(bytes), lastModified: null })),
      isTruncated: false,
    }),
  };
  const downloader: ObjectDownloader = {
    bucket: DEST,
    download: async (key: string): Promise<DownloadedObject> => {
      const bytes = objects[key]!;
      return { body: (async function* () { yield bytes; })(), size: bytes.length, etag: md5Hex(bytes) };
    },
  };
  return { lister, downloader };
}

async function sourcesFor(objects: Record<string, Uint8Array>): Promise<TakeoutSources> {
  const { downloader } = fakeBucket(objects);
  // Lecteur par plages minimal (le listing n'a besoin que de HEAD-like métadonnées, la lecture complète passe par `download`).
  const reader = { bucket: DEST, readRange: async (key: string): Promise<Uint8Array> => objects[key]! };
  return {
    downloader: () => downloader,
    remoteZips: async () => ({ origin: `${DEST}/backups/`, zips: await listBackupZips(fakeBucket(objects).lister, reader) }),
    localZip: async (file) => {
      const source = await localZipSource(file);
      return { name: path.basename(file), location: file, size: source.size, open: async () => source };
    },
  };
}

describe('gpb takeout attester', () => {
  let dir: string;
  let testConfig: AppConfig;
  let sources: TakeoutSources;
  let out: string[];
  let s3: FakeS3;
  let deps: ArchiverDeps;
  const options = (extra: object = {}): { export: string; parties: string } => ({ export: '20260806T062636Z', parties: '1', ...extra });
  const attestNow = (): Date => new Date(Date.now() + 3_600_000);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-takeout-attest-'));
    testConfig = { ...config, database: { path: path.join(dir, 'data', 'app.db') } } as AppConfig;
    await initDatabase(testConfig.database);
    const real = await sourcesFor({ [KEY]: EXPORT });
    sources = { ...real, remoteZips: jest.fn(real.remoteZips) };
    s3 = new FakeS3();
    s3.createBucket(DEST);
    deps = { createWriter: jest.fn((_config, scope) => new S3ArchiveWriter(s3.asClient(), scope)) };
    out = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    closeDatabase();
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Analyse et plan enregistrés directement (les pipelines `analyser`/`planifier` sont testés ailleurs). */
  async function seedPlan(): Promise<string> {
    new InventoryModel().replace(DEST, [], new Date('2026-09-16T09:00:00Z'));
    const reader = { bucket: DEST, readRange: async (): Promise<Uint8Array> => EXPORT };
    const group = groupExports(await listBackupZips(fakeBucket({ [KEY]: EXPORT }).lister, reader))[0]!;
    const report = await analyzeExport(group, testConfig.sync.supportedFormats, 1);
    const zipFile = path.join(dir, 'export.zip');
    fs.writeFileSync(zipFile, EXPORT);
    const media = await analyzeTakeoutExport({ report, zipPaths: new Map([[group.parts[0]!.zip.name, zipFile]]), timeZone: 'Europe/Paris', keptAlbums: [], archived: [] });
    new TakeoutAnalysisModel().replace({
      exportId: EXPORT_ID,
      zips: [{ name: 'takeout-20260806T062636Z-1-001.zip', size: EXPORT.length, etag: md5Hex(EXPORT), verification: 'md5' }],
      timeZone: 'Europe/Paris', keptAlbums: [], destinationBucket: DEST,
      inventoryCompletedAt: '2026-09-16T09:00:00.000Z', analyzedAt: '2026-09-16T10:00:00.000Z', media,
    });
    const input: TakeoutPlanInput = {
      exportId: EXPORT_ID, destinationBucket: DEST, keptAlbums: [], analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
      media, occupied: [], destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
    };
    const plan = buildArchivePlan(input);
    new TakeoutPlanModel().save(plan);
    return plan.id;
  }

  /** Archivage réel contre le faux S3, puis inventaire du bucket dédié refait après la passe. */
  async function archiveAndReinventory(): Promise<void> {
    const planId = await seedPlan();
    expect(await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId }, deps)).toBe(0);
    new InventoryModel().replace(
      DEST,
      s3.keys(DEST).map((key) => ({ key, size: s3.get(DEST, key)!.size, etag: s3.get(DEST, key)!.etag, lastModified: null })),
      new Date(Date.now() + 60_000),
    );
    out.length = 0;
    (sources.remoteZips as jest.Mock).mockClear();
    s3.send.mockClear();
  }

  it('refuse, sans appel réseau, quand l\'analyse est absente', async () => {
    expect(await attesterCommand(testConfig, sources, options(), attestNow)).toBe(1);
    expect(out.join('\n')).toContain('aucune analyse pour l\'export');
    expect(sources.remoteZips).not.toHaveBeenCalled();
  });

  it('refuse, sans appel réseau, quand le plan est absent', async () => {
    await seedPlan();
    getDatabase().prepare('DELETE FROM takeout_archive_plans').run();
    expect(await attesterCommand(testConfig, sources, options(), attestNow)).toBe(1);
    expect(out.join('\n')).toContain('aucun plan d\'archivage enregistré');
    expect(sources.remoteZips).not.toHaveBeenCalled();
  });

  it('refuse, sans appel réseau, un bucket dédié non configuré', async () => {
    const noBucket = { ...testConfig, repair: { ...testConfig.repair, destinationBucket: '' } } as AppConfig;
    expect(await attesterCommand(noBucket, sources, options(), attestNow)).toBe(1);
    expect(out.join('\n')).toContain('aucun bucket dédié configuré');
    expect(sources.remoteZips).not.toHaveBeenCalled();
  });

  it('attestation accordée : liste écrite AVANT l\'affichage, zips supprimables, code 0, aucune écriture S3', async () => {
    await archiveAndReinventory();
    const list = path.join(dir, 'sortie', 'couverts.csv');
    const code = await attesterCommand(testConfig, sources, options({ exportListe: list }), attestNow);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Export attesté');
    expect(text).toContain(`${KEY}`);
    expect(text).toContain('ne supprimera jamais rien');
    expect(text).toContain('1 médias couverts : 1 déposés par la passe d\'archivage, 0 déjà archivés, 0 doublons internes');
    expect(fs.readFileSync(list, 'utf8')).toContain(`IMG_0001.JPG;2020-05-14T12:00:00;`);
    expect(fs.readFileSync(list, 'utf8')).toMatch(new RegExp(`;;Photos de.2020;${DESTINATION_KEY};${PHOTO.length};${md5Hex(PHOTO)}`));
    expect(text.indexOf('Export attesté')).toBeLessThan(text.indexOf(list));
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('refus : aucune liste écrite, code 1, raison actionnable ; la liste des écarts est écrite à la demande', async () => {
    await archiveAndReinventory();
    s3.put(DEST, DESTINATION_KEY, { size: PHOTO.length + 1, etag: md5Hex(PHOTO) }); // l'inventaire local ne change pas : on le refait
    new InventoryModel().replace(DEST, [{ key: DESTINATION_KEY, size: PHOTO.length + 1, etag: md5Hex(PHOTO), lastModified: null }], new Date(Date.now() + 120_000));
    const list = path.join(dir, 'couverts.csv');
    const gaps = path.join(dir, 'ecarts.csv');
    const code = await attesterCommand(testConfig, sources, options({ exportListe: list, exportEcarts: gaps }), attestNow);
    expect(code).toBe(1);
    expect(fs.existsSync(list)).toBe(false);
    expect(out.join('\n')).toContain('NE SUPPRIMEZ RIEN');
    expect(out.join('\n')).toContain('Taille différente');
    expect(fs.readFileSync(gaps, 'utf8')).toContain('taille_differente');
  });

  it('refus : inventaire antérieur à la dernière écriture du journal', async () => {
    await archiveAndReinventory();
    new InventoryModel().replace(DEST, [], new Date('2026-09-16T11:00:00Z'));
    expect(await attesterCommand(testConfig, sources, options(), attestNow)).toBe(1);
    expect(out.join('\n')).toContain('non postérieur à la dernière écriture du journal');
  });

  it('refuse d\'écraser un fichier existant, avant tout appel réseau', async () => {
    await archiveAndReinventory();
    const list = path.join(dir, 'couverts.csv');
    fs.writeFileSync(list, 'ancien');
    expect(await attesterCommand(testConfig, sources, options({ exportListe: list }), attestNow)).toBe(1);
    expect(fs.readFileSync(list, 'utf8')).toBe('ancien');
    expect(out.join('\n')).toContain('existe déjà');
    expect(sources.remoteZips).not.toHaveBeenCalled();
  });

  it('refuse deux options désignant le même fichier', async () => {
    const same = path.join(dir, 'x.csv');
    expect(await attesterCommand(testConfig, sources, options({ exportListe: same, exportEcarts: same }), attestNow)).toBe(1);
    expect(out.join('\n')).toContain('le même fichier');
  });
});
