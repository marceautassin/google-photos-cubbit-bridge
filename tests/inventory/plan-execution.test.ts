import { CopyObjectCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3ArchiveWriter, WriteRefusedError } from '../../src/clients/archive-writer';
import {
  confirmationMatches,
  executePlan,
  ExecutionJournal,
  ExecutionRefusedError,
  ExecutionState,
  JournalEntry,
  isSameAsSource,
  isVerifiedCopy,
  MAX_COPY_BYTES,
  summarizeExecution,
} from '../../src/inventory/plan-execution';
import { PlanAction, PlanLine, RepairPlan } from '../../src/inventory/repair-plan';
import { FakeS3 } from '../fixtures/fake-s3';

const SOURCE = 'marceau';
const DEST = 'marceau-photos';
const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);

function line(sourceKey: string, action: PlanAction, destination: string | null, etag: string | null, size = 100): PlanLine {
  return { sourceKey, sourceBucket: SOURCE, size, etag, action, destination, keptKey: null, reason: 'essai' };
}

function planOf(lines: PlanLine[], id = 'a'.repeat(64)): RepairPlan {
  return {
    id,
    config: {
      sourceBucket: SOURCE,
      destinationBucket: DEST,
      sourcePrefixes: ['backup_google_photos/photos/'],
      supportedFormats: ['jpg'],
      keptAlbums: ['mariage'],
      ignoredFileNames: [],
      ignoredExtensions: [],
    },
    index: { sourceInventory: { completedAt: '2026-09-15T08:00:00.000Z', objectCount: lines.length }, destinationInventory: { completedAt: '2026-09-15T08:05:00.000Z', objectCount: 1 }, datings: { count: 0, lastDatedAt: null } },
    lines,
    exclusions: [],
    unrecognized: [],
    namingAnomalies: [],
    violations: [],
    executable: true,
  };
}

/** Arrêt brutal simulé (`kill -9`, extinction) : plus rien n'est journalisé ni envoyé ensuite. */
class Killed extends Error {
  constructor() {
    super('processus tué');
    this.name = 'Killed';
  }
}

/** Journal en mémoire, même contrat que `RepairExecutionModel` (testé à part sur base temporaire). */
class MemoryJournal implements ExecutionJournal {
  readonly rows = new Map<string, Map<string, JournalEntry>>();
  /** Processus tué : toute écriture échoue. */
  killed = false;
  /** Tue le processus juste avant (`persisted` faux) ou juste après (`persisted` vrai) l'écriture choisie. */
  killOn: ((sourceKey: string, state: ExecutionState, persisted: boolean) => boolean) | null = null;
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
    const kill = (persisted: boolean): void => {
      if (this.killOn?.(sourceKey, state, persisted)) {
        this.killed = true;
        throw new Killed();
      }
    };
    if (this.killed) throw new Killed();
    kill(false);
    const entry = this.rows.get(planId)?.get(sourceKey);
    if (!entry) throw new Error('ligne absente');
    this.rows.get(planId)!.set(sourceKey, { ...entry, state, message, copyAttempted: copyAttempted ?? entry.copyAttempted });
    kill(true);
  }
  entry(planId: string, key: string): JournalEntry | undefined {
    return this.rows.get(planId)?.get(key);
  }
  state(planId: string, key: string): ExecutionState | undefined {
    return this.rows.get(planId)?.get(key)?.state;
  }
}

const K = {
  a: 'backup_google_photos/photos/2016/IMG_0005.JPG',
  b: 'backup_google_photos/photos/mariage/DSC 01 & co #2+?.jpg',
  c: 'backup_google_photos/photos/divers/scan.jpg',
  d: 'backup_google_photos/photos/2019/IMG_0005.JPG',
  e: 'backup_google_photos/photos/2020/video.mp4',
};

/** Plan type : une copie MD5, une copie d'album multipart, une quarantaine, un doublon ignoré, un déjà archivé. */
function scenario(): { s3: FakeS3; plan: RepairPlan; journal: MemoryJournal; writer: S3ArchiveWriter } {
  const s3 = new FakeS3();
  s3.put(SOURCE, K.a, { size: 100, etag: md5('a') });
  s3.put(SOURCE, K.b, { size: 200, etag: `${md5('b')}-3` });
  s3.put(SOURCE, K.c, { size: 50, etag: md5('c') });
  s3.put(SOURCE, K.d, { size: 100, etag: md5('a') });
  s3.put(SOURCE, K.e, { size: 70, etag: md5('e') });
  s3.put(DEST, 'photos/2020/2020-01/video.mp4', { size: 70, etag: md5('e') });
  const plan = planOf([
    line(K.a, 'copier', 'photos/2016/2016-02/IMG_0005.JPG', md5('a'), 100),
    line(K.b, 'copier', 'albums/mariage/DSC 01 & co #2+?.jpg', `${md5('b')}-3`, 200),
    line(K.c, 'quarantaine', `quarantaine/${K.c}`, md5('c'), 50),
    { ...line(K.d, 'ignorer_doublon', null, md5('a'), 100), keptKey: K.a },
    line(K.e, 'ignorer_deja_archive', 'photos/2020/2020-01/video.mp4', md5('e'), 70),
  ]);
  return { s3, plan, journal: new MemoryJournal(), writer: new S3ArchiveWriter(s3.asClient(), { sourceBucket: SOURCE, sourcePrefixes: ['backup_google_photos/photos/'], destinationBucket: DEST }) };
}

