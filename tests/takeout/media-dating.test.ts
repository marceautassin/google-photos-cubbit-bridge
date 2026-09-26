import { ExifDetails } from '../../src/inventory/dating';
import { dateMedia, LIVE_PHOTO_MAX_GAP_SECONDS, MediaDateEvidence, parsePhotoTakenTime, TakenTime } from '../../src/takeout/media-dating';
import { Mp4CreationTimeProbe } from '../../src/takeout/mp4-creation-time';
import { checkTimeZone, instantToLocalDateTime, instantWithOffset } from '../../src/utils/local-date-time';
import { buildJpeg } from '../fixtures/jpeg-exif';
import { parseExifDetails } from '../../src/inventory/dating';
import { buildMp4 } from '../fixtures/mp4';

/** 2020-01-31T23:30:00Z : 1er février 00:30 à Paris, 31 janvier en UTC. */
const END_OF_MONTH = Date.UTC(2020, 0, 31, 23, 30, 0) / 1000;

describe('instant → heure locale nominale d\'un fuseau', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it.each(['UTC', 'Europe/Paris', 'Pacific/Kiritimati', 'America/Sao_Paulo'])('indépendant du TZ de la machine (%s)', (tz) => {
    process.env.TZ = tz;
    expect(instantToLocalDateTime(END_OF_MONTH, 'Europe/Paris')).toBe('2020-02-01T00:30:00');
    expect(instantToLocalDateTime(END_OF_MONTH, 'UTC')).toBe('2020-01-31T23:30:00');
    expect(instantToLocalDateTime(END_OF_MONTH, 'Atlantic/Canary')).toBe('2020-01-31T23:30:00');
  });

  it('heure d\'été : +2 h à Paris en juillet, passage du 29 mars 2020', () => {
    expect(instantToLocalDateTime(Date.UTC(2020, 6, 14, 12, 0, 0) / 1000, 'Europe/Paris')).toBe('2020-07-14T14:00:00');
    expect(instantToLocalDateTime(Date.UTC(2020, 2, 29, 0, 59, 59) / 1000, 'Europe/Paris')).toBe('2020-03-29T01:59:59');
    expect(instantToLocalDateTime(Date.UTC(2020, 2, 29, 1, 0, 0) / 1000, 'Europe/Paris')).toBe('2020-03-29T03:00:00');
    expect(instantToLocalDateTime(Date.UTC(1999, 11, 31, 23, 0, 0) / 1000, 'Europe/Paris')).toBe('2000-01-01T00:00:00');
  });

  it('décalage fixe (OffsetTimeOriginal)', () => {
    expect(instantWithOffset(END_OF_MONTH, '+05:30')).toBe('2020-02-01T05:00:00');
    expect(instantWithOffset(END_OF_MONTH, '-00:00')).toBe('2020-01-31T23:30:00');
    expect(instantWithOffset(END_OF_MONTH, '+25:00')).toBeNull();
    expect(instantWithOffset(END_OF_MONTH, 'Europe/Paris')).toBeNull();
  });

  it('EXIF : DateTimeOriginal et OffsetTimeOriginal lus sur les octets', async () => {
    await expect(parseExifDetails(buildJpeg({ DateTimeOriginal: '2020:01:31 23:30:00', OffsetTimeOriginal: '+00:00', ModifyDate: '2024:01:01 00:00:00' }))).resolves.toEqual({
      best: { takenAt: '2020-01-31T23:30:00', tag: 'DateTimeOriginal' }, dateTimeOriginal: '2020-01-31T23:30:00', offsetTimeOriginal: '+00:00',
    });
    await expect(parseExifDetails(buildJpeg({ ModifyDate: '2024:01:01 00:00:00' }))).resolves.toEqual({
      best: { takenAt: '2024-01-01T00:00:00', tag: 'ModifyDate' }, dateTimeOriginal: null, offsetTimeOriginal: null,
    });
  });

  it('fuseau inconnu : erreur en français', () => {
    expect(() => checkTimeZone('Europe/Pariss')).toThrow('fuseau horaire inconnu « Europe/Pariss »');
    expect(() => checkTimeZone('America/Sao_Paulo')).not.toThrow();
  });
});

