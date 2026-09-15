import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { closeDatabase, initDatabase } from '../../src/database/connection';
import { InventoryModel } from '../../src/database/inventory-model';
import { InventoryDateModel } from '../../src/database/inventory-date-model';
import {
  dateInventory,
  DatingOptions,
  suspectReason,
  MAX_CONSECUTIVE_FAILURES,
  parseExifDate,
  readExifDate,
  selectMedia,
  summarizeDates,
  EXIF_FORMATS,
} from '../../src/inventory/dating';
import { S3ObjectRangeReader } from '../../src/clients/object-range-reader';
import { BucketObject, ObjectRangeReader } from '../../src/clients/types';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { buildJpeg, buildTiff } from '../fixtures/jpeg-exif';
import { ObjectDating } from '../../src/database/inventory-date-model';
import { getDatabase } from '../../src/database/connection';

const FORMATS = ['jpg', 'jpeg', 'png', 'mp4'];
const KO = 1024;

/**
 * Objet d'inventaire dont `lastModified` (date d'upload, fausse) lève une erreur si on la lit :
 * la cascade ne doit jamais s'en servir.
 */
function obj(key: string, size: number, etag = `etag-${key}`): BucketObject {
  const object = { key, size, etag } as BucketObject;
  Object.defineProperty(object, 'lastModified', {
    enumerable: false,
    get() {
      throw new Error('lastModified ne doit jamais servir de date de prise de vue');
    },
  });
  return object;
}

/** Lecteur mocké servant des contenus en mémoire, en respectant les plages demandées. */
function fakeReader(contents: Record<string, Buffer>, failures: Record<string, number> = {}) {
  const calls: { key: string; start: number; end: number }[] = [];
  const reader: ObjectRangeReader = {
    bucket: 'marceau',
    async readRange(key, start, end) {
      calls.push({ key, start, end });
      if ((failures[key] ?? 0) > 0) {
        failures[key]!--;
        const error = new Error('socket hang up');
        error.name = 'TimeoutError';
        throw error;
      }
      const content = contents[key];
      if (!content) throw new Error(`objet inconnu ${key}`);
      return new Uint8Array(content.subarray(start, end + 1));
    },
  };
  return { reader, calls };
}

const WITH_EXIF = buildJpeg({ DateTimeOriginal: '2016:02:20 14:03:11', CreateDate: '2016:02:21 08:00:00', ModifyDate: '2024:01:29 10:00:00' });
const CREATE_ONLY = buildJpeg({ CreateDate: '2018:05:01 09:15:00', ModifyDate: '2024:01:29 10:00:00' });
const MODIFY_ONLY = buildJpeg({ ModifyDate: '2012:12:31 23:59:59' });
const NO_EXIF = buildJpeg();
const FAR_EXIF = buildJpeg({ DateTimeOriginal: '2015:07:14 22:00:00' }, 200 * KO);