const onlyHeadAndCopy = (s3: FakeS3): void => {
  expect(s3.commands.every((c) => c instanceof HeadBucketCommand || c instanceof HeadObjectCommand || c instanceof CopyObjectCommand)).toBe(true);
  for (const c of s3.commands) expect((c as HeadBucketCommand | HeadObjectCommand | CopyObjectCommand).input.Bucket).toBe(DEST);
};
const copies = (s3: FakeS3): CopyObjectCommand[] => s3.commands.filter((c): c is CopyObjectCommand => c instanceof CopyObjectCommand);

describe('executePlan : exécution nominale', () => {
  it('copie côté serveur chaque ligne copier/quarantaine, vérifie, journalise ; aucune autre écriture', async () => {
    const { s3, plan, journal, writer } = scenario();
    const progress: number[] = [];
    const result = await executePlan(plan, { writer, journal, onProgress: (p) => progress.push(p.remaining) });

    expect(result).toEqual({ copied: { count: 3, size: 350 }, recovered: 0, alreadyPresent: 0, skipped: 0, remaining: 0, stop: null, interrupted: false });
    expect(progress).toEqual([2, 1, 0]);
    expect(s3.keys(DEST)).toEqual([
      `quarantaine/${K.c}`,
      'albums/mariage/DSC 01 & co #2+?.jpg',
      'photos/2016/2016-02/IMG_0005.JPG',
      'photos/2020/2020-01/video.mp4',
    ].sort());
    // Source intacte : rien d'ajouté ni de retiré.
    expect(s3.keys(SOURCE)).toEqual(Object.values(K).sort());
    // Séquence : contrôle d'accès (bucket, sonde), puis HEAD, copie, HEAD par ligne. Doublon et déjà archivé : aucune requête.
    expect(s3.commandNames()).toEqual([
      'HeadBucketCommand',
      'HeadObjectCommand',
      ...Array(3).fill(['HeadObjectCommand', 'CopyObjectCommand', 'HeadObjectCommand']).flat(),
    ]);
    onlyHeadAndCopy(s3);
    expect(copies(s3).map((c) => c.input.CopySource)).toEqual([
      `${SOURCE}/backup_google_photos/photos/2016/IMG_0005.JPG`,
      `${SOURCE}/backup_google_photos/photos/mariage/DSC%2001%20%26%20co%20%232%2B%3F.jpg`,
      `${SOURCE}/backup_google_photos/photos/divers/scan.jpg`,
    ]);
    expect(copies(s3).map((c) => c.input.CopySourceIfMatch)).toEqual([`"${md5('a')}"`, `"${md5('b')}-3"`, `"${md5('c')}"`]);
    expect([K.a, K.b, K.c].map((k) => journal.state(plan.id, k))).toEqual(['copie', 'copie', 'copie']);
    expect(journal.state(plan.id, K.d)).toBeUndefined();
    expect(journal.state(plan.id, K.e)).toBeUndefined();
  });

  it('source multipart : vérification par la taille seule, quel que soit l\'ETag renvoyé après copie', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.copyEtag = (source) => (source.etag.includes('-') ? 'etag-inconnu-renvoye-par-cubbit' : source.etag);
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toBeNull();
    expect(journal.state(plan.id, K.b)).toBe('copie');
  });

  it('source MD5 : un ETag différent après copie arrête l\'exécution (vérification en échec), rien n\'est supprimé', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.copyEtag = (source) => (source.etag === md5('a') ? md5('z') : source.etag);
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toMatchObject({ sourceKey: K.a, reason: expect.stringContaining('vérification en échec') });
    expect(journal.state(plan.id, K.a)).toBe('echec');
    expect(journal.state(plan.id, K.b)).toBe('a_faire');
    expect(copies(s3)).toHaveLength(1);
    onlyHeadAndCopy(s3);
  });

  it('vérification en échec : taille différente ou copie introuvable → arrêt, jamais « copie »', async () => {
    const altered = scenario();
    altered.s3.afterCopy = (bucket, key) => altered.s3.put(bucket, key, { size: 1, etag: md5('a') });
    expect((await executePlan(altered.plan, altered).then((r) => r.stop))?.reason).toMatch('vérification en échec');
    expect(altered.journal.state(altered.plan.id, K.a)).toBe('echec');

    const vanished = scenario();
    vanished.s3.afterCopy = (bucket, key) => vanished.s3.buckets.get(bucket)!.delete(key);
    expect((await executePlan(vanished.plan, vanished).then((r) => r.stop))?.reason).toMatch('copie introuvable');
    expect(vanished.journal.state(vanished.plan.id, K.a)).toBe('echec');
  });
});

