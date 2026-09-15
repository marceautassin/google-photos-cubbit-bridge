import { BucketObject } from '../../src/clients/types';
import { ObjectDating } from '../../src/database/inventory-date-model';
import {
  analyzeDuplicates,
  chooseKept,
  datingRank,
  destinationFolder,
  disambiguateNames,
  DuplicateReport,
  etagKind,
  NamingEntry,
  resolveNames,
  splitName,
} from '../../src/inventory/duplicates';

const BACKUP = 'backup_google_photos/photos/';
const PERSO = '2_Personnel/Photos/google_photos/';

const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);
const multipart = (seed: string, parts = 3): string => `${md5(seed)}-${parts}`;

function obj(key: string, size: number, etag: string | null): BucketObject {
  return { key, size, etag, lastModified: null };
}

function dated(object: BucketObject, takenAt: string | null, source: ObjectDating['source'] = 'exif', detail: string | null = 'DateTimeOriginal'): ObjectDating {
  return { key: object.key, size: object.size, etag: object.etag, source, takenAt, detail, exifRead: source === 'exif' };
}

/** Jeu reproduisant les cas réels du bucket. */
function realCase(): { media: BucketObject[]; datings: ObjectDating[] } {
  const img2016 = obj(`${BACKUP}2016/IMG_0044.JPG`, 293_332, md5('a'));
  const img2025a = obj(`${BACKUP}2025/IMG_0044.JPG`, 67_347, md5('b'));
  const img2025b = obj(`${PERSO}IMG_0044.JPG`, 67_347, md5('b'));
  const pxlBackup = obj(`${BACKUP}2024/PXL_20240315_180000123.jpg`, 3_000_000, md5('c'));
  const pxlPerso = obj(`${PERSO}PXL_20240315_180000123.jpg`, 3_000_000, md5('c'));
  const media = [img2016, img2025a, img2025b, pxlBackup, pxlPerso];
  const datings = [
    dated(img2016, '2016-02-20T10:00:00'),
    dated(img2025a, '2025-08-01T12:00:00'),
    dated(img2025b, '2025-08-01T12:00:00'),
    dated(pxlBackup, '2024-03-15T18:00:00', 'nom_fichier', null),
    dated(pxlPerso, '2024-03-15T18:00:00', 'nom_fichier', null),
  ];
  return { media, datings };
}

/** Chaque destination (comparée sans casse) ne reçoit qu'un objet. */
function assertUniqueDestinations(report: DuplicateReport): void {
  const values = [...report.destinations.values()].map((d) => d.normalize('NFC').toLowerCase());
  expect(new Set(values).size).toBe(values.length);
}

/** Deux copies du même mois, datées EXIF identiquement. */
function pair(a: BucketObject, b: BucketObject, takenAt = '2025-08-01T00:00:00'): DuplicateReport {
  return analyzeDuplicates([a, b], [dated(a, takenAt), dated(b, takenAt)]);
}

describe('utilitaires', () => {
  it('etagKind distingue MD5, multipart et absent', () => {
    expect(etagKind(md5('f'))).toBe('md5');
    expect(etagKind(multipart('f', 12))).toBe('multipart');
    expect(etagKind(null)).toBe('absent');
    expect(etagKind('')).toBe('absent');
  });

  it('destinationFolder découpe la date sans fuseau', () => {
    expect(destinationFolder('2016-12-31T23:30:00')).toBe('photos/2016/2016-12/');
  });

  it('splitName : un nom commençant par un point n\'a pas de base', () => {
    expect(splitName('.jpg')).toEqual({ base: '', extension: '.jpg' });
    expect(splitName('IMG.1.JPG')).toEqual({ base: 'IMG.1', extension: '.JPG' });
    expect(splitName('sans_extension')).toEqual({ base: 'sans_extension', extension: '' });
  });

  it('datingRank : EXIF à champ inconnu ou vide moins fiable que ModifyDate, plus fiable qu\'indéterminée', () => {
    const o = obj('a.jpg', 1, md5('1'));
    const modify = datingRank(dated(o, '2020-01-01T00:00:00', 'exif', 'ModifyDate'));
    const unknown = datingRank(dated(o, '2020-01-01T00:00:00', 'exif', 'Inconnu'));
    const empty = datingRank(dated(o, '2020-01-01T00:00:00', 'exif', null));
    const indeterminate = datingRank(dated(o, null, 'indeterminee', 'aucune'));
    expect(unknown).toBeGreaterThan(modify);
    expect(empty).toBe(unknown);
    expect(indeterminate).toBeGreaterThan(unknown);
    expect(datingRank(null)).toBeGreaterThan(indeterminate);
  });
});

