import { BucketObject } from '../../src/clients/types';
import { ObjectDating } from '../../src/database/inventory-date-model';
import {
  albumOf,
  assessPlanFreshness,
  bucketMismatchHint,
  buildRepairPlan,
  checkPlanInvariants,
  IndexState,
  normalizePlanConfig,
  objectsInScope,
  occupiedFrom,
  PlanInput,
  PlanLine,
  planExport,
  PlanRefusedError,
  planToCsv,
  planToJson,
  RepairPlan,
  summarizePlan,
  verifyStoredPlan,
} from '../../src/inventory/repair-plan';

const BACKUP = 'backup_google_photos/photos/';
const PERSO = '2_Personnel/Photos/google_photos/';
const PREFIXES = [BACKUP, PERSO];
const FORMATS = ['jpg', 'jpeg', 'mp4'];
const CR = String.fromCharCode(13);
const IGNORED = ['.DS_Store', 'Thumbs.db', `Icon${CR}`];

const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);

function obj(key: string, size: number, etag: string | null): BucketObject {
  return { key, size, etag, lastModified: null };
}

function dated(o: BucketObject, takenAt: string | null, source: ObjectDating['source'] = 'exif', detail: string | null = 'DateTimeOriginal'): ObjectDating {
  return { key: o.key, size: o.size, etag: o.etag, source, takenAt, detail, exifRead: source === 'exif' };
}

const INDEX: IndexState = {
  sourceInventory: { completedAt: '2026-09-15T08:00:00.000Z', objectCount: 17_875 },
  destinationInventory: null,
  datings: { count: 12_736, lastDatedAt: '2026-09-15T09:00:00.000Z' },
};

/** Jeu reproduisant le bucket réel : deux emplacements, doublons, collision IMG_0044, album mariage, indéterminé, hors périmètre. */
function realCase(): { objects: BucketObject[]; datings: ObjectDating[] } {
  const img2016 = obj(`${BACKUP}2016/IMG_0044.JPG`, 293_332, md5('a'));
  const img2025a = obj(`${BACKUP}2025/2025-08/IMG_0044.JPG`, 67_347, md5('b'));
  const img2025b = obj(`${PERSO}IMG_0044.JPG`, 67_347, md5('b')); // doublon inter-emplacements
  const img2025c = obj(`${PERSO}2025/IMG_0044.JPG`, 71_000, md5('c')); // homonyme du même mois : collision
  const pxl = obj(`${BACKUP}2024/PXL_20240315_180000123.jpg`, 3_000_000, md5('d'));
  const pxlPerso = obj(`${PERSO}PXL_20240315_180000123.jpg`, 3_000_000, md5('d'));
  const wedding = obj(`${PERSO}mariage/DSC_1000.jpg`, 5_000_000, md5('e'));
  const weddingChrono = obj(`${BACKUP}2019/DSC_1000.jpg`, 5_000_000, md5('e')); // doublon album / chronologique
  const weddingUndated = obj(`${PERSO}mariage/sans_date.jpg`, 900, md5('f'));
  const undated = obj(`${BACKUP}2025/2025-08/scan.jpg`, 1_200, md5('9'));
  const outOfScope = obj('2_Personnel/Mariage/DSC_1000.jpg', 5_000_000, md5('e'));
  const outOfScopePhoto = obj('2_Personnel/Photos/altA123_jpg.jpg', 42, md5('8'));
  const outOfScopeDoc = obj('1_Professionel/devis.pdf', 10, md5('7'));
  const dsStore = obj(`${BACKUP}.DS_Store`, 6_148, md5('6')); // exclusion déclarée
  const objects = [img2016, img2025a, img2025b, img2025c, pxl, pxlPerso, wedding, weddingChrono, weddingUndated, undated, outOfScope, outOfScopePhoto, outOfScopeDoc, dsStore];
  const datings = [
    dated(img2016, '2016-02-20T10:00:00'),
    dated(img2025a, '2025-08-01T12:00:00'),
    dated(img2025b, '2025-08-01T12:00:00'),
    dated(img2025c, '2025-08-20T12:00:00', 'exif', 'CreateDate'),
    dated(pxl, '2024-03-15T18:00:00', 'nom_fichier', null),
    dated(pxlPerso, '2024-03-15T18:00:00', 'nom_fichier', null),
    dated(wedding, '2019-06-01T15:00:00'),
    dated(weddingChrono, '2019-06-01T15:00:00'),
    dated(weddingUndated, null, 'indeterminee', 'aucune date dans le nom ni dans l\'EXIF (1 Ko lus)'),
    dated(undated, null, 'indeterminee', 'aucune date dans le nom ni dans l\'EXIF (2 Ko lus)'),
  ];
  return { objects, datings };
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  const { objects, datings } = realCase();
  return {
    sourceBucket: 'marceau',
    destinationBucket: 'photos',
    objects,
    datings,
    supportedFormats: FORMATS,
    sourcePrefixes: PREFIXES,
    keptAlbums: ['mariage'],
    ignoredFileNames: IGNORED,
    ignoredExtensions: [],
    index: INDEX,
    occupied: [],
    ...overrides,
  };
}

/** Plan construit sur un jeu réduit, chaque objet daté au 1er janvier 2020 sauf mention. */
function planOf(objects: BucketObject[], datings: ObjectDating[] = objects.map((o) => dated(o, '2020-01-01T00:00:00')), overrides: Partial<PlanInput> = {}): RepairPlan {
  return buildRepairPlan(input({ objects, datings, ...overrides }));
}

const lineOf = (plan: RepairPlan, key: string): PlanLine => {
  const found = plan.lines.find((l) => l.sourceKey === key);
  if (!found) throw new Error(`ligne absente : ${key}`);
  return found;
};