describe('executePlan : destination déjà occupée', () => {
  it('objet identique déjà présent : sauté sans copie (déjà présent)', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.put(DEST, 'photos/2016/2016-02/IMG_0005.JPG', { size: 100, etag: md5('a') });
    const result = await executePlan(plan, { writer, journal });
    expect(result.alreadyPresent).toBe(1);
    expect(result.copied.count).toBe(2);
    expect(journal.state(plan.id, K.a)).toBe('deja_present');
    expect(copies(s3).map((c) => c.input.Key)).not.toContain('photos/2016/2016-02/IMG_0005.JPG');
  });

  it.each([
    ['taille différente', { size: 999, etag: md5('a') }],
    ['même taille, ETag différent (source MD5)', { size: 100, etag: md5('x') }],
  ])('objet différent (%s) : arrêt immédiat, rien d\'écrasé, lignes suivantes intactes', async (_label, existing) => {
    const { s3, plan, journal, writer } = scenario();
    s3.put(DEST, 'photos/2016/2016-02/IMG_0005.JPG', existing);
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toMatchObject({ sourceKey: K.a, reason: expect.stringContaining('jamais écrasé') });
    expect(copies(s3)).toHaveLength(0);
    expect(s3.get(DEST, 'photos/2016/2016-02/IMG_0005.JPG')).toEqual(existing);
    expect(journal.state(plan.id, K.a)).toBe('echec');
    expect([K.b, K.c].map((k) => journal.state(plan.id, k))).toEqual(['a_faire', 'a_faire']);
    expect(result.remaining).toBe(3);
  });

  it('source multipart, objet présent de même taille mais d\'ETag différent : arrêt « objet existant à examiner », rien écrit', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.put(DEST, 'albums/mariage/DSC 01 & co #2+?.jpg', { size: 200, etag: 'autre-etag-2' });
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toMatchObject({ sourceKey: K.b, reason: expect.stringContaining('objet existant à examiner') });
    expect(s3.get(DEST, 'albums/mariage/DSC 01 & co #2+?.jpg')).toEqual({ size: 200, etag: 'autre-etag-2' });
    expect(copies(s3).map((c) => c.input.Key)).toEqual(['photos/2016/2016-02/IMG_0005.JPG']);
    expect(journal.state(plan.id, K.b)).toBe('echec');
  });

  it('source multipart, objet présent de même taille et même ETag : déjà présent', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.put(DEST, 'albums/mariage/DSC 01 & co #2+?.jpg', { size: 200, etag: `${md5('b')}-3` });
    await executePlan(plan, { writer, journal });
    expect(journal.state(plan.id, K.b)).toBe('deja_present');
  });
});

describe('executePlan : échecs de copie', () => {
  it('source modifiée depuis l\'inventaire (CopySourceIfMatch en échec, 412) : arrêt, rien écrit', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.put(SOURCE, K.a, { size: 100, etag: md5('m') });
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop?.reason).toMatch('source modifiée depuis l\'inventaire');
    expect(s3.keys(DEST)).toEqual(['photos/2020/2020-01/video.mp4']);
    expect(copies(s3)).toHaveLength(1);
  });

  it.each([
    ['erreur serveur 500', Object.assign(new Error('We encountered an internal error'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } })],
    ['coupure réseau', Object.assign(new Error('socket hang up'), { name: 'TimeoutError', code: 'ECONNRESET' })],
  ])('HEAD de destination en échec (%s) : ligne en échec, arrêt, aucune copie', async (_label, error) => {
    const { s3, plan, journal, writer } = scenario();
    s3.headError = (_bucket, key) => (key === 'photos/2016/2016-02/IMG_0005.JPG' ? error : null);
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toMatchObject({ sourceKey: K.a, reason: expect.stringContaining('lecture de la destination impossible') });
    expect(result.stop?.reason).toContain(`${error.name}: ${error.message}`);
    expect(journal.state(plan.id, K.a)).toBe('echec');
    expect(copies(s3)).toHaveLength(0);
  });

  it('bucket dédié inexistant (HEAD bucket 404) : refus avant toute copie', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.buckets.delete(DEST);
    await expect(executePlan(plan, { writer, journal })).rejects.toThrow('accès au bucket dédié « marceau-photos » impossible : NotFound');
    expect(s3.commandNames()).toEqual(['HeadBucketCommand']);
  });

  it('contrôle d\'accès refusé : refus avant toute copie', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.headError = () => Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(executePlan(plan, { writer, journal })).rejects.toThrow('accès au bucket dédié « marceau-photos » impossible : AccessDenied: Access Denied');
    expect(copies(s3)).toHaveLength(0);
  });
});

