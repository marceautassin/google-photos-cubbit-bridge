import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { closeDatabase, getDatabase, initDatabase } from '../../src/database/connection';
import { InventoryModel } from '../../src/database/inventory-model';
import { locationOf, scanBucket, summarizeInventory } from '../../src/inventory/inventory';
import { BucketLister, BucketObject, BucketObjectPage } from '../../src/clients/types';

const FORMATS = ['jpg', 'jpeg', 'mp4'];

function obj(key: string, size: number): BucketObject {
  return { key, size, lastModified: new Date('2024-01-29T10:00:00.000Z'), etag: `etag-${key}` };
}

const BUCKET_V1 = [
  obj('backup_google_photos/photos/2019/IMG_20190101_120000.jpg', 1000),
  obj('backup_google_photos/photos/2025/2025-08/IMG_20190202_120000.jpg', 1000),
];
const BUCKET_V2 = [
  ...BUCKET_V1,
  obj('2_Personnel/Photos/google_photos/2017/20170326_173149.jpg', 500),
  obj('2_Personnel/Photos/google_photos/mariage/DSC_0001.JPG', 700),
  obj('1_Professionel/facture.pdf', 50),
  obj('2_Personnel/Photos/', 0),
];

/** Lister mocké : pages successives, avec échec optionnel sur une page donnée. */
function fakeLister(objects: BucketObject[], pageSize: number, failOnPage?: number): BucketLister & { calls: number } {
  const lister = {
    bucket: 'marceau',
    calls: 0,
    async listPage(token?: string): Promise<BucketObjectPage> {
      lister.calls++;
      const page = token ? Number(token) : 0;
      if (page === failOnPage) throw new Error('socket hang up');
      const start = page * pageSize;
      const end = start + pageSize;
      const isTruncated = end < objects.length;
      return { objects: objects.slice(start, end), isTruncated, nextToken: isTruncated ? String(page + 1) : undefined };
    },
  };
  return lister;
}

describe('inventaire du bucket', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-inventory-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  it('persiste tous les objets, y compris hors préfixe photo, et les relit sans réseau', async () => {
    const lister = fakeLister(BUCKET_V2, 2);
    const objects = await scanBucket(lister);
    expect(lister.calls).toBe(3);

    const run = new InventoryModel().replace('marceau', objects, new Date('2026-09-14T20:00:00.000Z'));
    expect(run.objectCount).toBe(6);
    expect(run.totalSize).toBe(3250);

    const model = new InventoryModel();
    const stored = model.findAll('marceau');
    expect(stored).toHaveLength(6);
    expect(stored).toEqual(expect.arrayContaining(BUCKET_V2));
    expect(model.findRun('marceau')).toEqual(run);
    expect(model.findRun('autre-bucket')).toBeNull();
    expect(lister.calls).toBe(3); // la relecture n'a pas appelé le lister
  });

  it("une interruption en cours de pagination laisse l'inventaire précédent intact, et la relance aboutit", async () => {
    const model = new InventoryModel();
    const previous = model.replace('marceau', await scanBucket(fakeLister(BUCKET_V1, 2)));

    await expect(scanBucket(fakeLister(BUCKET_V2, 2, 1))).rejects.toThrow('socket hang up');
    expect(model.findAll('marceau')).toHaveLength(2);
    expect(model.findRun('marceau')).toEqual(previous);

    model.replace('marceau', await scanBucket(fakeLister(BUCKET_V2, 2)));
    expect(model.findAll('marceau')).toHaveLength(6);
    expect(model.findRun('marceau')?.objectCount).toBe(6);
  });

  it("annule le remplacement si l'écriture échoue en cours de transaction", () => {
    const model = new InventoryModel();
    const previous = model.replace('marceau', BUCKET_V1);
    const doublon = [...BUCKET_V2, BUCKET_V2[0] as BucketObject]; // viole la clé primaire en fin d'insertion

    expect(() => model.replace('marceau', doublon)).toThrow();
    expect(model.findAll('marceau')).toHaveLength(2);
    expect(model.findRun('marceau')).toEqual(previous);
  });

  it("relance l'erreur d'origine même si le ROLLBACK échoue", () => {
    const db = getDatabase();
    const exec = db.exec.bind(db);
    const spy = jest.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback impossible');
      exec(sql);
    });
    const doublon = [BUCKET_V1[0] as BucketObject, BUCKET_V1[0] as BucketObject];
    try {
      expect(() => new InventoryModel().replace('marceau', doublon)).toThrow(/UNIQUE constraint failed/);
    } finally {
      spy.mockRestore();
      if (db.isTransaction) db.exec('ROLLBACK');
    }
  });

  it('isole les inventaires de buckets différents', () => {
    const model = new InventoryModel();
    model.replace('marceau', BUCKET_V2);
    model.replace('photos', BUCKET_V1);
    expect(model.findAll('marceau')).toHaveLength(6);
    expect(model.findAll('photos')).toHaveLength(2);
  });
});

describe('restitution des emplacements de médias', () => {
  it('regroupe les médias par emplacement, hors backup_google_photos/ compris', () => {
    const summary = summarizeInventory(BUCKET_V2, FORMATS, 3);

    expect(summary.objectCount).toBe(6);
    expect(summary.totalSize).toBe(3250);
    expect(summary.mediaCount).toBe(4);
    expect(summary.mediaSize).toBe(3200);
    expect(summary.locations).toEqual([
      { location: 'backup_google_photos/photos/2019/', mediaCount: 1, mediaSize: 1000 },
      { location: 'backup_google_photos/photos/2025/', mediaCount: 1, mediaSize: 1000 },
      { location: '2_Personnel/Photos/google_photos/', mediaCount: 2, mediaSize: 1200 },
    ].sort((a, b) => b.mediaSize - a.mediaSize));
    expect(summary.unrecognizedExtensions).toEqual([{ extension: '.pdf', count: 1 }]);
  });

  it('respecte la profondeur demandée et la racine', () => {
    expect(summarizeInventory(BUCKET_V2, FORMATS, 1).locations).toEqual([
      { location: 'backup_google_photos/', mediaCount: 2, mediaSize: 2000 },
      { location: '2_Personnel/', mediaCount: 2, mediaSize: 1200 },
    ]);
    expect(locationOf('racine.jpg', 3)).toBe('(racine)');
    expect(locationOf('a/b.jpg', 3)).toBe('a/');
    expect(locationOf('2_Personnel/Photos/google_photos/mariage/x.jpg', 4)).toBe(
      '2_Personnel/Photos/google_photos/mariage/',
    );
  });
});