describe('photoTakenTime', () => {
  it('lit le timestamp de prise de vue ; creationTime seulement conservé pour les alertes', () => {
    const json = JSON.stringify({
      title: 'IMG_0001.JPG',
      creationTime: { timestamp: '1700000000', formatted: '14 nov. 2023, 22:13:20 UTC' },
      photoTakenTime: { timestamp: '1580513400', formatted: '31 janv. 2020, 23:30:00 UTC' },
    });
    expect(parsePhotoTakenTime(json)).toEqual({ instant: 1580513400, creation: 1700000000, problem: null });
    expect(parsePhotoTakenTime(JSON.stringify({ photoTakenTime: { timestamp: 1580513400 } }))).toEqual({ instant: 1580513400, creation: null, problem: null });
  });

  it.each([
    [JSON.stringify({ creationTime: { timestamp: '1700000000' } }), 1700000000, 'photoTakenTime absent des métadonnées'],
    [JSON.stringify({ photoTakenTime: { timestamp: '0' } }), null, 'photoTakenTime invalide ("0")'],
    [JSON.stringify({ photoTakenTime: { timestamp: 'hier' } }), null, 'photoTakenTime invalide ("hier")'],
    ['{ pas du json', null, 'métadonnées JSON illisibles'],
    ['null', null, 'photoTakenTime absent des métadonnées'],
    [JSON.stringify({ photoTakenTime: { timestamp: '1580513400000' } }), null, 'photoTakenTime en millisecondes ?'],
    [JSON.stringify({ photoTakenTime: { timestamp: 1580513400000 } }), null, 'photoTakenTime en millisecondes ?'],
  ])('%s → %s', (content, creation, problem) => {
    expect(parsePhotoTakenTime(content)).toEqual({ instant: null, creation, problem });
  });
});