describe('executePlan : pré-vol (avant toute requête)', () => {
  it.each([
    ['destination sous backups/', line(K.a, 'copier', 'backups/IMG_0005.JPG', md5('a')), 'backups/'],
    ['destination hors des espaces', line(K.a, 'quarantaine', 'autre/IMG_0005.JPG', md5('a')), 'hors des espaces'],
    ['ETag source absent', line(K.a, 'copier', 'photos/2016/2016-02/IMG_0005.JPG', null), 'ETag source absent'],
    ['objet de plus de 5 Gio', line(K.a, 'copier', 'photos/2016/2016-02/IMG_0005.JPG', md5('a'), MAX_COPY_BYTES + 1), '5 Gio'],
    ['sans destination', line(K.a, 'copier', null, md5('a')), 'aucune destination'],
    ['clé source hors des préfixes', line('2_Personnel/Mariage/IMG_0005.JPG', 'copier', 'photos/2016/2016-02/IMG_0005.JPG', md5('a')), 'hors des préfixes source'],
    ['clé source avec « .. »', line('backup_google_photos/photos/../../marceau-photos/backups/x.zip', 'copier', 'photos/2016/2016-02/x.zip', md5('a')), 'invalide'],
  ])('%s → refus, aucune requête, aucun journal', async (_label, bad, message) => {
    const { s3, plan, journal, writer } = scenario();
    const broken = { ...plan, lines: [...plan.lines.slice(1), bad] };
    await expect(executePlan(broken, { writer, journal })).rejects.toThrow(message);
    expect(s3.send).not.toHaveBeenCalled();
    expect(journal.rows.size).toBe(0);
  });

  it('plan généré sans inventaire du bucket dédié → refus', async () => {
    const { s3, plan, journal, writer } = scenario();
    const blind = { ...plan, index: { ...plan.index, destinationInventory: null } };
    await expect(executePlan(blind, { writer, journal })).rejects.toThrow('sans inventaire du bucket dédié');
    expect(s3.send).not.toHaveBeenCalled();
    expect(journal.rows.size).toBe(0);
  });

  it('plan visant un autre bucket dédié ou dont la destination est le bucket source → refus', async () => {
    const { s3, plan, journal, writer } = scenario();
    await expect(executePlan({ ...plan, config: { ...plan.config, destinationBucket: 'marceau-autre' } }, { writer, journal })).rejects.toThrow(
      ExecutionRefusedError,
    );
    await expect(executePlan({ ...plan, config: { ...plan.config, destinationBucket: SOURCE } }, { writer, journal })).rejects.toThrow(
      'bucket source',
    );
    await expect(executePlan({ ...plan, config: { ...plan.config, sourceBucket: 'autre' } }, { writer, journal })).rejects.toThrow(
      'bucket source du plan',
    );
    expect(s3.send).not.toHaveBeenCalled();
  });
});

describe('executePlan : relance, journal et interruption', () => {
  it('relance après exécution complète : aucune copie, aucune requête (journal du même plan)', async () => {
    const { s3, plan, journal, writer } = scenario();
    await executePlan(plan, { writer, journal });
    s3.commands.length = 0;
    const again = await executePlan(plan, { writer, journal });
    expect(again).toMatchObject({ copied: { count: 0, size: 0 }, alreadyPresent: 0, skipped: 3, remaining: 0, stop: null });
    expect(s3.commands).toHaveLength(0);
  });

  it('relance sans journal (journal perdu ou d\'un autre plan) : HEAD → déjà présent, aucune copie', async () => {
    const { s3, plan, journal, writer } = scenario();
    await executePlan(plan, { writer, journal });
    s3.commands.length = 0;
    const other = planOf(plan.lines, 'b'.repeat(64));
    const result = await executePlan(other, { writer, journal });
    expect(result).toMatchObject({ copied: { count: 0 }, alreadyPresent: 3, skipped: 0, stop: null });
    expect(copies(s3)).toHaveLength(0);
    // Le journal de l'autre plan n'a pas été réutilisé ni modifié.
    expect([K.a, K.b, K.c].map((k) => journal.state(plan.id, k))).toEqual(['copie', 'copie', 'copie']);
    expect([K.a, K.b, K.c].map((k) => journal.state(other.id, k))).toEqual(['deja_present', 'deja_present', 'deja_present']);
  });

  it('une ligne en échec est retraitée à la relance ; les lignes faites sont sautées', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.put(SOURCE, K.b, { size: 200, etag: 'modifie-3' });
    expect((await executePlan(plan, { writer, journal })).stop?.sourceKey).toBe(K.b);
    s3.put(SOURCE, K.b, { size: 200, etag: `${md5('b')}-3` });
    s3.commands.length = 0;
    const result = await executePlan(plan, { writer, journal });
    expect(result).toMatchObject({ skipped: 1, copied: { count: 2 }, stop: null });
    expect(copies(s3).map((c) => c.input.Key)).toEqual(['albums/mariage/DSC 01 & co #2+?.jpg', `quarantaine/${K.c}`]);
  });

  it('arrêt demandé (Ctrl-C) : la ligne en cours se termine, les suivantes restent à faire', async () => {
    const { s3, plan, journal, writer } = scenario();
    let calls = 0;
    const result = await executePlan(plan, { writer, journal, shouldStop: () => calls++ >= 1 });
    expect(result).toMatchObject({ interrupted: true, copied: { count: 1 }, remaining: 2, stop: null });
    expect([K.a, K.b, K.c].map((k) => journal.state(plan.id, k))).toEqual(['copie', 'a_faire', 'a_faire']);
    expect(copies(s3)).toHaveLength(1);
  });

  it('copie écrite mais réponse perdue (coupure) : jamais « copie » sans vérification, la relance la vérifie par HEAD sans recopier', async () => {
    const { s3, plan, journal, writer } = scenario();
    s3.afterCopy = () => {
      throw new Error('processus tué');
    };
    await expect(executePlan(plan, { writer, journal })).resolves.toMatchObject({ stop: { sourceKey: K.a } });
    // Le faux S3 a écrit la copie puis « perdu » la réponse : la ligne n'est pas « copie » (échec, retraité à la relance).
    expect(journal.state(plan.id, K.a)).toBe('echec');
    s3.afterCopy = null;
    s3.commands.length = 0;
    const result = await executePlan(plan, { writer, journal });
    // Story 3.2 : copie tentée → reprise vérifiée (« copie »), et non plus « déjà présent ».
    expect(result).toMatchObject({ recovered: 1, alreadyPresent: 0, copied: { count: 2 }, stop: null });
    expect(journal.state(plan.id, K.a)).toBe('copie');
    expect(copies(s3).map((c) => c.input.Key)).not.toContain('photos/2016/2016-02/IMG_0005.JPG');
  });

  it('journal incohérent (même plan, autre destination) : refus', async () => {
    const { plan, journal, writer } = scenario();
    journal.prepare(plan.id, [{ sourceKey: K.a, destination: 'photos/ailleurs.jpg' }]);
    await expect(executePlan(plan, { writer, journal })).rejects.toThrow('journal incohérent');
  });
});