describe('analyzeDuplicates — doublons', () => {
  it('groupe nom + taille + ETag, chiffre le volume récupérable et sépare IMG_0044 2016/2025', () => {
    const { media, datings } = realCase();
    const report = analyzeDuplicates(media, datings);

    expect(report.mediaCount).toBe(5);
    expect(report.contentCount).toBe(3);
    expect(report.groups.map((g) => [g.name, g.size, g.others.length])).toEqual([
      ['IMG_0044.JPG', 67_347, 1],
      ['PXL_20240315_180000123.jpg', 3_000_000, 1],
    ]);
    expect(report.extraCopyCount).toBe(2);
    expect(report.recoverableSize).toBe(67_347 + 3_000_000);
    expect(report.unconfirmed).toEqual([]);
    expect(report.groups.some((g) => g.size === 293_332)).toBe(false);
    expect(report.homonyms).toHaveLength(1);
    expect(report.collisions).toEqual([]);
    expect(report.destinations.get(`${BACKUP}2016/IMG_0044.JPG`)).toBe('photos/2016/2016-02/IMG_0044.JPG');
    expect(report.destinations.get(`${PERSO}IMG_0044.JPG`)).toBe('photos/2025/2025-08/IMG_0044.JPG');
    assertUniqueDestinations(report);
  });

  it('regroupe les noms NFC/NFD et de casse différente (même taille, même ETag) : doublon, sans anomalie', () => {
    const nfc = obj(`${BACKUP}\u00c9t\u00e9.jpg`, 10, md5('d'));
    const nfd = obj(`${PERSO}E\u0301te\u0301.jpg`, 10, md5('d'));
    const report = pair(nfc, nfd);
    expect(report.groups).toHaveLength(1);
    expect(report.recoverableSize).toBe(10);
    expect(report.namingAnomalies).toEqual([]);
    expect(report.destinations.size).toBe(1);

    const upper = obj(`${BACKUP}IMG_1.JPG`, 10, md5('e'));
    const lower = obj(`${PERSO}img_1.jpg`, 10, md5('e'));
    const caseReport = pair(upper, lower);
    expect(caseReport.groups).toHaveLength(1);
    expect(caseReport.namingAnomalies).toEqual([]);
    expect(caseReport.collisions).toEqual([]);
  });

  it('conserve l\'exemplaire le mieux daté, puis la plus petite clé', () => {
    const a = obj(`${BACKUP}IMG_1.JPG`, 10, md5('d'));
    const b = obj(`${PERSO}IMG_1.JPG`, 10, md5('d'));
    const c = obj(`zzz/IMG_1.JPG`, 10, md5('d'));
    const report = analyzeDuplicates([a, b, c], [
      dated(a, '2019-01-01T00:00:00', 'exif', 'ModifyDate'),
      dated(b, null, 'indeterminee', 'aucune date'),
      dated(c, '2018-05-05T00:00:00', 'exif', 'DateTimeOriginal'),
    ]);
    expect(report.groups[0]!.kept.object.key).toBe('zzz/IMG_1.JPG');
    expect(report.groups[0]!.dateMismatch).toBe(true);
    expect(chooseKept([{ object: a, dating: null }, { object: b, dating: null }]).object.key).toBe(b.key);
  });

  it('signale les dates divergentes au sein d\'un groupe, pas les copies cohérentes', () => {
    const { media, datings } = realCase();
    datings[2] = dated(media[2]!, '2025-09-01T12:00:00');
    const report = analyzeDuplicates(media, datings);
    expect(report.groups.find((g) => g.name === 'IMG_0044.JPG')!.dateMismatch).toBe(true);
    expect(report.groups.find((g) => g.name.startsWith('PXL'))!.dateMismatch).toBe(false);
  });
});