describe('datation d\'un média Takeout (règle révisée)', () => {
  const exifOf = (details: Partial<ExifDetails>) => jest.fn(async (): Promise<ExifDetails> => ({ best: null, dateTimeOriginal: null, offsetTimeOriginal: null, ...details }));
  const taken = (instant: number, creation: number | null = null): TakenTime => ({ instant, creation, problem: null });
  const base = (overrides: Partial<MediaDateEvidence>): MediaDateEvidence => ({
    fileName: 'IMG_0001.JPG',
    timeZone: 'Europe/Paris',
    takenTime: null,
    livePhoto: null,
    readExif: exifOf({}),
    exifReadable: true,
    ...overrides,
  });
  /** Tenerife (UTC+0 en hiver) : photo du 31/01/2020 à 23:30 heure locale = 23:30 UTC, 00:30 le 1er février à Paris. */
  const TENERIFE_EXIF = { best: { takenAt: '2020-01-31T23:30:00', tag: 'DateTimeOriginal' as const }, dateTimeOriginal: '2020-01-31T23:30:00' };

  it('(a) Tenerife 31/01 23:30 : EXIF concordant (≤ 14 h) retenu, heure de l\'appareil, pas la conversion à Paris', async () => {
    const date = await dateMedia(base({ takenTime: taken(END_OF_MONTH), readExif: exifOf(TENERIFE_EXIF) }));
    expect(date).toEqual({
      takenAt: '2020-01-31T23:30:00', source: 'exif', instant: END_OF_MONTH, warning: null,
      detail: 'DateTimeOriginal ; photoTakenTime 2020-01-31T23:30:00Z concordant (écart 0 h)',
    });
  });

  it('(a) nom concordant : date du nom, même sans EXIF ; nom daté au jour seul (WhatsApp) toléré sur la journée', async () => {
    const name = await dateMedia(base({ fileName: 'IMG_20200201_003000.jpg', takenTime: taken(END_OF_MONTH) }));
    expect(name).toMatchObject({ takenAt: '2020-02-01T00:30:00', source: 'nom_fichier', warning: null, instant: END_OF_MONTH });
    const whatsapp = await dateMedia(base({ fileName: 'IMG-20190417-WA0003.jpg', takenTime: taken(Date.UTC(2019, 3, 17, 21, 45) / 1000) }));
    expect(whatsapp).toMatchObject({ takenAt: '2019-04-17T00:00:00', source: 'nom_fichier', warning: null });
  });

  it('(b) WhatsApp 2015 dans le nom, photoTakenTime 2019 : date du nom retenue, alerte de discordance (creationTime proche signalé)', async () => {
    const reception2019 = Date.UTC(2019, 5, 1, 12, 0) / 1000;
    const date = await dateMedia(base({ fileName: 'IMG-20150714-WA0012.jpg', takenTime: taken(reception2019, reception2019 + 3600) }));
    expect(date.takenAt).toBe('2015-07-14T00:00:00');
    expect(date.source).toBe('nom_fichier');
    expect(date.warning).toMatch(/^discordance JSON : photoTakenTime 2019-06-01T12:00:00Z à [\d,\s]+ j de la date du nom 2015-07-14T00:00:00 ; photoTakenTime proche de creationTime/);
  });

  it('(b) EXIF et nom concordants entre eux mais discordants avec le JSON : EXIF retenu ; EXIF contredit par le nom : nom retenu', async () => {
    const json2024 = Date.UTC(2024, 3, 5, 10, 0) / 1000;
    const exif = exifOf({ dateTimeOriginal: '2024-02-13T18:22:05', best: { takenAt: '2024-02-13T18:22:05', tag: 'DateTimeOriginal' } });
    expect(await dateMedia(base({ fileName: 'IMG-20240213-WA0005~2.jpg', takenTime: taken(json2024), readExif: exif }))).toMatchObject({
      takenAt: '2024-02-13T18:22:05', source: 'exif', warning: expect.stringMatching(/^discordance JSON/),
    });
    const oddExif = exifOf({ dateTimeOriginal: '2010-01-01T10:00:00', best: { takenAt: '2010-01-01T10:00:00', tag: 'DateTimeOriginal' } });
    expect(await dateMedia(base({ fileName: 'IMG-20240213-WA0005~2.jpg', takenTime: taken(json2024), readExif: oddExif }))).toMatchObject({
      takenAt: '2024-02-13T00:00:00', source: 'nom_fichier', warning: expect.stringMatching(/^discordance JSON/),
    });
  });

  it('EXIF seul (sans photoTakenTime) : cascade 2.2 ; rien du tout avec photoTakenTime → Paris ; OffsetTimeOriginal prime sur le fuseau', async () => {
    const readExif = exifOf({ best: { takenAt: '2016-02-20T11:12:13', tag: 'DateTimeOriginal' }, dateTimeOriginal: '2016-02-20T11:12:13' });
    expect(await dateMedia(base({ readExif }))).toMatchObject({ takenAt: '2016-02-20T11:12:13', source: 'exif', detail: 'DateTimeOriginal', instant: null });
    expect(await dateMedia(base({ takenTime: taken(END_OF_MONTH) }))).toEqual({
      takenAt: '2020-02-01T00:30:00', source: 'json_takeout', instant: END_OF_MONTH, warning: null,
      detail: 'photoTakenTime 2020-01-31T23:30:00Z converti en Europe/Paris',
    });
    expect((await dateMedia(base({ takenTime: taken(END_OF_MONTH), timeZone: 'UTC' }))).takenAt).toBe('2020-01-31T23:30:00');
    expect(await dateMedia(base({ takenTime: taken(END_OF_MONTH), readExif: exifOf({ offsetTimeOriginal: '-03:00' }) }))).toMatchObject({
      takenAt: '2020-01-31T20:30:00', source: 'json_takeout', detail: 'photoTakenTime 2020-01-31T23:30:00Z avec OffsetTimeOriginal -03:00',
    });
  });

  it('JSON sans photoTakenTime : nom de fichier ; raisons cumulées si tout échoue ; vidéo sans EXIF lisible : indéterminée', async () => {
    expect(await dateMedia(base({ fileName: 'IMG_20190817_181059.jpg', takenTime: { instant: null, creation: 1700000000, problem: 'photoTakenTime absent des métadonnées' } }))).toMatchObject({
      takenAt: '2019-08-17T18:10:59', source: 'nom_fichier',
    });
    expect(await dateMedia(base({ takenTime: { instant: null, creation: null, problem: 'métadonnées JSON illisibles' } }))).toEqual({
      takenAt: null, source: 'indeterminee', instant: null, warning: null,
      detail: 'métadonnées JSON illisibles ; aucune date dans le nom ; aucune date EXIF',
    });
    const readExif = exifOf({ best: { takenAt: '2016-02-20T11:12:13', tag: 'DateTimeOriginal' } });
    expect(await dateMedia(base({ fileName: 'clip.mp4', exifReadable: false, readExif }))).toMatchObject({
      takenAt: null, source: 'indeterminee', detail: 'aucune date dans le nom ; format sans EXIF lisible',
    });
    expect(readExif).not.toHaveBeenCalled();
  });

  it('Live Photo : date QuickTime prioritaire, puis photoTakenTime de l\'image compagnon, écart > 1 jour signalé', async () => {
    const companionTakenTime = taken(END_OF_MONTH);
    const video = { fileName: 'IMG_0043.MP4', exifReadable: false };
    expect(await dateMedia(base({ ...video, livePhoto: { quicktime: END_OF_MONTH + 2, companion: 'IMG_0043.JPG', companionTakenTime } }))).toMatchObject({
      takenAt: '2020-02-01T00:30:02', source: 'quicktime', warning: null,
    });
    const far = await dateMedia(base({ ...video, livePhoto: { quicktime: END_OF_MONTH + LIVE_PHOTO_MAX_GAP_SECONDS + 3600, companion: 'IMG_0043.JPG', companionTakenTime } }));
    expect(far).toMatchObject({ source: 'quicktime', warning: 'date QuickTime à 1 j de celle de l\'image compagnon IMG_0043.JPG' });
    expect(await dateMedia(base({ ...video, livePhoto: { quicktime: null, companion: 'IMG_0043.JPG', companionTakenTime } }))).toMatchObject({
      takenAt: '2020-02-01T00:30:00', source: 'compagnon_live_photo', detail: 'photoTakenTime de IMG_0043.JPG 2020-01-31T23:30:00Z converti en Europe/Paris',
    });
    expect(await dateMedia(base({ ...video, livePhoto: { quicktime: null, companion: 'IMG_0043.JPG', companionTakenTime: null } }))).toMatchObject({
      source: 'indeterminee', detail: 'aucune date QuickTime (mvhd) ; aucun photoTakenTime pour l\'image compagnon IMG_0043.JPG ; aucune date dans le nom ; format sans EXIF lisible',
    });
  });

  it('Live Photo avec son propre JSON : la date QuickTime (mvhd) prime sur photoTakenTime de la vidéo (AC 7)', async () => {
    const video = { fileName: 'IMG_0043.MP4', exifReadable: false };
    // photoTakenTime de la vidéo elle-même diverge nettement de la date QuickTime : QuickTime doit tout de même primer.
    const ownDivergentTakenTime = taken(Date.UTC(2019, 5, 1, 12, 0) / 1000);
    const companionTakenTime = taken(END_OF_MONTH);
    const date = await dateMedia(base({
      ...video, takenTime: ownDivergentTakenTime, livePhoto: { quicktime: END_OF_MONTH + 2, companion: 'IMG_0043.JPG', companionTakenTime },
    }));
    expect(date).toMatchObject({ takenAt: '2020-02-01T00:30:02', source: 'quicktime', warning: null });
  });
});