describe('fonctions pures', () => {
  it('confirmationMatches : empreinte complète ou au moins 12 caractères', () => {
    const id = '6b67339c5387'.padEnd(64, 'f');
    expect(confirmationMatches(id, '6b67339c5387')).toBe(true);
    expect(confirmationMatches(id, id)).toBe(true);
    expect(confirmationMatches(id, '6B67339C5387')).toBe(true);
    expect(confirmationMatches(id, '6b67339c538')).toBe(false);
    expect(confirmationMatches(id, '6b67339c5388')).toBe(false);
    expect(confirmationMatches(id, undefined)).toBe(false);
    expect(confirmationMatches(id, '')).toBe(false);
  });

  it('isSameAsSource (avant copie) : taille et ETag, y compris multipart', () => {
    expect(isSameAsSource({ size: 1, etag: md5('a') }, { size: 1, etag: `"${md5('a').toUpperCase()}"` })).toBe(true);
    expect(isSameAsSource({ size: 1, etag: md5('a') }, { size: 1, etag: null })).toBe(false);
    expect(isSameAsSource({ size: 1, etag: 'abc-2' }, { size: 1, etag: 'abc-2' })).toBe(true);
    expect(isSameAsSource({ size: 1, etag: 'abc-2' }, { size: 1, etag: 'abd-2' })).toBe(false);
    expect(isSameAsSource({ size: 1, etag: null }, { size: 1, etag: null })).toBe(false);
  });

  it('isVerifiedCopy (après copie conditionnelle) : MD5 → taille et ETag ; multipart → taille', () => {
    expect(isVerifiedCopy({ size: 1, etag: md5('a') }, { size: 1, etag: md5('a') })).toBe(true);
    expect(isVerifiedCopy({ size: 1, etag: md5('a') }, { size: 1, etag: null })).toBe(false);
    expect(isVerifiedCopy({ size: 1, etag: 'abc-2' }, { size: 1, etag: null })).toBe(true);
    expect(isVerifiedCopy({ size: 1, etag: 'abc-2' }, { size: 2, etag: 'abc-2' })).toBe(false);
  });

  it('summarizeExecution : volumes par action, faites d\'après le journal, restantes', () => {
    const { plan, journal } = scenario();
    journal.prepare(plan.id, [{ sourceKey: K.a, destination: 'photos/2016/2016-02/IMG_0005.JPG' }]);
    journal.record(plan.id, K.a, 'copie', null);
    expect(summarizeExecution(plan, journal.findStates(plan.id))).toEqual({
      copier: { count: 2, size: 300 },
      quarantaine: { count: 1, size: 50 },
      done: { count: 1, size: 100 },
      remaining: { count: 2, size: 250 },
      inProgress: { count: 0, size: 0 },
      failed: { count: 0, size: 0 },
      notStarted: { count: 2, size: 250 },
      failures: [],
    });
  });
});

// --- Story 3.2 : reprise d'une exécution interrompue ------------------------------------------------------------------

/** Cubbit renvoie un ETag MD5 simple après copie d'un multipart : cas qui bloquait la reprise en 3.1. */
const cubbitEtag = (source: { etag: string }): string => (source.etag.includes('-') ? md5('9') : source.etag);
const destinationContent = (s3: FakeS3): Record<string, unknown> => Object.fromEntries(s3.buckets.get(DEST) ?? []);
const statesOf = (journal: MemoryJournal, planId: string): Record<string, ExecutionState> =>
  Object.fromEntries([...journal.findStates(planId)].map(([k, e]) => [k, e.state]));
const copiesByKey = (s3: FakeS3): Record<string, number> =>
  copies(s3).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.input.Key!]: (acc[c.input.Key!] ?? 0) + 1 }), {});
const s3ErrorOf = (name: string, status: number | undefined, code?: string, attempts = 1): Error =>
  Object.assign(new Error(`${name} simulée`), { name, code, $metadata: status ? { httpStatusCode: status, attempts } : {} });

/** Exécution ininterrompue de référence. */
async function uninterrupted(): Promise<{ content: Record<string, unknown>; states: Record<string, ExecutionState> }> {
  const ref = scenario();
  ref.s3.copyEtag = cubbitEtag;
  const result = await executePlan(ref.plan, ref);
  expect(result.stop).toBeNull();
  return { content: destinationContent(ref.s3), states: statesOf(ref.journal, ref.plan.id) };
}

