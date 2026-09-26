import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BucketObject } from '../../src/clients/types';
import {
  AnalysisContext,
  analysisExport,
  analyzeTakeoutExport,
  AnalyzedMedia,
  matchArchive,
  summarizeAnalysis,
} from '../../src/takeout/takeout-analysis';
import { analyzeExport, ExportGroup } from '../../src/takeout/takeout-validation';
import { localZipSource } from '../../src/takeout/zip-directory';
import { buildJpeg } from '../fixtures/jpeg-exif';
import { buildMp4 } from '../fixtures/mp4';
import { buildZip, ZipFileSpec } from '../fixtures/zip-builder';

const NBSP = '\u00a0';
const BOM = '\ufeff';
const ROOT = `Takeout/Google${NBSP}Photos`;
const Y2020 = `${ROOT}/Photos de${NBSP}2020`;
const ALBUM = `${ROOT}/Baptême Raphaëlle`;
const FORMATS = ['jpg', 'jpeg', 'png', 'mp4', 'mov'];

/** 2020-01-31T23:30:00Z : 23:30 à Tenerife (UTC+0 en hiver), 1er février 00:30 à Paris. */
const END_OF_MONTH = Date.UTC(2020, 0, 31, 23, 30, 0) / 1000;
const CREATION_2023 = Date.UTC(2023, 10, 14, 22, 13, 20) / 1000;
const RECEPTION_2019 = Date.UTC(2019, 5, 1, 12, 0, 0) / 1000;

const json = (taken: number | null, creation = CREATION_2023): string =>
  JSON.stringify({
    title: 'x',
    creationTime: { timestamp: String(creation), formatted: 'peu importe' },
    ...(taken === null ? {} : { photoTakenTime: { timestamp: String(taken), formatted: 'peu importe' } }),
    geoData: { latitude: 0, longitude: 0 },
  });
const meta = (media: string, taken: number | null, creation?: number): ZipFileSpec => ({ name: `${media}.supplemental-metadata.json`, data: json(taken, creation), deflate: true });

const TENERIFE = buildJpeg({ DateTimeOriginal: '2020:01:31 23:30:00' }, 2000);
const SCAN = buildJpeg({ DateTimeOriginal: '2015:07:01 09:00:00' });
const NO_EXIF = buildJpeg();
const NO_EXIF_OTHER = buildJpeg(undefined, 10);
const WHATSAPP = buildJpeg(undefined, 20);
const DUP = crypto.randomBytes(4000);
const DUP2 = crypto.randomBytes(4100);
const NEW_IN_ALBUM = crypto.randomBytes(4200);
const QUARANTINED = crypto.randomBytes(4300);
const MULTI = crypto.randomBytes(3000);
const MULTI_OTHER = crypto.randomBytes(3100);
const LIVE_IMAGE = buildJpeg({ DateTimeOriginal: '2020:02:01 00:30:00' });
const LIVE_VIDEO = buildMp4({ creationUnix: END_OF_MONTH + 1, mdatBytes: 50_000 });
const LIVE_VIDEO_WITHOUT_MVHD = buildMp4({ withoutMvhd: true });

