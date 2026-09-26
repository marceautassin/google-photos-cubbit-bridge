import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DownloadedObject, ObjectDownloader } from '../../src/clients/types';
import { EnsureOptions, ensureLocalZip, EtagHasher, RemoteZip, ZipProgress } from '../../src/takeout/zip-download';
import { readZipDirectory, ZipEntry } from '../../src/takeout/zip-directory';
import { MIB, MultipartEtagHasher, multipartPartSizes } from '../../src/utils/multipart-etag';
import { buildZip } from '../fixtures/zip-builder';

const md5 = (data: Uint8Array): string => crypto.createHash('md5').update(data).digest('hex');

/** ETag multipart tel que S3 le calcule : MD5 des MD5 binaires des parties, suivi du nombre de parties. */
function multipartEtag(data: Uint8Array, partSize: number): string {
  const digests: Buffer[] = [];
  for (let p = 0; p < data.length; p += partSize) digests.push(crypto.createHash('md5').update(data.subarray(p, p + partSize)).digest());
  return `${crypto.createHash('md5').update(Buffer.concat(digests)).digest('hex')}-${digests.length}`;
}

interface FakeObject {
  bytes: Uint8Array;
  etag: string | null;
  announcedSize?: number | null;
  announcedEtag?: string | null;
  failAfter?: number; // coupure après ce nombre d'octets
}

/** Faux téléchargeur en mémoire : aucun réseau, compte les téléchargements. */
class FakeDownloader implements ObjectDownloader {
  readonly bucket = 'marceau-photos';
  readonly calls: string[] = [];
  constructor(readonly objects: Map<string, FakeObject>) {}

  async download(key: string): Promise<DownloadedObject> {
    this.calls.push(key);
    const object = this.objects.get(key);
    if (!object) throw new Error(`objet absent : ${key}`);
    const body = async function* (): AsyncGenerator<Uint8Array> {
      for (let p = 0; p < object.bytes.length; p += 64 * 1024) {
        if (object.failAfter !== undefined && p >= object.failAfter) throw new Error('connexion interrompue');
        yield object.bytes.subarray(p, p + 64 * 1024);
      }
    };
    return {
      body: body(),
      size: object.announcedSize === undefined ? object.bytes.length : object.announcedSize,
      etag: object.announcedEtag === undefined ? object.etag : object.announcedEtag,
    };
  }
}

const ZIP = buildZip([
  { name: 'Takeout/Google Photos/Photos de 2020/a.jpg', data: crypto.randomBytes(1_500_000) },
  { name: 'Takeout/Google Photos/Photos de 2020/b.txt', data: 'texte '.repeat(50_000), deflate: true },
]).bytes;
const KEY = 'backups/takeout-20260806T062636Z-1-001.zip';
const NAME = 'takeout-20260806T062636Z-1-001.zip';

