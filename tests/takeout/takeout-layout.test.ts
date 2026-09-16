import { classifyEntry, comparableName, folderKind, livePhotoCompanion, metadataMatch, pairMetadata } from '../../src/takeout/takeout-layout';

const NBSP = '\u00a0';
const FORMATS = ['jpg', 'jpeg', 'png', 'mp4', 'mov', 'heic'];

describe('comparableName', () => {
  it('ramène l\'espace insécable à l\'espace normal et normalise en NFC', () => {
    expect(comparableName(`Google${NBSP}Photos`)).toBe('Google Photos');
    expect(comparableName('Baptême'.normalize('NFD'))).toBe('Baptême'.normalize('NFC'));
  });
});

describe('folderKind', () => {
  it.each([
    [`Photos de${NBSP}2020`, { kind: 'annee', year: 2020 }],
    ['Photos de 2019', { kind: 'annee', year: 2019 }],
    ['Photos from 2021', { kind: 'annee', year: 2021 }],
    ['2019 à imprimer', { kind: 'album' }],
    ['tenerife 2026', { kind: 'album' }],
    ['Photos de famille', { kind: 'album' }],
  ])('%s → %j', (folder, expected) => {
    expect(folderKind(folder)).toEqual(expected);
  });
});

describe('classifyEntry', () => {
  const root = `Takeout/Google${NBSP}Photos`;
  it.each([
    [`${root}/Photos de${NBSP}2020/IMG_20200104_154653.jpg`, { kind: 'media', folder: 'Photos de 2020', fileName: 'IMG_20200104_154653.jpg' }],
    ['Takeout/Google Photos/Photos from 2020/IMG_0043.MP4', { kind: 'media', folder: 'Photos from 2020', fileName: 'IMG_0043.MP4' }],
    [`${root}/Baptême Raphaëlle/IMG_1.jpeg`.normalize('NFD'), { kind: 'media', folder: 'Baptême Raphaëlle', fileName: 'IMG_1.jpeg' }],
    [`${root}/Photos de${NBSP}2020/IMG_1.jpg.supplemental-metadata.json`, { kind: 'json', folder: 'Photos de 2020', fileName: 'IMG_1.jpg.supplemental-metadata.json' }],
    [`${root}/2019 à imprimer/métadonnées.json`, { kind: 'metadonnees_album', folder: '2019 à imprimer' }],
    [`${root}/2019 à imprimer/métadonnées.json`.normalize('NFD'), { kind: 'metadonnees_album', folder: '2019 à imprimer' }],
    [`${root}/Trip/metadata.json`, { kind: 'metadonnees_album', folder: 'Trip' }],
    [`${root}/Photos de${NBSP}2020/`, { kind: 'repertoire' }],
    ['Takeout/archive_browser.html', { kind: 'non_reconnu', reason: 'hors de Takeout/Google Photos/' }],
    ['Takeout/Google Photos/user-generated-memory-titles.json', { kind: 'non_reconnu', reason: 'fichier à la racine de Takeout/Google Photos/' }],
    [`${root}/Album/sous/IMG_1.jpg`, { kind: 'non_reconnu', reason: 'sous-dossier inattendu dans un dossier d\'année ou d\'album' }],
    [`${root}/Photos de 2020/notes.txt`, { kind: 'non_reconnu', reason: 'extension non prise en charge (sync.supportedFormats)', folder: 'Photos de 2020', fileName: 'notes.txt' }],
  ])('%s', (entryPath, expected) => {
    expect(classifyEntry(entryPath, FORMATS)).toEqual(expected);
  });

  it('suit sync.supportedFormats (règle unique isSupportedFormat)', () => {
    expect(classifyEntry('Takeout/Google Photos/A/x.heic', FORMATS).kind).toBe('media');
    expect(classifyEntry('Takeout/Google Photos/A/x.heic', ['jpg']).kind).toBe('non_reconnu');
  });
});

