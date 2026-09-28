import * as crypto from 'crypto';
import * as path from 'path';
import { BucketObject } from '../clients/types';
import { EXIF_FORMATS, EXIF_RANGE_LIMITS, parseExifDetails, suspectReason } from '../inventory/dating';
import { comparableName as caseInsensitiveName, etagKind, normalizeEtag } from '../inventory/duplicates';
import { ALBUMS_ROOT, CHRONO_ROOT, csvDocument, QUARANTINE_ROOT } from '../inventory/repair-plan';
import { parseFilenameDate } from '../utils/file-utils';
import { instantToLocalDateTime, LocalDateTime } from '../utils/local-date-time';
import { MultipartEtagHasher, multipartPartCount } from '../utils/multipart-etag';
import { dateMedia, JSON_DISCORDANCE, parsePhotoTakenTime, TAKEOUT_DATE_SOURCES, TakenTime, TakeoutDateSource } from './media-dating';
import { Mp4CreationTimeProbe } from './mp4-creation-time';
import { folderKind } from './takeout-layout';
import { ExportReport, MediaReport, ZipLocation } from './takeout-validation';
import { localZipSource, readZipDirectory, ZipEntry, ZipStructureError } from './zip-directory';
import { readSmallZipEntry, readZipEntry } from './zip-entry-stream';

/**
 * Analyse d'un export Takeout téléchargé et vérifié (story 4.2) : lecture en flux de chaque média, identité par le
 * contenu (MD5 + taille), datation tracée, doublons internes, rapprochement avec l'archive du bucket dédié.
 * Rien n'est écrit, ni dans un bucket, ni sur disque (hors persistance faite par l'appelant).
 */

/** Plafond d'un fichier de métadonnées JSON lu en mémoire. */
const MAX_METADATA_SIZE = 1024 * 1024;
/** Octets de tête conservés pour l'EXIF : la plus grande plage lue par la datation de l'archive (2.2). */
const EXIF_HEAD_SIZE = EXIF_RANGE_LIMITS[EXIF_RANGE_LIMITS.length - 1]!;
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);
/** Espaces de l'archive dans le bucket dédié ; `backups/` (exports Takeout) et tout autre préfixe en sont exclus. */
export const ARCHIVE_ROOTS = [CHRONO_ROOT, ALBUMS_ROOT, QUARANTINE_ROOT];

export type ArchiveStatus = 'deja_archive' | 'non_confirmable' | 'homonyme_different' | 'nouveau';
export const ARCHIVE_STATUSES: readonly ArchiveStatus[] = ['deja_archive', 'non_confirmable', 'homonyme_different', 'nouveau'];
/** Preuve d'identité d'un média déjà archivé : ETag MD5 égal, ou ETag multipart recalculé égal. */
export type ArchiveProof = 'md5' | 'etag_multipart';

export interface ArchiveMatch {
  status: ArchiveStatus;
  proof: ArchiveProof | null; // seulement pour deja_archive
  key: string | null; // objet archivé confirmé (même nom de préférence)
  /**
   * ETag (normalisé) de l'objet `key` tel que vu par CETTE analyse, seulement pour `deja_archive` (story 4.3) : `md5`
   * égal au MD5 du contenu, ou ETag multipart confirmé par recalcul. Sert à revérifier au moment du plan que l'objet
   * archivé n'a pas changé depuis (même preuve, quelle que soit sa forme), sans jamais comparer un MD5 à un ETag
   * multipart. `null` sinon.
   */
  archivedEtag: string | null;
  candidates: string[]; // clés confirmées, non confirmables, ou homonymes selon le statut
  sameNameAndSize: boolean; // un objet archivé a le même nom comparable et la même taille
}

export interface AnalyzedMedia extends ZipLocation {
  folder: string;
  folderKind: 'annee' | 'album';
  fileName: string;
  size: number;
  md5: string;
  takenAt: LocalDateTime | null;
  dateSource: TakeoutDateSource;
  dateDetail: string | null;
  instant: number | null; // instant UTC d'origine (photoTakenTime, QuickTime)
  dateWarning: string | null;
  metadata: ZipLocation | null;
  companion: string | null;
  duplicateOf: ZipLocation | null; // représentant du même contenu dans l'export
  archive: ArchiveMatch;
}

