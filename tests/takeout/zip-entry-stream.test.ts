import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readZipDirectory, localZipSource, ZipEntry } from '../../src/takeout/zip-directory';
import { readSmallZipEntry, readZipEntry } from '../../src/takeout/zip-entry-stream';
import { buildZip, patch, ZipFileSpec } from '../fixtures/zip-builder';

describe('lecture en flux d\'une entrée de zip local', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-entry-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const big = crypto.randomBytes(300_000); // incompressible : plusieurs morceaux
  const text = 'bonjour '.repeat(10_000); // très compressible

  async function write(files: ZipFileSpec[], bytes?: Uint8Array, options: { zip64?: boolean } = {}): Promise<{ file: string; entries: ZipEntry[] }> {
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, bytes ?? buildZip(files, options).bytes);
    const { entries } = await readZipDirectory(await localZipSource(file));
    return { file, entries };
  }

  async function content(file: string, entry: ZipEntry): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await readZipEntry(file, entry, (c) => chunks.push(c));
    return Buffer.concat(chunks);
  }

  it.each([false, true])('stockée et deflate, zip64 %s : contenu exact, CRC et position lus du répertoire central', async (zip64) => {
    const { file, entries } = await write(
      [
        { name: 'a/stockee.bin', data: big },
        { name: 'a/deflate.txt', data: text, deflate: true },
        { name: 'a/vide.txt', data: '', deflate: true },
        { name: 'a/vide-stockee.txt', data: '' },
      ],
      undefined,
      { zip64 },
    );
    expect(entries.map((e) => e.method)).toEqual([0, 8, 8, 0]);
    expect(entries[1]!.compressedSize).toBeLessThan(entries[1]!.size);
    expect((await content(file, entries[0]!)).equals(big)).toBe(true);
    expect((await content(file, entries[1]!)).toString()).toBe(text);
    expect((await content(file, entries[2]!)).length).toBe(0);
    expect((await content(file, entries[3]!)).length).toBe(0);
    expect((await readSmallZipEntry(file, entries[1]!, 1_000_000)).toString()).toBe(text);
  });

  it.each([
    ['deflate', true],
    ['stockée', false],
  ])('CRC-32 annoncé faux (%s) : erreur explicite « zip corrompu »', async (_label, deflate) => {
    const { file, entries } = await write([{ name: 'x.jpg', data: text, deflate, crc32: 0x12345678 }]);
    await expect(content(file, entries[0]!)).rejects.toThrow(/x\.jpg : CRC-32 invalide \(calculé [0-9a-f]+, annoncé 12345678\) : zip corrompu/);
  });

  it('octet de données altéré dans une entrée stockée : CRC-32 invalide', async () => {
    const built = buildZip([{ name: 'x.bin', data: big }]);
    const bytes = built.bytes.slice();
    bytes[30 + 'x.bin'.length + 1000]! ^= 0xff;
    const { file, entries } = await write([], bytes);
    await expect(content(file, entries[0]!)).rejects.toThrow('CRC-32 invalide');
  });

  it('données deflate altérées : erreur de décompression ou de CRC', async () => {
    const built = buildZip([{ name: 'x.txt', data: text, deflate: true }]);
    const bytes = built.bytes.slice();
    for (let i = 40; i < 60; i++) bytes[i]! ^= 0x5a;
    const { file, entries } = await write([], bytes);
    await expect(content(file, entries[0]!)).rejects.toThrow(/x\.txt : (décompression impossible|CRC-32 invalide|taille décompressée|contenu plus long)/);
  });

  it('taille décompressée annoncée différente : erreur', async () => {
    const built = buildZip([{ name: 'x.txt', data: text, deflate: true }]);
    const { file, entries } = await write([], patch(built.bytes, built.entryOffsets[0]! + 24, text.length + 1, 32));
    await expect(content(file, entries[0]!)).rejects.toThrow('x.txt : taille décompressée 80000 octets, 80001 annoncés');
    const shorter = buildZip([{ name: 'y.txt', data: text, deflate: true }]);
    const second = await write([], patch(shorter.bytes, shorter.entryOffsets[0]! + 24, 10, 32));
    await expect(content(second.file, second.entries[0]!)).rejects.toThrow('contenu plus long que la taille annoncée');
  });

  it('en-tête local absent à la position annoncée : erreur', async () => {
    const built = buildZip([{ name: 'x.txt', data: 'abc' }]);
    const { file, entries } = await write([], patch(built.bytes, 0, 0, 32));
    await expect(content(file, entries[0]!)).rejects.toThrow('x.txt : en-tête local introuvable à la position 0');
  });

  it('sonde B : en-tête local d\'une autre entrée (nom ou méthode différents du répertoire central) : erreur', async () => {
    const built = buildZip([{ name: 'x.txt', data: text, deflate: true }]);
    const renamed = built.bytes.slice();
    renamed[30] = 'y'.charCodeAt(0);
    const first = await write([], renamed);
    await expect(content(first.file, first.entries[0]!)).rejects.toThrow('x.txt : l\'en-tête local porte un autre nom ("y.txt") : zip corrompu');
    const second = await write([], patch(built.bytes, 8, 0, 16));
    await expect(content(second.file, second.entries[0]!)).rejects.toThrow('x.txt : méthode 0 dans l\'en-tête local, 8 dans le répertoire central : zip corrompu');
  });

  it('petite entrée : refus au-delà de la taille maximale', async () => {
    const { file, entries } = await write([{ name: 'm.json', data: text }]);
    await expect(readSmallZipEntry(file, entries[0]!, 100)).rejects.toThrow('m.json : 80000 octets, au-delà de 100 octets attendus');
  });
});
