import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
  logError: jest.fn(),
}));

const cubbit = {
  testConnection: jest.fn().mockResolvedValue(true),
  ensureBucketExists: jest.fn().mockResolvedValue(undefined),
  fileExists: jest.fn().mockResolvedValue(false),
  uploadFile: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../src/clients/cubbit', () => ({ CubbitClient: jest.fn(() => cubbit) }));

import { closeDatabase, initDatabase } from '../../src/database/connection';
import { SyncRecordModel } from '../../src/database/models';
import { SyncStatus } from '../../src/clients/types';
import { SyncManager } from '../../src/sync/sync-manager';
import { AppConfig } from '../../src/config/types';

describe('SyncManager', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-sync-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  it("en simulation, ne change aucun statut et n'envoie rien", async () => {
    const records = new SyncRecordModel();
    const id = await records.create({
      googlePhotoId: 'id-1',
      filename: 'IMG_20190301_120000.jpg',
      googleUrl: path.join(dir, 'IMG_20190301_120000.jpg'),
      cubbitPath: 'backup_google_photos/photos/2019/2019-03/IMG_20190301_120000.jpg',
      fileSize: 10,
      mimeType: 'image/jpeg',
      createdDate: new Date('2019-03-01T12:00:00Z'),
      status: SyncStatus.PENDING,
      metadata: { source: 'takeout' },
    });

    const config = { cubbit: {}, sync: { maxConcurrentDownloads: 2, supportedFormats: ['jpg'] } } as unknown as AppConfig;
    await new SyncManager(config).sync({ dryRun: true });

    const record = await records.findById(id);
    expect(record?.status).toBe(SyncStatus.PENDING);
    expect(record?.syncDate).toBeUndefined();
    expect(cubbit.uploadFile).not.toHaveBeenCalled();
    expect(cubbit.fileExists).not.toHaveBeenCalled();
  });
});