describe('metadataMatch : table des variantes de nom des JSON (nom complet du média)', () => {
  const LONG = 'Screenshot_20190523-145630_Samsung Internet_avec_un_nom_de_fichier_très_long_jusqu_a_131_caracteres.jpg';
  it.each([
    // [JSON, média, apparié]
    ['IMG_20200104_154653.jpg.supplemental-metadata.json', 'IMG_20200104_154653.jpg', true], // forme observée
    [`${LONG}.supplemental-metadata.json`, LONG, true], // noms longs : aucune troncature observée
    ['IMG_20200104_154653.jpg.supplemental-metada.json', 'IMG_20200104_154653.jpg', true], // suffixe tronqué, nom intact
    ['IMG_1.jpg.supp.json', 'IMG_1.jpg', true],
    ['IMG_1234.jpg.json', 'IMG_1234.jpg', true], // ancien format
    ['IMG_1234.jpg.supplemental-metadata(1).json', 'IMG_1234(1).jpg', true], // doublon (non observé, par précaution)
    ['IMG_1234(1).jpg.supplemental-metadata.json', 'IMG_1234(1).jpg', true],
    ['IMG_1234.jpg.supplemental-metadata.json', 'IMG_1234(1).jpg', false], // numéro de doublon différent
    ['IMG_1234.jpg.supplemental-metadata(1).json', 'IMG_1234.jpg', false],
    ['Screenshot_20190523-145630_Samsung Intern.json', 'Screenshot_20190523-145630_Samsung Internet_B.jpg', false], // troncature du nom : non gérée
    [`${LONG.slice(0, 46)}.json`, LONG, false],
    ['IMG_1.jpg.supplementalXmetadata.json', 'IMG_1.jpg', false],
    ['IMG_1.jpgx.supplemental-metadata.json', 'IMG_1.jpg', false],
    ['IMG_12.jpg.supplemental-metadata.json', 'IMG_1.jpg', false],
    ['IMG_1.supplemental-metadata.json', 'IMG_1.jpg', false], // sans extension : dernier recours de pairMetadata seulement
    ['IMG_1234.jpg.supplemental-metadata.json', 'IMG_1234.JPG', false], // casse préservée par Google
    ['IMG_1.jpg', 'IMG_1.jpg', false],
  ])('%s ↔ %s → %s', (json, media, expected) => {
    expect(metadataMatch(json, media)).toBe(expected);
  });
});