export interface AnalysisInput {
  report: ExportReport; // validation 4.1 des zips locaux
  zipPaths: ReadonlyMap<string, string>; // nom de partie → fichier local vérifié
  timeZone: string;
  keptAlbums: string[];
  archived: BucketObject[]; // bucket dédié : seuls photos/, albums/ et quarantaine/ sont pris en compte
  onProgress?: (done: number, total: number) => void; // octets décompressés
}

const locationKey = (l: ZipLocation): string => `${l.part}\u0000${l.path}`;
const baseName = (key: string): string => caseInsensitiveName(path.posix.basename(key));

/** Objets du bucket dédié qui font partie de l'archive (`photos/`, `albums/`, `quarantaine/`). */
export function archivedScope(objects: BucketObject[]): BucketObject[] {
  return objects.filter((o) => ARCHIVE_ROOTS.some((root) => o.key.startsWith(root)));
}

/** Objets archivés indexés par ETag MD5 et par nom comparable. */
class ArchiveIndex {
  private readonly byMd5 = new Map<string, BucketObject[]>();
  private readonly byName = new Map<string, BucketObject[]>();
  constructor(objects: BucketObject[]) {
    for (const object of archivedScope(objects)) {
      const etag = normalizeEtag(object.etag);
      if (etagKind(etag) === 'md5') this.byMd5.set(etag!, [...(this.byMd5.get(etag!) ?? []), object]);
      this.byName.set(baseName(object.key), [...(this.byName.get(baseName(object.key)) ?? []), object]);
    }
  }

  withMd5(md5: string, size: number): BucketObject[] {
    return (this.byMd5.get(md5) ?? []).filter((o) => o.size === size);
  }

  homonyms(fileName: string): BucketObject[] {
    return this.byName.get(caseInsensitiveName(fileName)) ?? [];
  }

  /** Homonymes de même taille à ETag multipart : comparables par recalcul de l'ETag pendant la lecture. */
  multipartHomonyms(fileName: string, size: number): BucketObject[] {
    return this.homonyms(fileName).filter((o) => o.size === size && multipartPartCount(normalizeEtag(o.etag)) !== null);
  }
}

