import * as crypto from 'crypto';
import { S3ArchiveWriter } from '../../src/clients/archive-writer';
import type { ExecutionJournal, ExecutionState, JournalEntry } from '../../src/inventory/plan-execution';
import {
  archiveConfirmationMatches,
  ARCHIVE_CONFIRMATION_LENGTH,
  archiveExecutionCommandLine,
  ArchiveExecutionRefusedError,
  ArchiveWriteLine,
  executeArchivePlan,
  isArchiveLineDone,
  isSameContent,
  isVerifiedUpload,
  linesToSend,
  preflightArchiveExecution,
} from '../../src/takeout/archive-execution';
import { buildArchivePlan, locationKey, TakeoutArchivePlan, TakeoutPlanInput } from '../../src/takeout/archive-plan';
import { AnalyzedMedia } from '../../src/takeout/takeout-analysis';
import { computeMultipartEtag } from '../../src/utils/multipart-etag';
import { FakeS3 } from '../fixtures/fake-s3';

const SOURCE = 'marceau';
const DEST = 'marceau-photos';
const md5Hex = (data: Buffer): string => crypto.createHash('md5').update(data).digest('hex');

/** Journal en mémoire, même contrat que `RepairExecutionModel` (repris du test de la réparation). */
class MemoryJournal implements ExecutionJournal {
  readonly rows = new Map<string, Map<string, JournalEntry>>();
  prepare(planId: string, lines: { sourceKey: string; destination: string }[]): void {
    const plan = this.rows.get(planId) ?? new Map<string, JournalEntry>();
    for (const l of lines) {
      if (!plan.has(l.sourceKey)) plan.set(l.sourceKey, { destination: l.destination, state: 'a_faire', copyAttempted: false, message: null });
    }
    this.rows.set(planId, plan);
  }
  findStates(planId: string): Map<string, JournalEntry> {
    return new Map(this.rows.get(planId) ?? []);
  }
  record(planId: string, sourceKey: string, state: ExecutionState, message: string | null, copyAttempted?: boolean): void {
    const entry = this.rows.get(planId)?.get(sourceKey);
    if (!entry) throw new Error('ligne absente');
    this.rows.get(planId)!.set(sourceKey, { ...entry, state, message, copyAttempted: copyAttempted ?? entry.copyAttempted });
  }
  state(planId: string, key: string): ExecutionState | undefined {
    return this.rows.get(planId)?.get(key)?.state;
  }
}

function media(overrides: Partial<AnalyzedMedia> & Pick<AnalyzedMedia, 'part' | 'path' | 'fileName' | 'md5' | 'size'>): AnalyzedMedia {
  return {
    folder: 'Photos de 2020', folderKind: 'annee', takenAt: '2020-05-14T10:00:00', dateSource: 'exif',
    dateDetail: null, instant: null, dateWarning: null, metadata: null, companion: null, duplicateOf: null,
    archive: { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize: false },
    ...overrides,
  };
}

function planInput(mediaList: AnalyzedMedia[]): TakeoutPlanInput {
  return {
    exportId: '20260806T062636Z', destinationBucket: DEST, keptAlbums: [], analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
    media: mediaList, occupied: [], destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
  };
}

function scope() {
  return { sourceBucket: SOURCE, sourcePrefixes: ['backup_google_photos/photos/'], destinationBucket: DEST };
}

describe('linesToSend', () => {
  it('ne retient que envoyer, reclasser_quarantaine et quarantaine', () => {
    const bodyA = Buffer.from('a');
    const plan = buildArchivePlan(planInput([
      media({ part: '1', path: 'a.jpg', fileName: 'a.jpg', md5: md5Hex(bodyA), size: bodyA.length }),
      media({ part: '1', path: 'b.jpg', fileName: 'b.jpg', md5: md5Hex(bodyA), size: bodyA.length, duplicateOf: { part: '1', path: 'a.jpg' } }),
    ]));
    expect(linesToSend(plan).map((l) => l.action)).toEqual(['envoyer']);
  });
});

describe('archiveConfirmationMatches / archiveExecutionCommandLine', () => {
  it('exige au moins 12 caractères de préfixe de l\'empreinte', () => {
    const id = 'a'.repeat(64);
    expect(archiveConfirmationMatches(id, id.slice(0, ARCHIVE_CONFIRMATION_LENGTH))).toBe(true);
    expect(archiveConfirmationMatches(id, id.slice(0, ARCHIVE_CONFIRMATION_LENGTH - 1))).toBe(false);
    expect(archiveConfirmationMatches(id, undefined)).toBe(false);
    expect(archiveExecutionCommandLine('export-1', id)).toBe(`gpb takeout archiver --export export-1 --confirmer ${id.slice(0, ARCHIVE_CONFIRMATION_LENGTH)}`);
  });
});

