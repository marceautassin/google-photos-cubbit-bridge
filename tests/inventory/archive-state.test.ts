import { BucketObject } from '../../src/clients/types';
import { ObjectDating } from '../../src/database/inventory-date-model';
import { InventoryRun } from '../../src/database/inventory-model';
import {
  buildArchiveState,
  planStatus,
  quarantineView,
  recommendAction,
  yearBreakdown,
} from '../../src/inventory/archive-state';
import { buildRepairPlan, IndexState, PlanInput, RepairPlan, summarizePlan } from '../../src/inventory/repair-plan';

const BACKUP = 'backup_google_photos/photos/';
const PERSO = '2_Personnel/Photos/google_photos/';
const NOW = new Date('2026-09-15T12:00:00Z');
const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);

const obj = (key: string, size: number, etag: string | null = md5(key.slice(-1))): BucketObject => ({ key, size, etag, lastModified: null });

function dated(o: BucketObject, takenAt: string | null, source: ObjectDating['source'] = 'exif', detail: string | null = 'DateTimeOriginal'): ObjectDating {
  return { key: o.key, size: o.size, etag: o.etag, source, takenAt, detail, exifRead: source === 'exif' };
}

const INDEX: IndexState = {
  sourceInventory: { completedAt: '2026-09-15T08:00:00.000Z', objectCount: 9 },
  destinationInventory: null,
  datings: { count: 7, lastDatedAt: '2026-09-15T09:00:00.000Z' },
};

const RUN: InventoryRun = { bucket: 'marceau', completedAt: new Date('2026-09-15T08:00:00Z'), objectCount: 9, totalSize: 0 };

/** Jeu : deux emplacements, doublon inter-emplacements, date suspecte, indéterminé, album, exclusion, hors périmètre. */
function fixture(): { objects: BucketObject[]; datings: ObjectDating[] } {
  const a2019 = obj(`${BACKUP}2019/IMG_1.jpg`, 1_000, md5('a'));
  const a2019Copy = obj(`${PERSO}IMG_1.jpg`, 1_000, md5('a')); // doublon confirmé
  const b2024 = obj(`${BACKUP}2024/PXL_20240315_180000123.jpg`, 3_000, md5('b'));
  const old = obj(`${BACKUP}1999/scan_ancien.jpg`, 500, md5('c')); // date suspecte (avant 2000)
  const modify = obj(`${PERSO}2024/export.jpg`, 700, md5('d')); // suspecte (EXIF ModifyDate)
  const unknown = obj(`${BACKUP}divers/scan.jpg`, 1_200, md5('e')); // date indéterminée
  const wedding = obj(`${PERSO}mariage/sans_date.jpg`, 900, md5('f')); // indéterminé en album : pas en quarantaine
  const dsStore = obj(`${BACKUP}.DS_Store`, 6_148, md5('6'));
  const outOfScope = obj('1_Professionel/photo.jpg', 42, md5('7'));
  const objects = [a2019, a2019Copy, b2024, old, modify, unknown, wedding, dsStore, outOfScope];
  const datings = [
    dated(a2019, '2019-06-01T15:00:00'),
    dated(a2019Copy, '2019-06-01T15:00:00'),
    dated(b2024, '2024-03-15T18:00:00', 'nom_fichier', null),
    dated(old, '1999-12-31T23:00:00'),
    dated(modify, '2024-01-01T10:00:00', 'exif', 'ModifyDate'),
    dated(unknown, null, 'indeterminee', 'aucune date'),
    dated(wedding, null, 'indeterminee', 'aucune date'),
  ];
  return { objects, datings };
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    sourceBucket: 'marceau',
    destinationBucket: 'photos',
    sourcePrefixes: [BACKUP, PERSO],
    supportedFormats: ['jpg'],
    keptAlbums: ['mariage'],
    ignoredFileNames: ['.DS_Store'],
    ignoredExtensions: [],
    index: INDEX,
    occupied: [],
    ...fixture(),
    ...overrides,
  };
}

const stored = (plan: RepairPlan): { plan: RepairPlan; generatedAt: Date } => ({ plan, generatedAt: NOW });

describe('yearBreakdown', () => {
  it('range chaque média daté dans son année, suspects compris ; indéterminés et non datés à part', () => {
    const { objects, datings } = fixture();
    const media = objects.filter((o) => o.key.endsWith('.jpg') && !o.key.startsWith('1_'));
    const withoutOld = datings.filter((d) => !d.key.includes('1999')); // → non daté
    const result = yearBreakdown(media, withoutOld, NOW);
    expect(result.years).toEqual([
      { year: '2019', count: 2, size: 2_000, suspectCount: 0 },
      { year: '2024', count: 2, size: 3_700, suspectCount: 1 },
    ]);
    expect(result.indeterminate).toEqual({ count: 2, size: 2_100 });
    expect(result.undated).toEqual({ count: 1, size: 500 });
    const total = result.years.reduce((n, y) => n + y.count, 0) + result.indeterminate.count + result.undated.count;
    expect(total).toBe(media.length);
  });

  it('compte une date antérieure à 2000 dans son année, comme suspecte', () => {
    const { objects, datings } = fixture();
    const result = yearBreakdown(objects.filter((o) => o.key.includes('1999')), datings, NOW);
    expect(result.years).toEqual([{ year: '1999', count: 1, size: 500, suspectCount: 1 }]);
  });

  it('traite une datation périmée (taille ou ETag différents) comme non datée', () => {
    const { objects, datings } = fixture();
    const changed = { ...objects[0]!, size: 9_999 };
    const result = yearBreakdown([changed], datings, NOW);
    expect(result.years).toEqual([]);
    expect(result.undated).toEqual({ count: 1, size: 9_999 });
  });
});

