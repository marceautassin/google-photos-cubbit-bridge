jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { extractDateFromFilename, isSupportedFormat, parseFilenameDate } from '../../src/utils/file-utils';

/**
 * Documente le comportement ACTUEL de extractDateFromFilename sur des noms réels du bucket.
 * La date est construite en heure locale : on compare donc les composantes locales.
 * Toute évolution de la datation relève de la story 2.2.
 */
describe('extractDateFromFilename', () => {
  const composantes = (date: Date | null) =>
    date && [
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ];

  it.each([
    ['IMG_20230101_120000.jpg', [2023, 1, 1, 12, 0, 0]],
    // Préfixe PXL non reconnu : motif générique AAAAMMJJ_HHMMSS, millisecondes ignorées
    ['PXL_20240315_180000123.jpg', [2024, 3, 15, 18, 0, 0]],
    // Millisecondes ignorées
    ['VID_20250720_144314853.mp4', [2025, 7, 20, 14, 43, 14]],
    ['20170326_173149.jpg', [2017, 3, 26, 17, 31, 49]],
  ])('extrait la date de %s', (filename, attendu) => {
    expect(composantes(extractDateFromFilename(filename))).toEqual(attendu);
  });

  it.each(['IMG_0005.JPG', 'f3aba967-9be6-45bd-bdae-fe26540ea847.jpg'])(
    'renvoie null pour %s (pas de date du jour en repli)',
    (filename) => {
      expect(extractDateFromFilename(filename)).toBeNull();
    },
  );
});

describe('parseFilenameDate (heure locale nominale, sans fuseau)', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it.each([
    ['IMG_20230101_120000.jpg', '2023-01-01T12:00:00'],
    ['PXL_20240315_180000123.jpg', '2024-03-15T18:00:00'],
    ['VID_20250720_144314853.mp4', '2025-07-20T14:43:14'],
    ['20170326_173149.jpg', '2017-03-26T17:31:49'],
    ['MVIMG_20190817_181059.jpg', '2019-08-17T18:10:59'],
    ['PANO_20200101_000001.jpg', '2020-01-01T00:00:01'],
    ['00100lrPORTRAIT_00100_BURST20210614174503123_COVER.jpg', '2021-06-14T17:45:03'],
    ['IMG-20190817-WA0001.jpg', '2019-08-17T00:00:00'],
    ['2019-08-17_18-10-59.jpg', '2019-08-17T18:10:59'],
    ['2019-08-17 18.10.59.jpg', '2019-08-17T18:10:59'],
    ['Screenshot_2019-08-17-18-10-59.png', '2019-08-17T18:10:59'],
    ['2019.08.17_18.10.59.jpg', '2019-08-17T18:10:59'],
    // Captures d'écran et WhatsApp : souvent sans EXIF, le nom est leur seule source de date
    ['Screenshot_20190817-181059.png', '2019-08-17T18:10:59'],
    ['WhatsApp Image 2019-08-17 at 18.10.59.jpeg', '2019-08-17T18:10:59'],
    ["Capture d'écran 2019-08-17 à 18.10.59.png", '2019-08-17T18:10:59'],
    // Même nom avec l'accent décomposé (NFD), tel que macOS l'écrit
    ["Capture d'écran 2019-08-17 à 18.10.59.png".normalize('NFD'), '2019-08-17T18:10:59'],
    // Réveillon : une conversion en instant pourrait changer l'année selon le fuseau
    ['IMG_20191231_233000.jpg', '2019-12-31T23:30:00'],
    // Heure inexistante à Paris (passage à l'heure d'été le 31/03/2019 à 2 h) : conservée telle quelle
    ['IMG_20190331_023000.jpg', '2019-03-31T02:30:00'],
    // Date ancienne : extraite (elle sera signalée suspecte, pas rejetée)
    ['IMG_19950610_101010.jpg', '1995-06-10T10:10:10'],
    // Première occurrence invalide (bloc de 8 chiffres suivi de 14 chiffres) : l'occurrence suivante est essayée
    ['16587232_20190101235959.jpg', '2019-01-01T23:59:59'],
    ['12345678_20190817123456.jpg', '2019-08-17T12:34:56'],
  ])('%s → %s', (filename, attendu) => {
    for (const tz of ['UTC', 'Europe/Paris', 'Pacific/Kiritimati', 'America/Sao_Paulo']) {
      process.env.TZ = tz;
      expect(parseFilenameDate(filename)).toBe(attendu);
    }
  });

  it.each([
    'IMG_0005.JPG',
    'f3aba967-9be6-45bd-bdae-fe26540ea847.jpg',
    'IMG_20190231_120000.jpg', // 31 février : refusé au lieu d'être reporté en mars
    'IMG_20191301_120000.jpg', // mois 13
    'IMG_20190101_250000.jpg', // 25 h
    'DSC_12345678901234.jpg', // année 1234
    // Noms réels du bucket sans date
    '1011461_10153003702045297_1458414453_n.jpg',
    'E77264EA-1F74-4BA4-AB8B-4F11DA9605DC-1250-000001027C05243C.jpeg',
    '6762a05117898970f765091d137b844d.jpg',
    '71a4df33b83c437449f4b746d5c7b8ed.jpg',
    '9507eb91-09a2-4dd0-b185-05a329d2b319.jpg',
    'IMG_0044.JPG',
    'IMG_0014.MP4',
    'altAtGP5dnmN7jTdZ7kTWLM_kZaGIhTxtFek7064gf2UJxQ_jpg.jpg',
    'photo(1) (1).JPG',
    // Faux positifs : chiffres collés à des lettres, ou suivis de trop de chiffres
    'hash19991231235959abc.jpg',
    'received_201908171234567890.jpeg',
    // Le tiret n'isole pas un bloc collé à une lettre ou suivi de trop de chiffres
    'hash19991231-235959abc.jpg',
    'received_20190817-1234567890.jpeg',
  ])('renvoie null pour %s', (filename) => {
    expect(parseFilenameDate(filename)).toBeNull();
  });

  it("extractDateFromFilename garde son contrat (Date locale, bornée à l'année courante + 1)", () => {
    expect(extractDateFromFilename('IMG_20190231_120000.jpg')).toBeNull();
    expect(extractDateFromFilename('IMG_19500101_120000.jpg')).toBeNull();
    expect(extractDateFromFilename(`IMG_${new Date().getFullYear() + 5}0101_120000.jpg`)).toBeNull();
    expect(extractDateFromFilename('2019-08-17_18-10-59.jpg')?.getMonth()).toBe(7);
  });
});

describe('isSupportedFormat (même règle que le plan de réparation)', () => {
  it.each([
    ['a.JPG', ['jpg', '.MP4'], true],
    ['clip.mp4', ['jpg', '.MP4'], true],
    ['s.jpg ', ['jpg'], true],
    ['photo.jpg.bak', ['jpg'], false],
    ['.jpg', ['jpg'], false],
    ['README', ['jpg'], false],
    ['backup/photos/2021/x.jpg/', ['jpg'], false],
    ['backup/photos/2021/y.JPG', ['jpg'], true],
  ])('%s avec %j → %s', (filename, formats, attendu) => {
    expect(isSupportedFormat(filename, formats)).toBe(attendu);
  });
});
