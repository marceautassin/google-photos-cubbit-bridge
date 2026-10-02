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
import { closeDatabase, initDatabase } from '../../src/database/connection';
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

describe('gpb takeout archiver', () => {
  let dir: string;
  let testConfig: AppConfig;
  let sources: TakeoutSources;
  let out: string[];
  let s3: FakeS3;
  let deps: ArchiverDeps;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-takeout-archive-'));
    testConfig = { ...config, database: { path: path.join(dir, 'data', 'app.db') } } as AppConfig;
    await initDatabase(testConfig.database);
    sources = await sourcesFor({ [KEY]: EXPORT });
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

  /** Analyse enregistrée directement (le pipeline `analyser` complet est testé ailleurs). Rend les médias analysés. */
  async function seedAnalysis(): Promise<TakeoutPlanInput['media']> {
    new InventoryModel().replace(DEST, [], new Date('2026-09-16T09:00:00Z'));
    const { lister, downloader } = fakeBucket({ [KEY]: EXPORT });
    const reader = { bucket: DEST, readRange: async (): Promise<Uint8Array> => EXPORT };
    const group = groupExports(await listBackupZips(lister, reader))[0]!;
    const report = await analyzeExport(group, testConfig.sync.supportedFormats, 1);
    const zipFile = path.join(dir, 'export.zip');
    fs.writeFileSync(zipFile, EXPORT);
    const media = await analyzeTakeoutExport({
      report,
      zipPaths: new Map([[group.parts[0]!.zip.name, zipFile]]),
      timeZone: 'Europe/Paris',
      keptAlbums: [],
      archived: [],
    });
    new TakeoutAnalysisModel().replace({
      exportId: EXPORT_ID,
      zips: [{ name: 'takeout-20260806T062636Z-1-001.zip', size: EXPORT.length, etag: md5Hex(EXPORT), verification: 'md5' }],
      timeZone: 'Europe/Paris', keptAlbums: [], destinationBucket: DEST,
      inventoryCompletedAt: '2026-09-16T09:00:00.000Z', analyzedAt: '2026-09-16T10:00:00.000Z', media,
    });
    void downloader;
    return media;
  }

  /** Analyse + plan enregistrés directement (le pipeline `analyser`/`planifier` complet est testé ailleurs). */
  async function seedPlan(): Promise<string> {
    const media = await seedAnalysis();
    const input: TakeoutPlanInput = {
      exportId: EXPORT_ID, destinationBucket: DEST, keptAlbums: [], analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
      media, occupied: [], destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
    };
    const plan = buildArchivePlan(input);
    expect(plan.executable).toBe(true);
    expect(plan.lines.map((l) => l.action)).toEqual(['envoyer']);
    new TakeoutPlanModel().save(plan);
    return plan.id;
  }

  it('refuse sans plan enregistré pour l\'export (analyse pourtant valide)', async () => {
    await seedAnalysis();
    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z' }, deps);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('aucun plan d\'archivage enregistré');
  });

  it('simulation (sans --confirmer) : affiche le résumé, n\'écrit rien', async () => {
    await seedPlan();
    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z' }, deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Simulation : rien n\'a été envoyé');
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('refuse une confirmation qui ne correspond pas à l\'empreinte du plan', async () => {
    await seedPlan();
    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: 'x'.repeat(12) }, deps);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('ne correspond pas à l\'empreinte du plan');
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('envoie le média confirmé, vérifie après envoi, marque le journal ; relance idempotente', async () => {
    const planId = await seedPlan();
    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId }, deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Terminé. Aucune suppression, nulle part.');
    expect(s3.get(DEST, DESTINATION_KEY)).toEqual({ size: PHOTO.length, etag: md5Hex(PHOTO) });

    const savedLine = new TakeoutPlanModel().find(EXPORT_ID)!.plan.lines[0]!;
    const journal = new RepairExecutionModel();
    const states = journal.findStates(planId);
    expect(states.get(locationKey(savedLine))?.state).toBe('copie');

    out.length = 0;
    const commandsAfterFirst = s3.commands.length;
    const again = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId }, deps);
    expect(again).toBe(0);
    expect(out.join('\n')).toContain('Restant d\'après le journal : 0 (0 octet');
    // Aucun nouvel appel réseau pour les lignes elles-mêmes (déjà faites) ; seule la lecture des dépôts multipart
    // inachevés (story 4.3, correction), en fin d'exécution, s'ajoute à chaque appel.
    expect(s3.commands.length).toBe(commandsAfterFirst + 1);
    expect(s3.commandNames().at(-1)).toBe('ListMultipartUploadsCommand');
  });

  it('objet déjà présent et identique en destination avant envoi → déjà présent, jamais renvoyé', async () => {
    const planId = await seedPlan();
    s3.put(DEST, DESTINATION_KEY, { size: PHOTO.length, etag: md5Hex(PHOTO) });
    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId }, deps);
    expect(code).toBe(0);
    expect(s3.commandNames().includes('PutObjectCommand')).toBe(false);
    expect(out.join('\n')).toContain('Déjà présents (identiques, non renvoyés) : 1');
  });

  it('--lever-verrou : lève le verrou global (partagé avec la réparation), cite le plan détenu dans le message (story 4.3, correction)', async () => {
    const planId = await seedPlan();
    const journal = new RepairExecutionModel();
    const stalePid = 2 ** 22 + 99999; // PID hors plage, jamais un processus vivant du poste de test
    const acquiredAt = new Date('2026-01-01T00:00:00.000Z');
    journal.acquireLock('un-autre-plan-en-cours', { pid: stalePid, host: 'autre-poste' }, () => false, acquiredAt);
    const idleAt = new Date(acquiredAt.getTime() + (LOCK_IDLE_MINUTES + 1) * 60_000);

    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId, leverVerrou: true }, { ...deps, now: () => idleAt });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`Verrou levé (${LOCK_IDLE_MINUTES} min sans activité) : plan un-autre-plan-en-cours`);
    expect(journal.findLock()).toBeNull();
  });

  describe('reprise après coupure franche (story 4.4)', () => {
    const DEAD_PID = 2 ** 22 + 99999; // hors plage : jamais un processus vivant
    const acquiredAt = new Date('2026-01-01T00:00:00.000Z');
    const justAfter = (): Date => new Date(acquiredAt.getTime() + 2 * 60_000);

    it('verrou d\'un processus disparu sur ce poste : refus sans --lever-verrou (avec la piste), levée immédiate avec', async () => {
      const planId = await seedPlan();
      const journal = new RepairExecutionModel();
      journal.acquireLock('plan-coupe', { pid: DEAD_PID, host: currentOwner().host }, () => false, acquiredAt);
      const base = { export: '20260806T062636Z', confirmer: planId };

      expect(await archiverCommand(testConfig, sources, base, { ...deps, now: justAfter })).toBe(1);
      expect(out.join('\n')).toContain('verrou d\'exécution périmé');
      expect(out.join('\n')).toContain(`accepté tout de suite si le processus ${DEAD_PID} n'existe plus sur ce poste`);
      expect(journal.findLock()?.pid).toBe(DEAD_PID); // jamais levé en silence
      expect(s3.send).not.toHaveBeenCalled();

      out.length = 0;
      expect(await archiverCommand(testConfig, sources, { ...base, leverVerrou: true }, { ...deps, now: justAfter })).toBe(0);
      expect(out.join('\n')).toContain(`Verrou levé (processus ${DEAD_PID} absent de ce poste)`);
      expect(s3.get(DEST, DESTINATION_KEY)).toEqual({ size: PHOTO.length, etag: md5Hex(PHOTO) });
      expect(journal.findLock()).toBeNull();
    });

    it('verrou d\'un processus vivant (PID réutilisé compris) ou d\'un autre poste, activité récente : levée refusée', async () => {
      const planId = await seedPlan();
      const journal = new RepairExecutionModel();
      for (const owner of [{ pid: process.pid, host: currentOwner().host }, { pid: DEAD_PID, host: 'autre-poste' }]) {
        journal.acquireLock('plan-coupe', owner, () => true, acquiredAt);
        out.length = 0;
        const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId, leverVerrou: true }, { ...deps, now: justAfter });
        expect(code).toBe(1);
        expect(out.join('\n')).toContain('verrou non levé : dernière activité il y a 2 min');
        expect(journal.findLock()?.pid).toBe(owner.pid);
        journal.releaseLock(owner);
      }
      expect(s3.send).not.toHaveBeenCalled();
    });

    it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s en cours d\'envoi : le média en cours finit, verrou libéré, gestionnaires retirés', async (signal) => {
      const planId = await seedPlan();
      const before = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => process.listenerCount(sig));
      const written: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));
      s3.afterUpload = () => void process.emit(signal);
      const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId }, deps);
      expect(code).toBe(0); // un seul média : fini avant l'arrêt
      expect(written.join('')).toContain('Arrêt demandé');
      expect(s3.get(DEST, DESTINATION_KEY)).toEqual({ size: PHOTO.length, etag: md5Hex(PHOTO) });
      expect(new RepairExecutionModel().findLock()).toBeNull();
      expect((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => process.listenerCount(sig))).toEqual(before);
    });
  });

  it('dépôt multipart inachevé (d\'une exécution antérieure, panne réseau) sur le bucket dédié : signalé dans le bilan, jamais purgé (story 4.3, correction)', async () => {
    const planId = await seedPlan();
    // Simule un dépôt multipart laissé ouvert par une exécution antérieure (panne réseau pendant l'envoi des parties),
    // sans rapport avec la ligne du plan traitée ici : `listIncompleteMultipartUploads` doit le signaler malgré tout.
    const orphanWriter = new S3ArchiveWriter(s3.asClient(), { sourceBucket: 'marceau', sourcePrefixes: ['backup_google_photos/photos/'], destinationBucket: DEST }, undefined, 10, 4);
    s3.uploadPartError = () => new Error('panne réseau simulée');
    await expect(orphanWriter.uploadFile('quarantaine/orphelin/video.mp4', Buffer.from('0123456789ABCDE'))).rejects.toThrow();
    s3.uploadPartError = null;

    const code = await archiverCommand(testConfig, sources, { export: '20260806T062636Z', confirmer: planId }, deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1');
    expect(out.join('\n')).toMatch(/dépôt\(s\) multipart inachevé\(s\) sur marceau-photos/);
    expect(out.join('\n')).toContain('abort-multipart-upload');
    expect(s3.commandNames().includes('AbortMultipartUploadCommand')).toBe(false); // NFC-1 : jamais purgé par cet outil
  });
});