describe('buildArchiveState — cohérence avec le plan', () => {
  const current = input();
  const plan = buildRepairPlan(current);
  const state = buildArchiveState({ inventoryRun: RUN, planInput: current, storedPlan: stored(plan), lastRefusal: null, now: NOW });

  it('reprend l\'inventaire', () => {
    expect(state.inventory).toEqual({ bucket: 'marceau', completedAt: RUN.completedAt, objectCount: 9, totalSize: 0 });
  });

  it('a le même périmètre que buildRepairPlan (médias, exclusions, non reconnus)', () => {
    expect(state.scope.media.count).toBe(plan.lines.length);
    expect(state.scope.media.size).toBe(plan.lines.reduce((n, l) => n + l.size, 0));
    expect(state.scope.exclusions).toEqual({ count: plan.exclusions.length, size: 6_148 });
    expect(state.scope.unrecognized).toEqual({ count: 0, size: 0, extensions: [] });
    expect(state.scope.objects.count).toBe(8); // hors périmètre exclu
    expect(state.scope.prefixes).toEqual([PERSO, BACKUP]);
  });

  it('restitue doublons, années et quarantaine du plan (l\'indéterminé d\'album n\'y est pas)', () => {
    expect(state.duplicates).toEqual({ groupCount: 1, extraCopyCount: 1, recoverableSize: 1_000, unconfirmedGroupCount: 0, unconfirmedSize: 0 });
    expect(state.years.years.map((y) => [y.year, y.count, y.suspectCount])).toEqual([
      ['1999', 1, 1],
      ['2019', 2, 0],
      ['2024', 2, 1],
    ]);
    expect(state.years.indeterminate.count).toBe(2);
    expect(state.plan.quarantine).toEqual(summarizePlan(plan).byAction.quarantaine);
    expect(state.plan.quarantine).toEqual({ count: 1, size: 1_200 });
  });

  it('plan à jour → prêt à relire', () => {
    expect(state.plan.state).toBe('a_jour');
    expect(state.plan.reasons).toEqual([]);
    expect(state.nextAction).toContain('plan prêt à relire');
  });

  it('compte les objets non reconnus comme le plan et recommande de les déclarer', () => {
    const withHeic = input({ objects: [...fixture().objects, obj(`${BACKUP}2020/a.heic`, 10)] });
    const s = buildArchiveState({ inventoryRun: RUN, planInput: withHeic, storedPlan: null, lastRefusal: null, now: NOW });
    expect(s.scope.unrecognized).toEqual({ count: buildRepairPlan(withHeic).unrecognized.length, size: 10, extensions: ['.heic'] });
    expect(s.nextAction).toContain('déclarez les objets non reconnus');
  });

  it('médias non datés → gpb inventory dates, avant tout le reste', () => {
    const undated = input({ datings: fixture().datings.slice(1) });
    const s = buildArchiveState({ inventoryRun: RUN, planInput: undated, storedPlan: null, lastRefusal: null, now: NOW });
    expect(s.years.undated.count).toBe(1);
    expect(s.plan.state).toBe('absent');
    expect(s.plan.quarantine).toBeNull();
    expect(s.nextAction).toBe('datez les 1 média(s) non daté(s) : gpb inventory dates');
  });

  it('préfixes source vides : périmètre vide, renseigner repair.sourcePrefixes', () => {
    const s = buildArchiveState({ inventoryRun: RUN, planInput: input({ sourcePrefixes: [] }), storedPlan: null, lastRefusal: null, now: NOW });
    expect(s.scope.prefixes).toEqual([]);
    expect(s.scope.media.count).toBe(0);
    expect(s.nextAction).toContain('renseignez repair.sourcePrefixes');
  });
});