describe('albumOf', () => {
  it('reconnaît le premier segment après le préfixe, conserve le chemin relatif', () => {
    expect(albumOf(`${PERSO}mariage/a.jpg`, PREFIXES, ['mariage'])).toEqual({ album: 'mariage', folder: 'albums/mariage/' });
    expect(albumOf(`${PERSO}mariage/sous/a.jpg`, PREFIXES, ['mariage'])).toEqual({ album: 'mariage', folder: 'albums/mariage/sous/' });
  });

  it('ignore un fichier nommé comme l\'album, un segment plus profond, une autre casse, un préfixe hors périmètre', () => {
    expect(albumOf(`${PERSO}mariage`, PREFIXES, ['mariage'])).toBeNull();
    expect(albumOf(`${PERSO}2017/mariage/a.jpg`, PREFIXES, ['mariage'])).toBeNull();
    expect(albumOf(`${PERSO}Mariage/a.jpg`, PREFIXES, ['mariage'])).toBeNull();
    expect(albumOf('2_Personnel/Mariage/a.jpg', PREFIXES, ['Mariage'])).toBeNull();
  });
});

describe('buildRepairPlan — jeu réel', () => {
  const plan = buildRepairPlan(input());

  it('ne contient que les médias du périmètre, chacun une fois ; le .DS_Store est une exclusion déclarée', () => {
    expect(plan.lines).toHaveLength(10);
    expect(plan.lines.some((l) => !l.sourceKey.startsWith(BACKUP) && !l.sourceKey.startsWith(PERSO))).toBe(false);
    expect(plan.lines.every((l) => l.sourceBucket === 'marceau')).toBe(true);
    expect(plan.exclusions).toEqual([
      { sourceKey: `${BACKUP}.DS_Store`, size: 6_148, etag: md5('6'), reason: 'fichier technique ignoré (repair.ignoredFileNames) : ".DS_Store"' },
    ]);
    expect(plan.unrecognized).toEqual([]);
    expect(plan.config).toEqual(normalizePlanConfig(input()));
    expect(plan.config.sourcePrefixes).toEqual([...PREFIXES].sort());
    expect(plan.index).toEqual(INDEX);
  });

  it('est exécutable, invariants respectés', () => {
    expect(plan.violations).toEqual([]);
    expect(plan.namingAnomalies).toEqual([]);
    expect(plan.executable).toBe(true);
  });

  it('classe par date avec la raison tracée, IMG_0044 2016 garde son nom', () => {
    const line = lineOf(plan, `${BACKUP}2016/IMG_0044.JPG`);
    expect(line).toMatchObject({ action: 'copier', destination: 'photos/2016/2016-02/IMG_0044.JPG', size: 293_332, etag: md5('a') });
    expect(line.reason).toBe('date : EXIF DateTimeOriginal (2016-02-20T10:00:00)');
    expect(lineOf(plan, `${PERSO}PXL_20240315_180000123.jpg`).reason).toBe('date : nom de fichier (2024-03-15T18:00:00)');
  });

  it('doublon inter-emplacements : un seul exemplaire copié (plus petite clé à fiabilité égale), l\'autre ignoré', () => {
    const kept = lineOf(plan, `${PERSO}PXL_20240315_180000123.jpg`);
    const ignored = lineOf(plan, `${BACKUP}2024/PXL_20240315_180000123.jpg`);
    expect(kept.action).toBe('copier');
    expect(ignored).toMatchObject({ action: 'ignorer_doublon', destination: null, keptKey: kept.sourceKey });
    expect(ignored.reason).toBe(`doublon de ${kept.sourceKey}`);
  });

  it('collision IMG_0044 dans 2025-08 : les deux contenus suffixés, aucun écrasement', () => {
    const a = lineOf(plan, `${BACKUP}2025/2025-08/IMG_0044.JPG`);
    const b = lineOf(plan, `${PERSO}IMG_0044.JPG`);
    const c = lineOf(plan, `${PERSO}2025/IMG_0044.JPG`);
    expect(b.action).toBe('copier');
    expect(a).toMatchObject({ action: 'ignorer_doublon', keptKey: b.sourceKey });
    expect(b.destination).toBe(`photos/2025/2025-08/IMG_0044_${md5('b').slice(0, 8)}.JPG`);
    expect(c.destination).toBe(`photos/2025/2025-08/IMG_0044_${md5('c').slice(0, 8)}.JPG`);
    expect(b.reason).toContain('nom suffixé');
    expect(c.reason).toBe('date : EXIF CreateDate (2025-08-20T12:00:00) ; nom suffixé (collision de noms)');
    expect(summarizePlan(plan).renamedCount).toBe(2);
  });

  it('album mariage : copié dans albums/, la copie chronologique est ignorée comme doublon (ni éclatée ni dupliquée)', () => {
    const album = lineOf(plan, `${PERSO}mariage/DSC_1000.jpg`);
    const chrono = lineOf(plan, `${BACKUP}2019/DSC_1000.jpg`);
    expect(album).toMatchObject({ action: 'copier', destination: 'albums/mariage/DSC_1000.jpg', reason: 'album conservé : mariage' });
    expect(chrono).toMatchObject({ action: 'ignorer_doublon', destination: null, keptKey: album.sourceKey });
    expect(plan.lines.some((l) => l.destination?.includes('DSC_1000') && l.destination.startsWith('photos/'))).toBe(false);
  });

  it('un média d\'album à date indéterminée reste dans l\'album', () => {
    expect(lineOf(plan, `${PERSO}mariage/sans_date.jpg`)).toMatchObject({ action: 'copier', destination: 'albums/mariage/sans_date.jpg' });
  });

  it('date indéterminée hors album : quarantaine sous la clé source complète', () => {
    const line = lineOf(plan, `${BACKUP}2025/2025-08/scan.jpg`);
    expect(line.action).toBe('quarantaine');
    expect(line.destination).toBe(`quarantaine/${BACKUP}2025/2025-08/scan.jpg`);
    expect(line.reason).toBe('date indéterminée : aucune date dans le nom ni dans l\'EXIF (2 Ko lus)');
  });

  it('conserve les comptes : copier + doublons + quarantaine + déjà archivé = total, volumes', () => {
    const summary = summarizePlan(plan);
    const { copier, ignorer_doublon, quarantaine, ignorer_deja_archive } = summary.byAction;
    expect([copier.count, ignorer_doublon.count, quarantaine.count, ignorer_deja_archive.count]).toEqual([6, 3, 1, 0]);
    expect(copier.count + ignorer_doublon.count + quarantaine.count + ignorer_deja_archive.count).toBe(summary.total);
    expect(summary.total + plan.exclusions.length + plan.unrecognized.length).toBe(objectsInScope(realCase().objects, PREFIXES).length);
    expect(ignorer_doublon.size).toBe(67_347 + 3_000_000 + 5_000_000);
    expect(summary.albums).toEqual([{ album: 'mariage', count: 2, size: 5_000_900 }]);
    const destinations = plan.lines.flatMap((l) => (l.destination ? [l.destination.toLowerCase()] : []));
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});

describe('périmètre : objets non reconnus et exclusions', () => {
  it('un objet non média sous les préfixes rend le plan non exécutable, listé par extension', () => {
    const photo = obj(`${BACKUP}2020/a.jpg`, 10, md5('1'));
    const heic = obj(`${PERSO}2021/IMG_1.HEIC`, 20, md5('2'));
    const heic2 = obj(`${PERSO}2021/IMG_2.heic`, 30, md5('3'));
    const json = obj(`${BACKUP}2020/a.jpg.json`, 5, md5('4'));
    const noExt = obj(`${BACKUP}LISEZMOI`, 5, md5('5'));
    const plan = planOf([photo, heic, heic2, json, noExt], [dated(photo, '2020-01-01T00:00:00')]);
    expect(plan.lines).toHaveLength(1);
    expect(plan.unrecognized.map((u) => [u.sourceKey, u.extension])).toEqual([
      [heic.key, '.heic'],
      [heic2.key, '.heic'],
      [json.key, '.json'],
      [noExt.key, '(sans extension)'],
    ]);
    expect(plan.violations).toEqual([]);
    expect(plan.executable).toBe(false);
    expect(summarizePlan(plan).unrecognizedByExtension).toEqual([
      { extension: '(sans extension)', keys: [noExt.key] },
      { extension: '.heic', keys: [heic.key, heic2.key] },
      { extension: '.json', keys: [json.key] },
    ]);
    const csv = planToCsv(plan);
    expect(csv).toContain(`${heic.key};marceau;20;${md5('2')};non_reconnu;;;extension .heic non reconnue : ajoutez l'extension à sync.supportedFormats`);
    expect(JSON.parse(planToJson(plan)).non_reconnus[1]).toMatchObject({ extension: '.heic', cles: [heic.key, heic2.key] });
  });

  it('une fois l\'extension ajoutée aux formats, le même objet devient une ligne du plan', () => {
    const heic = obj(`${PERSO}2021/IMG_1.HEIC`, 20, md5('2'));
    const plan = planOf([heic], undefined, { supportedFormats: [...FORMATS, 'heic'] });
    expect(plan.unrecognized).toEqual([]);
    expect(lineOf(plan, heic.key).action).toBe('copier');
    expect(plan.executable).toBe(true);
  });

  it('exclusions : noms techniques sans casse, « Icon\\r », marqueur de dossier ; comptées, exportées, dans l\'empreinte', () => {
    const photo = obj(`${BACKUP}2020/a.jpg`, 10, md5('1'));
    const thumbs = obj(`${PERSO}2017/THUMBS.DB`, 1, md5('2'));
    const icon = obj(`${PERSO}mariage/Icon${CR}`, 0, md5('3'));
    const marker = obj(`${BACKUP}2020/`, 0, md5('4'));
    const plan = planOf([photo, thumbs, icon, marker], [dated(photo, '2020-01-01T00:00:00')]);
    expect(plan.exclusions.map((e) => e.sourceKey)).toEqual([thumbs.key, icon.key, marker.key]);
    expect(plan.exclusions[2]!.reason).toContain('marqueur de dossier');
    expect(plan.executable).toBe(true);
    expect(planToCsv(plan)).toContain(`${marker.key};marceau;0;${md5('4')};exclu;;;marqueur de dossier`);
    expect(JSON.parse(planToJson(plan)).exclusions).toHaveLength(3);
    const withoutThumbs = planOf([photo, icon, marker], [dated(photo, '2020-01-01T00:00:00')]);
    expect(withoutThumbs.lines).toEqual(plan.lines);
    expect(withoutThumbs.id).not.toBe(plan.id);
  });

  it('un marqueur de dossier non vide n\'est pas une exclusion : il est non reconnu', () => {
    const photo = obj(`${BACKUP}2020/a.jpg`, 10, md5('1'));
    const plan = planOf([photo, obj(`${BACKUP}2020/`, 3, md5('2'))], [dated(photo, '2020-01-01T00:00:00')]);
    expect(plan.unrecognized).toHaveLength(1);
    expect(plan.executable).toBe(false);
  });
});

describe('albums conservés et doublons', () => {
  it('deux albums partageant un contenu gardent chacun leur copie ; la copie chronologique et le doublon interne sont ignorés', () => {
    const inVacances = obj(`${PERSO}vacances/P1.jpg`, 100, md5('1'));
    const inMariage = obj(`${PERSO}mariage/P1.jpg`, 100, md5('1'));
    const inMariageBis = obj(`${BACKUP}mariage/P1.jpg`, 100, md5('1'));
    const chrono = obj(`${BACKUP}2019/P1.jpg`, 100, md5('1'));
    const plan = planOf([inVacances, inMariage, inMariageBis, chrono], undefined, { keptAlbums: ['mariage', 'vacances'] });
    expect(plan.lines.map((l) => [l.sourceKey, l.action, l.destination, l.keptKey])).toEqual([
      [inMariage.key, 'copier', 'albums/mariage/P1.jpg', null],
      [inVacances.key, 'copier', 'albums/vacances/P1.jpg', null],
      [chrono.key, 'ignorer_doublon', null, inMariage.key],
      [inMariageBis.key, 'ignorer_doublon', null, inMariage.key],
    ]);
    expect(plan.executable).toBe(true);
  });
});

describe('désambiguïsation des dossiers ne différant que par la casse ou la forme Unicode', () => {
  it('album : sous-dossier « Cérémonie » en NFC et en NFD, contenus différents → suffixés, plan exécutable', () => {
    const nfc = obj(`${PERSO}mariage/${'Cérémonie'.normalize('NFC')}/IMG.jpg`, 10, md5('1'));
    const nfd = obj(`${PERSO}mariage/${'Cérémonie'.normalize('NFD')}/IMG.jpg`, 20, md5('2'));
    expect(nfc.key).not.toBe(nfd.key);
    const plan = planOf([nfc, nfd]);
    expect(lineOf(plan, nfc.key).destination).toBe(`albums/mariage/${'Cérémonie'.normalize('NFC')}/IMG_${md5('1').slice(0, 8)}.jpg`);
    expect(lineOf(plan, nfd.key).destination).toBe(`albums/mariage/${'Cérémonie'.normalize('NFD')}/IMG_${md5('2').slice(0, 8)}.jpg`);
    expect(plan.namingAnomalies).toEqual([]);
    expect(plan.violations).toEqual([]);
    expect(plan.executable).toBe(true);
  });

  it('quarantaine : « Divers/scan.jpg » et « divers/scan.jpg » → suffixés, plan exécutable', () => {
    const upper = obj(`${BACKUP}Divers/scan.jpg`, 10, md5('1'));
    const lower = obj(`${BACKUP}divers/scan.jpg`, 20, md5('2'));
    const plan = planOf([upper, lower], [dated(upper, null, 'indeterminee', 'x'), dated(lower, null, 'indeterminee', 'x')]);
    expect(lineOf(plan, upper.key)).toMatchObject({ action: 'quarantaine', destination: `quarantaine/${BACKUP}Divers/scan_${md5('1').slice(0, 8)}.jpg` });
    expect(lineOf(plan, lower.key).destination).toBe(`quarantaine/${BACKUP}divers/scan_${md5('2').slice(0, 8)}.jpg`);
    expect(plan.executable).toBe(true);
  });
});

describe('rejouabilité', () => {
  it('même entrée, ordre inversé : mêmes lignes, même ordre, même empreinte', () => {
    const first = buildRepairPlan(input());
    const { objects, datings } = realCase();
    const second = buildRepairPlan(input({ objects: [...objects].reverse(), datings: [...datings].reverse(), sourcePrefixes: [...PREFIXES].reverse() }));
    expect(second).toEqual(first);
    expect(second.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('une entrée différente change l\'empreinte, y compris l\'état de l\'index seul', () => {
    const first = buildRepairPlan(input());
    expect(buildRepairPlan(input({ destinationBucket: 'photos-2' })).id).not.toBe(first.id);
    const reindexed = buildRepairPlan(input({ index: { ...INDEX, sourceInventory: { completedAt: '2026-09-16T08:00:00.000Z', objectCount: 17_875 } } }));
    expect(reindexed.lines).toEqual(first.lines);
    expect(reindexed.id).not.toBe(first.id);
  });
});

describe('refus plutôt que plan partiel', () => {
  it('média non daté', () => {
    const { datings } = realCase();
    expect(() => buildRepairPlan(input({ datings: datings.slice(1) }))).toThrow(PlanRefusedError);
    expect(() => buildRepairPlan(input({ datings: datings.slice(1) }))).toThrow(/1 média\(s\).*gpb inventory dates/);
  });

  it('datation périmée (ETag changé depuis la datation)', () => {
    const { objects, datings } = realCase();
    const changed = objects.map((o) => (o.key === `${BACKUP}2016/IMG_0044.JPG` ? { ...o, etag: md5('z') } : o));
    expect(() => buildRepairPlan(input({ objects: changed, datings }))).toThrow(/non daté\(s\) ou à datation périmée/);
  });

  it('préfixes vides, sans barre finale, imbriqués ou répétés ; album invalide ; destination absente ou égale ; périmètre vide', () => {
    expect(() => buildRepairPlan(input({ sourcePrefixes: [] }))).toThrow(/aucun préfixe source/);
    expect(() => buildRepairPlan(input({ sourcePrefixes: ['backup_google_photos'] }))).toThrow(/finir par « \/ »/);
    expect(() => buildRepairPlan(input({ sourcePrefixes: ['2_Personnel/Photos/', PERSO] }))).toThrow(/imbriqués ou répétés/);
    expect(() => buildRepairPlan(input({ sourcePrefixes: [PERSO, BACKUP, PERSO] }))).toThrow(/imbriqués ou répétés/);
    expect(() => buildRepairPlan(input({ keptAlbums: ['a/b'] }))).toThrow(PlanRefusedError);
    expect(() => buildRepairPlan(input({ destinationBucket: '' }))).toThrow(/bucket dédié non configuré/);
    expect(() => buildRepairPlan(input({ destinationBucket: 'marceau' }))).toThrow(/différer du bucket source/);
    expect(() => buildRepairPlan(input({ destinationBucket: 'MARCEAU' }))).toThrow(/nom de bucket « MARCEAU » invalide/);
    expect(() => buildRepairPlan(input({ destinationBucket: ' marceau' }))).toThrow(/invalide/);
    expect(() => buildRepairPlan(input({ sourceBucket: 'Marceau' }))).toThrow(/nom de bucket « Marceau » invalide/);
    expect(() => buildRepairPlan(input({ sourcePrefixes: ['vide/'] }))).toThrow(/aucun objet sous/);
  });
});

describe('déjà archivé', () => {
  it('un contenu déjà présent dans le bucket dédié est ignoré, un nom occupé par un autre contenu force un suffixe', () => {
    const occupied = occupiedFrom([
      obj('photos/2016/2016-02/IMG_0044.JPG', 293_332, md5('a')), // même contenu
      obj('albums/mariage/DSC_1000.jpg', 1, md5('0')), // même nom, autre contenu
    ]);
    const index = { ...INDEX, destinationInventory: { completedAt: '2026-09-15T08:30:00.000Z', objectCount: 2 } };
    const plan = buildRepairPlan(input({ occupied, index }));
    expect(lineOf(plan, `${BACKUP}2016/IMG_0044.JPG`)).toMatchObject({
      action: 'ignorer_deja_archive',
      destination: 'photos/2016/2016-02/IMG_0044.JPG',
    });
    expect(lineOf(plan, `${PERSO}mariage/DSC_1000.jpg`).destination).toBe(`albums/mariage/DSC_1000_${md5('e').slice(0, 8)}.jpg`);
    expect(summarizePlan(plan).byAction.ignorer_deja_archive.count).toBe(1);
    expect(plan.violations).toEqual([]);
    expect(plan.executable).toBe(true);
  });

  it('déjà archivé sous une autre casse : la destination est la clé exacte de l\'objet présent', () => {
    const source = obj(`${PERSO}mariage/ceremonie/x.jpg`, 10, md5('1'));
    const occupied = occupiedFrom([obj('albums/mariage/Ceremonie/X.jpg', 10, md5('1'))]);
    const index = { ...INDEX, destinationInventory: { completedAt: '2026-09-15T08:30:00.000Z', objectCount: 1 } };
    const plan = planOf([source], undefined, { occupied, index });
    expect(lineOf(plan, source.key)).toMatchObject({ action: 'ignorer_deja_archive', destination: 'albums/mariage/Ceremonie/X.jpg' });
    expect(plan.violations).toEqual([]);
  });
});

describe('anomalies et invariants', () => {
  it('anomalie de nommage (collision avec ETag absent) : ligne conservée sans destination, plan non exécutable', () => {
    const a = obj(`${BACKUP}2020/IMG_1.jpg`, 10, null);
    const b = obj(`${PERSO}IMG_1.jpg`, 20, md5('1'));
    const plan = planOf([a, b], [dated(a, '2020-01-01T00:00:00'), dated(b, '2020-01-02T00:00:00')]);
    expect(plan.lines).toHaveLength(2);
    expect(plan.namingAnomalies).toHaveLength(1);
    expect(lineOf(plan, a.key)).toMatchObject({ action: 'copier', destination: null });
    expect(lineOf(plan, a.key).reason).toContain('anomalie de nommage : ETag absent');
    expect(plan.executable).toBe(false);
    expect(plan.violations).toContain(`${a.key} (copier) sans destination`);
  });

  describe('détecte chaque invariant cassé', () => {
    const plan = buildRepairPlan(input());
    const scope = objectsInScope(realCase().objects, PREFIXES).map((o) => o.key);
    const copy = plan.lines.find((l) => l.action === 'copier')!;
    const doublon = plan.lines.find((l) => l.action === 'ignorer_doublon')!;
    const quarantine = plan.lines.find((l) => l.action === 'quarantaine')!;
    const withLines = (lines: PlanLine[]) => ({ ...plan, lines });
    const replace = (from: PlanLine, to: PlanLine) => withLines(plan.lines.map((l) => (l === from ? to : l)));
    const check = (p: Pick<RepairPlan, 'lines' | 'exclusions' | 'unrecognized'>, keys = scope, occupied = [] as ReturnType<typeof occupiedFrom>) =>
      checkPlanInvariants(p, keys, occupied, plan.config).join(' | ');

    it('plan intact : aucune violation', () => {
      expect(checkPlanInvariants(plan, scope, [], plan.config)).toEqual([]);
    });

    it('comptes : ligne absente, objet répété, hors périmètre, exclusion perdue', () => {
      expect(check(withLines(plan.lines.slice(1)))).toMatch(/lignes \(9\) \+ exclusions \(1\).*absent du plan/);
      expect(check(withLines([...plan.lines, copy]), [...scope, copy.sourceKey])).toMatch(/présent 2 fois.*attribuée deux fois/);
      expect(check(plan, [...scope.slice(1), 'autre.jpg'])).toMatch(/absent du plan.*hors périmètre/);
      expect(check({ ...plan, exclusions: [] })).toMatch(/exclusions \(0\).*absent du plan : backup_google_photos\/photos\/\.DS_Store/);
      expect(check({ ...plan, unrecognized: [{ ...plan.exclusions[0]!, extension: '' }] })).toMatch(/présent 2 fois/);
    });

    it('exclusion non justifiée : objet de 5 000 octets exclu sans nom ni extension ignorés', () => {
      const invented = { sourceKey: copy.sourceKey, size: 5_000, etag: copy.etag, reason: 'inventée' };
      const tampered = { ...plan, lines: plan.lines.filter((l) => l !== copy), exclusions: [...plan.exclusions, invented] };
      expect(check(tampered)).toMatch(/exclusion non justifiée : .*IMG_0044\.JPG \(5000 octets\)/);
      expect(check(plan)).toBe('');
      const marker = { sourceKey: `${BACKUP}2020/`, size: 5_000, etag: null, reason: 'marqueur' };
      expect(checkPlanInvariants({ ...plan, exclusions: [marker] }, [...plan.lines.map((l) => l.sourceKey), marker.sourceKey], [], plan.config).join()).toMatch(
        /exclusion non justifiée/,
      );
    });

    it('destinations : doublon de casse, espace attendu, action inconnue, occupée, longueur des clés', () => {
      const other = plan.lines.find((l) => l.action === 'copier' && l !== copy)!;
      expect(check(replace(other, { ...other, destination: copy.destination!.toUpperCase() }))).toMatch(/attribuée deux fois/);
      expect(check(replace(quarantine, { ...quarantine, destination: 'photos/x.jpg' }))).toMatch(/hors de quarantaine/);
      expect(check(replace(copy, { ...copy, action: 'inconnue' as never }))).toMatch(/somme des actions.*action inconnue/);
      expect(check(plan, scope, occupiedFrom([obj(copy.destination!, 1, md5('0'))]))).toMatch(/destination occupée/);
      const long = `photos/2020/2020-01/${'é'.repeat(510)}.jpg`;
      expect(Buffer.byteLength(long, 'utf8')).toBeGreaterThan(1024);
      expect(long.length).toBeLessThan(1024);
      expect(check(replace(copy, { ...copy, destination: long }))).toMatch(/plus de 1024 octets/);
    });

    it('doublon : exemplaire inconnu, non conservé, ou de taille ou d\'ETag différents', () => {
      expect(check(replace(doublon, { ...doublon, keptKey: 'inconnu' }))).toMatch(/n'est pas conservé/);
      const kept = plan.lines.find((l) => l.sourceKey === doublon.keptKey)!;
      expect(check(replace(doublon, { ...doublon, size: kept.size + 1 }))).toMatch(/taille ou ETag différent/);
      expect(check(replace(doublon, { ...doublon, etag: md5('z') }))).toMatch(/taille ou ETag différent/);
      expect(check(replace(doublon, { ...doublon, etag: null }))).toMatch(/taille ou ETag différent/);
      expect(check(replace(doublon, { ...doublon, etag: `"${kept.etag!.toUpperCase()}"` }))).toBe('');
      expect(check(replace(doublon, { ...doublon, keptKey: quarantine.sourceKey }))).toMatch(/taille ou ETag différent/);
    });

    it('déjà archivé : absent du bucket dédié, ETag différent, hors des espaces du bucket dédié', () => {
      const archived = { ...copy, action: 'ignorer_deja_archive' as const };
      expect(check(replace(copy, archived))).toMatch(/absent du bucket dédié/);
      expect(check(replace(copy, archived), scope, occupiedFrom([obj(copy.destination!, copy.size, copy.etag)]))).toBe('');
      expect(check(replace(copy, archived), scope, occupiedFrom([obj(copy.destination!, copy.size, md5('z'))]))).toMatch(
        /l'ETag de l'objet présent diffère/,
      );
      const outside = { ...archived, destination: 'ailleurs/x.jpg' };
      expect(check(replace(copy, outside), scope, occupiedFrom([obj('ailleurs/x.jpg', copy.size, copy.etag)]))).toMatch(/destination hors de/);
    });
  });
});

describe('fraîcheur du plan (assessPlanFreshness)', () => {
  const plan = buildRepairPlan(input());
  const config = normalizePlanConfig(input());

  it('index et configuration inchangés, aucun refus : utilisable ; formats équivalents après normalisation', () => {
    expect(assessPlanFreshness(plan, { ...INDEX }, config, null)).toEqual([]);
    const equivalent = normalizePlanConfig(input({ supportedFormats: ['.JPG', 'jpeg', 'mp4', 'jpg'], ignoredFileNames: ['thumbs.db', ...IGNORED] }));
    expect(assessPlanFreshness(plan, INDEX, equivalent, null)).toEqual([]);
  });

  it('inventaire source, bucket dédié ou datations modifiés : périmé', () => {
    const sourceChanged = { ...INDEX, sourceInventory: { ...INDEX.sourceInventory, objectCount: 17_876 } };
    expect(assessPlanFreshness(plan, sourceChanged, config, null)).toEqual([expect.stringMatching(/^plan périmé : l'index a changé.*bucket source/)]);
    const destinationScanned = { ...INDEX, destinationInventory: { completedAt: '2026-09-16T00:00:00.000Z', objectCount: 0 } };
    expect(assessPlanFreshness(plan, destinationScanned, config, null)).toEqual([expect.stringMatching(/bucket dédié \(non inventorié → inventaire/)]);
    const redated = { ...INDEX, datings: { count: 12_736, lastDatedAt: '2026-09-16T00:00:00.000Z' } };
    expect(assessPlanFreshness(plan, redated, config, null)).toEqual([expect.stringMatching(/datations/)]);
    expect(assessPlanFreshness(plan, null, config, null)).toEqual([expect.stringMatching(/n'existe pas/)]);
  });

  it('configuration modifiée : chaque champ changé est nommé', () => {
    const narrow = buildRepairPlan(input({ sourcePrefixes: [BACKUP] }));
    expect(assessPlanFreshness(narrow, INDEX, config, null)).toEqual(['plan périmé : la configuration a changé : sourcePrefixes']);
    const changed = normalizePlanConfig(
      input({
        sourceBucket: 'autre',
        destinationBucket: 'photos-2',
        supportedFormats: [...FORMATS, 'heic'],
        keptAlbums: [],
        ignoredFileNames: [],
        ignoredExtensions: ['json'],
      }),
    );
    expect(assessPlanFreshness(plan, INDEX, changed, null)).toEqual([
      'plan périmé : la configuration a changé : sourceBucket, destinationBucket, supportedFormats, keptAlbums, ignoredFileNames, ignoredExtensions',
    ]);
  });

  it('dernière génération refusée : signalée', () => {
    const refusal = { refusedAt: new Date('2026-09-16T10:00:00Z'), reason: '3 média(s) non daté(s)' };
    expect(assessPlanFreshness(plan, INDEX, config, refusal)).toEqual([
      'la dernière génération a été refusée le 2026-09-16T10:00:00.000Z : 3 média(s) non daté(s)',
    ]);
  });
});

describe('vérification d\'un plan stocké avant exécution (verifyStoredPlan)', () => {
  it('plan identique au recalcul : aucune raison de refuser', () => {
    expect(verifyStoredPlan(buildRepairPlan(input()), input(), null)).toEqual([]);
  });

  it('préfixe ajouté à la configuration après génération : configuration changée et empreinte recalculée différente', () => {
    const narrow = buildRepairPlan(input({ sourcePrefixes: [BACKUP] }));
    expect(narrow.executable).toBe(true);
    const reasons = verifyStoredPlan(narrow, input(), null);
    expect(reasons).toContain('plan périmé : la configuration a changé : sourcePrefixes');
    expect(reasons).toContain('l\'empreinte du plan recalculé depuis l\'index et la configuration actuels diffère de celle du plan stocké');
  });

  it('contenu stocké altéré (booléen ou ligne) : incohérence d\'empreinte, invariants rejoués', () => {
    const plan = buildRepairPlan(input());
    const doublon = plan.lines.find((l) => l.action === 'ignorer_doublon')!;
    const tampered = { ...plan, lines: plan.lines.map((l) => (l === doublon ? { ...l, keptKey: 'inconnu' } : l)) };
    const reasons = verifyStoredPlan(tampered, input(), null);
    expect(reasons).toContain('contenu du plan stocké incohérent avec son empreinte');
    expect(reasons.join()).toMatch(/invariant en échec sur le plan stocké : doublon .* n'est pas conservé/);
  });

  it('recalcul refusé (média ajouté non daté) ou objet non reconnu stocké : raisons de refuser', () => {
    const plan = buildRepairPlan(input());
    const { objects, datings } = realCase();
    const newcomer = obj(`${BACKUP}2026/nouveau.jpg`, 1, md5('n'));
    const reasons = verifyStoredPlan(plan, input({ objects: [...objects, newcomer], datings }), null);
    expect(reasons.join()).toMatch(/recalcul du plan .* est refusé : 1 média\(s\)/);
    expect(reasons.join()).toMatch(/objet source absent du plan : .*nouveau\.jpg/);
    const withJson = [...objects, obj(`${BACKUP}2020/a.json`, 1, md5('j'))];
    const blocked = buildRepairPlan(input({ objects: withJson }));
    expect(blocked.executable).toBe(false);
    expect(verifyStoredPlan(blocked, input({ objects: withJson }), null)).toEqual([
      'plan stocké marqué non exécutable (0 invariant(s) en échec enregistré(s))',
      '1 objet(s) non reconnu(s) dans le plan stocké',
    ]);
  });

  it('booléen stocké « non exécutable » sur un contenu propre : refus explicite, plus fort que le booléen', () => {
    const plan = buildRepairPlan(input());
    expect(verifyStoredPlan({ ...plan, executable: false }, input(), null)).toEqual([
      'plan stocké marqué non exécutable (0 invariant(s) en échec enregistré(s))',
    ]);
  });

  it('consigne de buckets : mêmes --bucket / --destination qu\'à la génération', () => {
    const plan = buildRepairPlan(input());
    expect(bucketMismatchHint(plan, 'marceau', 'photos')).toBeNull();
    expect(bucketMismatchHint(plan, 'marceau', 'photos-autre')).toBe(
      'les buckets vérifiés (source « marceau », dédié « photos-autre ») diffèrent de ceux du plan : ' +
        'repassez les mêmes options qu\'à la génération (--bucket marceau --destination photos)',
    );
  });

  it('dernière génération refusée : refus', () => {
    const refusal = { refusedAt: new Date('2026-09-16T10:00:00Z'), reason: 'x' };
    expect(verifyStoredPlan(buildRepairPlan(input()), input(), refusal)).toEqual([expect.stringMatching(/dernière génération a été refusée/)]);
  });
});

describe('extensions ignorées (repair.ignoredExtensions)', () => {
  it('un sidecar .json est exclu, compté par raison, exporté ; le plan reste exécutable', () => {
    const photo = obj(`${BACKUP}2020/a.jpg`, 10, md5('1'));
    const sidecar = obj(`${BACKUP}2020/a.jpg.JSON`, 700, md5('2'));
    const xmp = obj(`${PERSO}2021/b.xmp`, 300, md5('3'));
    const plan = planOf([photo, sidecar, xmp], [dated(photo, '2020-01-01T00:00:00')], { ignoredExtensions: ['.json', 'XMP'] });
    expect(plan.config.ignoredExtensions).toEqual(['json', 'xmp']);
    expect(plan.exclusions.map((e) => [e.sourceKey, e.reason])).toEqual([
      [xmp.key, 'extension ignorée (repair.ignoredExtensions) : .xmp'],
      [sidecar.key, 'extension ignorée (repair.ignoredExtensions) : .json'],
    ]);
    expect(summarizePlan(plan).exclusionsByReason.map((g) => [g.reason, g.keys.length, g.size])).toEqual([
      ['extension ignorée (repair.ignoredExtensions) : .json', 1, 700],
      ['extension ignorée (repair.ignoredExtensions) : .xmp', 1, 300],
    ]);
    expect(plan.executable).toBe(true);
    expect(planToCsv(plan)).toContain(`${sidecar.key};marceau;700;${md5('2')};exclu;;;extension ignorée`);
    expect(planOf([photo, sidecar, xmp], [dated(photo, '2020-01-01T00:00:00')]).executable).toBe(false);
  });

  it('refuse d\'exclure un média par son nom (ignoredFileNames avec une extension de média, sans casse)', () => {
    expect(() => buildRepairPlan(input({ ignoredFileNames: ['A.JPG'] }))).toThrow(/"A.JPG" dans repair.ignoredFileNames .* un média ne peut pas être exclu/);
    expect(() => buildRepairPlan(input({ ignoredFileNames: [...IGNORED, 'clip.MP4'] }))).toThrow(PlanRefusedError);
  });

  it('invariant indépendant : une exclusion portant une extension de média est une violation, même justifiée par la configuration', () => {
    const plan = buildRepairPlan(input());
    const photo = plan.lines.find((l) => l.sourceKey === `${BACKUP}2016/IMG_0044.JPG`)!;
    const excluded = { sourceKey: photo.sourceKey, size: photo.size, etag: photo.etag, reason: 'fichier technique ignoré (repair.ignoredFileNames) : "IMG_0044.JPG"' };
    const stored = { ...plan, lines: plan.lines.filter((l) => l !== photo), exclusions: [...plan.exclusions, excluded] };
    const scope = objectsInScope(realCase().objects, PREFIXES).map((o) => o.key);
    const bypassed = { ...plan.config, ignoredFileNames: [...plan.config.ignoredFileNames, 'img_0044.jpg'] };
    expect(checkPlanInvariants(stored, scope, [], bypassed)).toEqual([
      `exclusion d'un média : ${photo.sourceKey} (extension .jpg de sync.supportedFormats)`,
    ]);
  });

  it('refuse d\'exclure une extension de média ou une extension vide', () => {
    expect(() => buildRepairPlan(input({ ignoredExtensions: ['jpg'] }))).toThrow(/jpg à la fois dans repair.ignoredExtensions et sync.supportedFormats/);
    expect(() => buildRepairPlan(input({ ignoredExtensions: ['.JPEG'] }))).toThrow(PlanRefusedError);
    expect(() => buildRepairPlan(input({ ignoredExtensions: ['.'] }))).toThrow(/extension vide/);
  });
});

describe('export', () => {
  const plan = buildRepairPlan(input());

  it('CSV : BOM, en-têtes français, une ligne par objet du périmètre, champs échappés', () => {
    const csv = planToCsv(plan);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.slice(1).trimEnd().split('\n');
    expect(rows[0]).toBe('cle_source;bucket_source;taille_octets;etag;action;destination;cle_conservee;raison');
    expect(rows).toHaveLength(plan.lines.length + plan.exclusions.length + 1);
    expect(rows).toContain(
      `${BACKUP}2016/IMG_0044.JPG;marceau;293332;${md5('a')};copier;photos/2016/2016-02/IMG_0044.JPG;;date : EXIF DateTimeOriginal (2016-02-20T10:00:00)`,
    );
    const odd = { ...plan, exclusions: [], lines: [{ ...plan.lines[0]!, reason: 'a;b "c"' }] };
    expect(planToCsv(odd).split('\n')[1]).toMatch(/;"a;b ""c"""$/);
  });

  it('JSON : résumé, état de l\'index, exclusions et lignes complètes en français', () => {
    const json = JSON.parse(planToJson(plan, new Date('2026-09-15T10:00:00Z')));
    expect(json).toMatchObject({ empreinte: plan.id, genere_le: '2026-09-15T10:00:00.000Z', executable: true, bucket_destination: 'photos' });
    expect(json.etat_index.inventaire_source).toEqual({ termine_le: INDEX.sourceInventory.completedAt, objets: 17_875 });
    expect(json.resume.par_action.ignorer_doublon.nombre).toBe(3);
    expect(json.resume.exclusions).toEqual([{ raison: 'fichier technique ignoré (repair.ignoredFileNames) : ".DS_Store"', nombre: 1, octets: 6_148 }]);
    expect(json.configuration.prefixes_source).toEqual([...PREFIXES].sort());
    expect(json.lignes).toHaveLength(plan.lines.length);
    expect(json.lignes[0]).toEqual(expect.objectContaining({ cle_source: plan.lines[0]!.sourceKey, raison: plan.lines[0]!.reason }));
  });

  it('choisit le format par extension et refuse les autres', () => {
    expect(planExport(plan, 'plan.CSV')).toBe(planToCsv(plan));
    expect(planExport(plan, 'dossier/plan.json')).toBe(planToJson(plan));
    expect(() => planExport(plan, 'plan.txt')).toThrow(/\.csv ou \.json/);
  });
});