/** Lit, identifie et date chaque média, puis marque doublons internes et statut d'archivage. */
export async function analyzeTakeoutExport(input: AnalysisInput): Promise<AnalyzedMedia[]> {
  const { report, zipPaths, timeZone } = input;
  const index = new ArchiveIndex(input.archived);
  const entries = new Map<string, { file: string; entry: ZipEntry }>();
  for (const part of report.parts) {
    const file = zipPaths.get(part.name);
    if (file === undefined) throw new Error(`partie ${part.name} : aucun zip local vérifié`);
    for (const entry of (await readZipDirectory(await localZipSource(file))).entries) {
      entries.set(locationKey({ part: part.name, path: entry.name }), { file, entry });
    }
  }
  const entryOf = (location: ZipLocation): { file: string; entry: ZipEntry } => {
    const found = entries.get(locationKey(location));
    if (!found) throw new ZipStructureError(`${location.path} : entrée absente de ${location.part}`);
    return found;
  };

  const takenTimes = new Map<string, TakenTime>();
  const takenTimeOf = async (media: MediaReport): Promise<TakenTime | null> => {
    if (media.metadata === null) return null;
    const key = locationKey(media.metadata);
    if (!takenTimes.has(key)) {
      const { file, entry } = entryOf(media.metadata);
      takenTimes.set(key, parsePhotoTakenTime((await readSmallZipEntry(file, entry, MAX_METADATA_SIZE)).toString('utf8')));
    }
    return takenTimes.get(key)!;
  };
  const byFolderAndName = new Map(report.media.map((m) => [`${m.folder}\u0000${m.fileName}`, m]));

  const total = report.media.reduce((sum, m) => sum + m.size, 0);
  let done = 0;
  const analyzed: AnalyzedMedia[] = [];
  const multipartConfirmed = new Map<string, string[]>();
  for (const media of report.media) {
    const { file, entry } = entryOf(media);
    const extension = path.extname(media.fileName).slice(1).toLowerCase();
    const exifReadable = EXIF_FORMATS.includes(extension);
    const hash = crypto.createHash('md5');
    const head: Buffer[] = [];
    let headSize = 0;
    const probe = media.companion !== null && VIDEO_EXTENSIONS.has(extension) ? new Mp4CreationTimeProbe() : null;
    const multipartTargets = index.multipartHomonyms(media.fileName, media.size);
    const multipartHashers = new Map(
      [...new Set(multipartTargets.map((o) => normalizeEtag(o.etag)!))].map((etag) => [etag, new MultipartEtagHasher(etag, media.size)]),
    );
    await readZipEntry(file, entry, (chunk) => {
      hash.update(chunk);
      if (exifReadable && headSize < EXIF_HEAD_SIZE) {
        head.push(chunk.subarray(0, EXIF_HEAD_SIZE - headSize));
        headSize += head[head.length - 1]!.length;
      }
      probe?.push(chunk);
      for (const hasher of multipartHashers.values()) hasher.update(chunk);
      done += chunk.length;
      input.onProgress?.(done, total);
    });
    const confirmedByParts = multipartTargets.filter((o) => multipartHashers.get(normalizeEtag(o.etag)!)!.matchingPartSize() !== null);
    if (confirmedByParts.length > 0) multipartConfirmed.set(locationKey(media), confirmedByParts.map((o) => o.key));

    const companion = media.companion === null ? null : byFolderAndName.get(`${media.folder}\u0000${media.companion}`);
    const date = await dateMedia({
      fileName: media.fileName,
      timeZone,
      takenTime: await takenTimeOf(media),
      livePhoto:
        media.companion === null
          ? null
          : { quicktime: probe?.result() ?? null, companion: media.companion, companionTakenTime: companion ? await takenTimeOf(companion) : null },
      exifReadable,
      readExif: () => parseExifDetails(Buffer.concat(head)),
    });
    analyzed.push({
      part: media.part, path: media.path, folder: media.folder, folderKind: folderKind(media.folder).kind, fileName: media.fileName,
      size: media.size, md5: hash.digest('hex'),
      takenAt: date.takenAt, dateSource: date.source, dateDetail: date.detail, instant: date.instant, dateWarning: date.warning,
      metadata: media.metadata === null ? null : { part: media.metadata.part, path: media.metadata.path },
      companion: media.companion, duplicateOf: null,
      archive: { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize: false },
    });
  }
  markInternalDuplicates(analyzed, input.keptAlbums);
  matchArchive(analyzed, input.archived, multipartConfirmed);
  return analyzed;
}

const contentKey = (m: Pick<AnalyzedMedia, 'md5' | 'size'>): string => `${m.md5}:${m.size}`;

const keptAlbumTest = (keptAlbums: string[]): ((m: AnalyzedMedia) => boolean) => {
  const kept = new Set(keptAlbums.map(caseInsensitiveName));
  return (m) => m.folderKind === 'album' && kept.has(caseInsensitiveName(m.folder));
};

function groupByContent(media: AnalyzedMedia[]): AnalyzedMedia[][] {
  const groups = new Map<string, AnalyzedMedia[]>();
  for (const m of media) {
    const group = groups.get(contentKey(m));
    if (group) group.push(m);
    else groups.set(contentKey(m), [m]);
  }
  return [...groups.values()];
}

/**
 * Doublons internes : même MD5 et même taille. Représentant : occurrence dans un album conservé (règle des albums de la
 * story 4.3), sinon la première par partie puis chemin ; les autres pointent vers lui. Modifie `media` en place.
 */