describe('quarantineView', () => {
  const current = input();
  const plan = buildRepairPlan(current);

  it('sans plan, avec des médias non datés : estimation impossible (et non « 0 média »)', () => {
    const { objects } = fixture();
    const noDatings = input({ datings: [] });
    const s = buildArchiveState({ inventoryRun: RUN, planInput: noDatings, storedPlan: null, lastRefusal: null, now: NOW });
    expect(s.quarantine).toEqual({ kind: 'estimation_impossible', undatedCount: objects.filter((o) => o.key.endsWith('.jpg') && !o.key.startsWith('1_')).length });
  });

  it('sans plan, tout daté : borne haute d\'après les dates indéterminées', () => {
    const s = buildArchiveState({ inventoryRun: RUN, planInput: current, storedPlan: null, lastRefusal: null, now: NOW });
    expect(s.quarantine).toEqual({ kind: 'au_plus', volume: { count: 2, size: 2_100 } });
  });

  it('avec un plan : celui du plan, à jour ou non', () => {
    const years = yearBreakdown([], []);
    expect(quarantineView(years, planStatus(stored(plan), current, null))).toEqual({ kind: 'plan', volume: { count: 1, size: 1_200 }, planUpToDate: true });
    const later = input({ index: { ...INDEX, datings: { count: 7, lastDatedAt: '2026-09-15T10:00:00.000Z' } } });
    expect(quarantineView(years, planStatus(stored(plan), later, null))).toEqual({ kind: 'plan', volume: { count: 1, size: 1_200 }, planUpToDate: false });
  });
});

describe('planStatus', () => {
  const current = input();
  const plan = buildRepairPlan(current);

  it('absent, avec le dernier refus', () => {
    const status = planStatus(null, current, { refusedAt: NOW, reason: '2 média(s) non daté(s)' });
    expect(status.state).toBe('absent');
    expect(status.reasons).toEqual(['la dernière génération a été refusée : 2 média(s) non daté(s)']);
  });

  it('à jour', () => {
    expect(planStatus(stored(plan), current, null).state).toBe('a_jour');
  });

  it('périmé quand l\'index a changé, avec les raisons', () => {
    const later = input({ index: { ...INDEX, datings: { count: 7, lastDatedAt: '2026-09-15T10:00:00.000Z' } } });
    const status = planStatus(stored(plan), later, null);
    expect(status.state).toBe('perime');
    expect(status.reasons.some((r) => r.includes('datations'))).toBe(true);
  });

  it('périmé quand les buckets diffèrent, avec la consigne des options', () => {
    const status = planStatus(stored(plan), input({ destinationBucket: 'autre' }), null);
    expect(status.state).toBe('perime');
    expect(status.reasons.some((r) => r.includes('--destination photos'))).toBe(true);
  });

  it('dernière génération refusée, index inchangé : non exécutable en l\'état, pas périmé ; raisons conservées', () => {
    const status = planStatus(stored(plan), current, { refusedAt: NOW, reason: 'HEIC non daté' });
    expect(status.state).toBe('non_executable');
    expect(status.reasons).toHaveLength(1);
    expect(status.reasons[0]).toContain('HEIC non daté');
  });

  it('dernière génération refusée et index changé : périmé', () => {
    const later = input({ index: { ...INDEX, datings: { count: 7, lastDatedAt: '2026-09-15T10:00:00.000Z' } } });
    expect(planStatus(stored(plan), later, { refusedAt: NOW, reason: 'refus' }).state).toBe('perime');
  });

  it('non exécutable (objet non reconnu), prioritaire sur périmé', () => {
    const withHeic = input({ objects: [...fixture().objects, obj(`${BACKUP}2020/a.heic`, 10)] });
    const blocked = buildRepairPlan(withHeic);
    expect(blocked.executable).toBe(false);
    expect(planStatus(stored(blocked), withHeic, null).state).toBe('non_executable');
    expect(planStatus(stored(blocked), input(), null).state).toBe('non_executable');
  });
});

describe('recommendAction', () => {
  const facts = { sourcePrefixesMissing: false, undatedCount: 0, unrecognizedCount: 0 };

  it('inventaire absent → gpb inventory scan', () => {
    expect(recommendAction(null)).toBe('inventoriez le bucket : gpb inventory scan');
  });

  it('une action par état du plan', () => {
    expect(recommendAction({ ...facts, planState: 'absent' })).toBe('générez le plan de réparation : gpb plan generer');
    expect(recommendAction({ ...facts, planState: 'perime' })).toBe('régénérez le plan, il est périmé : gpb plan generer');
    expect(recommendAction({ ...facts, planState: 'non_executable' })).toContain('gpb plan afficher');
    expect(recommendAction({ ...facts, planState: 'a_jour' })).toBe('plan prêt à relire : gpb plan afficher --export plan.csv');
  });

  it('préfixes source vides → renseigner repair.sourcePrefixes, avant « générez le plan »', () => {
    expect(recommendAction({ ...facts, sourcePrefixesMissing: true, planState: 'absent' })).toBe(
      'renseignez repair.sourcePrefixes dans config/config.json, puis : gpb plan generer',
    );
  });

  it('priorités : non datés, puis non reconnus, puis plan', () => {
    expect(recommendAction({ ...facts, undatedCount: 12_345, unrecognizedCount: 3, planState: 'a_jour' })).toBe(
      `datez les 12${String.fromCharCode(0x202f)}345 média(s) non daté(s) : gpb inventory dates`,
    );
    expect(recommendAction({ ...facts, unrecognizedCount: 3, planState: 'a_jour' })).toContain('gpb plan generer');
  });
});