const PART1 = buildZip([
  { name: `${Y2020}/IMG_0001.JPG`, data: TENERIFE, deflate: true },
  { name: `${Y2020}/IMG_20190817_181059.jpg`, data: NO_EXIF, deflate: true },
  { name: `${Y2020}/scan.jpg`, data: SCAN, deflate: true },
  { name: `${Y2020}/scan2.png`, data: 'pas une image', deflate: true },
  { name: `${Y2020}/IMG_0043.JPG`, data: LIVE_IMAGE, deflate: true },
  meta(`${Y2020}/IMG_0043.JPG`, END_OF_MONTH),
  { name: `${Y2020}/IMG_0043.MP4`, data: LIVE_VIDEO, deflate: true },
  { name: `${Y2020}/IMG_0044.JPG`, data: NO_EXIF_OTHER, deflate: true },
  meta(`${Y2020}/IMG_0044.JPG`, null), // creationTime seul : jamais utilisé comme date
  { name: `${Y2020}/IMG_0045.JPG`, data: LIVE_IMAGE.subarray(0, LIVE_IMAGE.length - 1), deflate: true },
  meta(`${Y2020}/IMG_0045.JPG`, END_OF_MONTH),
  { name: `${Y2020}/IMG_0045.MOV`, data: LIVE_VIDEO_WITHOUT_MVHD },
  { name: `${Y2020}/dup.jpg`, data: DUP },
  meta(`${Y2020}/dup.jpg`, END_OF_MONTH),
  { name: `${Y2020}/dup2.jpg`, data: DUP2 },
  meta(`${Y2020}/dup2.jpg`, END_OF_MONTH),
  { name: `${Y2020}/neuf.jpg`, data: NEW_IN_ALBUM },
  meta(`${Y2020}/neuf.jpg`, END_OF_MONTH),
  { name: `${Y2020}/ancienne.jpg`, data: 'ancienne', deflate: true },
  meta(`${Y2020}/ancienne.jpg`, Date.UTC(1990, 5, 1) / 1000),
  { name: `${Y2020}/IMG-20150714-WA0012.jpg`, data: WHATSAPP, deflate: true },
  meta(`${Y2020}/IMG-20150714-WA0012.jpg`, RECEPTION_2019, RECEPTION_2019 + 3600),
  { name: `${Y2020}/quar.jpg`, data: QUARANTINED },
  meta(`${Y2020}/quar.jpg`, END_OF_MONTH),
  { name: `${Y2020}/VID_multi.mp4`, data: MULTI },
  meta(`${Y2020}/VID_multi.mp4`, END_OF_MONTH),
  { name: `${Y2020}/VID_autre.mp4`, data: MULTI_OTHER },
  meta(`${Y2020}/VID_autre.mp4`, END_OF_MONTH),
]).bytes;
const PART2 = buildZip([
  meta(`${Y2020}/IMG_0001.JPG`, END_OF_MONTH), // JSON dans une autre partie que son média
  { name: `${ALBUM}/métadonnées.json`.normalize('NFD'), data: '{}' },
  { name: `${ALBUM}/dup.jpg`.normalize('NFD'), data: DUP, deflate: true },
  meta(`${ALBUM}/dup.jpg`.normalize('NFD'), END_OF_MONTH),
  { name: `${ALBUM}/dup2.jpg`.normalize('NFD'), data: DUP2, deflate: true },
  meta(`${ALBUM}/dup2.jpg`.normalize('NFD'), END_OF_MONTH),
  { name: `${ALBUM}/neuf.jpg`.normalize('NFD'), data: NEW_IN_ALBUM, deflate: true },
  meta(`${ALBUM}/neuf.jpg`.normalize('NFD'), END_OF_MONTH),
]).bytes;

const md5 = (data: Uint8Array | string): string => crypto.createHash('md5').update(data).digest('hex');
/** ETag d'un dépôt en une seule partie multipart : MD5 du MD5 binaire, suivi de « -1 ». */
const onePartEtag = (data: Uint8Array): string => `${crypto.createHash('md5').update(crypto.createHash('md5').update(data).digest()).digest('hex')}-1`;
const object = (key: string, size: number, etag: string | null): BucketObject => ({ key, size, etag, lastModified: new Date('2024-01-29T00:00:00Z') });

const ARCHIVED: BucketObject[] = [
  object('photos/2020/2020-01/IMG_0001.JPG', TENERIFE.length, `"${md5(TENERIFE)}"`),
  object('photos/2020/2020-02/IMG_0043.MP4', LIVE_VIDEO.length, `${'e'.repeat(32)}-3`),
  object('photos/2015/2015-07/scan.jpg', SCAN.length + 5, md5('autre')),
  object('photos/2020/2020-01/IMG_0044.JPG', NO_EXIF_OTHER.length, 'ab'.repeat(16)),
  object('albums/Baptême Raphaëlle/dup_12345678.jpg', DUP.length, md5(DUP)),
  object('photos/2020/2020-02/dup2.jpg', DUP2.length, md5(DUP2)),
  object('quarantaine/quar.jpg', QUARANTINED.length, md5(QUARANTINED)),
  object('photos/2020/2020-02/VID_multi.mp4', MULTI.length, onePartEtag(MULTI)),
  object('photos/2020/2020-02/VID_autre.mp4', MULTI_OTHER.length, onePartEtag(MULTI)), // multipart d'un autre contenu
  object('backups/scan2.png', 13, md5('pas une image')), // hors archive : ignoré
  object('divers/ancienne.jpg', 8, md5('ancienne')), // hors archive : ignoré
];

