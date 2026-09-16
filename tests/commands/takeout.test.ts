jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn() };
});

import { S3Client } from '@aws-sdk/client-s3';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BucketLister, BucketObjectPage } from '../../src/clients/types';
import { LEGACY_MESSAGE, listBackupZips, register, TakeoutSources } from '../../src/commands/takeout';
import { AppConfig } from '../../src/config/types';
import { ZipRef } from '../../src/takeout/takeout-validation';
import { localZipSource, remoteZipSource } from '../../src/takeout/zip-directory';
import { buildZip, FakeRangeReader } from '../fixtures/zip-builder';

// Configuration écrite à la main : `src/config` n'est pas importé (il chargerait le fichier .env).
const config = {
  cubbit: { endpoint: '', accessKeyId: '', secretAccessKey: '', bucket: 'marceau' },
  sync: { supportedFormats: ['jpg', 'mp4'] },
  repair: { destinationBucket: 'marceau-photos' },
} as unknown as AppConfig;

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
      objects: Object.entries(objects).map(([key, bytes]) => ({ key, size: bytes.length, etag: null, lastModified: null })),
      isTruncated: false,
    }),
  };
  return { lister, reader };
}

function sourcesFor(objects: Record<string, Uint8Array>): { sources: TakeoutSources; reader: FakeRangeReader } {
  const { lister, reader } = fakeBucket(objects);
  return {
    reader,
    sources: {
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
    expect(output).toContain('Vidéos de Live Photo (1) : sans métadonnées propres, date à décider en 4.2\n   Photos de 2020/IMG_0043.mp4 → IMG_0043.jpg');
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
