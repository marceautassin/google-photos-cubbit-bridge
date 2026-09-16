import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countingSource, localZipSource, readZipDirectory, remoteZipSource, ZipSource, ZipStructureError } from '../../src/takeout/zip-directory';
import { buildZip, FakeRangeReader, patch } from '../fixtures/zip-builder';

const NBSP = '\u00a0';
const memorySource = (bytes: Uint8Array): ZipSource => ({ size: bytes.length, read: async (s, e) => bytes.slice(s, e + 1) });

const FILES = [
  { name: `Takeout/Google${NBSP}Photos/Photos de${NBSP}2020/IMG_20200104_154653.jpg`, data: 'jpeg' },
  { name: 'Takeout/Google Photos/Baptême Raphaëlle/métadonnées.json', data: '{}' },
  { name: 'Takeout/Google Photos/'.normalize('NFD') + 'Été/a.mp4'.normalize('NFD'), data: 'mp4!' },
];

describe('readZipDirectory', () => {
  it('lit les noms UTF-8 tels quels, les tailles et la méthode', async () => {
    const zip = buildZip(FILES);
    const counter = countingSource(memorySource(zip.bytes));
    const directory = await readZipDirectory(counter.source);
    expect(directory.zip64).toBe(false);
    expect(directory.entries).toEqual(FILES.map((f) => ({ name: f.name, size: f.data.length, compressedSize: f.data.length, method: 0 })));
    expect(counter.bytesRead()).toBe(zip.bytes.length); // petit zip : la queue couvre tout
  });

  it('lit un zip64 (tailles et positions dans le champ supplémentaire)', async () => {
    const zip = buildZip(FILES, { zip64: true });
    const directory = await readZipDirectory(memorySource(zip.bytes));
    expect(directory.zip64).toBe(true);
    expect(directory.entries.map((e) => [e.name, e.size])).toEqual(FILES.map((f) => [f.name, f.data.length]));
  });

  it('lit un zip64 dont le commentaire maximal repousse le localisateur hors de la queue', async () => {
    const zip = buildZip(FILES, { zip64: true, comment: 'x'.repeat(0xffff) });
    const reader = new FakeRangeReader('marceau-photos', new Map([['z.zip', zip.bytes]]));
    const directory = await readZipDirectory(remoteZipSource(reader, 'z.zip', zip.bytes.length));
    expect(directory.entries).toHaveLength(3);
    expect(reader.calls.length).toBeGreaterThan(1);
  });

  it('ne lit que la queue et le répertoire central d\'un gros zip distant (octets lus comptés)', async () => {
    const big = new Uint8Array(8 * 1024 * 1024);
    const files = [
      { name: 'Takeout/Google Photos/Photos de 2020/VID_1.mp4', data: big },
      ...Array.from({ length: 1500 }, (_, i) => ({
        name: `Takeout/Google Photos/Photos de 2020/IMG_2020010${i}_123456_nom_assez_long.jpg.supplemental-metadata.json`,
        data: '{}',
      })),
    ];
    const zip = buildZip(files);
    expect(zip.directorySize).toBeGreaterThan(65_557); // le répertoire central ne tient pas dans la queue
    const reader = new FakeRangeReader('marceau-photos', new Map([['backups/t.zip', zip.bytes]]));
    const directory = await readZipDirectory(remoteZipSource(reader, 'backups/t.zip', zip.bytes.length));

    expect(directory.entries).toHaveLength(1501);
    expect(reader.calls).toHaveLength(2);
    expect(reader.bytesServed).toBeLessThan(zip.bytes.length / 20);
    // Aucune lecture ne touche les 8 Mo de données de la vidéo
    expect(reader.calls.every((c) => c.start >= 30 + files[0]!.name.length + big.length)).toBe(true);
  });

  it('lit un zip local par plages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-zip-'));
    try {
      const file = path.join(dir, 'takeout-20260810T070025Z-1-001.zip');
      fs.writeFileSync(file, buildZip(FILES).bytes);
      const directory = await readZipDirectory(await localZipSource(file));
      expect(directory.entries.map((e) => e.name)).toEqual(FILES.map((f) => f.name));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('zips illisibles ou incohérents', () => {
    const zip = buildZip(FILES);
    const { eocdOffset, directoryOffset, entryOffsets } = zip;
    const cases: [string, Uint8Array, string][] = [
      ['zip tronqué (fin absente)', zip.bytes.slice(0, zip.bytes.length - 10), 'EOCD) introuvable'],
      ['fichier qui n\'est pas un zip', new TextEncoder().encode('ceci n\'est pas un zip, mais un texte assez long'), 'EOCD) introuvable'],
      ['fichier trop court', new Uint8Array(5), 'trop court'],
      ['une entrée de plus annoncée', patch(patch(zip.bytes, eocdOffset + 10, 4, 16), eocdOffset + 8, 4, 16), 'tronqué : 3 entrée(s) lue(s) sur 4'],
      ['une entrée de moins annoncée', patch(patch(zip.bytes, eocdOffset + 10, 2, 16), eocdOffset + 8, 2, 16), 'incohérent'],
      ['taille du répertoire annoncée trop grande', patch(zip.bytes, eocdOffset + 12, zip.directorySize + 1, 32), 'non contigu'],
      ['position du répertoire incohérente', patch(zip.bytes, eocdOffset + 16, directoryOffset + 1, 32), 'non contigu'],
      ['répertoire central plus court que sa fin (trou)', patch(zip.bytes, eocdOffset + 12, zip.directorySize - 1, 32), 'non contigu'],
      ['compte d\'entrées énorme', patch(patch(zip.bytes, eocdOffset + 10, 60_000, 16), eocdOffset + 8, 60_000, 16), 'incohérent : ' + zip.directorySize + ' octets pour 60000'],
      ['taille saturée sans champ zip64', patch(zip.bytes, entryOffsets[0]! + 20, 0xffffffff, 32), 'champ zip64 absent'],
      ['entrées qui se chevauchent', patch(zip.bytes, entryOffsets[1]! + 42, 1, 32), 'chevauchant'],
      ['signature d\'entrée corrompue', patch(zip.bytes, entryOffsets[1]!, 0x12345678, 32), 'signature invalide à l\'entrée 2'],
      ['zip multi-volume', patch(zip.bytes, eocdOffset + 4, 1, 16), 'multi-volume'],
      ['méthode de compression inconnue', patch(zip.bytes, entryOffsets[0]! + 10, 14, 16), 'méthode de compression 14'],
      ['entrée chiffrée', patch(zip.bytes, entryOffsets[0]! + 8, 0x0801, 16), 'chiffrée'],
      ['données hors des bornes', patch(zip.bytes, entryOffsets[2]! + 42, directoryOffset, 32), 'hors des bornes'],
      ['zip64 annoncé sans localisateur', patch(zip.bytes, eocdOffset + 16, 0xffffffff, 32), 'localisateur zip64 absent'],
    ];
    it.each(cases)('%s', async (_label, bytes, message) => {
      const promise = readZipDirectory(memorySource(bytes));
      await expect(promise).rejects.toThrow(ZipStructureError);
      await expect(readZipDirectory(memorySource(bytes))).rejects.toThrow(message);
    });

    it('fin de répertoire factice cachée en fin de commentaire', async () => {
      const fake = new Uint8Array(22);
      new DataView(fake.buffer).setUint32(0, 0x06054b50, true); // 0 entrée, répertoire vide à la position 0
      const withFake = buildZip(FILES, { comment: String.fromCharCode(...fake) });
      await expect(readZipDirectory(memorySource(withFake.bytes))).rejects.toThrow('non contigu');
    });

    it('zip64 : enregistrement de fin hors des bornes, puis signature invalide', async () => {
      const z64 = buildZip(FILES, { zip64: true });
      const locator = z64.eocdOffset - 20;
      const recordOffset = locator - 56;
      const outOfBounds = patch(z64.bytes, locator + 8, locator, 32);
      await expect(readZipDirectory(memorySource(outOfBounds))).rejects.toThrow('zip64 hors des bornes');
      const badSignature = patch(z64.bytes, recordOffset, 0x12345678, 32);
      await expect(readZipDirectory(memorySource(badSignature))).rejects.toThrow('fin zip64 introuvable');
    });

    it('zip sans aucune entrée : lisible, liste vide', async () => {
      await expect(readZipDirectory(memorySource(buildZip([]).bytes))).resolves.toEqual({ entries: [], zip64: false });
    });

    it('nom qui n\'est pas de l\'UTF-8', async () => {
      const bad = buildZip([{ name: new Uint8Array([0x54, 0xff, 0xfe, 0x2e, 0x6a, 0x70, 0x67]), data: 'x' }]);
      await expect(readZipDirectory(memorySource(bad.bytes))).rejects.toThrow('pas de l\'UTF-8 valide');
    });

    it('lecture incomplète (objet plus court que la taille listée)', async () => {
      const source = { size: zip.bytes.length + 100, read: async (s: number, e: number): Promise<Uint8Array> => zip.bytes.slice(s, e + 1) };
      await expect(readZipDirectory(source)).rejects.toThrow('lecture incomplète');
    });
  });
});
