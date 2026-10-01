import * as crypto from 'crypto';
import { S3ArchiveWriter } from '../../src/clients/archive-writer';
import type { ArchiveWriter } from '../../src/clients/types';
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
import { archivedObjectsFrom, buildArchivePlan, locationKey, TakeoutArchivePlan, TakeoutPlanInput } from '../../src/takeout/archive-plan';
import { AnalyzedMedia, matchArchive } from '../../src/takeout/takeout-analysis';
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

function planInput(mediaList: AnalyzedMedia[], occupied: TakeoutPlanInput['occupied'] = []): TakeoutPlanInput {
  return {
    exportId: '20260806T062636Z', destinationBucket: DEST, keptAlbums: [], analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
    media: mediaList, occupied, destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
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

// ---------------------------------------------------------------------------------------------------------------------
// Story 4.4 : reprise après coupure, équivalence avec une passe ininterrompue
// ---------------------------------------------------------------------------------------------------------------------

/** « Le processus meurt » : levée par le faux writer ou le faux journal, après quoi plus rien n'est enregistré ni envoyé. */
class Crash extends Error {}

type CutPoint = 'avant-ligne' | 'apres-journal-avant-depot' | 'apres-depot-avant-journal' | 'pendant-verification' | 'avant-journal-copie';

const THRESHOLDS = { multipartThresholdBytes: 10, partSizeBytes: 4 };

/** Plan de 7 lignes à déposer : 4 nouveaux, 2 homonymes (suffixes Q1), 1 vidéo multipart, 1 objet déjà présent, 1 reclassement. */
function equivalenceScenario() {
  const bodies = new Map<string, Buffer>();
  const mk = (path: string, text: string, overrides: Partial<AnalyzedMedia> = {}): AnalyzedMedia => {
    const body = Buffer.from(text);
    const m = media({ part: '1', path, fileName: path.split('/').pop()!, md5: md5Hex(body), size: body.length, ...overrides });
    bodies.set(locationKey(m), body);
    return m;
  };
  const mediaList = [
    mk('a.jpg', 'aaaa'),
    mk('x/img.jpg', 'imgx'),
    mk('y/img.jpg', 'imgy'),
    mk('big.mp4', '0123456789abcdef'), // 16 octets > seuil injecté (10) : dépôt multipart
    mk('deja.jpg', 'deja'),
    mk('c.jpg', 'cccc'),
    mk('reclass.jpg', 'recl', {
      takenAt: '2021-08-09T10:00:00',
      archive: { status: 'deja_archive', proof: 'md5', key: 'quarantaine/x/reclass.jpg', archivedEtag: md5Hex(Buffer.from('recl')), candidates: ['quarantaine/x/reclass.jpg'], sameNameAndSize: false },
    }),
  ];
  const freshBucket = (): FakeS3 => {
    const s3 = new FakeS3();
    s3.createBucket(DEST);
    s3.put(DEST, 'photos/2020/2020-05/deja.jpg', { size: 4, etag: md5Hex(Buffer.from('deja')) });
    s3.put(DEST, 'quarantaine/x/reclass.jpg', { size: 4, etag: md5Hex(Buffer.from('recl')) });
    return s3;
  };
  const occupiedOf = (s3: FakeS3) =>
    archivedObjectsFrom([...s3.buckets.get(DEST)!.entries()].map(([key, o]) => ({ key, size: o.size, etag: o.etag })));
  // Inventaire antérieur à l'apparition de deja.jpg dans le bucket : le plan l'envoie, l'exécution le trouve déjà présent.
  const plan = buildArchivePlan(planInput(mediaList, occupiedOf(freshBucket()).filter((o) => o.name !== 'deja.jpg')));
  expect(plan.violations).toEqual([]);
  expect(plan.executable).toBe(true);
  expect(linesToSend(plan)).toHaveLength(7);
  expect(plan.lines.find((l) => l.path === 'reclass.jpg')!.action).toBe('reclasser_quarantaine');
  const readMedia = async (line: ArchiveWriteLine): Promise<Buffer> => bodies.get(locationKey(line))!;
  return { mediaList, plan, readMedia, bodies, freshBucket, occupiedOf };
}

const snapshot = (s3: FakeS3): [string, number, string][] =>
  [...s3.buckets.get(DEST)!.entries()].map(([key, o]) => [key, o.size, o.etag] as [string, number, string]).sort(([a], [b]) => a.localeCompare(b));

/** Une passe sur `s3`, avec suivi des dépôts et coupure optionnelle. Les mêmes journal et bucket servent à la relance. */
function makeRun(s3: FakeS3, journal: MemoryJournal, readMedia: (line: ArchiveWriteLine) => Promise<Buffer>) {
  const uploads: string[] = [];
  const overwrites: string[] = [];
  const run = (plan: TakeoutArchivePlan, cut?: { line: ArchiveWriteLine; point: CutPoint }) => {
    const real = new S3ArchiveWriter(s3.asClient(), scope(), undefined, THRESHOLDS.multipartThresholdBytes, THRESHOLDS.partSizeBytes);
    let dead = false;
    const guard = (): void => {
      if (dead) throw new Crash('processus mort : plus rien ne part');
    };
    const die = (): never => {
      dead = true;
      throw new Crash('coupure simulée');
    };
    const target = cut?.line.destination;
    let uploadedTarget = false;
    let headsOfTarget = 0;
    const writer: ArchiveWriter = {
      sourceBucket: real.sourceBucket,
      sourcePrefixes: real.sourcePrefixes,
      destinationBucket: real.destinationBucket,
      checkAccess: () => (guard(), real.checkAccess()),
      copyFromSource: () => Promise.reject(new Error('jamais de copie serveur dans un archivage Takeout')),
      listIncompleteMultipartUploads: () => real.listIncompleteMultipartUploads(),
      headDestination: async (key) => {
        guard();
        if (key === target) {
          headsOfTarget++;
          if (cut!.point === 'avant-ligne' && headsOfTarget === 1) die();
          if (cut!.point === 'pendant-verification' && uploadedTarget) die();
        }
        return real.headDestination(key);
      },
      uploadFile: async (key, body) => {
        guard();
        if (key === target && cut!.point === 'apres-journal-avant-depot') die();
        if (s3.get(DEST, key)) overwrites.push(key);
        uploads.push(key);
        await real.uploadFile(key, body);
        if (key === target) {
          uploadedTarget = true;
          if (cut!.point === 'apres-depot-avant-journal') die();
        }
      },
    };
    const crashJournal: ExecutionJournal = {
      prepare: (...args) => (guard(), journal.prepare(...args)),
      findStates: (planId) => journal.findStates(planId),
      record: (planId, sourceKey, state, message, copyAttempted) => {
        guard();
        if (cut?.point === 'avant-journal-copie' && sourceKey === locationKey(cut.line) && state === 'copie') die();
        journal.record(planId, sourceKey, state, message, copyAttempted);
      },
    };
    return executeArchivePlan(plan, { writer, journal: crashJournal, readMedia, uploadThresholds: THRESHOLDS });
  };
  return { run, uploads, overwrites };
}

describe('executeArchivePlan : reprise après coupure = passe ininterrompue (story 4.4, AC3)', () => {
  const { plan, readMedia, freshBucket } = equivalenceScenario();
  const lines = linesToSend(plan);

  const reference = { s3: freshBucket() };
  beforeAll(async () => {
    const { run } = makeRun(reference.s3, new MemoryJournal(), readMedia);
    expect((await run(plan)).stop).toBeNull();
  });

  const cases: [string, CutPoint, number][] = [];
  lines.forEach((line, k) => {
    const points: CutPoint[] =
      line.path === 'deja.jpg'
        ? ['avant-ligne'] // jamais déposée : seule une coupure avant la ligne a un sens
        : ['avant-ligne', 'apres-journal-avant-depot', 'apres-depot-avant-journal', 'pendant-verification', 'avant-journal-copie'];
    for (const point of points) cases.push([`${line.path} (ligne ${k + 1}/${lines.length})`, point, k]);
  });

  it.each(cases)('coupure sur %s, point « %s » : relance → bucket et journal identiques, aucun écrasement, aucun renvoi', async (_label, point, k) => {
    const s3 = freshBucket();
    const journal = new MemoryJournal();
    const { run, uploads, overwrites } = makeRun(s3, journal, readMedia);
    const cutLine = lines[k]!;

    await expect(run(plan, { line: cutLine, point })).rejects.toBeInstanceOf(Crash);
    const stateAtCut = journal.state(plan.id, locationKey(cutLine));
    // Ce que le journal sait au moment de la coupure : jamais « copie » avant que le dépôt soit vérifié.
    expect(stateAtCut).toBe({
      'avant-ligne': 'a_faire',
      'apres-journal-avant-depot': 'copie_en_cours',
      'apres-depot-avant-journal': 'copie_en_cours',
      'pendant-verification': 'copie_en_cours',
      'avant-journal-copie': 'copie_en_cours',
    }[point]);

    const result = await run(plan); // relance : nouveau writer, même bucket, même journal
    expect(result.stop).toBeNull();
    expect(result.remaining).toBe(0);
    expect(snapshot(s3)).toEqual(snapshot(reference.s3));
    const states = journal.findStates(plan.id);
    expect(lines.every((l) => isArchiveLineDone(l, states))).toBe(true);
    expect(overwrites).toEqual([]);
    // Chaque média à déposer est envoyé exactement une fois sur les deux passes (jamais deux : le dépôt vérifié n'est pas renvoyé).
    const expectedUploads = lines.filter((l) => l.path !== 'deja.jpg').map((l) => l.destination).sort();
    expect([...uploads].sort()).toEqual(expectedUploads);
    if (point === 'apres-depot-avant-journal' || point === 'pendant-verification' || point === 'avant-journal-copie') {
      expect(result.recovered).toBe(1);
    }
  });
});

describe('replanification après coupure (story 4.4, AC4)', () => {
  const { mediaList, plan, readMedia, bodies, freshBucket, occupiedOf } = equivalenceScenario();
  const lines = linesToSend(plan);

  it.each([1, 2, 3, 4, 5, 6])('passe interrompue après %i lignes, inventaire refait, plan régénéré : déposés = déjà archivés, restants aux mêmes destinations, même état final', async (k) => {
    // Référence : passe ininterrompue.
    const refS3 = freshBucket();
    await makeRun(refS3, new MemoryJournal(), readMedia).run(plan);

    // Passe interrompue après k lignes (arrêt demandé entre deux lignes).
    const s3 = freshBucket();
    let asked = 0;
    const shouldStop = (): boolean => ++asked > k;
    const real = new S3ArchiveWriter(s3.asClient(), scope(), undefined, THRESHOLDS.multipartThresholdBytes, THRESHOLDS.partSizeBytes);
    const partial = await executeArchivePlan(plan, { writer: real, journal: new MemoryJournal(), readMedia, shouldStop, uploadThresholds: THRESHOLDS });
    expect(partial.interrupted).toBe(true);

    // Inventaire du bucket refait, plan régénéré (nouvelle empreinte, journal vierge).
    // Comme en vrai : l'analyse est refaite sur le nouvel inventaire (statut « déjà archivé » des médias déposés, y compris
    // par preuve d'ETag multipart pour la vidéo), puis le plan régénéré.
    const inventory = [...s3.buckets.get(DEST)!.entries()].map(([key, o]) => ({ key, size: o.size, lastModified: null, etag: o.etag }));
    const reanalysed = structuredClone(mediaList);
    const multipartConfirmed = new Map<string, string[]>();
    for (const m of reanalysed) {
      const key = lines.find((l) => l.path === m.path)!.destination;
      const body = bodies.get(locationKey(m))!;
      if (body.length > THRESHOLDS.multipartThresholdBytes && s3.get(DEST, key)?.etag === computeMultipartEtag(body, THRESHOLDS.partSizeBytes)) {
        multipartConfirmed.set(`${m.part}\u0000${m.path}`, [key]); // clé interne de l'analyse
      }
    }
    matchArchive(reanalysed, inventory, multipartConfirmed);
    const plan2 = buildArchivePlan(planInput(reanalysed, occupiedOf(s3)));
    expect(plan2.violations).toEqual([]);
    expect(plan2.executable).toBe(true);
    expect(plan2.id).not.toBe(plan.id);
    const byPath = (p: TakeoutArchivePlan, path: string) => p.lines.find((l) => l.path === path)!;
    lines.forEach((line, i) => {
      const again = byPath(plan2, line.path);
      expect(again.destination).toBe(line.destination); // mêmes noms, suffixes Q1 compris
      if (i < k) expect(again.action).toBe('ignorer_deja_archive');
      else if (line.path !== 'deja.jpg') expect(again.action).toBe(line.action);
    });

    const second = makeRun(s3, new MemoryJournal(), readMedia);
    const result = await second.run(plan2);
    expect(result.stop).toBeNull();
    expect(snapshot(s3)).toEqual(snapshot(refS3));
    expect(second.overwrites).toEqual([]);
  });
});