describe('lecture EXIF', () => {
  it('essaie DateTimeOriginal, puis CreateDate, puis ModifyDate', async () => {
    await expect(parseExifDate(WITH_EXIF)).resolves.toEqual({ takenAt: '2016-02-20T14:03:11', tag: 'DateTimeOriginal' });
    await expect(parseExifDate(CREATE_ONLY)).resolves.toEqual({ takenAt: '2018-05-01T09:15:00', tag: 'CreateDate' });
    await expect(parseExifDate(MODIFY_ONLY)).resolves.toEqual({ takenAt: '2012-12-31T23:59:59', tag: 'ModifyDate' });
  });

  it('ignore une date EXIF nulle et passe au champ suivant', async () => {
    const zero = buildJpeg({ DateTimeOriginal: '0000:00:00 00:00:00', ModifyDate: '2011:01:01 01:01:01' });
    await expect(parseExifDate(zero)).resolves.toEqual({ takenAt: '2011-01-01T01:01:01', tag: 'ModifyDate' });
  });

  it('rend null sans EXIF ou sur un contenu illisible', async () => {
    await expect(parseExifDate(NO_EXIF)).resolves.toBeNull();
    await expect(parseExifDate(Buffer.alloc(500, 7))).resolves.toBeNull();
  });

  it('le résultat ne dépend pas du fuseau de la machine', async () => {
    const originalTz = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Europe/Paris', 'Pacific/Kiritimati', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        const newYear = buildJpeg({ DateTimeOriginal: '2019:12:31 23:30:00' });
        const dst = buildJpeg({ DateTimeOriginal: '2019:03:31 02:30:00' }); // heure inexistante à Paris
        await expect(parseExifDate(newYear)).resolves.toEqual({ takenAt: '2019-12-31T23:30:00', tag: 'DateTimeOriginal' });
        await expect(parseExifDate(dst)).resolves.toEqual({ takenAt: '2019-03-31T02:30:00', tag: 'DateTimeOriginal' });
      }
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('lit seulement les 128 premiers Ko quand l\'EXIF y est', async () => {
    const big = Buffer.concat([WITH_EXIF, Buffer.alloc(5 * KO * KO)]);
    const { reader, calls } = fakeReader({ 'IMG_0005.JPG': big });
    const result = await readExifDate(reader, obj('IMG_0005.JPG', big.length));
    expect(result.date?.takenAt).toBe('2016-02-20T14:03:11');
    expect(calls).toEqual([{ key: 'IMG_0005.JPG', start: 0, end: 131071 }]);
  });

  it("fait un second essai jusqu'à 1 Mo si l'EXIF est au-delà de 128 Ko, sans relire le début", async () => {
    const big = Buffer.concat([FAR_EXIF, Buffer.alloc(3 * KO * KO)]);
    const { reader, calls } = fakeReader({ 'IMG_0044.JPG': big });
    const result = await readExifDate(reader, obj('IMG_0044.JPG', big.length));
    expect(result.date).toEqual({ takenAt: '2015-07-14T22:00:00', tag: 'DateTimeOriginal' });
    expect(calls).toEqual([
      { key: 'IMG_0044.JPG', start: 0, end: 131071 },
      { key: 'IMG_0044.JPG', start: 131072, end: 1048575 },
    ]);
  });

  it("ne s'arrête pas sur un champ de rang inférieur : DateTimeOriginal au-delà de 128 Ko l'emporte sur ModifyDate", async () => {
    const tiff = buildTiff({ ModifyDate: '2024:01:29 10:00:00', DateTimeOriginal: '2016:02:20 14:03:11' }, 500 * KO);
    const file = Buffer.concat([tiff, Buffer.alloc(600 * KO - tiff.length)]);
    await expect(parseExifDate(file.subarray(0, 128 * KO))).resolves.toMatchObject({ tag: 'ModifyDate' }); // piège
    const { reader, calls } = fakeReader({ 'scan.tif': file });
    const result = await readExifDate(reader, obj('scan.tif', file.length));
    expect(result).toEqual({ date: { takenAt: '2016-02-20T14:03:11', tag: 'DateTimeOriginal' }, bytesRead: 600 * KO });
    expect(calls).toHaveLength(2);
  });

  it('garde le meilleur champ trouvé si la plage suivante n\'apporte rien de mieux', async () => {
    const file = Buffer.concat([CREATE_ONLY, Buffer.alloc(2 * KO * KO)]);
    const { reader, calls } = fakeReader({ 'a.jpg': file });
    const result = await readExifDate(reader, obj('a.jpg', file.length));
    expect(result.date).toEqual({ takenAt: '2018-05-01T09:15:00', tag: 'CreateDate' });
    expect(calls).toHaveLength(2);
  });

  it("borne les plages à la taille de l'objet et ne relit pas un petit objet déjà lu en entier", async () => {
    const { reader, calls } = fakeReader({ 'a.jpg': NO_EXIF });
    const result = await readExifDate(reader, obj('a.jpg', NO_EXIF.length));
    expect(result).toEqual({ date: null, bytesRead: NO_EXIF.length });
    expect(calls).toEqual([{ key: 'a.jpg', start: 0, end: NO_EXIF.length - 1 }]);
  });

  it("passe par le client S3 en n'émettant que des GetObject partiels", async () => {
    const client = {
      send: jest.fn(async (command: GetObjectCommand) => {
        const [, start, end] = command.input.Range!.match(/bytes=(\d+)-(\d+)/)!.map(Number) as [number, number, number];
        return { Body: { transformToByteArray: async () => new Uint8Array(FAR_EXIF.subarray(start, end + 1)) } };
      }),
    };
    const reader = new S3ObjectRangeReader(client as never, 'marceau');
    const result = await readExifDate(reader, obj('IMG_0044.JPG', FAR_EXIF.length));
    expect(result.date?.takenAt).toBe('2015-07-14T22:00:00');
    for (const [command] of client.send.mock.calls) {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input.Range).toMatch(/^bytes=\d+-\d+$/);
    }
  });
});

