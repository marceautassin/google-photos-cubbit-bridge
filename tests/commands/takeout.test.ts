jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn() };
});

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { S3Client } from '@aws-sdk/client-s3';
import { Command } from 'commander';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BucketLister, BucketObjectPage, DownloadedObject, ObjectDownloader } from '../../src/clients/types';
import { LEGACY_MESSAGE, listBackupZips, register, TakeoutSources } from '../../src/commands/takeout';
import { closeDatabase, initDatabase } from '../../src/database/connection';
import { InventoryModel } from '../../src/database/inventory-model';
import { TakeoutAnalysisModel } from '../../src/database/takeout-analysis-model';
import { AppConfig } from '../../src/config/types';
import { ZipRef } from '../../src/takeout/takeout-validation';
import { localZipSource, remoteZipSource } from '../../src/takeout/zip-directory';
import { buildJpeg } from '../fixtures/jpeg-exif';
import { buildZip, FakeRangeReader } from '../fixtures/zip-builder';

// Configuration écrite à la main : `src/config` n'est pas importé (il chargerait le fichier .env).
const config = {
  cubbit: { endpoint: '', accessKeyId: '', secretAccessKey: '', bucket: 'marceau' },
  sync: { supportedFormats: ['jpg', 'mp4'] },
  repair: { destinationBucket: 'marceau-photos' },
  takeout: { keptAlbums: ['tenerife 2026'] },
  database: { path: '/chemin/inexistant/app.db' },
} as unknown as AppConfig;

const md5 = (bytes: Uint8Array): string => crypto.createHash('md5').update(bytes).digest('hex');

const NBSP = '\u00a0';
const ROOT = `Takeout/Google${NBSP}Photos`;
const PART = buildZip([
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_20200104_154653.jpg`, data: new Uint8Array(2048) },
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_20200104_154653.jpg.supplemental-metadata.json`, data: '{}' },
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_0043.mp4`, data: 'mp4' },
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_0043.jpg`, data: 'jpg' },
  { name: `${ROOT}/Photos de${NBSP}2020/IMG_0043.jpg.supplemental-metadata.json`, data: '{}' },
  { name: `${ROOT}/Photos de${NBSP}2020/scan-sans-json.jpg`, data: 'jpg' },
  { name: `${ROOT}/tenerife 2026/IMG_1.jpg`, data: 'jpg' },
  { name: `${ROOT}/tenerife 2026/IMG_1.jpg.supp.json`, data: '{}' },
  { name: `${ROOT}/tenerife 2026/métadonnées.json`, data: '{}' },
  { name: `${ROOT}/tenerife 2026/lisez-moi.txt`, data: 'x' },
]).bytes;
const BROKEN = PART.slice(0, PART.length - 5);

/** Faux S3 en lecture : listing et GET partiels sur des objets en mémoire. */
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

/** Faux téléchargeur : contenu entier des objets en mémoire, téléchargements comptés. */
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

function sourcesFor(
  objects: Record<string, Uint8Array>,
  downloads: Record<string, Uint8Array> = objects,
): { sources: TakeoutSources; reader: FakeRangeReader; downloader: FakeDownloader } {
  const { lister, reader } = fakeBucket(objects);
  const downloader = new FakeDownloader(downloads);
  return {
    reader,
    downloader,
    sources: {
      downloader: () => downloader,
      remoteZips: async () => ({ origin: 'marceau-photos/backups/', zips: await listBackupZips(lister, reader) }),
      localZip: async (file): Promise<ZipRef> => {
        const source = await localZipSource(file);
        return { name: path.basename(file), location: file, size: source.size, open: async () => source };
      },
    },
  };
}

