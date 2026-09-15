import { CopyObjectCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3ArchiveWriter } from '../../src/clients/archive-writer';
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

/** Journal en mémoire, même contrat que `RepairExecutionModel` (testé à part sur base temporaire). */
class MemoryJournal implements ExecutionJournal {
  readonly rows = new Map<string, Map<string, JournalEntry>>();
  prepare(planId: string, lines: { sourceKey: string; destination: string }[]): void {
    const plan = this.rows.get(planId) ?? new Map<string, JournalEntry>();
    for (const l of lines) if (!plan.has(l.sourceKey)) plan.set(l.sourceKey, { destination: l.destination, state: 'a_faire', message: null });
    this.rows.set(planId, plan);
  }
  findStates(planId: string): Map<string, JournalEntry> {
    return new Map(this.rows.get(planId) ?? []);
  }
  record(planId: string, sourceKey: string, state: ExecutionState, message: string | null): void {
    const entry = this.rows.get(planId)?.get(sourceKey);
    if (!entry) throw new Error('ligne absente');
    this.rows.get(planId)!.set(sourceKey, { ...entry, state, message });
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

    expect(result).toEqual({ copied: { count: 3, size: 350 }, alreadyPresent: 0, skipped: 0, remaining: 0, stop: null, interrupted: false });
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

  it('copie écrite mais réponse perdue (coupure) : jamais « copie » sans vérification, la relance la reconnaît par HEAD', async () => {
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
    expect(result).toMatchObject({ alreadyPresent: 1, copied: { count: 2 }, stop: null });
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
    });
  });
});