const KEPT_ALBUMS = ['baptême raphaëlle', 'tenerife 2026'];
const NOW = new Date('2026-09-16T12:00:00Z');

describe('analyse d\'un export Takeout local', () => {
  let dir: string;
  let group: ExportGroup;
  const originalTz = process.env.TZ;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpb-analyse-'));
    const parts = [PART1, PART2].map((bytes, i) => {
      const name = `takeout-20260806T062636Z-1-00${i + 1}.zip`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      fs.utimesSync(file, new Date('2026-08-06T06:26:36Z'), new Date('2026-08-06T06:26:36Z')); // date de fichier : jamais utilisée
      return { number: i + 1, zip: { name, location: file, size: bytes.length, open: () => localZipSource(file) } };
    });
    group = { id: '20260806T062636Z-1', parts };
  });
  afterEach(() => {
    process.env.TZ = originalTz;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function analyze(options: { timeZone?: string; archived?: BucketObject[]; zips?: ExportGroup } = {}): Promise<AnalyzedMedia[]> {
    const target = options.zips ?? group;
    const report = await analyzeExport(target, FORMATS, target.parts.length);
    expect(report.exploitable).toBe(true);
    return analyzeTakeoutExport({
      report,
      zipPaths: new Map(target.parts.map((p) => [p.zip.name, p.zip.location])),
      timeZone: options.timeZone ?? 'Europe/Paris',
      keptAlbums: KEPT_ALBUMS,
      archived: options.archived ?? ARCHIVED,
    });
  }
  const byName = (media: AnalyzedMedia[], folder: string, name: string): AnalyzedMedia => media.find((m) => m.folder === folder && m.fileName === name)!;
  const Y = 'Photos de 2020';
  const A = 'Baptême Raphaëlle';
  const summaryOf = (media: AnalyzedMedia[]): ReturnType<typeof summarizeAnalysis> => summarizeAnalysis(media, { timeZone: 'Europe/Paris', keptAlbums: KEPT_ALBUMS, now: NOW });

  it('identité par le contenu décompressé et datation tracée selon la règle révisée', async () => {
    const media = await analyze();
    expect(media).toHaveLength(20);
    const m = (name: string, folder = Y): AnalyzedMedia => byName(media, folder, name);

    // (a) Tenerife : EXIF à 0 h de photoTakenTime → heure de l'appareil, pas la conversion à Paris.
    expect(m('IMG_0001.JPG')).toMatchObject({
      md5: md5(TENERIFE), size: TENERIFE.length, takenAt: '2020-01-31T23:30:00', dateSource: 'exif', instant: END_OF_MONTH, dateWarning: null,
      metadata: { part: 'takeout-20260806T062636Z-1-002.zip' },
    });
    expect(m('IMG_0043.JPG')).toMatchObject({ takenAt: '2020-02-01T00:30:00', dateSource: 'exif', dateWarning: null });
    // (b) WhatsApp : nom 2015, photoTakenTime 2019 (proche de creationTime) → nom, alerte.
    expect(m('IMG-20150714-WA0012.jpg')).toMatchObject({ takenAt: '2015-07-14T00:00:00', dateSource: 'nom_fichier' });
    expect(m('IMG-20150714-WA0012.jpg').dateWarning).toMatch(/^discordance JSON : photoTakenTime 2019-06-01T12:00:00Z .* proche de creationTime/);
    // (c) ni nom ni EXIF : photoTakenTime converti à Paris.
    expect(m('dup.jpg')).toMatchObject({ takenAt: '2020-02-01T00:30:00', dateSource: 'json_takeout' });
    // Sans JSON : cascade 2.2.
    expect(m('IMG_20190817_181059.jpg')).toMatchObject({ takenAt: '2019-08-17T18:10:59', dateSource: 'nom_fichier' });
    expect(m('scan.jpg')).toMatchObject({ takenAt: '2015-07-01T09:00:00', dateSource: 'exif', dateDetail: 'DateTimeOriginal' });
    expect(m('scan2.png')).toMatchObject({ takenAt: null, dateSource: 'indeterminee', dateDetail: 'aucune date dans le nom ; aucune date EXIF' });
    expect(m('IMG_0044.JPG')).toMatchObject({
      takenAt: null, dateSource: 'indeterminee', dateDetail: 'photoTakenTime absent des métadonnées ; aucune date dans le nom ; aucune date EXIF',
    });
    expect(m('IMG_0043.MP4')).toMatchObject({ companion: 'IMG_0043.JPG', takenAt: '2020-02-01T00:30:01', dateSource: 'quicktime', dateWarning: null });
    expect(m('IMG_0045.MOV')).toMatchObject({ companion: 'IMG_0045.JPG', takenAt: '2020-02-01T00:30:00', dateSource: 'compagnon_live_photo' });
    expect(m('ancienne.jpg')).toMatchObject({ takenAt: '1990-06-01T02:00:00', dateSource: 'json_takeout' });
    for (const item of media) expect([null, expect.stringMatching(/^(1990|2015|2019|2020)-/)]).toContainEqual(item.takenAt);
  });

  it('même résultat quel que soit le TZ de la machine ; le fuseau choisi ne change que les dates sans date locale', async () => {
    process.env.TZ = 'Pacific/Kiritimati';
    const kiritimati = await analyze();
    process.env.TZ = 'America/Sao_Paulo';
    expect(await analyze()).toEqual(kiritimati);
    const utc = await analyze({ timeZone: 'UTC' });
    expect(byName(utc, Y, 'dup.jpg').takenAt).toBe('2020-01-31T23:30:00');
    expect(byName(utc, Y, 'IMG_0001.JPG').takenAt).toBe('2020-01-31T23:30:00');
  });

  it('doublons internes (année et album conservé, deux parties) : représentant dans l\'album', async () => {
    const media = await analyze();
    expect(byName(media, A, 'dup.jpg').duplicateOf).toBeNull();
    expect(byName(media, Y, 'dup.jpg').duplicateOf).toEqual({ part: 'takeout-20260806T062636Z-1-002.zip', path: `${ALBUM}/dup.jpg`.normalize('NFD') });
    const summary = summaryOf(media);
    expect(summary.duplicateGroups.map((g) => g.map((x) => `${x.folder}/${x.fileName}`))).toEqual([
      [`${A}/dup.jpg`, `${Y}/dup.jpg`], [`${A}/dup2.jpg`, `${Y}/dup2.jpg`], [`${A}/neuf.jpg`, `${Y}/neuf.jpg`],
    ]);
    expect(summary.duplicateCopies).toEqual({ count: 3, size: DUP.length + DUP2.length + NEW_IN_ALBUM.length });
    expect(summary.distinct.count).toBe(17);
    // Règle des albums à trancher en 4.3 : dup2 archivé sous photos/ et présent dans l'album ; neuf à envoyer, année + album.
    expect(summary.albumRule).toEqual({ archivedInPhotosAndKeptAlbum: 1, newInYearAndKeptAlbum: 1 });
  });

  it('déjà archivé : MD5, ETag multipart recalculé, non confirmable, homonymes, quarantaine seule, hors archive ignoré', async () => {
    const media = await analyze();
    const status = (name: string, folder = Y): AnalyzedMedia['archive'] => byName(media, folder, name).archive;
    expect(status('IMG_0001.JPG')).toEqual({
      status: 'deja_archive', proof: 'md5', key: 'photos/2020/2020-01/IMG_0001.JPG', candidates: ['photos/2020/2020-01/IMG_0001.JPG'], sameNameAndSize: true,
    });
    expect(status('dup.jpg', A)).toMatchObject({ status: 'deja_archive', proof: 'md5', key: 'albums/Baptême Raphaëlle/dup_12345678.jpg', sameNameAndSize: false });
    expect(status('VID_multi.mp4')).toEqual({
      status: 'deja_archive', proof: 'etag_multipart', key: 'photos/2020/2020-02/VID_multi.mp4', candidates: ['photos/2020/2020-02/VID_multi.mp4'], sameNameAndSize: true,
    });
    expect(status('VID_autre.mp4')).toMatchObject({ status: 'non_confirmable', proof: null, candidates: ['photos/2020/2020-02/VID_autre.mp4'] });
    expect(status('IMG_0043.MP4')).toMatchObject({ status: 'non_confirmable', candidates: ['photos/2020/2020-02/IMG_0043.MP4'], sameNameAndSize: true });
    expect(status('scan.jpg')).toMatchObject({ status: 'homonyme_different', sameNameAndSize: false });
    expect(status('IMG_0044.JPG')).toMatchObject({ status: 'homonyme_different', sameNameAndSize: true });
    expect(status('scan2.png')).toMatchObject({ status: 'nouveau', candidates: [] }); // l'objet de backups/ est ignoré
    expect(status('ancienne.jpg')).toMatchObject({ status: 'nouveau' }); // divers/ : hors archive
    expect(status('quar.jpg')).toMatchObject({ status: 'deja_archive', key: 'quarantaine/quar.jpg' });

    const summary = summaryOf(media);
    expect(summary.byStatus.deja_archive.count).toBe(7); // IMG_0001, dup ×2, dup2 ×2, quar, VID_multi
    expect(summary.byProof).toEqual({ md5: 6, etag_multipart: 1 });
    expect(summary.byStatus.non_confirmable.count).toBe(2);
    expect(summary.byStatus.homonyme_different.count).toBe(2);
    expect(summary.byStatus.nouveau.count).toBe(9);
    expect(summary.quarantineOnly.map((m) => [m.fileName, m.takenAt])).toEqual([['quar.jpg', '2020-02-01T00:30:00']]);
    expect(summary.sameNameAndSize).toEqual({ total: 8, deja_archive: 5, non_confirmable: 2, homonyme_different: 1, nouveau: 0 });
    expect(summary.toSend.count).toBe(10); // contenus distincts nouveaux (8) ou homonymes différents (2)
    expect(summary.bySource).toEqual({ json_takeout: 10, quicktime: 1, compagnon_live_photo: 1, nom_fichier: 2, exif: 4, indeterminee: 2 });
    expect(summary.jsonDiscordances).toBe(1);
    expect(summary.dateWarnings.map((m) => m.fileName)).toEqual(['IMG-20150714-WA0012.jpg']);
    expect(summary.suspects.map((s) => [s.media.fileName, s.reason])).toEqual([['ancienne.jpg', 'antérieure à 2000']]);
    expect(summary.livePhotos.map((l) => l.fileName)).toEqual(['IMG_0043.MP4', 'IMG_0045.MOV']);
    // IMG_0001 (EXIF Tenerife) dans 2020-01 : concordant ; photoTakenTime l'aurait mis en 2020-02 à Paris, 2020-01 en UTC.
    // dup2 ×2 et VID_multi (JSON à Paris) dans 2020-02 : concordants ; en UTC, 2020-01 : discordants. dup ×2 (albums/), quar : non comparables.
    expect(summary.monthConcordance).toEqual([
      { source: 'json_takeout', concordant: 3, discordant: 0, notComparable: 3, jsonInTimeZone: 3, jsonUtc: 0 },
      { source: 'exif', concordant: 1, discordant: 0, notComparable: 0, jsonInTimeZone: 0, jsonUtc: 1 },
    ]);
    // Noms datés avec photoTakenTime : seul le WhatsApp (2015 contre 2019).
    expect(summary.nameConcordance).toEqual({ compared: 1, inTimeZone: 0, utc: 0 });
  });

  it('CRC-32 faux dans un média : erreur explicite, aucune analyse partielle', async () => {
    const corrupt = buildZip([{ name: `${Y2020}/IMG_1.jpg`, data: NO_EXIF, deflate: true, crc32: 1 }]).bytes;
    const file = path.join(dir, 'takeout-20260810T070025Z-1-001.zip');
    fs.writeFileSync(file, corrupt);
    const zips: ExportGroup = { id: '20260810T070025Z-1', parts: [{ number: 1, zip: { name: path.basename(file), location: file, size: corrupt.length, open: () => localZipSource(file) } }] };
    await expect(analyze({ zips })).rejects.toThrow(/IMG_1\.jpg : CRC-32 invalide .* zip corrompu/);
  });

  it('exports CSV et JSON en français', async () => {
    const media = await analyze();
    const context: AnalysisContext = {
      exportId: group.id, timeZone: 'Europe/Paris', keptAlbums: KEPT_ALBUMS, destinationBucket: 'marceau-photos', inventoryCompletedAt: '2026-09-16T10:00:00.000Z',
      analyzedAt: '2026-09-16T12:00:00.000Z', zips: [{ name: 'a.zip', size: 1, etag: 'x', verification: 'md5' }],
    };
    const csv = analysisExport(media, context, 'analyse.csv');
    expect(csv.split('\n')[0]).toBe(
      `${BOM}partie;chemin;dossier;type_dossier;nom;taille_octets;md5;date_prise_de_vue;source_date;detail_date;alerte_date;json_partie;json_chemin;compagnon;doublon_de_partie;doublon_de_chemin;statut_archive;preuve_archive;cle_archivee;candidats`,
    );
    expect(csv.trim().split('\n')).toHaveLength(21);
    const parsed = JSON.parse(analysisExport(media, context, 'analyse.json', NOW));
    expect(parsed.resume.statuts_archive.deja_archive.nombre).toBe(7);
    expect(parsed.resume.deja_archive_par_preuve).toEqual({ md5: 6, etag_multipart: 1 });
    expect(parsed.resume.discordances_json).toBe(1);
    expect(parsed.alertes_date).toHaveLength(1);
    expect(parsed.medias).toHaveLength(20);
    expect(parsed.fuseau).toBe('Europe/Paris');
    expect(() => analysisExport(media, context, 'analyse.txt')).toThrow('format d\'export non reconnu');
  });
});

