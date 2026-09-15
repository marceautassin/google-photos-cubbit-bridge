import { formatBytes, formatDate, formatNumber } from '../../src/utils/format';

/** Séparateur de milliers français : espace fine insécable. */
const NNBSP = String.fromCharCode(0x202f);

describe('formatNumber', () => {
  it('sépare les milliers à la française', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(17875)).toBe(`17${NNBSP}875`);
    expect(formatNumber(1234567)).toBe(`1${NNBSP}234${NNBSP}567`);
  });
});

describe('formatBytes', () => {
  it('affiche les petites tailles en octets', () => {
    expect(formatBytes(0)).toBe('0 octet');
    expect(formatBytes(1)).toBe('1 octet');
    expect(formatBytes(512)).toBe('512 octets');
    expect(formatBytes(1023)).toBe(`1${NNBSP}023 octets`);
  });

  it('utilise Ko, Mo, Go, To avec une virgule décimale', () => {
    expect(formatBytes(1024)).toBe('1 Ko');
    expect(formatBytes(1536)).toBe('1,5 Ko');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 Mo');
    expect(formatBytes(2.34 * 1024 ** 3)).toBe('2,3 Go');
    expect(formatBytes(1024 ** 4)).toBe('1 To');
  });

  it('passe à l\'unité suivante quand l\'arrondi atteint 1024', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 Mo');
    expect(formatBytes(1024 ** 3 - 1)).toBe('1 Go');
    expect(formatBytes(1024 * 1023)).toBe(`1${NNBSP}023 Ko`);
  });

  it('renvoie un libellé sûr pour une valeur négative, NaN ou infinie', () => {
    expect(formatBytes(NaN)).toBe('taille inconnue');
    expect(formatBytes(-1)).toBe('taille inconnue');
    expect(formatBytes(Infinity)).toBe('taille inconnue');
  });

  it('plafonne à l\'unité la plus grande', () => {
    expect(formatBytes(2048 * 1024 ** 5)).toBe(`2${NNBSP}048 Po`);
  });
});

describe('formatDate', () => {
  it('écrit le mois en toutes lettres', () => {
    expect(formatDate(new Date(2026, 8, 15, 8, 5))).toMatch(/^15 septembre 2026.*08:05$/);
  });
});