describe('analyzeDuplicates — ETag : un doublon exige un ETag identique non nul', () => {
  it('MD5 + multipart : jamais fusionnés, signalés non confirmables, hors volume récupérable', () => {
    const report = pair(obj(`${BACKUP}VID_1.mp4`, 500_000_000, multipart('e', 50)), obj(`${PERSO}VID_1.mp4`, 500_000_000, md5('1')));
    expect(report.groups).toEqual([]);
    expect(report.contentCount).toBe(2);
    expect(report.recoverableSize).toBe(0);
    expect(report.unconfirmed).toHaveLength(1);
    expect(report.unconfirmedSize).toBe(500_000_000);
    expect(report.etagConflicts).toEqual([]);
    expect(report.namingAnomalies).toEqual([]);
    assertUniqueDestinations(report);
  });

  it('MD5 + ETag absent : jamais fusionnés, non confirmables ; l\'absent en collision est une anomalie', () => {
    const a = obj(`${BACKUP}IMG_2.JPG`, 1000, md5('1'));
    const b = obj(`${PERSO}IMG_2.JPG`, 1000, null);
    const report = pair(a, b);
    expect(report.groups).toEqual([]);
    expect(report.recoverableSize).toBe(0);
    expect(report.unconfirmed).toHaveLength(1);
    expect(report.namingAnomalies.map((x) => x.id)).toEqual([b.key]);
    expect(report.destinations.get(a.key)).toBe('photos/2025/2025-08/IMG_2_11111111.JPG');
  });

  it('X + Y + absent même mois : trois contenus, conflit d\'ETag, anomalie collectée sans faire échouer le rapport', () => {
    const x = obj(`${BACKUP}IMG_0044.JPG`, 1000, md5('1'));
    const y = obj(`${PERSO}IMG_0044.JPG`, 1000, md5('2'));
    const z = obj(`zzz/IMG_0044.JPG`, 1000, null);
    const report = analyzeDuplicates([x, y, z], [x, y, z].map((o) => dated(o, '2025-08-01T00:00:00')));
    expect(report.groups).toEqual([]);
    expect(report.contentCount).toBe(3);
    expect(report.etagConflicts).toHaveLength(1);
    expect(report.unconfirmed).toHaveLength(1);
    expect(report.unconfirmedSize).toBe(2000);
    expect(report.recoverableSize).toBe(0);
    expect(report.namingAnomalies.map((a) => a.id)).toEqual([z.key]);
    expect([...report.destinations.values()].sort()).toEqual([
      'photos/2025/2025-08/IMG_0044_11111111.JPG',
      'photos/2025/2025-08/IMG_0044_22222222.JPG',
    ]);
    expect(report.collisions[0]!.entries.find((e) => e.copy.object.key === z.key)!.finalName).toBeNull();
    assertUniqueDestinations(report);
  });

  it('deux multipart strictement identiques, même taille : fusion confirmée', () => {
    const report = pair(obj(`${BACKUP}VID_2.mp4`, 9000, multipart('9')), obj(`${PERSO}VID_2.mp4`, 9000, multipart('9').toUpperCase()));
    expect(report.groups).toHaveLength(1);
    expect(report.recoverableSize).toBe(9000);
    expect(report.unconfirmed).toEqual([]);
  });

  it('deux multipart différents : pas de fusion', () => {
    const report = pair(obj(`${BACKUP}VID_3.mp4`, 9000, multipart('9', 3)), obj(`${PERSO}VID_3.mp4`, 9000, multipart('9', 4)));
    expect(report.groups).toEqual([]);
    expect(report.contentCount).toBe(2);
    expect(report.unconfirmed).toHaveLength(1);
    expect(report.namingAnomalies).toEqual([]);
    // Même préfixe de 32 caractères : le suffixe s'allonge jusqu'au nombre de parties.
    expect([...report.destinations.values()].sort()).toEqual([
      `photos/2025/2025-08/VID_3_${md5('9')}3.mp4`,
      `photos/2025/2025-08/VID_3_${md5('9')}4.mp4`,
    ]);
  });
});