describe('preflightArchiveExecution', () => {
  it('refuse une destination hors des espaces autorisés, ou un bucket dédié différent, avant tout appel réseau', () => {
    const body = Buffer.from('x');
    const plan = buildArchivePlan(planInput([media({ part: '1', path: 'a.jpg', fileName: 'a.jpg', md5: md5Hex(body), size: body.length })]));
    const tampered: TakeoutArchivePlan = { ...plan, lines: [{ ...plan.lines[0]!, destination: 'backups/a.jpg' }] };
    expect(preflightArchiveExecution(tampered, scope())).toEqual(expect.arrayContaining([expect.stringContaining('backups/')]));
    expect(preflightArchiveExecution({ ...plan, destinationBucket: 'autre-bucket' }, scope())).toEqual(
      expect.arrayContaining([expect.stringContaining('différent de')]),
    );
  });
});

describe('isSameContent / isVerifiedUpload', () => {
  it('exige taille et MD5 identiques (ETag simple) ; ETag multipart ou absent : jamais présumé identique', () => {
    expect(isSameContent({ size: 10, md5: 'a'.repeat(32) }, { size: 10, etag: 'a'.repeat(32) })).toBe(true);
    expect(isSameContent({ size: 10, md5: 'a'.repeat(32) }, { size: 10, etag: `${'a'.repeat(32)}-2` })).toBe(false);
    expect(isSameContent({ size: 10, md5: 'a'.repeat(32) }, { size: 10, etag: null })).toBe(false);
    expect(isSameContent({ size: 10, md5: 'a'.repeat(32) }, { size: 11, etag: 'a'.repeat(32) })).toBe(false);
  });

  describe('vérification après envoi', () => {
    const thresholds = { multipartThresholdBytes: 10, partSizeBytes: 4 };
    const readBody = (body: Buffer) => (): Promise<Buffer> => Promise.resolve(body);

    it('en-deçà du seuil : MD5 simple comparé, le média n\'est jamais relu', async () => {
      const body = Buffer.from('petitfic'); // 8 octets ≤ seuil (10)
      const md5 = crypto.createHash('md5').update(body).digest('hex');
      const readBodyFn = jest.fn(readBody(body));
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length, etag: md5 }, readBodyFn, thresholds)).resolves.toBe(true);
      expect(readBodyFn).not.toHaveBeenCalled();
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length, etag: 'f'.repeat(32) }, readBody(body), thresholds)).resolves.toBe(false);
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length - 1, etag: md5 }, readBody(body), thresholds)).resolves.toBe(false);
    });

    it('au-delà du seuil : ETag multipart attendu recalculé sur le contenu déposé (parties de partSizeBytes), comparé à l\'ETag renvoyé (BLOQUANT, revue : ne plus se limiter à la taille)', async () => {
      const body = Buffer.from('0123456789abcdef'); // 16 octets > seuil (10), 4 parties de 4 octets
      const md5 = crypto.createHash('md5').update(body).digest('hex');
      const expectedMultipartEtag = computeMultipartEtag(body, thresholds.partSizeBytes);
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length, etag: expectedMultipartEtag }, readBody(body), thresholds)).resolves.toBe(true);
    });

    it('au-delà du seuil : ETag multipart divergent (dépôt corrompu ou tronqué) → arrêt, jamais présumé correct', async () => {
      const body = Buffer.from('0123456789abcdef');
      const md5 = crypto.createHash('md5').update(body).digest('hex');
      const wrongEtag = `${'f'.repeat(32)}-4`;
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length, etag: wrongEtag }, readBody(body), thresholds)).resolves.toBe(false);
    });

    it('au-delà du seuil : ETag absent ou non multipart → jamais présumé correct', async () => {
      const body = Buffer.from('0123456789abcdef');
      const md5 = crypto.createHash('md5').update(body).digest('hex');
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length, etag: null }, readBody(body), thresholds)).resolves.toBe(false);
      await expect(isVerifiedUpload({ size: body.length, md5 }, { size: body.length, etag: md5 }, readBody(body), thresholds)).resolves.toBe(false);
    });
  });
});