describe('reprise après arrêt brutal, à chaque étape d\'une ligne', () => {
  const DEST_OF: Record<string, string> = { [K.a]: 'photos/2016/2016-02/IMG_0005.JPG', [K.b]: 'albums/mariage/DSC 01 & co #2+?.jpg' };
  type Step = 'avant copie' | 'après journal copie_en_cours, avant envoi' | 'après copie, avant vérification' | 'après vérification, avant journal copie';
  const STEPS: [Step, boolean][] = [
    ['avant copie', false],
    ['après journal copie_en_cours, avant envoi', false],
    ['après copie, avant vérification', true],
    ['après vérification, avant journal copie', true],
  ];

  it.each(
    [K.a, K.b].flatMap((target) => STEPS.map(([step, copiedBeforeKill]) => [target === K.a ? 'MD5' : 'multipart', step, target, copiedBeforeKill] as const)),
  )('source %s, arrêt %s : la relance termine à l\'identique, sans recopie ni écrasement', async (_kind, step, target, copiedBeforeKill) => {
    const reference = await uninterrupted();
    const { s3, plan, journal, writer } = scenario();
    s3.copyEtag = cubbitEtag;
    if (step === 'avant copie') journal.killOn = (key, state, persisted) => key === target && state === 'copie_en_cours' && !persisted;
    if (step === 'après journal copie_en_cours, avant envoi') journal.killOn = (key, state, persisted) => key === target && state === 'copie_en_cours' && persisted;
    if (step === 'après copie, avant vérification') {
      s3.afterCopy = (_bucket, key) => {
        if (key === DEST_OF[target]!) {
          journal.killed = true;
          throw new Killed();
        }
      };
    }
    if (step === 'après vérification, avant journal copie') journal.killOn = (key, state, persisted) => key === target && state === 'copie' && !persisted;

    await expect(executePlan(plan, { writer, journal })).rejects.toThrow('processus tué');
    const expectedState = step === 'avant copie' ? 'a_faire' : 'copie_en_cours';
    expect(journal.entry(plan.id, target)).toMatchObject({ state: expectedState, copyAttempted: expectedState === 'copie_en_cours' });
    expect(s3.get(DEST, DEST_OF[target]!) !== undefined).toBe(copiedBeforeKill);

    // Relance (nouveau processus).
    journal.killed = false;
    journal.killOn = null;
    s3.afterCopy = null;
    const result = await executePlan(plan, { writer, journal });
    expect(result).toMatchObject({ stop: null, interrupted: false, remaining: 0, recovered: copiedBeforeKill ? 1 : 0 });
    expect(destinationContent(s3)).toEqual(reference.content);
    expect(statesOf(journal, plan.id)).toEqual(reference.states);
    // Chaque destination copiée exactement une fois, toutes exécutions confondues ; jamais d'écrasement.
    expect(copiesByKey(s3)).toEqual({ [DEST_OF[K.a]!]: 1, [DEST_OF[K.b]!]: 1, [`quarantaine/${K.c}`]: 1 });
    expect(s3.overwrites).toEqual([]);
    onlyHeadAndCopy(s3);

    // Troisième lancement : rien à faire.
    s3.commands.length = 0;
    expect(await executePlan(plan, { writer, journal })).toMatchObject({ skipped: 3, remaining: 0 });
    expect(s3.commands).toHaveLength(0);
  });
});