describe('analyzeDuplicates — collisions et sans date', () => {
  it('homonymes de tailles différentes dans le même mois : collision, tous suffixés par leur ETag', () => {
    const a = obj(`${BACKUP}2025/IMG_0044.JPG`, 67_347, md5('b'));
    const b = obj(`${PERSO}img_0044.jpg`, 12_000, multipart('9'));
    const report = analyzeDuplicates([a, b], [dated(a, '2025-08-01T00:00:00'), dated(b, '2025-08-31T23:59:59')]);
    expect(report.groups).toEqual([]);
    expect(report.collisions).toHaveLength(1);
    expect(report.destinations.get(a.key)).toBe('photos/2025/2025-08/IMG_0044_bbbbbbbb.JPG');
    expect(report.destinations.get(b.key)).toBe('photos/2025/2025-08/img_0044_99999999.jpg');
  });

  it('objet sans date : aucun dossier daté ni date inventée', () => {
    const a = obj(`${BACKUP}IMG_0044.JPG`, 1, md5('1'));
    const b = obj(`${PERSO}IMG_0044.JPG`, 2, md5('2'));
    const c = obj(`${PERSO}autre.gif`, 3, md5('3'));
    const report = analyzeDuplicates([a, b, c], [dated(a, '2025-08-01T00:00:00'), dated(b, null, 'indeterminee', 'aucune date')]);
    expect(report.withoutFolder.map((copy) => copy.object.key).sort()).toEqual([b.key, c.key].sort());
    expect(report.destinations.has(b.key)).toBe(false);
    expect(report.destinations.has(c.key)).toBe(false);
    expect(report.destinations.get(a.key)).toBe('photos/2025/2025-08/IMG_0044.JPG');
    expect(report.undatedCount).toBe(1);
    expect(report.collisions).toEqual([]);
  });

  it('ignore une datation périmée (ETag changé)', () => {
    const a = obj(`${BACKUP}IMG_1.JPG`, 1, md5('1'));
    const report = analyzeDuplicates([a], [{ ...dated(a, '2020-01-01T00:00:00'), etag: md5('2') }]);
    expect(report.undatedCount).toBe(1);
    expect(report.withoutFolder).toHaveLength(1);
  });

  it('passe ultérieure au niveau du rapport : destinations occupées prises en compte', () => {
    const arrival = obj(`${PERSO}IMG_0044.JPG`, 12, md5('c'));
    const same = obj(`${BACKUP}IMG_0045.JPG`, 13, md5('d'));
    const report = analyzeDuplicates([arrival, same], [dated(arrival, '2025-08-01T00:00:00'), dated(same, '2025-08-01T00:00:00')], [
      { folder: 'photos/2025/2025-08/', name: 'IMG_0044.JPG', etag: md5('b') },
      { folder: 'photos/2025/2025-08/', name: 'IMG_0045.JPG', etag: md5('d') },
    ]);
    expect(report.destinations.get(arrival.key)).toBe('photos/2025/2025-08/IMG_0044_cccccccc.JPG');
    expect(report.alreadyArchived.get(same.key)).toBe('photos/2025/2025-08/IMG_0045.JPG');
    expect(report.destinations.has(same.key)).toBe(false);
  });
});