export function markInternalDuplicates(media: AnalyzedMedia[], keptAlbums: string[]): void {
  const inKeptAlbum = keptAlbumTest(keptAlbums);
  for (const group of groupByContent(media)) {
    group.sort((a, b) => Number(!inKeptAlbum(a)) - Number(!inKeptAlbum(b)) || a.part.localeCompare(b.part) || a.path.localeCompare(b.path));
    const [representative, ...copies] = group;
    representative!.duplicateOf = null;
    for (const copy of copies) copy.duplicateOf = { part: representative!.part, path: representative!.path };
  }
}

/**
 * Statut d'archivage de chaque média d'après les objets de l'archive (`photos/`, `albums/`, `quarantaine/`) :
 * - `deja_archive` : un objet a un ETag MD5 égal au MD5 du contenu (quel que soit son nom), ou un homonyme de même taille
 *   a un ETag multipart égal à celui recalculé sur le contenu (`multipartConfirmed` : clés confirmées par média) ;
 * - `non_confirmable` : sinon, un homonyme de même taille a un ETag multipart ou absent — jamais présumé identique ;
 * - `homonyme_different` : sinon, un objet de même nom comparable existe (contenu différent, prouvé par la taille ou l'ETag MD5) ;
 * - `nouveau` : sinon. Modifie `media` en place.
 */
export function matchArchive(media: AnalyzedMedia[], archived: BucketObject[], multipartConfirmed: ReadonlyMap<string, string[]> = new Map()): void {
  const index = new ArchiveIndex(archived);
  // ETag (normalisé) de chaque objet archivé par sa clé : sert à enregistrer la preuve exacte vue par CETTE analyse
  // (story 4.3), quelle que soit sa forme (MD5 simple ou multipart), pour la revérifier au moment du plan.
  const etagByKey = new Map(archived.map((o) => [o.key, normalizeEtag(o.etag)]));
  for (const m of media) {
    const homonyms = index.homonyms(m.fileName);
    const sameNameAndSize = homonyms.some((o) => o.size === m.size);
    const preferred = (keys: string[]): string => keys.find((k) => baseName(k) === caseInsensitiveName(m.fileName)) ?? keys[0]!;
    const byMd5 = index.withMd5(m.md5, m.size).map((o) => o.key).sort();
    const byParts = [...(multipartConfirmed.get(locationKey(m)) ?? [])].sort();
    if (byMd5.length > 0) {
      const key = preferred(byMd5);
      m.archive = { status: 'deja_archive', proof: 'md5', key, archivedEtag: etagByKey.get(key) ?? null, candidates: byMd5, sameNameAndSize };
      continue;
    }
    if (byParts.length > 0) {
      const key = preferred(byParts);
      m.archive = { status: 'deja_archive', proof: 'etag_multipart', key, archivedEtag: etagByKey.get(key) ?? null, candidates: byParts, sameNameAndSize };
      continue;
    }
    const keys = (objects: BucketObject[]): string[] => objects.map((o) => o.key).sort();
    const unconfirmable = homonyms.filter((o) => o.size === m.size && etagKind(o.etag) !== 'md5');
    if (unconfirmable.length > 0) {
      m.archive = { status: 'non_confirmable', proof: null, key: null, archivedEtag: null, candidates: keys(unconfirmable), sameNameAndSize };
    } else if (homonyms.length > 0) {
      m.archive = { status: 'homonyme_different', proof: null, key: null, archivedEtag: null, candidates: keys(homonyms), sameNameAndSize };
    } else {
      m.archive = { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize };
    }
  }
}

export interface VolumeCount {
  count: number;
  size: number;
}

export interface MonthConcordance {
  source: TakeoutDateSource;
  concordant: number; // mois de la date retenue = mois du dossier de l'objet archivé
  discordant: number;
  notComparable: number; // objet archivé hors de photos/AAAA/AAAA-MM/
  jsonInTimeZone: number | null; // concordants si l'on avait pris l'instant d'origine converti dans le fuseau
  jsonUtc: number | null; // concordants si l'on avait pris l'instant d'origine en UTC
}

export interface SummaryOptions {
  timeZone: string;
  keptAlbums: string[];
  now?: Date;
}