describe('pairMetadata', () => {
  it('apparie un pour un par nom complet ; un JSON sans média est orphelin', () => {
    const media = ['IMG_1234.jpg', 'IMG_1234(1).jpg', 'IMG_1.jpg', 'IMG_12.jpg'];
    const json = ['IMG_1234.jpg.supplemental-metadata.json', 'IMG_1234.jpg.supplemental-metadata(1).json', 'IMG_1.jpg.supplemental-metadata.json', 'IMG_12.jpg.supplemental-metadata.json', 'orphelin.jpg.supplemental-metadata.json'];
    const { pairs, unpairedJson, ambiguousJson } = pairMetadata(media, json, [...media, ...json]);
    expect(Object.fromEntries([...pairs].map(([m, p]) => [m, [p.json, p.quality]]))).toEqual({
      'IMG_1234.jpg': ['IMG_1234.jpg.supplemental-metadata.json', 'complet'],
      'IMG_1234(1).jpg': ['IMG_1234.jpg.supplemental-metadata(1).json', 'complet'],
      'IMG_1.jpg': ['IMG_1.jpg.supplemental-metadata.json', 'complet'],
      'IMG_12.jpg': ['IMG_12.jpg.supplemental-metadata.json', 'complet'],
    });
    expect(unpairedJson).toEqual(['orphelin.jpg.supplemental-metadata.json']);
    expect(ambiguousJson).toEqual([]);
  });

  it('le JSON le plus précis l\'emporte quand deux visent le même média', () => {
    const files = ['IMG_1234.jpg', 'IMG_1234.jpg.json', 'IMG_1234.jpg.supplemental-metadata.json'];
    const { pairs, unpairedJson } = pairMetadata(['IMG_1234.jpg'], files.slice(1), files);
    expect(pairs.get('IMG_1234.jpg')).toEqual({ json: 'IMG_1234.jpg.supplemental-metadata.json', quality: 'complet' });
    expect(unpairedJson).toEqual(['IMG_1234.jpg.json']);
  });

  it.each([
    ['9507eb91-0000-4000-8000-000000000000'],
    ['f3aba967-1111-4222-8333-944445555666'],
  ])('dernier recours : JSON sans extension de média pour %s.jpg', (uuid) => {
    const files = [`${uuid}.jpg`, `${uuid}.supplemental-metadata.json`, 'IMG_1.jpg', 'IMG_1.jpg.supplemental-metadata.json'];
    const { pairs, unpairedJson, ambiguousJson } = pairMetadata([`${uuid}.jpg`, 'IMG_1.jpg'], [files[1]!, files[3]!], files);
    expect(pairs.get(`${uuid}.jpg`)).toEqual({ json: `${uuid}.supplemental-metadata.json`, quality: 'sans_extension' });
    expect(unpairedJson).toEqual([]);
    expect(ambiguousJson).toEqual([]);
  });

  it('dernier recours avec suffixe de doublon', () => {
    const files = ['abc(1).jpg', 'abc.supplemental-metadata(1).json'];
    expect(pairMetadata(['abc(1).jpg'], [files[1]!], files).pairs.get('abc(1).jpg')?.quality).toBe('sans_extension');
  });

  it.each([
    ['deux médias de même radical', ['IMG_1.jpg', 'IMG_1.mp4'], ['IMG_1.jpg', 'IMG_1.mp4']],
    ['un fichier non pris en charge et une vidéo', ['IMG_1.MP4'], ['IMG_1.HEIC', 'IMG_1.MP4']],
    ['un média déjà apparié et une vidéo orpheline', ['IMG_1.jpg', 'IMG_1.mp4'], ['IMG_1.jpg', 'IMG_1.jpg.supplemental-metadata.json', 'IMG_1.mp4']],
    ['un seul porteur qui n\'est pas un média', [], ['IMG_1.HEIC']],
  ])('dernier recours refusé, JSON ambigu : %s', (_label, media, others) => {
    const json = ['IMG_1.supplemental-metadata.json', ...others.filter((f) => f.endsWith('.json'))];
    const files = [...new Set([...others, ...json])];
    const { pairs, ambiguousJson } = pairMetadata(media, json, files);
    expect(ambiguousJson).toEqual(['IMG_1.supplemental-metadata.json']);
    expect([...pairs.values()].some((p) => p.quality === 'sans_extension')).toBe(false);
  });

  it('dernier recours sans aucun porteur : JSON orphelin, pas ambigu', () => {
    const { unpairedJson, ambiguousJson } = pairMetadata(['a.jpg'], ['zzz.supplemental-metadata.json'], ['a.jpg', 'zzz.supplemental-metadata.json']);
    expect(unpairedJson).toEqual(['zzz.supplemental-metadata.json']);
    expect(ambiguousJson).toEqual([]);
  });
});

describe('livePhotoCompanion', () => {
  const files = ['IMG_0043.JPG', 'IMG_0043.JPG.supplemental-metadata.json', 'IMG_0043.MP4'];
  it('vidéo sans JSON dont le radical est celui d\'une seule image appariée', () => {
    expect(livePhotoCompanion('IMG_0043.MP4', files, new Set(['IMG_0043.JPG']))).toBe('IMG_0043.JPG');
    expect(livePhotoCompanion('IMG_7.mov', ['IMG_7.HEIC', 'IMG_7.mov'], new Set(['IMG_7.HEIC']))).toBe('IMG_7.HEIC');
  });
  it.each([
    ['image non appariée', 'IMG_0043.MP4', files, new Set<string>()],
    ['vidéo déjà appariée', 'IMG_0043.MP4', files, new Set(['IMG_0043.JPG', 'IMG_0043.MP4'])],
    ['pas une vidéo', 'IMG_0043.JPG', files, new Set<string>()],
    ['deux porteurs du radical', 'IMG_0043.MP4', [...files, 'IMG_0043.png'], new Set(['IMG_0043.JPG', 'IMG_0043.png'])],
    ['compagnon vidéo', 'IMG_9.MP4', ['IMG_9.MP4', 'IMG_9.mov'], new Set(['IMG_9.mov'])],
    ['aucun compagnon', 'IMG_0044.MP4', ['IMG_0044.MP4'], new Set<string>()],
    ['image qui n\'est pas une Live Photo', 'clip.mp4', ['clip.mp4', 'clip.png'], new Set(['clip.png'])],
  ])('refus : %s', (_label, video, all, paired) => {
    expect(livePhotoCompanion(video, all, paired)).toBeNull();
  });
});