describe('ETag multipart recalculé localement', () => {
  it('tailles usuelles d\'abord, puis parties égales, puis autres multiples ; seulement celles qui donnent exactement N parties', () => {
    expect(multipartPartSizes(2_147_000_000, 410)[0]).toBe(5 * MIB);
    const sizes = multipartPartSizes(12 * MIB + 1, 3);
    expect(sizes).toEqual(expect.arrayContaining([5 * MIB, 6 * MIB]));
    expect(sizes.indexOf(5 * MIB)).toBeLessThan(sizes.indexOf(6 * MIB));
    for (const size of sizes) expect(Math.ceil((12 * MIB + 1) / size)).toBe(3);
    expect(sizes.length).toBeLessThanOrEqual(8);
    expect(multipartPartSizes(10, 1)).toEqual([10]);
    expect(multipartPartSizes(10, 0)).toEqual([]);
    expect(multipartPartSizes(3_000_001, 3)).toContain(1_000_001);
  });

  it('MultipartEtagHasher : taille de partie retrouvée, ou aucune', () => {
    const data = crypto.randomBytes(3 * MIB + 17);
    const hasher = new MultipartEtagHasher(multipartEtag(data, MIB), data.length);
    for (let p = 0; p < data.length; p += 77_777) hasher.update(data.subarray(p, p + 77_777));
    expect(hasher.matchingPartSize()).toBe(MIB);
    const other = new MultipartEtagHasher(multipartEtag(data, 1_100_003), data.length);
    other.update(data);
    expect(other.matchingPartSize()).toBeNull();
  });

  it('EtagHasher : MD5 simple, multipart retrouvé, multipart non recalculable (tailles essayées signalées), MD5 différent', () => {
    const data = crypto.randomBytes(3 * MIB + 17);
    const feed = (hasher: EtagHasher): EtagHasher => {
      for (let p = 0; p < data.length; p += 100_000) hasher.update(data.subarray(p, p + 100_000));
      return hasher;
    };
    expect(feed(new EtagHasher(`"${md5(data).toUpperCase()}"`, data.length)).check()).toEqual({ verification: 'md5', partSize: null, mismatch: null, detail: null });
    expect(feed(new EtagHasher(multipartEtag(data, MIB), data.length)).check()).toEqual({ verification: 'etag_multipart', partSize: MIB, mismatch: null, detail: null });
    const exotic = feed(new EtagHasher(multipartEtag(data, 1_100_003), data.length)).check();
    expect(exotic).toMatchObject({ verification: null, mismatch: null });
    expect(exotic.detail).toMatch(/^ETag [0-9a-f]{32}-3 non retrouvé avec les tailles de partie donnant le bon nombre de parties \(1048582 octets\)$/);
    expect(feed(new EtagHasher('0'.repeat(32), data.length)).check().mismatch).toMatch(/^MD5 du contenu [0-9a-f]{32} différent de l'ETag 0{32}$/);
  });
});

describe('téléchargement local vérifié des zips', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-download-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const remote = (etag: string | null, size = ZIP.length): RemoteZip => ({ name: NAME, key: KEY, size, etag });
  const setup = (object: FakeObject): FakeDownloader => new FakeDownloader(new Map([[KEY, object]]));
  const localFiles = (): string[] => fs.readdirSync(dir).sort();
  const entriesOf = async (bytes: Uint8Array): Promise<ZipEntry[]> =>
    (await readZipDirectory({ size: bytes.length, read: async (start, end) => bytes.slice(start, end + 1) })).entries;
  const options = (extra: Partial<EnsureOptions> = {}, remoteBytes: Uint8Array = ZIP): EnsureOptions => ({
    remoteEntries: () => entriesOf(remoteBytes),
    freeSpace: async () => Number.MAX_SAFE_INTEGER,
    ...extra,
  });

  it('ETag MD5 simple : téléchargé, vérifié, renommé, marqueur écrit ; progression signalée', async () => {
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    const progress: ZipProgress[] = [];
    const zip = await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options({ onProgress: (p) => progress.push(p) }));
    expect(zip).toMatchObject({ verification: 'md5', origin: 'telecharge', path: path.join(dir, NAME), note: null });
    expect(Buffer.from(fs.readFileSync(zip.path)).equals(Buffer.from(ZIP))).toBe(true);
    expect(localFiles()).toEqual([NAME, `${NAME}.verification.json`]);
    expect(progress.at(-1)).toEqual({ zip: NAME, phase: 'telechargement', done: ZIP.length, total: ZIP.length });
  });

  it('reprise : un zip déjà vérifié n\'est ni retéléchargé ni relu', async () => {
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options());
    const progress: ZipProgress[] = [];
    const again = await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options({ onProgress: (p) => progress.push(p) }));
    expect(again.origin).toBe('reutilise');
    expect(downloader.calls).toHaveLength(1);
    expect(progress).toEqual([]);
  });

  it('zip complet sans marqueur : revérifié localement, sans téléchargement', async () => {
    fs.writeFileSync(path.join(dir, NAME), ZIP);
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    const zip = await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options());
    expect(zip).toMatchObject({ origin: 'reverifie', verification: 'md5' });
    expect(downloader.calls).toEqual([]);
  });

  it('marqueur périmé (ETag listé changé) ou fichier local altéré : remplacé par un nouveau téléchargement, raison consignée', async () => {
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options());
    const altered = Buffer.from(ZIP);
    altered[100]! ^= 0xff;
    fs.writeFileSync(path.join(dir, NAME), altered);
    const zip = await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options());
    expect(zip.origin).toBe('telecharge');
    expect(zip.note).toMatch(/exemplaire local complet mais non conforme remplacé \(.*MD5 du contenu/);
    expect(downloader.calls).toHaveLength(2);
    expect(Buffer.from(fs.readFileSync(zip.path)).equals(Buffer.from(ZIP))).toBe(true);
  });

  it('fichier partiel d\'une exécution interrompue : remplacé', async () => {
    fs.writeFileSync(path.join(dir, NAME), ZIP.subarray(0, 1000));
    fs.writeFileSync(path.join(dir, `${NAME}.partiel`), ZIP.subarray(0, 5000));
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    const zip = await ensureLocalZip(downloader, remote(md5(ZIP)), dir, options());
    expect(zip).toMatchObject({ origin: 'telecharge', note: `taille locale 1000 octets ≠ ${ZIP.length} listés, remplacé` });
    expect(localFiles()).toEqual([NAME, `${NAME}.verification.json`]);
  });

  it.each([
    ['contenu différent de l\'ETag MD5', { bytes: Buffer.from(ZIP).fill(1, 50, 60), etag: md5(ZIP) }, /MD5 du contenu .* différent de l'ETag/],
    ['taille annoncée différente', { bytes: ZIP, etag: md5(ZIP), announcedSize: ZIP.length + 1 }, /taille annoncée \d+ octets, \d+ listés/],
    ['ETag de la réponse différent du listing', { bytes: ZIP, etag: md5(ZIP), announcedEtag: 'f'.repeat(32) }, /ETag de la réponse f{32} différent de l'ETag listé/],
    ['octets manquants', { bytes: ZIP.subarray(0, ZIP.length - 10), etag: md5(ZIP), announcedSize: null }, /\d+ octets reçus sur \d+/],
    ['coupure réseau', { bytes: ZIP, etag: md5(ZIP), failAfter: 100_000 }, /téléchargement interrompu \(.*connexion interrompue\)/],
  ])('%s : zip refusé, aucun fichier laissé', async (_label, object, message) => {
    const downloader = setup(object as FakeObject);
    await expect(ensureLocalZip(downloader, remote(md5(ZIP)), dir, options())).rejects.toThrow(message);
    await expect(ensureLocalZip(downloader, remote(md5(ZIP)), dir, options())).rejects.toThrow('zip refusé, il ne sera pas utilisé');
    expect(localFiles()).toEqual([]);
  });

  it('ETag multipart dont la taille de partie se déduit : recalculé', async () => {
    const big = buildZip([{ name: 'Takeout/Google Photos/Photos de 2020/v.mp4', data: crypto.randomBytes(2 * MIB + 300) }]).bytes;
    const etag = multipartEtag(big, MIB);
    const downloader = setup({ bytes: big, etag });
    const zip = await ensureLocalZip(downloader, remote(etag, big.length), dir, options({}, big));
    expect(zip).toMatchObject({ verification: 'etag_multipart', partSize: MIB });
  });

  it('ETag multipart non recalculable : repli sur CRC-32 de toutes les entrées ; CRC faux → refusé', async () => {
    const etag = multipartEtag(ZIP, 700_001);
    const zip = await ensureLocalZip(setup({ bytes: ZIP, etag }), remote(etag), dir, options());
    expect(zip).toMatchObject({ verification: 'crc_entrees', partSize: null });
    expect(zip.detail).toMatch(/non retrouvé avec les tailles de partie donnant le bon nombre de parties/);
    fs.rmSync(dir, { recursive: true, force: true });

    const corrupt = buildZip([{ name: 'Takeout/Google Photos/Photos de 2020/a.jpg', data: crypto.randomBytes(1_500_000), crc32: 7 }]).bytes;
    const corruptEtag = multipartEtag(corrupt, 700_001);
    await expect(ensureLocalZip(setup({ bytes: corrupt, etag: corruptEtag }), remote(corruptEtag, corrupt.length), dir, options({}, corrupt))).rejects.toThrow(
      /vérification en échec \(.*CRC-32 invalide.*\) — zip refusé/,
    );
    expect(localFiles()).toEqual([]);
  });

  it('ETag multipart dont une taille déduite ne correspond pas : pas de refus sans preuve, repli CRC', async () => {
    const etag = `${'a'.repeat(32)}-2`;
    const zip = await ensureLocalZip(setup({ bytes: ZIP, etag }), remote(etag), dir, options());
    expect(zip.verification).toBe('crc_entrees');
  });

  it('sonde A : ETag non recalculable et fichier local différent de même nom et taille → refusé (répertoire central comparé au zip distant)', async () => {
    const files = (seed: string): Uint8Array =>
      buildZip([
        { name: 'Takeout/Google Photos/Photos de 2020/a.jpg', data: crypto.createHash('sha512').update(seed).digest() },
        { name: 'Takeout/Google Photos/Photos de 2020/b.txt', data: `contenu ${seed}` },
      ]).bytes;
    const remoteBytes = files('A');
    const other = files('B');
    expect(other.length).toBe(remoteBytes.length);
    const etag = `${'c'.repeat(32)}-2`;

    // Exemplaire local B déjà présent, sans marqueur : rejeté, puis A retéléchargé et accepté.
    fs.writeFileSync(path.join(dir, NAME), other);
    const downloader = setup({ bytes: remoteBytes, etag });
    const zip = await ensureLocalZip(downloader, remote(etag, remoteBytes.length), dir, options({}, remoteBytes));
    expect(zip.origin).toBe('telecharge');
    expect(zip.note).toMatch(/non conforme remplacé \(.*répertoire central différent de celui du zip distant \(entrée 1 \(.*a\.jpg\) : crc32 différent/);
    expect(zip.verification).toBe('crc_entrees');

    // Octets B servis au téléchargement alors que le zip distant (lu par plages) est A : refusé et supprimé.
    fs.rmSync(dir, { recursive: true, force: true });
    await expect(ensureLocalZip(setup({ bytes: other, etag }), remote(etag, other.length), dir, options({}, remoteBytes))).rejects.toThrow(
      /vérification en échec \(.*répertoire central différent de celui du zip distant .*\) — zip refusé/,
    );
    expect(localFiles()).toEqual([]);
  });

  it('espace disque insuffisant : rien téléchargé', async () => {
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    await expect(ensureLocalZip(downloader, remote(md5(ZIP)), dir, options({ freeSpace: async () => ZIP.length }))).rejects.toThrow(
      /espace disque insuffisant .* rien n'a été téléchargé/,
    );
    expect(downloader.calls).toEqual([]);
  });

  it('échec à l\'ouverture du téléchargement : aucun fichier partiel laissé', async () => {
    fs.writeFileSync(path.join(dir, `${NAME}.partiel`), 'restes');
    const downloader = setup({ bytes: ZIP, etag: md5(ZIP) });
    downloader.download = async (): Promise<DownloadedObject> => {
      throw new Error('réseau coupé');
    };
    await expect(ensureLocalZip(downloader, remote(md5(ZIP)), dir, options())).rejects.toThrow('réseau coupé');
    expect(localFiles()).toEqual([]);
  });
});