describe('date de création QuickTime (mvhd) lue en flux', () => {
  const probe = (bytes: Buffer, chunkSize: number): number | null => {
    const p = new Mp4CreationTimeProbe();
    for (let i = 0; i < bytes.length; i += chunkSize) p.push(bytes.subarray(i, i + chunkSize));
    return p.result();
  };

  it.each([
    ['version 0, moov après mdat', { version: 0 as const }],
    ['version 1, moov en tête', { version: 1 as const, moovFirst: true }],
    ['mdat à taille 64 bits', { largeMdat: true }],
  ])('%s, par morceaux de 1, 7 et 4096 octets', (_label, options) => {
    const bytes = buildMp4({ creationUnix: END_OF_MONTH, ...options });
    for (const size of [1, 7, 4096]) expect(probe(bytes, size)).toBe(END_OF_MONTH);
  });

  it('mvhd absent, date nulle, ou fichier qui n\'est pas une vidéo : null', () => {
    expect(probe(buildMp4({ withoutMvhd: true }), 100)).toBeNull();
    expect(probe(buildMp4({ creationUnix: null }), 100)).toBeNull();
    expect(probe(Buffer.from('ceci n\'est pas une vidéo, juste du texte'), 5)).toBeNull();
    expect(probe(buildMp4({ creationUnix: END_OF_MONTH }).subarray(0, 200), 50)).toBeNull();
  });
});