describe('executeArchivePlan : scénario complet', () => {
  function scenario() {
    const s3 = new FakeS3();
    s3.createBucket(DEST);
    const bodyA = Buffer.from('contenu nouveau');
    const bodyB = Buffer.from('deja present identique');
    s3.put(DEST, 'photos/2020/2020-05/deja.jpg', { size: bodyB.length, etag: md5Hex(bodyB) });
    const lineA = media({ part: '1', path: 'a.jpg', fileName: 'a.jpg', md5: md5Hex(bodyA), size: bodyA.length });
    const lineB = media({ part: '1', path: 'deja.jpg', fileName: 'deja.jpg', md5: md5Hex(bodyB), size: bodyB.length });
    const plan = buildArchivePlan(planInput([lineA, lineB]));
    expect(plan.executable).toBe(true);
    const bodies = new Map([[locationKey(lineA), bodyA], [locationKey(lineB), bodyB]]);
    const readMedia = jest.fn(async (line: ArchiveWriteLine) => bodies.get(locationKey(line))!);
    const writer = new S3ArchiveWriter(s3.asClient(), scope());
    return { s3, plan, journal: new MemoryJournal(), writer, readMedia, bodyA, bodyB, lineA, lineB };
  }

  it('envoie un média nouveau, saute un objet déjà présent identique, et vérifie après envoi', async () => {
    const { plan, journal, writer, readMedia, bodyA } = scenario();
    const result = await executeArchivePlan(plan, { writer, journal, readMedia });
    expect(result.stop).toBeNull();
    expect(result.sent).toEqual({ count: 1, size: bodyA.length });
    expect(result.alreadyPresent).toBe(1);
    expect(result.remaining).toBe(0);
    expect(journal.state(plan.id, locationKey({ part: '1', path: 'a.jpg' }))).toBe('copie');
    expect(journal.state(plan.id, locationKey({ part: '1', path: 'deja.jpg' }))).toBe('deja_present');
  });

  it('objet présent différent → arrêt de sûreté, rien n\'est envoyé après', async () => {
    const { s3, plan, journal, writer, readMedia, lineA } = scenario();
    s3.put(DEST, 'photos/2020/2020-05/a.jpg', { size: 999, etag: 'f'.repeat(32) }); // occupe déjà la destination, contenu différent
    const result = await executeArchivePlan(plan, { writer, journal, readMedia });
    expect(result.stop).toMatchObject({ location: { part: '1', path: 'a.jpg' } });
    expect(result.stop!.reason).toMatch('destination déjà occupée');
    expect(journal.state(plan.id, locationKey(lineA))).toBe('echec');
    expect(s3.commandNames().includes('PutObjectCommand')).toBe(false);
  });

  it('vérification après envoi en échec → arrêt, ligne non marquée faite', async () => {
    const { s3, plan, journal, writer, readMedia, lineA } = scenario();
    s3.afterUpload = (bucket, key) => {
      if (key === 'photos/2020/2020-05/a.jpg') s3.put(bucket, key, { size: 3, etag: 'corrompu-etag-sans-rapport' });
    };
    const result = await executeArchivePlan(plan, { writer, journal, readMedia });
    expect(result.stop).toMatchObject({ location: { part: '1', path: 'a.jpg' } });
    expect(result.stop!.reason).toMatch('vérification en échec');
    expect(journal.state(plan.id, locationKey(lineA))).toBe('echec');
  });

  it('contenu lu différent du MD5 attendu (zip modifié depuis l\'analyse) → arrêt avant tout envoi', async () => {
    const { plan, journal, writer } = scenario();
    const readMedia = jest.fn(async () => Buffer.from('contenu inattendu, ne correspond à aucune ligne'));
    const result = await executeArchivePlan(plan, { writer, journal, readMedia });
    expect(result.stop).not.toBeNull();
    expect(result.stop!.reason).toMatch('différent de celui de l\'analyse');
  });

  it('relance idempotente : une deuxième exécution sur un plan déjà entièrement traité ne renvoie rien', async () => {
    const { s3, plan, journal, writer, readMedia } = scenario();
    await executeArchivePlan(plan, { writer, journal, readMedia });
    const commandsAfterFirst = s3.commands.length;
    const result = await executeArchivePlan(plan, { writer, journal, readMedia });
    expect(result.skipped).toBe(2);
    expect(result.remaining).toBe(0);
    expect(s3.commands.length).toBe(commandsAfterFirst); // aucun nouvel appel réseau
  });

  it('reprise : une ligne « copie_en_cours » lors d\'une relance est acceptée si l\'objet est un dépôt vérifié, jamais renvoyée', async () => {
    const { plan, journal, writer, readMedia, bodyA, lineA } = scenario();
    // Simule une coupure juste après l'envoi (avant vérification) : l'objet existe bien, conforme.
    journal.prepare(plan.id, [{ sourceKey: locationKey(lineA), destination: 'photos/2020/2020-05/a.jpg' }, { sourceKey: locationKey({ part: '1', path: 'deja.jpg' }), destination: 'photos/2020/2020-05/deja.jpg' }]);
    journal.record(plan.id, locationKey(lineA), 'copie_en_cours', null, true);
    const s3 = new FakeS3();
    s3.createBucket(DEST);
    s3.put(DEST, 'photos/2020/2020-05/a.jpg', { size: bodyA.length, etag: md5Hex(bodyA) });
    const bodyDeja = await readMedia({ part: '1', path: 'deja.jpg' } as ArchiveWriteLine);
    s3.put(DEST, 'photos/2020/2020-05/deja.jpg', { size: bodyDeja.length, etag: md5Hex(bodyDeja) });
    const writerRetry = new S3ArchiveWriter(s3.asClient(), scope());
    const result = await executeArchivePlan(plan, { writer: writerRetry, journal, readMedia: jest.fn() });
    expect(result.recovered).toBe(1);
    expect(s3.commandNames().filter((n) => n === 'PutObjectCommand')).toHaveLength(0);
    expect(journal.state(plan.id, locationKey(lineA))).toBe('copie');
  });
});