export interface AnalysisSummary {
  media: VolumeCount;
  distinct: VolumeCount;
  bySource: Record<TakeoutDateSource, number>;
  suspects: { media: AnalyzedMedia; reason: string }[];
  indeterminate: AnalyzedMedia[];
  dateWarnings: AnalyzedMedia[]; // discordances JSON, écarts Live Photo
  jsonDiscordances: number;
  livePhotos: AnalyzedMedia[];
  duplicateGroups: AnalyzedMedia[][]; // représentant en premier
  duplicateCopies: VolumeCount;
  byStatus: Record<ArchiveStatus, VolumeCount>; // tous les médias
  byProof: Record<ArchiveProof, number>; // médias déjà archivés, par preuve
  quarantineOnly: AnalyzedMedia[]; // déjà archivés uniquement en quarantaine/ (datables désormais)
  toSend: VolumeCount; // contenus distincts nouveaux ou homonymes différents
  sameNameAndSize: { total: number } & Record<ArchiveStatus, number>;
  /** Cas de la règle des albums à trancher en 4.3, en contenus distincts. */
  albumRule: { archivedInPhotosAndKeptAlbum: number; newInYearAndKeptAlbum: number };
  monthConcordance: MonthConcordance[];
  nameConcordance: { compared: number; inTimeZone: number; utc: number }; // mois du nom vs photoTakenTime
}

const volume = (items: { size: number }[]): VolumeCount => ({ count: items.length, size: items.reduce((sum, i) => sum + i.size, 0) });
const utcMonth = (instant: number): string => new Date(instant * 1000).toISOString().slice(0, 7);
const ARCHIVE_MONTH = /^photos\/\d{4}\/(\d{4}-\d{2})\//;