describe('reprise : règles par état journalisé', () => {
  const B_DEST = 'albums/mariage/DSC 01 & co #2+?.jpg';
  const A_DEST = 'photos/2016/2016-02/IMG_0005.JPG';

  function withJournal(state: ExecutionState, copyAttempted: boolean, key = K.b): ReturnType<typeof scenario> {
    const context = scenario();
    context.journal.prepare(context.plan.id, [{ sourceKey: K.a, destination: A_DEST }, { sourceKey: K.b, destination: B_DEST }, { sourceKey: K.c, destination: `quarantaine/${K.c}` }]);
    context.journal.record(context.plan.id, key, state, state === 'echec' ? 'essai' : null, copyAttempted);
    return context;
  }

  it('multipart copié non journalisé (copie_en_cours), ETag changé par Cubbit : accepté sans recopie', async () => {
    const { s3, plan, journal, writer } = withJournal('copie_en_cours', true);
    s3.put(DEST, B_DEST, { size: 200, etag: md5('9') });
    const result = await executePlan(plan, { writer, journal });
    expect(result).toMatchObject({ stop: null, recovered: 1, copied: { count: 2 } });
    expect(journal.entry(plan.id, K.b)).toMatchObject({ state: 'copie', message: expect.stringContaining('vérifiée à la reprise') });
    expect(copies(s3).map((c) => c.input.Key)).not.toContain(B_DEST);
    expect(s3.overwrites).toEqual([]);
  });

  it('même objet pour une ligne jamais tentée (a_faire) : toujours bloqué « objet existant à examiner » (règle 3.1)', async () => {
    const { s3, plan, journal, writer } = withJournal('a_faire', false);
    s3.put(DEST, B_DEST, { size: 200, etag: md5('9') });
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toMatchObject({ sourceKey: K.b, reason: expect.stringContaining('objet existant à examiner') });
    expect(copies(s3).map((c) => c.input.Key)).not.toContain(B_DEST);
  });

  it.each([
    ['copie_en_cours', 'multipart, taille différente', K.b, B_DEST, { size: 199, etag: md5('9') }],
    ['copie_en_cours', 'MD5, même taille mais ETag différent', K.a, A_DEST, { size: 100, etag: md5('x') }],
    ['echec après envoi', 'multipart, taille différente', K.b, B_DEST, { size: 1, etag: `${md5('b')}-3` }],
  ] as const)('%s, objet présent non conforme (%s) : arrêt « à examiner », rien écrit, bloquant à chaque relance', async (label, _what, key, dest, object) => {
    const { s3, plan, journal, writer } = withJournal(label === 'copie_en_cours' ? 'copie_en_cours' : 'echec', true, key);
    s3.put(DEST, dest, object);
    for (let run = 0; run < 2; run++) {
      const result = await executePlan(plan, { writer, journal });
      expect(result.stop).toMatchObject({ sourceKey: key, destination: dest, reason: expect.stringContaining('copie antérieure non conforme, à examiner') });
      expect(journal.entry(plan.id, key)).toMatchObject({ state: 'echec', copyAttempted: true });
    }
    expect(copies(s3).map((c) => c.input.Key)).not.toContain(dest);
    expect(s3.get(DEST, dest)).toEqual(object);
  });

  it('copie_en_cours, destination absente (copie jamais arrivée) : copie normale', async () => {
    const { s3, plan, journal, writer } = withJournal('copie_en_cours', true);
    const result = await executePlan(plan, { writer, journal });
    expect(result).toMatchObject({ stop: null, recovered: 0, copied: { count: 3 } });
    expect(copiesByKey(s3)[B_DEST]).toBe(1);
  });

  it('echec avant envoi (copie non tentée) : règles strictes, un multipart présent d\'ETag différent reste bloqué', async () => {
    const { s3, plan, journal, writer } = withJournal('echec', false);
    s3.put(DEST, B_DEST, { size: 200, etag: md5('9') });
    expect((await executePlan(plan, { writer, journal })).stop?.reason).toMatch('objet existant à examiner');
  });
});