describe('cascade de datation sur l\'inventaire', () => {
  let dir: string;
  const bucket = 'marceau';

  const INVENTORY = [
    obj('backup_google_photos/photos/2025/2025-08/IMG_20190817_181059.jpg', 3 * KO * KO),
    obj('2_Personnel/Photos/google_photos/2017/20170326_173149.jpg', 2 * KO * KO),
    obj('backup_google_photos/photos/2024/IMG_0005.JPG', WITH_EXIF.length),
    obj('backup_google_photos/photos/2024/IMG_0044.JPG', FAR_EXIF.length),
    obj('backup_google_photos/photos/2024/sans-exif.jpg', NO_EXIF.length),
    obj('backup_google_photos/photos/2024/IMG_1999.JPG', MODIFY_ONLY.length),
    obj('backup_google_photos/photos/2024/video.mp4', 10 * KO * KO),
    obj('backup_google_photos/photos/2024/vide.jpg', 0),
    obj('1_Professionel/facture.pdf', 50),
  ];
  const CONTENTS = {
    'backup_google_photos/photos/2024/IMG_0005.JPG': WITH_EXIF,
    'backup_google_photos/photos/2024/IMG_0044.JPG': FAR_EXIF,
    'backup_google_photos/photos/2024/sans-exif.jpg': NO_EXIF,
    'backup_google_photos/photos/2024/IMG_1999.JPG': MODIFY_ONLY,
  };

  function options(reader: ObjectRangeReader, prefixes: string[] = []): DatingOptions {
    return { bucket, supportedFormats: FORMATS, prefixes, getReader: () => reader };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-dating-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
    new InventoryModel().replace(bucket, INVENTORY.map((o) => ({ ...o, lastModified: null })));
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  it('applique la cascade, trace la source et ne lit l\'EXIF que des médias sans date dans le nom', async () => {
    const model = new InventoryDateModel();
    const { reader, calls } = fakeReader({ ...CONTENTS });
    const run = await dateInventory(INVENTORY, model, options(reader));

    expect(run).toEqual({ mediaCount: 8, filenameCount: 2, exifReusedCount: 0, exifReadCount: 4, failures: [], aborted: false });
    // Aucune lecture pour les dates de nom, la vidéo, l'objet vide, le PDF
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(Object.keys(CONTENTS)));

    const byKey = Object.fromEntries(model.findAll(bucket).map((d) => [path.basename(d.key), d]));
    expect(byKey['IMG_20190817_181059.jpg']).toMatchObject({ source: 'nom_fichier', takenAt: '2019-08-17T18:10:59', exifRead: false });
    expect(byKey['20170326_173149.jpg']).toMatchObject({ source: 'nom_fichier', takenAt: '2017-03-26T17:31:49' });
    expect(byKey['IMG_0005.JPG']).toMatchObject({ source: 'exif', takenAt: '2016-02-20T14:03:11', detail: 'DateTimeOriginal', exifRead: true });
    expect(byKey['IMG_0044.JPG']).toMatchObject({ source: 'exif', takenAt: '2015-07-14T22:00:00' });
    expect(byKey['IMG_1999.JPG']).toMatchObject({ source: 'exif', takenAt: '2012-12-31T23:59:59', detail: 'ModifyDate' });
    expect(byKey['sans-exif.jpg']).toMatchObject({ source: 'indeterminee', takenAt: null, exifRead: true });
    expect(byKey['video.mp4']).toMatchObject({ source: 'indeterminee', takenAt: null, exifRead: false });
    expect(byKey['video.mp4']?.detail).toContain('format .mp4 sans EXIF lisible');
    expect(byKey['vide.jpg']).toMatchObject({ source: 'indeterminee', takenAt: null });
    expect(byKey['facture.pdf']).toBeUndefined();

    const summary = summarizeDates(selectMedia(INVENTORY, FORMATS, []), model.findAll(bucket), new Date('2026-09-14T12:00:00Z'));
    expect(summary.bySource).toEqual({ nom_fichier: 2, exif: 3, indeterminee: 3 });
    expect(summary.byExifTag).toEqual({ DateTimeOriginal: 2, ModifyDate: 1 });
    expect(summary.indeterminate).toHaveLength(3);
    expect(summary.undatedKeys).toEqual([]);
  });

  it('ne crée pas de lecteur S3 quand aucune lecture EXIF n\'est nécessaire', async () => {
    const getReader = jest.fn();
    const run = await dateInventory(INVENTORY.slice(0, 2), new InventoryDateModel(), {
      bucket,
      supportedFormats: FORMATS,
      prefixes: [],
      getReader,
    });
    expect(run.filenameCount).toBe(2);
    expect(getReader).not.toHaveBeenCalled();
  });

  it('formats ajoutés : EXIF lu pour un DNG (structure TIFF) et un HEIC sans date, vidéos 3gp/mts/m4v/webm sans requête', async () => {
    const raw = buildTiff({ DateTimeOriginal: '2016:02:20 14:03:11' }, 64);
    const objects = [
      obj('p/raw.dng', raw.length),
      obj('p/clip.3gp', KO),
      obj('p/clip.mts', KO),
      obj('p/clip.m4v', KO),
      obj('p/clip.webm', KO),
      obj('p/VID_20190817_181059.mts', KO),
    ];
    const { reader, calls } = fakeReader({ 'p/raw.dng': raw });
    const model = new InventoryDateModel();
    await dateInventory(objects, model, { bucket, supportedFormats: ['dng', '3gp', 'mts', 'm4v', 'webm'], prefixes: [], getReader: () => reader });
    const byKey = Object.fromEntries(model.findAll(bucket).map((d) => [path.basename(d.key), d]));
    expect(byKey['raw.dng']).toMatchObject({ source: 'exif', takenAt: '2016-02-20T14:03:11', detail: 'DateTimeOriginal' });
    for (const video of ['clip.3gp', 'clip.mts', 'clip.m4v', 'clip.webm']) {
      expect(byKey[video]).toMatchObject({ source: 'indeterminee', takenAt: null, exifRead: false });
    }
    expect(byKey['VID_20190817_181059.mts']).toMatchObject({ source: 'nom_fichier', takenAt: '2019-08-17T18:10:59' });
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(['p/raw.dng']));
    expect(EXIF_FORMATS).toEqual(expect.arrayContaining(['heic', 'heif', 'dng']));
  });

  it('restreint aux préfixes demandés', async () => {
    const { reader, calls } = fakeReader({ ...CONTENTS });
    const run = await dateInventory(INVENTORY, new InventoryDateModel(), options(reader, ['2_Personnel/']));
    expect(run.mediaCount).toBe(1);
    expect(calls).toEqual([]);
  });

  it("erreur réseau : rien n'est enregistré pour l'objet, la relance le relit sans relire les autres", async () => {
    const model = new InventoryDateModel();
    const first = fakeReader({ ...CONTENTS }, { 'backup_google_photos/photos/2024/IMG_0044.JPG': 1 });
    const run1 = await dateInventory(INVENTORY, model, options(first.reader));

    expect(run1.failures).toEqual([
      { key: 'backup_google_photos/photos/2024/IMG_0044.JPG', reason: 'TimeoutError: socket hang up' },
    ]);
    expect(run1.exifReadCount).toBe(3);
    const media = selectMedia(INVENTORY, FORMATS, []);
    expect(summarizeDates(media, model.findAll(bucket)).undatedKeys).toEqual(['backup_google_photos/photos/2024/IMG_0044.JPG']);

    const second = fakeReader({ ...CONTENTS });
    const run2 = await dateInventory(INVENTORY, model, options(second.reader));
    expect(run2).toMatchObject({ exifReusedCount: 3, exifReadCount: 1, failures: [] });
    expect(new Set(second.calls.map((c) => c.key))).toEqual(new Set(['backup_google_photos/photos/2024/IMG_0044.JPG']));

    // Troisième passe : idempotente, aucune lecture
    const third = fakeReader({});
    const run3 = await dateInventory(INVENTORY, model, options(third.reader));
    expect(run3).toMatchObject({ exifReusedCount: 4, exifReadCount: 0, failures: [] });
    expect(third.calls).toEqual([]);
    expect(summarizeDates(media, model.findAll(bucket)).bySource).toEqual({ nom_fichier: 2, exif: 3, indeterminee: 3 });
  });

  it("supprime l'ancienne datation d'un objet qui repart en lecture : non daté si la lecture échoue", async () => {
    const model = new InventoryDateModel();
    const key = 'backup_google_photos/photos/2024/IMG_0005.JPG';
    const object = INVENTORY.find((o) => o.key === key)!;
    // Datation « nom de fichier » d'une version antérieure des motifs, que le nom ne justifie plus
    model.save(bucket, [{ key, size: object.size, etag: object.etag, source: 'nom_fichier', takenAt: '2005-01-01T00:00:00', detail: null, exifRead: false }]);

    const failing = fakeReader({ ...CONTENTS }, { [key]: 1 });
    const run = await dateInventory(INVENTORY, model, options(failing.reader));

    expect(run.failures.map((f) => f.key)).toEqual([key]);
    expect(model.findAll(bucket).find((d) => d.key === key)).toBeUndefined();
    expect(summarizeDates(selectMedia(INVENTORY, FORMATS, []), model.findAll(bucket)).undatedKeys).toEqual([key]);
  });

  it('refuse en base une date au format inattendu', () => {
    const bad = { key: 'x.jpg', size: 1, etag: null, source: 'exif' as const, takenAt: '2019-08-17 18:10:59', detail: 'DateTimeOriginal', exifRead: true };
    expect(() => new InventoryDateModel().save(bucket, [bad])).toThrow(/CHECK constraint failed/);
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM inventory_dates').get()).toEqual({ n: 0 });
  });

  it('abandonne les lectures restantes après plusieurs échecs consécutifs', async () => {
    const reader: ObjectRangeReader = {
      bucket,
      readRange: jest.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    };
    const many = Array.from({ length: MAX_CONSECUTIVE_FAILURES + 3 }, (_, i) => obj(`photos/IMG_${i}.JPG`, 1000));
    new InventoryModel().replace(bucket, many.map((o) => ({ ...o, lastModified: null })));
    const model = new InventoryDateModel();
    const run = await dateInventory(many, model, options(reader));

    expect(run.aborted).toBe(true);
    expect(run.failures).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(reader.readRange).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
    expect(model.findAll(bucket)).toEqual([]);
  });

  it("relit l'EXIF d'un objet modifié (ETag différent) et purge les datations d'objets disparus", async () => {
    const model = new InventoryDateModel();
    await dateInventory(INVENTORY, model, options(fakeReader({ ...CONTENTS }).reader));

    const changed = INVENTORY.filter((o) => !o.key.endsWith('sans-exif.jpg')).map((o) =>
      o.key.endsWith('IMG_0005.JPG') ? obj(o.key, CREATE_ONLY.length, 'nouvel-etag') : o,
    );
    new InventoryModel().replace(bucket, changed.map((o) => ({ ...o, lastModified: null })));

    const { reader, calls } = fakeReader({ ...CONTENTS, 'backup_google_photos/photos/2024/IMG_0005.JPG': CREATE_ONLY });
    await dateInventory(changed, model, options(reader));

    expect(calls.map((c) => c.key)).toEqual(['backup_google_photos/photos/2024/IMG_0005.JPG']);
    const keys = model.findAll(bucket).map((d) => d.key);
    expect(keys).not.toContain('backup_google_photos/photos/2024/sans-exif.jpg');
    expect(model.findAll(bucket).find((d) => d.key.endsWith('IMG_0005.JPG'))).toMatchObject({
      source: 'exif',
      takenAt: '2018-05-01T09:15:00',
      detail: 'CreateDate',
      etag: 'nouvel-etag',
    });
  });
});