export function summarizeAnalysis(media: AnalyzedMedia[], options: SummaryOptions): AnalysisSummary {
  const now = options.now ?? new Date();
  const zoneMonth = (instant: number): string | undefined => instantToLocalDateTime(instant, options.timeZone)?.slice(0, 7);
  const inKeptAlbum = keptAlbumTest(options.keptAlbums);
  const representatives = media.filter((m) => m.duplicateOf === null);
  const byStatus = Object.fromEntries(ARCHIVE_STATUSES.map((s) => [s, volume(media.filter((m) => m.archive.status === s))])) as Record<ArchiveStatus, VolumeCount>;
  const archived = media.filter((m) => m.archive.status === 'deja_archive');
  const sameNameAndSize = media.filter((m) => m.archive.sameNameAndSize);
  const groups = groupByContent(media);

  const concordance = new Map<TakeoutDateSource, MonthConcordance>();
  for (const m of archived) {
    if (m.takenAt === null) continue;
    const row = concordance.get(m.dateSource) ?? { source: m.dateSource, concordant: 0, discordant: 0, notComparable: 0, jsonInTimeZone: null, jsonUtc: null };
    concordance.set(m.dateSource, row);
    const months = m.archive.candidates.map((key) => ARCHIVE_MONTH.exec(key)?.[1]).filter((month): month is string => month !== undefined);
    if (months.length === 0) {
      row.notComparable++;
      continue;
    }
    if (months.includes(m.takenAt.slice(0, 7))) row.concordant++;
    else row.discordant++;
    if (m.instant !== null) {
      row.jsonInTimeZone = (row.jsonInTimeZone ?? 0) + Number(months.includes(zoneMonth(m.instant) ?? ''));
      row.jsonUtc = (row.jsonUtc ?? 0) + Number(months.includes(utcMonth(m.instant)));
    }
  }

  const nameConcordance = { compared: 0, inTimeZone: 0, utc: 0 };
  for (const m of media) {
    const nameDate = m.instant !== null && m.dateSource !== 'quicktime' ? parseFilenameDate(m.fileName) : null;
    if (nameDate === null) continue;
    nameConcordance.compared++;
    nameConcordance.inTimeZone += Number(nameDate.slice(0, 7) === zoneMonth(m.instant!));
    nameConcordance.utc += Number(nameDate.slice(0, 7) === utcMonth(m.instant!));
  }

  const status = (group: AnalyzedMedia[]): ArchiveStatus => group[0]!.archive.status;
  return {
    media: volume(media),
    distinct: volume(representatives),
    bySource: Object.fromEntries(TAKEOUT_DATE_SOURCES.map((s) => [s, media.filter((m) => m.dateSource === s).length])) as Record<TakeoutDateSource, number>,
    suspects: media.flatMap((m) => {
      const reason = suspectReason({ takenAt: m.takenAt, source: m.dateSource, detail: m.dateDetail }, now);
      return reason === null ? [] : [{ media: m, reason }];
    }),
    indeterminate: media.filter((m) => m.takenAt === null),
    dateWarnings: media.filter((m) => m.dateWarning !== null),
    jsonDiscordances: media.filter((m) => m.dateWarning?.startsWith(JSON_DISCORDANCE)).length,
    livePhotos: media.filter((m) => m.companion !== null),
    duplicateGroups: groups
      .filter((g) => g.length > 1)
      .map((g) => [...g].sort((a, b) => Number(a.duplicateOf !== null) - Number(b.duplicateOf !== null))),
    duplicateCopies: volume(media.filter((m) => m.duplicateOf !== null)),
    byStatus,
    byProof: { md5: archived.filter((m) => m.archive.proof === 'md5').length, etag_multipart: archived.filter((m) => m.archive.proof === 'etag_multipart').length },
    quarantineOnly: archived.filter((m) => m.archive.candidates.every((key) => key.startsWith(QUARANTINE_ROOT))),
    toSend: volume(representatives.filter((m) => m.archive.status === 'nouveau' || m.archive.status === 'homonyme_different')),
    sameNameAndSize: {
      total: sameNameAndSize.length,
      ...(Object.fromEntries(ARCHIVE_STATUSES.map((s) => [s, sameNameAndSize.filter((m) => m.archive.status === s).length])) as Record<ArchiveStatus, number>),
    },
    albumRule: {
      archivedInPhotosAndKeptAlbum: groups.filter(
        (g) => status(g) === 'deja_archive' && g[0]!.archive.candidates.some((k) => k.startsWith(CHRONO_ROOT)) && g.some(inKeptAlbum),
      ).length,
      newInYearAndKeptAlbum: groups.filter(
        (g) => (status(g) === 'nouveau' || status(g) === 'homonyme_different') && g.some(inKeptAlbum) && g.some((m) => m.folderKind === 'annee'),
      ).length,
    },
    monthConcordance: TAKEOUT_DATE_SOURCES.flatMap((s) => (concordance.has(s) ? [concordance.get(s)!] : [])),
    nameConcordance,
  };
}

// --- Exports détaillés -----------------------------------------------------------------------------------------------

export interface AnalysisContext {
  exportId: string;
  timeZone: string;
  keptAlbums: string[];
  destinationBucket: string;
  inventoryCompletedAt: string | null;
  analyzedAt: string;
  zips: { name: string; size: number; etag: string | null; verification: string }[];
}

const CSV_HEADER = [
  'partie', 'chemin', 'dossier', 'type_dossier', 'nom', 'taille_octets', 'md5', 'date_prise_de_vue', 'source_date', 'detail_date',
  'alerte_date', 'json_partie', 'json_chemin', 'compagnon', 'doublon_de_partie', 'doublon_de_chemin', 'statut_archive', 'preuve_archive',
  'cle_archivee', 'candidats',
];

export function analysisToCsv(media: AnalyzedMedia[]): string {
  return csvDocument(
    CSV_HEADER,
    media.map((m) => [
      m.part, m.path, m.folder, m.folderKind, m.fileName, m.size, m.md5, m.takenAt, m.dateSource, m.dateDetail, m.dateWarning,
      m.metadata?.part ?? null, m.metadata?.path ?? null, m.companion, m.duplicateOf?.part ?? null, m.duplicateOf?.path ?? null,
      m.archive.status, m.archive.proof, m.archive.key, m.archive.candidates.join(' | '),
    ]),
  );
}