describe('executeArchivePlan : dépôt multipart (story 4.3, correction bloquante en revue)', () => {
  const uploadThresholds = { multipartThresholdBytes: 10, partSizeBytes: 4 };

  function multipartScenario() {
    const s3 = new FakeS3();
    s3.createBucket(DEST);
    const body = Buffer.from('0123456789abcdef'); // 16 octets > seuil (10) : dépôt multipart, 4 parties de 4 octets
    const line = media({ part: '1', path: 'a.mp4', fileName: 'a.mp4', md5: md5Hex(body), size: body.length });
    const plan = buildArchivePlan(planInput([line]));
    expect(plan.executable).toBe(true);
    const readMedia = jest.fn(async () => body);
    const writer = new S3ArchiveWriter(s3.asClient(), scope(), undefined, uploadThresholds.multipartThresholdBytes, uploadThresholds.partSizeBytes);
    return { s3, plan, journal: new MemoryJournal(), writer, readMedia, body, line };
  }

  it('dépôt multipart vérifié : ETag multipart recalculé (parties de partSizeBytes) et comparé à celui du HEAD, envoi accepté', async () => {
    const { s3, plan, journal, writer, readMedia, line } = multipartScenario();
    const result = await executeArchivePlan(plan, { writer, journal, readMedia, uploadThresholds });
    expect(result.stop).toBeNull();
    expect(result.sent).toEqual({ count: 1, size: 16 });
    expect(s3.commandNames()).toEqual(expect.arrayContaining(['CreateMultipartUploadCommand', 'CompleteMultipartUploadCommand']));
    expect(journal.state(plan.id, locationKey(line))).toBe('copie');
  });

  it('ETag multipart divergent après envoi (dépôt corrompu ou tronqué côté serveur) → arrêt, ligne non marquée faite (BLOQUANT, revue)', async () => {
    const { s3, plan, journal, writer, readMedia, line } = multipartScenario();
    s3.afterUpload = (bucket, key) => {
      if (key === 'photos/2020/2020-05/a.mp4') s3.put(bucket, key, { size: 16, etag: `${'f'.repeat(32)}-4` });
    };
    const result = await executeArchivePlan(plan, { writer, journal, readMedia, uploadThresholds });
    expect(result.stop).toMatchObject({ location: { part: '1', path: 'a.mp4' } });
    expect(result.stop!.reason).toMatch('vérification en échec');
    expect(journal.state(plan.id, locationKey(line))).toBe('echec');
  });
});

describe('isArchiveLineDone', () => {
  it('vrai seulement pour un état « fait » vers la même destination', () => {
    const line: ArchiveWriteLine = { part: '1', path: 'a.jpg', folder: 'x', fileName: 'a.jpg', size: 1, md5: 'a'.repeat(32), dateSource: 'exif', action: 'envoyer', destination: 'photos/2020/2020-05/a.jpg', keptOf: null, archivedEtag: null, reason: 'r' };
    const states = new Map<string, JournalEntry>([[locationKey(line), { destination: line.destination, state: 'copie', copyAttempted: true, message: null }]]);
    expect(isArchiveLineDone(line, states)).toBe(true);
    expect(isArchiveLineDone({ ...line, destination: 'photos/2020/2020-05/autre.jpg' }, states)).toBe(false);
    expect(isArchiveLineDone(line, new Map())).toBe(false);
  });
});

describe('ArchiveExecutionRefusedError : préflight en échec avant toute écriture', () => {
  it('lève avant tout appel réseau si le bucket dédié du plan diffère du point d\'accès', async () => {
    const body = Buffer.from('x');
    const plan = buildArchivePlan(planInput([media({ part: '1', path: 'a.jpg', fileName: 'a.jpg', md5: md5Hex(body), size: body.length })]));
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), { ...scope(), destinationBucket: 'marceau-photos' });
    await expect(
      executeArchivePlan({ ...plan, destinationBucket: 'autre-bucket' }, { writer, journal: new MemoryJournal(), readMedia: jest.fn() }),
    ).rejects.toThrow(ArchiveExecutionRefusedError);
    expect(s3.send).not.toHaveBeenCalled();
  });
});