describe('dates suspectes', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const row = (takenAt: string, source: 'nom_fichier' | 'exif' = 'nom_fichier', detail: string | null = null): ObjectDating => ({
    key: `a/${takenAt}.jpg`,
    size: 1,
    etag: null,
    source,
    takenAt,
    detail,
    exifRead: source === 'exif',
  });

  it('signale les dates antérieures à 2000 ou dans le futur, quel que soit le fuseau', () => {
    const originalTz = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        expect(suspectReason(row('1999-12-31T23:59:59'), now)).toBe('antérieure à 2000');
        expect(suspectReason(row('2000-01-01T00:00:00'), now)).toBeNull();
        expect(suspectReason(row('2026-09-14T23:00:00'), now)).toBeNull(); // déjà le soir à UTC+14
        expect(suspectReason(row('2026-09-16T00:00:00'), now)).toBe('dans le futur');
        expect(suspectReason(row('2099-01-01T00:00:00'), now)).toBe('dans le futur');
      }
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('signale les dates issues d\'EXIF ModifyDate, pas celles de DateTimeOriginal ou CreateDate', () => {
    expect(suspectReason(row('2012-12-31T23:59:59', 'exif', 'ModifyDate'), now)).toMatch(/ModifyDate/);
    expect(suspectReason(row('2012-12-31T23:59:59', 'exif', 'DateTimeOriginal'), now)).toBeNull();
    expect(suspectReason(row('2012-12-31T23:59:59', 'exif', 'CreateDate'), now)).toBeNull();
  });

  it('les compte et les liste avec leur raison, sans les rejeter', () => {
    const media = [obj('a/1995.jpg', 1), obj('a/2099.jpg', 1), obj('a/2019.jpg', 1), obj('a/modif.jpg', 1)];
    const datings = [
      { ...row('1995-01-01T00:00:00'), key: 'a/1995.jpg', etag: 'etag-a/1995.jpg' },
      { ...row('2099-01-01T00:00:00'), key: 'a/2099.jpg', etag: 'etag-a/2099.jpg' },
      { ...row('2019-01-01T00:00:00'), key: 'a/2019.jpg', etag: 'etag-a/2019.jpg' },
      { ...row('2012-01-01T00:00:00', 'exif', 'ModifyDate'), key: 'a/modif.jpg', etag: 'etag-a/modif.jpg' },
    ];
    const summary = summarizeDates(media, datings, now);
    expect(summary.bySource).toEqual({ nom_fichier: 3, exif: 1, indeterminee: 0 });
    expect(summary.suspects.map((s) => [s.dating.key, s.reason])).toEqual([
      ['a/1995.jpg', 'antérieure à 2000'],
      ['a/2099.jpg', 'dans le futur'],
      ['a/modif.jpg', 'EXIF ModifyDate (date de modification possible)'],
    ]);
  });

  it("ne compte pas une datation d'un objet qui a changé depuis", () => {
    const media = [obj('a/x.jpg', 2, 'etag-2')];
    const stale = [{ ...row('2010-01-01T00:00:00', 'exif', 'DateTimeOriginal'), key: 'a/x.jpg', etag: 'etag-1' }];
    expect(summarizeDates(media, stale, now).undatedKeys).toEqual(['a/x.jpg']);
  });
});
