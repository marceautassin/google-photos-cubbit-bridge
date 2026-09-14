jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { extractDateFromFilename } from '../../src/utils/file-utils';

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
