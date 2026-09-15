import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

// Le logger réel écrit dans un fichier : on le neutralise pour les tests.
jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import {
  backupDatabase,
  closeDatabase,
  getDatabase,
  initDatabase,
} from '../../src/database/connection';
import { AppMetadataModel, SyncRecordModel, SyncSessionModel } from '../../src/database/models';
import { SyncStatus } from '../../src/clients/types';

describe('couche base de données (node:sqlite)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-db-'));
    dbPath = path.join(dir, 'sous-dossier', 'app.db');
    await initDatabase({ path: dbPath });
  });

  afterEach(async () => {
    closeDatabase();
    await fs.remove(dir);
  });

  it('crée le fichier et applique toutes les migrations', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    const row = getDatabase().prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    };
    expect(row.version).toBe(8);
  });

  it('écritures durables : synchronous = FULL (une ligne copie_en_cours validée survit à une coupure de courant)', () => {
    const row = getDatabase().prepare('PRAGMA synchronous').get() as { synchronous: number };
    expect(row.synchronous).toBe(2); // 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA
  });

  it('est idempotente à la réouverture', async () => {
    closeDatabase();
    await initDatabase({ path: dbPath });
    const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(row.n).toBe(8);
  });

  it('crée, relit et met à jour un enregistrement avec champs optionnels absents', async () => {
    const model = new SyncRecordModel();
    const id = await model.create({
      googlePhotoId: 'id-1',
      filename: 'IMG_0001.JPG',
      googleUrl: '',
      cubbitPath: '2024/01/IMG_0001.JPG',
      fileSize: 1234,
      mimeType: 'image/jpeg',
      createdDate: new Date('2024-01-15T10:00:00Z'),
      status: SyncStatus.PENDING,
      metadata: { source: 'test' },
    });
    expect(typeof id).toBe('number');

    await model.update(id, { status: SyncStatus.SYNCED, syncDate: new Date('2024-02-01T00:00:00Z') });

    const record = await model.findByGooglePhotoId('id-1');
    expect(record?.status).toBe(SyncStatus.SYNCED);
    expect(record?.syncDate?.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(record?.metadata).toEqual({ source: 'test' });
    expect(await model.countByStatus(SyncStatus.SYNCED)).toBe(1);
  });

  it('gère sessions et métadonnées', async () => {
    const sessions = new SyncSessionModel();
    const id = await sessions.create({
      startTime: new Date(),
      status: 'running',
      filesProcessed: 0,
      filesSuccess: 0,
      filesError: 0,
      totalSize: 0,
    });
    expect((await sessions.findLast())?.id).toBe(id);

    const endTime = new Date('2026-01-02T03:04:05.000Z');
    await sessions.update(id, { status: 'completed', endTime, filesProcessed: 3 });
    const updated = await sessions.findById(id);
    expect(updated?.status).toBe('completed');
    expect(updated?.endTime?.toISOString()).toBe(endTime.toISOString());
    expect(updated?.filesProcessed).toBe(3);

    const meta = new AppMetadataModel();
    await meta.set('cle', 'valeur');
    expect(await meta.get('cle')).toBe('valeur');
  });

  it('sauvegarde la base dans un fichier', async () => {
    const backupPath = path.join(dir, 'backup', 'app.db');
    await backupDatabase(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
  });
});
