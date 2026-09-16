import { analyzeExport, groupExports, ZipRef } from '../../src/takeout/takeout-validation';
import { remoteZipSource } from '../../src/takeout/zip-directory';
import { buildZip, FakeRangeReader, ZipFileSpec } from '../fixtures/zip-builder';

const NBSP = '\u00a0';
const FORMATS = ['jpg', 'jpeg', 'png', 'mp4', 'mov'];
const ROOT = `Takeout/Google${NBSP}Photos`;
const Y2020 = `${ROOT}/Photos de${NBSP}2020`;

/** Zips distants en mémoire, lus par un faux lecteur par plages. */
function remote(parts: Record<string, Uint8Array>): { zips: ZipRef[]; reader: FakeRangeReader } {
  const reader = new FakeRangeReader('marceau-photos', new Map(Object.entries(parts).map(([name, bytes]) => [`backups/${name}`, bytes])));
  const zips = Object.entries(parts).map(([name, bytes]) => ({
    name,
    location: `marceau-photos/backups/${name}`,
    size: bytes.length,
    open: async () => remoteZipSource(reader, `backups/${name}`, bytes.length),
  }));
  return { zips, reader };
}

const file = (name: string, size = 3): ZipFileSpec => ({ name, data: new Uint8Array(size) });

/** Export réaliste en deux parties : un JSON dans une autre partie que son média, formes NFD et espace normal mêlées. */
const PART1 = buildZip([
  file(`${Y2020}/IMG_20200104_154653.jpg`, 5000),
  file(`${Y2020}/IMG_20200104_154653.jpg.supplemental-metadata.json`),
  file(`${Y2020}/IMG_1234(1).jpg`, 50),
  file(`${Y2020}/f3aba967-1111-4222-8333-944445555666.jpg`, 10),
  file(`${Y2020}/f3aba967-1111-4222-8333-944445555666.supplemental-metadata.json`), // JSON sans extension de média
  file(`${Y2020}/sans-json.jpg`, 5),
  file(`${Y2020}/IMG_0050.JPG`, 20),
  file(`${Y2020}/IMG_0050.JPG.supplemental-metadata.json`),
  file(`${ROOT}/Baptême Raphaëlle/métadonnées.json`),
  file(`${ROOT}/Baptême Raphaëlle/IMG_20240601_101010.jpg`.normalize('NFD'), 70),
  file(`${ROOT}/Photos de${NBSP}2020/`),
]).bytes;
const PART2 = buildZip(
  [
    file('Takeout/Google Photos/Photos de 2020/IMG_1234.jpg.supplemental-metadata(1).json'), // espace normal
    file(`${ROOT}/Baptême Raphaëlle/IMG_20240601_101010.jpg.supplemental-me.json`),
    file(`${ROOT}/Photos from 2019/VID_0001.mp4`, 400),
    file(`${ROOT}/Photos from 2019/VID_0001.mp4.json`),
    file(`${ROOT}/Photos from 2019/orphelin.jpg.supplemental-metadata.json`),
    file(`${ROOT}/Photos from 2019/notes.txt`),
    file(`${ROOT}/tenerife 2026/IMG_0043.mov`, 30),
    file(`${ROOT}/Photos de 2020/IMG_0050.MP4`.normalize('NFD'), 40), // vidéo de Live Photo, autre partie
  ],
  { zip64: true },
).bytes;

describe('groupExports', () => {
  it('regroupe les parties par horodatage et numéro d\'export, triées ; un nom non conforme forme un export seul', () => {
    const ref = (name: string): ZipRef => ({ name, location: name, size: 1, open: async () => ({ size: 1, read: async () => new Uint8Array() }) });
    const groups = groupExports([
      ref('takeout-20260806T062636Z-1-002.zip'),
      ref('takeout-20260810T070025Z-1-001.zip'),
      ref('takeout-20260806T062636Z-1-001.zip'),
      ref('photos.zip'),
    ]);
    expect(groups.map((g) => [g.id, g.parts.map((p) => [p.number, p.zip.name])])).toEqual([
      ['20260806T062636Z-1', [[1, 'takeout-20260806T062636Z-1-001.zip'], [2, 'takeout-20260806T062636Z-1-002.zip']]],
      ['20260810T070025Z-1', [[1, 'takeout-20260810T070025Z-1-001.zip']]],
      ['photos.zip', [[1, 'photos.zip']]],
    ]);
  });
});