describe('gpb takeout', () => {
  let out: string[];
  let errors: string[];

  beforeEach(() => {
    out = [];
    errors = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(args: string[], sources: TakeoutSources): Promise<string> {
    const program = new Command().exitOverride();
    register(program, config, sources);
    await program.parseAsync(['node', 'gpb', ...args]);
    return out.join('\n');
  }

  it('valider : lit backups/ par plages, affiche parties, dossiers, albums, manquants, non reconnus et verdict', async () => {
    const { sources, reader } = sourcesFor({
      'backups/takeout-20260806T062636Z-1-001.zip': PART,
      'backups/notes.txt': new Uint8Array(3),
      'photos/2020/2020-01/IMG_1.jpg': new Uint8Array(3),
    });
    const output = await run(['takeout', 'valider'], sources);

    expect(process.exitCode).toBeUndefined();
    expect(output).toContain('Source : marceau-photos/backups/ — 1 zip(s)');
    expect(output).toContain('Export 20260806T062636Z-1 : ');
    expect(output).toMatch(/001 {2}takeout-20260806T062636Z-1-001\.zip .* 10 entrée\(s\)/);
    expect(output).toMatch(/Photos de 2020 +année +4 média\(s\) · 2 Ko · 1 sans métadonnées/);
    expect(output).toMatch(/tenerife 2026 +album +1 média\(s\) · 3 octets · 0 sans métadonnées · métadonnées d'album/);
    expect(output).toContain('Albums détectés : tenerife 2026');
    expect(output).toContain('Médias sans métadonnées (1) :\n   Photos de 2020/scan-sans-json.jpg');
    expect(output).toContain('Vidéos de Live Photo (1) : sans métadonnées propres, datées par « gpb takeout analyser »\n   Photos de 2020/IMG_0043.mp4 → IMG_0043.jpg');
    expect(output).toContain(`Fichiers non reconnus (1) :\n   ${ROOT}/tenerife 2026/lisez-moi.txt`);
    expect(output).toContain('Verdict : exploitable, nombre de parties non confirmé (--parties). Rien n\'a été écrit.');
    expect(new Set(reader.calls.map((c) => c.key))).toEqual(new Set(['backups/takeout-20260806T062636Z-1-001.zip']));
    expect(S3Client).not.toHaveBeenCalled();
  });

  it('valider --export : filtre un export ; code 1 et raisons si non exploitable', async () => {
    const { sources } = sourcesFor({
      'backups/takeout-20260806T062636Z-1-001.zip': PART,
      'backups/takeout-20260810T070025Z-1-001.zip': BROKEN,
    });
    const output = await run(['takeout', 'valider', '--export', '20260810T070025Z'], sources);
    expect(output).not.toContain('20260806T062636Z');
    expect(output).toContain('Verdict : non exploitable, nombre de parties non confirmé (--parties).');
    expect(output).toContain('partie takeout-20260810T070025Z-1-001.zip illisible : fin du répertoire central (EOCD) introuvable');
    expect(process.exitCode).toBe(1);
  });

  it('valider --parties : nombre confirmé ; écart → non exploitable, code 1', async () => {
    const { sources } = sourcesFor({ 'backups/takeout-20260806T062636Z-1-001.zip': PART });
    expect(await run(['takeout', 'valider', '--parties', '1'], sources)).toContain('Verdict : exploitable, nombre de parties confirmé (1).');
    expect(process.exitCode).toBeUndefined();
    out.length = 0;
    const output = await run(['takeout', 'valider', '--export', '20260806T062636Z', '--parties', '4'], sources);
    expect(output).toContain('• 1 partie(s) présente(s), 4 attendue(s) (--parties)');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['--parties', 'deux'], '--parties attend un entier positif'],
    [['--parties', '2'], '--parties concerne un seul export : précisez --export'],
  ])('valider %j : refus', async (args, message) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { sources } = sourcesFor({ 'backups/takeout-20260806T062636Z-1-001.zip': PART, 'backups/takeout-20260810T070025Z-1-001.zip': PART });
    await run(['takeout', 'valider', ...args], sources);
    expect(errors.join('\n')).toContain(message);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('valider --export inconnu : refus qui liste les exports présents', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { sources } = sourcesFor({ 'backups/takeout-20260806T062636Z-1-001.zip': PART });
    await run(['takeout', 'valider', '--export', '2019'], sources);
    expect(errors.join('\n')).toContain('aucun export « 2019 » (exports présents : 20260806T062636Z-1)');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('valider --zip : zips locaux, sans aucune lecture distante', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-takeout-'));
    try {
      const file = path.join(dir, 'takeout-20260806T062636Z-1-001.zip');
      fs.writeFileSync(file, PART);
      const { sources, reader } = sourcesFor({});
      const output = await run(['takeout', 'valider', '--zip', file], sources);
      expect(output).toContain('Source : zips locaux — 1 zip(s)');
      expect(output).toContain('Verdict : exploitable');
      expect(reader.calls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [['takeout', 'import', '/chemin/Takeout', '--force']],
    [['takeout', 'list', '/chemin/Takeout', '--albums']],
    [['takeout', 'validate', '/chemin/Takeout']],
    [['archive', 'extract', 'takeout.zip', '--output', '/tmp/x']],
  ])('ancienne commande %j : refus explicite, code 1, rien lu', async (args) => {
    const { sources, reader } = sourcesFor({ 'backups/takeout-20260806T062636Z-1-001.zip': PART });
    await run(args, sources);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain(`gpb ${args[0] === 'archive' ? 'archive' : `takeout ${args[1]}`} : ${LEGACY_MESSAGE}`);
    expect(reader.calls).toEqual([]);
    expect(S3Client).not.toHaveBeenCalled();
  });

  it('listBackupZips : seuls les .zip de backups/, emplacement et taille issus du listing', async () => {
    const { lister, reader } = fakeBucket({ 'backups/a.zip': PART, 'backups/a.txt': PART, 'albums/b.zip': PART, 'backupsX/c.zip': PART });
    const zips = await listBackupZips(lister, reader);
    expect(zips.map((z) => [z.name, z.location, z.size])).toEqual([['a.zip', 'marceau-photos/backups/a.zip', PART.length]]);
    expect(reader.calls).toEqual([]); // le listing ne lit aucun octet
    const source = await zips[0]!.open();
    expect(source.size).toBe(remoteZipSource(reader, 'backups/a.zip', PART.length).size);
  });

  it('le code de l\'ancien format a disparu', () => {
    const src = path.join(__dirname, '../../src');
    for (const legacy of ['takeout/takeout-parser.ts', 'utils/takeout-scanner.ts', 'utils/takeout-extractor.ts', 'commands/archive.ts']) {
      expect(fs.existsSync(path.join(src, legacy))).toBe(false);
    }
    const all = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of all(src)) {
      const text = fs.readFileSync(file, 'utf8');
      expect([file, /takeout import|takeout-parser|takeout-scanner|takeout-extractor|Photos from YYYY|yauzl/.test(text)]).toEqual([file, false]);
    }
  });
});

describe('gpb takeout analyser', () => {
  let out: string[];
  let errors: string[];
  let dir: string;
  let analysisConfig: AppConfig;

  const PHOTO = buildJpeg(undefined, 7); // ni EXIF ni date dans le nom : photoTakenTime converti dans le fuseau
  const NEW_PHOTO = buildJpeg(undefined, 50);
  const takenAt = String(Date.UTC(2020, 0, 31, 23, 30, 0) / 1000);
  const EXPORT = buildZip([
    { name: `${ROOT}/Photos de${NBSP}2020/IMG_0001.JPG`, data: PHOTO, deflate: true },
    { name: `${ROOT}/Photos de${NBSP}2020/IMG_0001.JPG.supplemental-metadata.json`, data: JSON.stringify({ photoTakenTime: { timestamp: takenAt } }) },
    { name: `${ROOT}/tenerife 2026/IMG_0002.JPG`, data: NEW_PHOTO, deflate: true },
    { name: `${ROOT}/Photos de${NBSP}2020/IMG_0002.JPG`, data: NEW_PHOTO },
  ]).bytes;
  const KEY = 'backups/takeout-20260806T062636Z-1-001.zip';

  beforeEach(async () => {
    out = [];
    errors = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.exitCode = undefined;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-analyser-'));
    analysisConfig = { ...config, database: { path: path.join(dir, 'data', 'app.db') } };
    await initDatabase(analysisConfig.database);
  });

  afterEach(() => {
    closeDatabase();
    jest.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[], sources: TakeoutSources): Promise<string> {
    const program = new Command().exitOverride();
    register(program, analysisConfig, sources);
    await program.parseAsync(['node', 'gpb', 'takeout', 'analyser', ...args]);
    return out.join('\n');
  }

  const inventory = (): void => {
    new InventoryModel().replace(
      'marceau-photos',
      [
        { key: 'photos/2020/2020-02/IMG_0001.JPG', size: PHOTO.length, etag: md5(PHOTO), lastModified: null },
        { key: KEY, size: EXPORT.length, etag: md5(EXPORT), lastModified: null }, // backups/ : jamais une archive
      ],
      new Date('2026-09-16T10:00:00Z'),
    );
  };

  it('télécharge et vérifie, analyse, enregistre, exporte ; relance sans retéléchargement', async () => {
    inventory();
    const { sources, reader, downloader } = sourcesFor({ [KEY]: EXPORT });
    const csv = path.join(dir, 'sorties', 'analyse.csv');
    const json = path.join(dir, 'sorties', 'analyse.json');
    const output = await run(['--export', '20260806T062636Z', '--parties', '1', '--sortie', csv, json], sources);

    expect(errors).toEqual([]);
    const local = path.join(dir, 'data', 'takeout', '20260806T062636Z-1', 'takeout-20260806T062636Z-1-001.zip');
    expect(output).toMatch(/takeout-20260806T062636Z-1-001\.zip .* téléchargé — MD5 égal à l'ETag/);
    expect(fs.existsSync(local)).toBe(true);
    expect(output).toMatch(/Médias : 3 .* contenus distincts : 2/);
    expect(output).toMatch(/json_takeout +1/);
    expect(output).toMatch(/déjà archivés \(confirmés par MD5 ou ETag multipart recalculé\) +1/);
    expect(output).toContain('dont confirmés par MD5 : 1 ; par ETag multipart recalculé : 0');
    expect(output).toMatch(/nouveaux +2/);
    expect(output).toContain('Médias ayant un objet de même nom et même taille : 1, dont 1 confirmés');
    expect(output).toMatch(/À envoyer \(contenus distincts nouveaux ou homonymes différents\) : 1 /);
    expect(output).toContain('tenerife 2026/IMG_0002.JPG  =  Photos de 2020/IMG_0002.JPG');
    expect(output).toContain('json_takeout           1 concordant(s), 0 discordant(s), 0 non comparable(s) ; avec photoTakenTime : 1 en Europe/Paris, 0 en UTC');
    expect(output).toContain('Règle des albums à trancher en 4.3 : 0 contenu(s) déjà archivé(s) sous photos/ et présent(s) dans un album conservé ; 1 contenu(s) à envoyer présent(s) dans une année et un album conservé');
    expect(output).toContain('Rien n\'a été écrit dans aucun bucket.');
    expect(fs.readFileSync(csv, 'utf8').trim().split('\n')).toHaveLength(4);
    expect(JSON.parse(fs.readFileSync(json, 'utf8')).export).toBe('20260806T062636Z-1');

    const stored = new TakeoutAnalysisModel().find('20260806T062636Z-1')!;
    expect(stored.media.map((m) => [m.fileName, m.takenAt, m.archive.status])).toEqual([
      ['IMG_0001.JPG', '2020-02-01T00:30:00', 'deja_archive'],
      ['IMG_0002.JPG', null, 'nouveau'],
      ['IMG_0002.JPG', null, 'nouveau'],
    ]);
    expect(stored.zips).toEqual([{ name: 'takeout-20260806T062636Z-1-001.zip', size: EXPORT.length, etag: md5(EXPORT), verification: 'md5' }]);
    const current = {
      zips: [{ name: 'takeout-20260806T062636Z-1-001.zip', size: EXPORT.length, etag: md5(EXPORT) }],
      inventoryCompletedAt: '2026-09-16T10:00:00.000Z',
      keptAlbums: ['TENERIFE 2026'.toLowerCase()],
    };
    const model = new TakeoutAnalysisModel();
    expect(stored.keptAlbums).toEqual(['tenerife 2026']);
    expect(model.findValid('20260806T062636Z-1', current)).not.toBeNull();
    expect(model.findValid('20260806T062636Z-1', { ...current, zips: [{ ...current.zips[0]!, etag: 'autre' }] })).toBeNull();
    expect(model.findValid('20260806T062636Z-1', { ...current, inventoryCompletedAt: '2026-09-17T10:00:00.000Z' })).toBeNull();
    expect(model.findValid('20260806T062636Z-1', { ...current, keptAlbums: ['tenerife 2026', 'mariage'] })).toBeNull();

    out.length = 0;
    const again = await run(['--export', '20260806T062636Z', '--parties', '1', '--fuseau', 'UTC'], sources);
    expect(again).toContain('déjà présent et vérifié, réutilisé');
    expect(downloader.calls).toEqual([KEY]);
    expect(new TakeoutAnalysisModel().find('20260806T062636Z-1')!.media[0]!.takenAt).toBe('2020-01-31T23:30:00');
    expect(reader.calls.every((c) => c.key === KEY)).toBe(true);
    expect(S3Client).not.toHaveBeenCalled();
  });

  it.each([
    ['sans inventaire du bucket dédié', ['--export', '20260806T062636Z', '--parties', '1'], false, 'aucun inventaire local du bucket dédié « marceau-photos »'],
    ['nombre de parties différent', ['--export', '20260806T062636Z', '--parties', '2'], true, 'non exploitable (gpb takeout valider --export 20260806T062636Z --parties 2) : 1 partie(s) présente(s), 2 attendue(s)'],
    ['fuseau inconnu', ['--export', '20260806T062636Z', '--parties', '1', '--fuseau', 'Mars/Olympus'], true, 'fuseau horaire inconnu « Mars/Olympus »'],
    ['export inconnu', ['--export', '2019', '--parties', '1'], true, 'aucun export « 2019 »'],
  ])('refus : %s, rien téléchargé ni enregistré', async (_label, args, withInventory, message) => {
    if (withInventory) inventory();
    const { sources, downloader } = sourcesFor({ [KEY]: EXPORT });
    await run(args, sources);
    expect(errors.join('\n')).toContain(message);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(downloader.calls).toEqual([]);
    expect(new TakeoutAnalysisModel().find('20260806T062636Z-1')).toBeNull();
  });

  it('--parties obligatoire', async () => {
    const { sources } = sourcesFor({ [KEY]: EXPORT });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--export', '20260806T062636Z'], sources)).rejects.toThrow(/--parties/);
  });

  it('zip téléchargé différent de son ETag : refusé, aucune analyse, aucun fichier local', async () => {
    inventory();
    const altered = EXPORT.slice();
    altered[40]! ^= 0xff;
    const { sources } = sourcesFor({ [KEY]: EXPORT }, { [KEY]: altered });
    // Le faux téléchargeur annonce l'ETag du contenu servi : il diffère du listing.
    await run(['--export', '20260806T062636Z', '--parties', '1'], sources);
    expect(errors.join('\n')).toContain('zip refusé, il ne sera pas utilisé');
    expect(new TakeoutAnalysisModel().find('20260806T062636Z-1')).toBeNull();
    expect(fs.readdirSync(path.join(dir, 'data', 'takeout', '20260806T062636Z-1'))).toEqual([]);
  });
});