describe('stabilité', () => {
  function shuffled<T>(items: T[], seed: number): T[] {
    const copy = [...items];
    let state = seed;
    for (let i = copy.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const j = state % (i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }

  it('même rapport entre deux exécutions et quel que soit l\'ordre d\'entrée', () => {
    const { media, datings } = realCase();
    const extra = obj(`${PERSO}2025/IMG_0044.JPG`, 1234, md5('7'));
    const absent = obj(`${PERSO}2025/b/IMG_0044.JPG`, 99, null);
    media.push(extra, absent);
    datings.push(dated(extra, '2025-08-15T00:00:00'), dated(absent, '2025-08-16T00:00:00'));

    const reference = analyzeDuplicates(media, datings);
    const snapshot = (r: DuplicateReport): unknown => ({
      destinations: [...r.destinations.entries()].sort(),
      kept: r.groups.map((g) => g.kept.object.key),
      groups: r.groups.map((g) => [g.name, g.size, g.others.map((o) => o.object.key)]),
      collisions: r.collisions.map((c) => c.entries.map((e) => e.finalName)),
      anomalies: r.namingAnomalies,
      recoverable: r.recoverableSize,
    });
    expect(snapshot(analyzeDuplicates(media, datings))).toEqual(snapshot(reference));
    for (const seed of [1, 7, 42]) {
      expect(snapshot(analyzeDuplicates(shuffled(media, seed), shuffled(datings, seed + 1)))).toEqual(snapshot(reference));
    }
    expect(snapshot(analyzeDuplicates([...media].reverse(), [...datings].reverse()))).toEqual(snapshot(reference));
    expect(reference.destinations.get(extra.key)).toBe('photos/2025/2025-08/IMG_0044_77777777.JPG');
    expect(reference.destinations.get(`${PERSO}IMG_0044.JPG`)).toBe('photos/2025/2025-08/IMG_0044_bbbbbbbb.JPG');
    expect(reference.namingAnomalies.map((a) => a.id)).toEqual([absent.key]);
  });
});

describe('resolveNames / disambiguateNames', () => {
  const entry = (id: string, folder: string, name: string, etag: string | null): NamingEntry => ({ id, folder, name, etag });
  const MONTH = 'photos/2025/2025-08/';

  it('archive vide : nom conservé sans conflit, tous les membres d\'un conflit suffixés', () => {
    const { names } = disambiguateNames([
      entry('1', 'photos/2016/2016-02/', 'IMG_0044.JPG', md5('a')),
      entry('2', MONTH, 'IMG_0044.JPG', md5('b')),
      entry('3', MONTH, 'IMG_0044.JPG', md5('c')),
    ]);
    expect(names.get('1')).toBe('IMG_0044.JPG');
    expect(names.get('2')).toBe('IMG_0044_bbbbbbbb.JPG');
    expect(names.get('3')).toBe('IMG_0044_cccccccc.JPG');
  });

  it('passes successives : un nom occupé ne change jamais, seul l\'arrivant est suffixé, même contenu déjà archivé', () => {
    const pass1 = disambiguateNames([entry('a', MONTH, 'IMG_0044.JPG', md5('b'))]);
    expect(pass1.names.get('a')).toBe('IMG_0044.JPG');
    const archive = [{ folder: MONTH, name: pass1.names.get('a')!, etag: md5('b') }];

    const pass2 = disambiguateNames([entry('nouveau', MONTH, 'IMG_0044.JPG', md5('c'))], archive);
    expect(pass2.names.get('nouveau')).toBe('IMG_0044_cccccccc.JPG');
    expect(pass2.names.has('a')).toBe(false);

    const again = disambiguateNames([entry('copie', MONTH, 'img_0044.jpg', `"${md5('b').toUpperCase()}"`)], archive);
    expect(again.alreadyArchived.get('copie')).toBe('IMG_0044.JPG');
    expect(again.names.size).toBe(0);

    // Passe 3 : un contenu archivé sous un nom suffixé est reconnu ; le nom suffixé n'est pas réattribué.
    const archive2 = [...archive, { folder: MONTH, name: 'IMG_0044_cccccccc.JPG', etag: md5('c') }];
    const pass3 = disambiguateNames(
      [entry('c2', MONTH, 'IMG_0044.JPG', md5('c')), entry('d', MONTH, 'IMG_0044.JPG', md5('d'))],
      archive2,
    );
    expect(pass3.alreadyArchived.get('c2')).toBe('IMG_0044_cccccccc.JPG');
    expect(pass3.names.get('d')).toBe('IMG_0044_dddddddd.JPG');
  });

  it('deux ETag au même préfixe de 8 caractères : suffixe allongé', () => {
    const { names } = disambiguateNames([
      entry('1', MONTH, 'a.jpg', `abcdef12${'0'.repeat(24)}`),
      entry('2', MONTH, 'a.jpg', `abcdef12${'1'.repeat(24)}`),
    ]);
    expect(names.get('1')).toBe('a_abcdef1200000000.jpg');
    expect(names.get('2')).toBe('a_abcdef1211111111.jpg');
  });

  it('nom suffixé déjà occupé : suffixe allongé au lieu d\'échouer', () => {
    const { names, anomalies } = resolveNames(
      [entry('1', MONTH, 'a.jpg', md5('b')), entry('2', MONTH, 'a.jpg', md5('c')), entry('3', MONTH, 'a_bbbbbbbb.jpg', md5('d'))],
    );
    expect(anomalies).toEqual([]);
    expect(names.get('3')).toBe('a_bbbbbbbb.jpg');
    expect(names.get('1')).toBe('a_bbbbbbbbbbbbbbbb.jpg');
    expect(names.get('2')).toBe('a_cccccccccccccccc.jpg');
  });

  it('nom sans base (« .jpg ») : l\'extension est conservée', () => {
    const { names } = disambiguateNames([entry('1', MONTH, '.jpg', md5('b')), entry('2', MONTH, '.JPG', md5('c'))]);
    expect(names.get('1')).toBe('_bbbbbbbb.jpg');
    expect(names.get('2')).toBe('_cccccccc.JPG');
  });

  it('dernier recours : anomalies collectées par resolveNames, erreur levée par la variante stricte', () => {
    const entries = [entry('1', MONTH, 'a.jpg', null), entry('2', MONTH, 'a.jpg', md5('b')), entry('3', MONTH, 'A.JPG', md5('b'))];
    const { anomalies, names } = resolveNames(entries);
    expect(anomalies.map((a) => a.id).sort()).toEqual(['1', '2', '3']);
    expect(names.size).toBe(0);
    expect(() => disambiguateNames(entries)).toThrow(/Désambiguïsation impossible/);
    expect(() => disambiguateNames([entry('1', MONTH, 'a.jpg', null), entry('2', MONTH, 'b.jpg', null)])).not.toThrow();
  });
});