describe('analyzeExport', () => {
  it('reconnaît le format réel sur plusieurs parties et apparie les JSON toutes parties confondues', async () => {
    const { zips, reader } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-002.zip': PART2 });
    const [group] = groupExports(zips);
    const report = await analyzeExport(group!, FORMATS);

    expect(report.problems).toEqual([]);
    expect(report.exploitable).toBe(true);
    expect(report.parts.map((p) => [p.name, p.entryCount, p.zip64, p.error])).toEqual([
      ['takeout-20260806T062636Z-1-001.zip', 11, false, null],
      ['takeout-20260806T062636Z-1-002.zip', 8, true, null],
    ]);
    expect(report.parts.reduce((s, p) => s + p.bytesRead, 0)).toBe(reader.bytesServed);
    expect(report.folders).toEqual([
      { name: 'Photos from 2019', kind: 'annee', year: 2019, mediaCount: 1, mediaSize: 400, albumMetadata: false, withoutMetadata: [], livePhotoVideos: [] },
      {
        name: 'Photos de 2020',
        kind: 'annee',
        year: 2020,
        mediaCount: 6,
        mediaSize: 5125,
        albumMetadata: false,
        withoutMetadata: ['sans-json.jpg'],
        livePhotoVideos: [{ video: 'IMG_0050.MP4', image: 'IMG_0050.JPG' }],
      },
      { name: 'Baptême Raphaëlle', kind: 'album', year: null, mediaCount: 1, mediaSize: 70, albumMetadata: true, withoutMetadata: [], livePhotoVideos: [] },
      { name: 'tenerife 2026', kind: 'album', year: null, mediaCount: 1, mediaSize: 30, albumMetadata: false, withoutMetadata: ['IMG_0043.mov'], livePhotoVideos: [] },
    ]);
    const img1234 = report.media.find((m) => m.fileName === 'IMG_1234(1).jpg')!;
    expect(img1234).toEqual({
      part: 'takeout-20260806T062636Z-1-001.zip',
      path: `${Y2020}/IMG_1234(1).jpg`,
      folder: 'Photos de 2020',
      fileName: 'IMG_1234(1).jpg',
      size: 50,
      metadata: { part: 'takeout-20260806T062636Z-1-002.zip', path: 'Takeout/Google Photos/Photos de 2020/IMG_1234.jpg.supplemental-metadata(1).json', quality: 'complet' },
      companion: null,
    });
    expect(report.media.find((m) => m.fileName.startsWith('f3aba967'))!.metadata).toEqual({
      part: 'takeout-20260806T062636Z-1-001.zip',
      path: `${Y2020}/f3aba967-1111-4222-8333-944445555666.supplemental-metadata.json`,
      quality: 'sans_extension',
    });
    expect(report.media.find((m) => m.fileName === 'IMG_0050.MP4')).toMatchObject({ metadata: null, companion: 'IMG_0050.JPG' });
    expect(report.warnings).toEqual(['1 JSON sans média correspondant : partie possiblement manquante (son média serait dans une autre partie)']);
    expect(report.partCountConfirmed).toBe(false);
    expect(report.unrecognized).toEqual([
      { part: 'takeout-20260806T062636Z-1-002.zip', path: `${ROOT}/Photos from 2019/notes.txt`, reason: 'extension non prise en charge (sync.supportedFormats)' },
      { part: 'takeout-20260806T062636Z-1-002.zip', path: `${ROOT}/Photos from 2019/orphelin.jpg.supplemental-metadata.json`, reason: 'métadonnées sans média correspondant' },
    ]);
  });

  it('non exploitable : partie manquante', async () => {
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-003.zip': PART2 });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.exploitable).toBe(false);
    expect(report.problems).toEqual(['partie(s) manquante(s) : 002']);
  });

  it('non exploitable : partie illisible (zip tronqué), les autres parties restent analysées', async () => {
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-002.zip': PART2.slice(0, PART2.length - 30) });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.exploitable).toBe(false);
    expect(report.problems).toEqual([
      'partie takeout-20260806T062636Z-1-002.zip illisible : fin du répertoire central (EOCD) introuvable : zip tronqué ou corrompu',
    ]);
    expect(report.parts[1]!.entryCount).toBeNull();
    expect(report.parts[1]!.bytesRead).toBeGreaterThan(0); // octets lus comptés même en échec
    expect(report.media).toHaveLength(6);
  });

  it('non exploitable : même chemin dans deux parties (espace insécable ou normal indifférent)', async () => {
    const dup = buildZip([file('Takeout/Google Photos/Photos de 2020/IMG_1234(1).jpg', 50)]).bytes;
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-002.zip': dup });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.problems).toEqual(['chemin présent 2 fois dans l\'export : Takeout/Google Photos/Photos de 2020/IMG_1234(1).jpg']);
  });

  it('non exploitable : aucun média sous Takeout/Google Photos/', async () => {
    const { zips } = remote({ 'takeout-20260810T070025Z-1-001.zip': buildZip([file('Takeout/archive_browser.html')]).bytes });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.problems).toEqual(['partie takeout-20260810T070025Z-1-001.zip sans aucun média', 'aucun média reconnu sous Takeout/Google Photos/']);
    expect(report.unrecognized).toEqual([
      { part: 'takeout-20260810T070025Z-1-001.zip', path: 'Takeout/archive_browser.html', reason: 'hors de Takeout/Google Photos/' },
    ]);
  });

  it('export du 10 août : une photo, son JSON et les métadonnées de l\'album « 2019 à imprimer »', async () => {
    const album = `${ROOT}/2019 à imprimer`;
    const bytes = buildZip([file(`${album}/IMG_20190801_120000.jpg`, 600), file(`${album}/IMG_20190801_120000.jpg.supplemental-metadata.json`), file(`${album}/métadonnées.json`)]).bytes;
    const { zips } = remote({ 'takeout-20260810T070025Z-1-001.zip': bytes });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.exploitable).toBe(true);
    expect(report.folders).toEqual([
      { name: '2019 à imprimer', kind: 'album', year: null, mediaCount: 1, mediaSize: 600, albumMetadata: true, withoutMetadata: [], livePhotoVideos: [] },
    ]);
  });

  it('non exploitable : partie sans aucune entrée (zip vide)', async () => {
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-002.zip': buildZip([]).bytes });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.parts[1]!.entryCount).toBe(0);
    expect(report.problems).toEqual(['partie takeout-20260806T062636Z-1-002.zip sans aucune entrée']);
  });

  it('non exploitable : partie qui ne contient que des métadonnées', async () => {
    const onlyJson = buildZip([file(`${Y2020}/IMG_9.jpg.supplemental-metadata.json`)]).bytes;
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-002.zip': onlyJson });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.problems).toEqual(['partie takeout-20260806T062636Z-1-002.zip sans aucun média']);
  });

  it('non exploitable : JSON ambigu (dernier recours refusé)', async () => {
    const bytes = buildZip([file(`${Y2020}/IMG_1.jpg`), file(`${Y2020}/IMG_1.mp4`), file(`${Y2020}/IMG_1.supplemental-metadata.json`)]).bytes;
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': bytes });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.problems).toEqual(['JSON ambigu (plusieurs fichiers portent ce nom) : Photos de 2020/IMG_1.supplemental-metadata.json']);
    expect(report.media.every((m) => m.metadata === null)).toBe(true);
  });

  it('nombre de parties : --parties différent → non exploitable ; égal → confirmé ; absent → non confirmé', async () => {
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': PART1, 'takeout-20260806T062636Z-1-002.zip': PART2 });
    const group = groupExports(zips)[0]!;
    const three = await analyzeExport(group, FORMATS, 3);
    expect(three.problems).toEqual(['2 partie(s) présente(s), 3 attendue(s) (--parties)']);
    expect(three.partCountConfirmed).toBe(false);
    const two = await analyzeExport(group, FORMATS, 2);
    expect([two.exploitable, two.partCountConfirmed]).toEqual([true, true]);
    expect((await analyzeExport(group, FORMATS)).partCountConfirmed).toBe(false);
  });

  it('avertit quand la dernière partie est de taille pleine (≥ 90 % de la plus grosse)', async () => {
    const big = (n: number): Uint8Array => buildZip([file(`${Y2020}/IMG_${n}.jpg`, 10_000), file(`${Y2020}/IMG_${n}.jpg.supplemental-metadata.json`)]).bytes;
    const { zips } = remote({ 'takeout-20260806T062636Z-1-001.zip': big(1), 'takeout-20260806T062636Z-1-002.zip': big(2) });
    const report = await analyzeExport(groupExports(zips)[0]!, FORMATS);
    expect(report.exploitable).toBe(true);
    expect(report.warnings).toEqual(['la dernière partie (002) est de taille pleine : une partie suivante peut manquer']);
  });
});