describe('reprise : erreurs transitoires et arrêts de sûreté', () => {
  const A_DEST = 'photos/2016/2016-02/IMG_0005.JPG';
  const ERRORS = [
    ['coupure réseau', () => s3ErrorOf('TimeoutError', undefined, 'ECONNRESET')],
    ['erreur 500', () => s3ErrorOf('InternalError', 500)],
    ['erreur 503', () => s3ErrorOf('ServiceUnavailable', 503)],
    ['SlowDown', () => s3ErrorOf('SlowDown', 503)],
  ] as const;
  type Phase = 'HEAD avant copie' | 'copie refusée avant écriture' | 'réponse de copie perdue' | 'HEAD de vérification';
  const PHASES: [Phase, boolean, boolean][] = [
    // phase, copie tentée d'après le journal, copie arrivée en destination
    ['HEAD avant copie', false, false],
    ['copie refusée avant écriture', true, false],
    ['réponse de copie perdue', true, true],
    ['HEAD de vérification', true, true],
  ];

  it.each(ERRORS.flatMap(([label, make]) => PHASES.map(([phase, attempted, arrived]) => [label, phase, make, attempted, arrived] as const)))(
    '%s pendant « %s » : ligne en échec, arrêt ; la relance la retente et termine à l\'identique',
    async (_label, phase, make, attempted, arrived) => {
      const reference = await uninterrupted();
      const { s3, plan, journal, writer } = scenario();
      s3.copyEtag = cubbitEtag;
      let heads = 0;
      if (phase === 'HEAD avant copie') s3.headError = (_b, key) => (key === A_DEST ? make() : null);
      if (phase === 'HEAD de vérification') s3.headError = (_b, key) => (key === A_DEST && ++heads === 2 ? make() : null);
      if (phase === 'copie refusée avant écriture') s3.copyError = (key) => (key === A_DEST ? make() : null);
      if (phase === 'réponse de copie perdue') {
        s3.afterCopy = (_b, key) => {
          if (key === A_DEST) throw make();
        };
      }

      const first = await executePlan(plan, { writer, journal });
      expect(first.stop).toMatchObject({ sourceKey: K.a, destination: A_DEST });
      expect(first.stop?.reason).toMatch(/simulée/);
      expect(journal.entry(plan.id, K.a)).toMatchObject({ state: 'echec', copyAttempted: attempted });
      expect([K.b, K.c].map((k) => journal.state(plan.id, k))).toEqual(['a_faire', 'a_faire']);
      expect(s3.get(DEST, A_DEST) !== undefined).toBe(arrived);

      s3.headError = null;
      s3.copyError = null;
      s3.afterCopy = null;
      const second = await executePlan(plan, { writer, journal });
      expect(second).toMatchObject({ stop: null, remaining: 0, recovered: arrived ? 1 : 0 });
      expect(destinationContent(s3)).toEqual(reference.content);
      expect(statesOf(journal, plan.id)).toEqual(reference.states);
      expect(copiesByKey(s3)[A_DEST]).toBe(phase === 'HEAD avant copie' ? 1 : phase === 'copie refusée avant écriture' ? 2 : 1);
      expect(s3.overwrites).toEqual([]);
    },
  );

  it('source modifiée (412) : bloquant à chaque relance tant que la cause subsiste, rien écrit ; la tentative n\'est plus réputée', async () => {
    const { s3, plan, journal, writer } = scenario();
    journal.prepare(plan.id, [{ sourceKey: K.a, destination: A_DEST }]);
    journal.record(plan.id, K.a, 'copie_en_cours', null, true); // tentative précédente jamais arrivée
    s3.put(SOURCE, K.a, { size: 100, etag: md5('m') });
    for (let run = 0; run < 2; run++) {
      const result = await executePlan(plan, { writer, journal });
      expect(result.stop).toMatchObject({ sourceKey: K.a, destination: A_DEST, reason: expect.stringContaining('source modifiée depuis l\'inventaire') });
      expect(journal.entry(plan.id, K.a)).toMatchObject({ state: 'echec', copyAttempted: false });
      expect(s3.keys(DEST)).toEqual(['photos/2020/2020-01/video.mp4']);
    }
    // Un objet multipart étranger déposé ensuite n'est pas pris pour une copie de l'outil.
    s3.put(SOURCE, K.a, { size: 100, etag: md5('a') });
    s3.put(DEST, A_DEST, { size: 100, etag: 'etranger-2' });
    expect((await executePlan(plan, { writer, journal })).stop?.reason).toMatch('destination déjà occupée');
  });

  it.each([
    ['refus du garde', false, () => new WriteRefusedError('essai')],
    ['403 AccessDenied', false, () => s3ErrorOf('AccessDenied', 403)],
    ['404 NoSuchKey', false, () => s3ErrorOf('NoSuchKey', 404)],
    ['404 NoSuchBucket', false, () => s3ErrorOf('NoSuchBucket', 404)],
    ['412 après 2 tentatives du SDK', true, () => s3ErrorOf('PreconditionFailed', 412, undefined, 2)],
    ['500', true, () => s3ErrorOf('InternalError', 500)],
  ] as const)('copie en cours précédente puis %s : copie réputée tentée = %s', async (_label, attempted, make) => {
    const { s3, plan, journal, writer } = scenario();
    journal.prepare(plan.id, [{ sourceKey: K.a, destination: A_DEST }]);
    journal.record(plan.id, K.a, 'copie_en_cours', null, true);
    const error = make();
    if (error instanceof WriteRefusedError) jest.spyOn(writer, 'copyFromSource').mockRejectedValueOnce(error);
    else s3.copyError = (key) => (key === A_DEST ? error : null);
    const result = await executePlan(plan, { writer, journal });
    expect(result.stop).toMatchObject({ sourceKey: K.a });
    expect(journal.entry(plan.id, K.a)).toMatchObject({ state: 'echec', copyAttempted: attempted });
    expect(result.stop!.reason.includes('rien n\'a été écrit')).toBe(!attempted);
    expect(s3.keys(DEST)).toEqual(['photos/2020/2020-01/video.mp4']);
  });

  it('verrou perdu (keepAlive faux) : arrêt avant la ligne, aucune requête pour elle, journal intact', async () => {
    const { s3, plan, journal, writer } = scenario();
    let calls = 0;
    const result = await executePlan(plan, { writer, journal, keepAlive: () => ++calls < 2 });
    expect(calls).toBe(2);
    expect(result.stop).toMatchObject({ sourceKey: K.b, reason: expect.stringContaining('verrou d\'exécution perdu') });
    expect([K.a, K.b, K.c].map((k) => journal.state(plan.id, k))).toEqual(['copie', 'a_faire', 'a_faire']);
    expect(copies(s3).map((c) => c.input.Key)).toEqual([A_DEST]);
  });

  it('keepAlive appelé une fois par ligne traitée', async () => {
    const { plan, journal, writer } = scenario();
    const keepAlive = jest.fn(() => true);
    await executePlan(plan, { writer, journal, keepAlive });
    expect(keepAlive).toHaveBeenCalledTimes(3);
  });

  it('summarizeExecution : déjà faits, en cours à vérifier, en échec à retenter (avec message), jamais traités', () => {
    const { plan, journal } = scenario();
    journal.prepare(plan.id, [{ sourceKey: K.a, destination: A_DEST }, { sourceKey: K.b, destination: 'albums/mariage/DSC 01 & co #2+?.jpg' }]);
    journal.record(plan.id, K.a, 'copie_en_cours', null, true);
    journal.record(plan.id, K.b, 'echec', 'copie en échec : SlowDown: ralentissez', true);
    const overview = summarizeExecution(plan, journal.findStates(plan.id));
    expect(overview).toMatchObject({
      done: { count: 0 },
      remaining: { count: 3, size: 350 },
      inProgress: { count: 1, size: 100 },
      failed: { count: 1, size: 200 },
      notStarted: { count: 1, size: 50 },
    });
    expect(overview.failures).toEqual([{ sourceKey: K.b, destination: 'albums/mariage/DSC 01 & co #2+?.jpg', reason: 'copie en échec : SlowDown: ralentissez' }]);
  });
});