describe('règle « déjà archivé »', () => {
  const media = (fileName: string, content: string): AnalyzedMedia => ({
    part: 'p.zip', path: `x/${fileName}`, folder: 'Photos de 2020', folderKind: 'annee', fileName, size: content.length, md5: md5(content),
    takenAt: null, dateSource: 'indeterminee', dateDetail: null, instant: null, dateWarning: null, metadata: null, companion: null, duplicateOf: null,
    archive: { status: 'nouveau', proof: null, key: null, candidates: [], sameNameAndSize: false },
  });

  it('un homonyme de même taille à ETag multipart n\'est jamais présumé identique sans recalcul, même si un autre homonyme diffère', () => {
    const items = [media('Été.jpg', 'abcd'), media('b.jpg', 'abcd')];
    matchArchive(items, [
      object('photos/2020/2020-01/ÉTÉ.JPG'.normalize('NFD'), 4, `${'1'.repeat(32)}-2`),
      object('photos/2019/2019-01/été.jpg', 9, md5('autre contenu')),
      object('photos/2020/2020-01/b.jpg', 4, null),
    ]);
    expect(items[0]!.archive).toMatchObject({ status: 'non_confirmable', candidates: ['photos/2020/2020-01/ÉTÉ.JPG'.normalize('NFD')] });
    expect(items[1]!.archive.status).toBe('non_confirmable'); // ETag absent : non comparable non plus
  });

  it('confirmation par ETag multipart recalculé : fournie par la lecture, clé préférée au même nom', () => {
    const items = [media('v.mp4', 'abcd')];
    matchArchive(items, [object('photos/2020/2020-01/v.mp4', 4, `${'1'.repeat(32)}-2`)], new Map([['p.zip\u0000x/v.mp4', ['photos/2020/2020-01/v.mp4']]]));
    expect(items[0]!.archive).toEqual({ status: 'deja_archive', proof: 'etag_multipart', key: 'photos/2020/2020-01/v.mp4', candidates: ['photos/2020/2020-01/v.mp4'], sameNameAndSize: true });
  });

  it('même nom et même taille mais ETag MD5 différent : contenu différent ; MD5 égal mais taille différente : non confirmé', () => {
    const items = [media('c.jpg', 'abcd'), media('d.jpg', 'wxyz')];
    matchArchive(items, [object('photos/c.jpg', 4, md5('efgh')), object('photos/autre.jpg', 5, md5('wxyz'))]);
    expect(items[0]!.archive).toMatchObject({ status: 'homonyme_different', sameNameAndSize: true });
    expect(items[1]!.archive.status).toBe('nouveau');
  });
});