export function analysisToJson(media: AnalyzedMedia[], context: AnalysisContext, now: Date = new Date()): string {
  const summary = summarizeAnalysis(media, { timeZone: context.timeZone, keptAlbums: context.keptAlbums, now });
  const count = (v: VolumeCount): unknown => ({ nombre: v.count, octets: v.size });
  const where = (m: AnalyzedMedia): unknown => ({ partie: m.part, chemin: m.path });
  return (
    JSON.stringify(
      {
        export: context.exportId,
        analyse_le: context.analyzedAt,
        fuseau: context.timeZone,
        albums_conserves: context.keptAlbums,
        bucket_dedie: context.destinationBucket,
        inventaire_termine_le: context.inventoryCompletedAt,
        zips: context.zips.map((z) => ({ nom: z.name, taille_octets: z.size, etag: z.etag, verification: z.verification })),
        resume: {
          medias: count(summary.media),
          contenus_distincts: count(summary.distinct),
          dates_par_source: summary.bySource,
          suspectes: summary.suspects.length,
          indeterminees: summary.indeterminate.length,
          discordances_json: summary.jsonDiscordances,
          videos_live_photo: summary.livePhotos.length,
          doublons_internes: { groupes: summary.duplicateGroups.length, copies: count(summary.duplicateCopies) },
          statuts_archive: Object.fromEntries(ARCHIVE_STATUSES.map((s) => [s, count(summary.byStatus[s])])),
          deja_archive_par_preuve: summary.byProof,
          deja_archive_en_quarantaine_seulement: summary.quarantineOnly.length,
          a_envoyer: count(summary.toSend),
          meme_nom_et_taille: summary.sameNameAndSize,
          regle_albums_a_trancher_en_4_3: {
            archive_sous_photos_et_present_dans_un_album_conserve: summary.albumRule.archivedInPhotosAndKeptAlbum,
            nouveau_dans_une_annee_et_un_album_conserve: summary.albumRule.newInYearAndKeptAlbum,
          },
          concordance_mois: summary.monthConcordance.map((c) => ({
            source: c.source, concordants: c.concordant, discordants: c.discordant, non_comparables: c.notComparable,
            concordants_si_json_fuseau: c.jsonInTimeZone, concordants_si_json_utc: c.jsonUtc,
          })),
          concordance_nom_fichier_json: {
            compares: summary.nameConcordance.compared, concordants_fuseau: summary.nameConcordance.inTimeZone, concordants_utc: summary.nameConcordance.utc,
          },
        },
        suspectes: summary.suspects.map((s) => ({ ...(where(s.media) as object), date: s.media.takenAt, raison: s.reason })),
        alertes_date: summary.dateWarnings.map((m) => ({ ...(where(m) as object), date: m.takenAt, source: m.dateSource, alerte: m.dateWarning })),
        medias: media.map((m) => ({
          partie: m.part, chemin: m.path, dossier: m.folder, type_dossier: m.folderKind, nom: m.fileName, taille_octets: m.size, md5: m.md5,
          date_prise_de_vue: m.takenAt, source_date: m.dateSource, detail_date: m.dateDetail, instant_utc: m.instant, alerte_date: m.dateWarning,
          json: m.metadata === null ? null : { partie: m.metadata.part, chemin: m.metadata.path }, compagnon: m.companion,
          doublon_de: m.duplicateOf === null ? null : { partie: m.duplicateOf.part, chemin: m.duplicateOf.path },
          statut_archive: m.archive.status, preuve_archive: m.archive.proof, cle_archivee: m.archive.key, candidats: m.archive.candidates,
          meme_nom_et_taille: m.archive.sameNameAndSize,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/** Contenu d'export selon l'extension (`.csv` ou `.json`). */
export function analysisExport(media: AnalyzedMedia[], context: AnalysisContext, fileName: string, now: Date = new Date()): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.csv') return analysisToCsv(media);
  if (extension === '.json') return analysisToJson(media, context, now);
  throw new Error(`format d'export non reconnu pour « ${fileName} » : extension .csv ou .json attendue`);
}
