import * as path from 'path';
import * as exifr from 'exifr';
import { BucketObject, ObjectRangeReader } from '../clients/types';
import { DateSource, InventoryDateModel, ObjectDating } from '../database/inventory-date-model';
import { isSupportedFormat, parseFilenameDate } from '../utils/file-utils';
import { describeError } from '../utils/format';
import { buildLocalDateTime, LocalDateTime } from '../utils/local-date-time';

/**
 * Cascade de datation (story 2.2) : (1) date dans le nom du fichier, (2) EXIF lu par GET partiel,
 * (3) date indéterminée. Jamais de date par défaut, jamais la date courante, jamais `LastModified` ni la
 * métadonnée S3 `mtime` (date d'upload) : ce module ne les lit pas.
 */

/** Champs EXIF essayés, dans cet ordre. */
export const EXIF_TAGS = ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] as const;

/** Formats dont exifr sait lire l'EXIF. Vidéos, gif, bmp, webp : aucune requête. */
export const EXIF_FORMATS = ['jpg', 'jpeg', 'tif', 'tiff', 'heic', 'heif', 'avif', 'png'];

/**
 * Plages lues depuis le début de l'objet : 128 Ko (10 succès sur 12 mesurés), puis jusqu'à 1 Mo si la date
 * n'a pas été trouvée (EXIF précédé d'autres segments). Le second essai ne relit pas les octets déjà reçus.
 */
export const EXIF_RANGE_LIMITS = [128 * 1024, 1024 * 1024];

/** Au-delà de ce nombre d'échecs de lecture consécutifs, les lectures restantes sont abandonnées (réseau coupé). */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Marge du « futur » : décalage maximal d'un fuseau horaire (UTC+14), pour ne dépendre d'aucun fuseau. */
const FUTURE_MARGIN_MS = 14 * 60 * 60 * 1000;
/** Toute date antérieure est suspecte. */
export const SUSPECT_BEFORE: LocalDateTime = '2000-01-01T00:00:00';

export interface ExifDate {
  takenAt: LocalDateTime;
  tag: (typeof EXIF_TAGS)[number];
}

export interface DatingFailure {
  key: string;
  reason: string; // `name: message` uniquement
}

export interface DatingRun {
  mediaCount: number;
  filenameCount: number; // datés par le nom de fichier (aucune requête)
  exifReusedCount: number; // lectures EXIF réutilisées d'une passe précédente
  exifReadCount: number; // objets dont l'EXIF a été lu pendant cette passe
  failures: DatingFailure[]; // non enregistrés : à relire à la prochaine passe
  aborted: boolean; // lectures restantes abandonnées après trop d'échecs consécutifs
}

export interface DatingOptions {
  bucket: string;
  supportedFormats: string[];
  prefixes: string[]; // vide : tout l'inventaire
  getReader: () => ObjectRangeReader; // appelé seulement si une lecture EXIF est nécessaire
  onExifProgress?: (done: number, total: number) => void;
}

/** Médias de l'inventaire (extensions de la config), éventuellement restreints à des préfixes. */
export function selectMedia(objects: BucketObject[], supportedFormats: string[], prefixes: string[]): BucketObject[] {
  return objects.filter(
    (object) =>
      isSupportedFormat(object.key, supportedFormats) &&
      (prefixes.length === 0 || prefixes.some((prefix) => object.key.startsWith(prefix))),
  );
}

/** Convertit une valeur EXIF brute (`AAAA:MM:JJ HH:MM:SS`) en `LocalDateTime`, sans passer par un fuseau. */
export function parseExifDateValue(value: unknown): LocalDateTime | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  return buildLocalDateTime(year, month, day, hour, minute, second);
}

/**
 * Extrait la date EXIF d'un début de fichier : `DateTimeOriginal`, puis `CreateDate`, puis `ModifyDate`.
 * Un contenu illisible ou tronqué rend `null` (ce n'est pas une erreur de lecture).
 */
export async function parseExifDate(data: Uint8Array): Promise<ExifDate | null> {
  let tags: Record<string, unknown> | undefined;
  try {
    // reviveValues: false → chaînes brutes, aucune conversion en Date dépendante du fuseau de la machine.
    tags = await exifr.parse(data, {
      pick: [...EXIF_TAGS],
      reviveValues: false,
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
      ihdr: false,
    });
  } catch {
    return null;
  }
  for (const tag of EXIF_TAGS) {
    const takenAt = parseExifDateValue(tags?.[tag]);
    if (takenAt) return { takenAt, tag };
  }
  return null;
}

/**
 * Lit l'EXIF d'un objet par GET partiel : 128 Ko, puis jusqu'à 1 Mo si nécessaire, jamais au-delà de sa taille.
 * Un champ de rang inférieur (`CreateDate`, `ModifyDate`) trouvé dans la première plage n'arrête pas la lecture :
 * `DateTimeOriginal` peut se trouver plus loin. On ne s'arrête avant la dernière plage que sur `DateTimeOriginal`
 * ou si l'objet est lu en entier ; le meilleur champ selon `EXIF_TAGS` est retenu.
 * Les erreurs de lecture (réseau, S3) sont propagées ; renvoie aussi le nombre d'octets lus.
 */
export async function readExifDate(
  reader: ObjectRangeReader,
  object: BucketObject,
): Promise<{ date: ExifDate | null; bytesRead: number }> {
  let data = new Uint8Array(0);
  let best: ExifDate | null = null;
  for (const limit of EXIF_RANGE_LIMITS) {
    const end = Math.min(limit, object.size) - 1;
    if (end < data.length) break; // l'objet entier est déjà lu
    const chunk = await reader.readRange(object.key, data.length, end);
    data = Buffer.concat([data, chunk]);
    const date = await parseExifDate(data);
    if (date && (!best || EXIF_TAGS.indexOf(date.tag) < EXIF_TAGS.indexOf(best.tag))) best = date;
    if (best?.tag === EXIF_TAGS[0]) break;
  }
  return { date: best, bytesRead: data.length };
}

function dating(object: BucketObject, source: DateSource, takenAt: LocalDateTime | null, detail: string | null, exifRead = false): ObjectDating {
  return { key: object.key, size: object.size, etag: object.etag, source, takenAt, detail, exifRead };
}

/** Une datation ne vaut que pour l'objet daté : même clé, même taille, même ETag. */
export function isSameObject(row: ObjectDating | undefined, object: BucketObject): row is ObjectDating {
  return row !== undefined && row.key === object.key && row.size === object.size && row.etag === object.etag;
}

const NO_NAME_DATE = 'aucune date dans le nom';

/**
 * Applique la cascade aux médias de l'inventaire et persiste le résultat au fil de l'eau.
 * Idempotent : les dates « nom de fichier » sont recalculées (gratuit), les lectures EXIF déjà faites sur un objet
 * inchangé sont réutilisées. Une interruption ne perd que la lecture en cours.
 */
export async function dateInventory(
  objects: BucketObject[],
  model: InventoryDateModel,
  options: DatingOptions,
): Promise<DatingRun> {
  model.purgeStale(options.bucket);
  const previous = new Map(model.findAll(options.bucket).map((row) => [row.key, row]));
  const media = selectMedia(objects, options.supportedFormats, options.prefixes);

  const run: DatingRun = {
    mediaCount: media.length,
    filenameCount: 0,
    exifReusedCount: 0,
    exifReadCount: 0,
    failures: [],
    aborted: false,
  };
  const withoutRequest: ObjectDating[] = [];
  const toRead: BucketObject[] = [];

  for (const object of media) {
    const nameDate = parseFilenameDate(path.basename(object.key));
    const extension = path.extname(object.key).slice(1).toLowerCase();
    const prior = previous.get(object.key);
    if (nameDate) {
      run.filenameCount++;
      withoutRequest.push(dating(object, 'nom_fichier', nameDate, null));
    } else if (isSameObject(prior, object) && prior.exifRead) {
      run.exifReusedCount++;
    } else if (!EXIF_FORMATS.includes(extension)) {
      withoutRequest.push(dating(object, 'indeterminee', null, `${NO_NAME_DATE} ; format .${extension} sans EXIF lisible`));
    } else if (object.size === 0) {
      withoutRequest.push(dating(object, 'indeterminee', null, `${NO_NAME_DATE} ; objet vide`));
    } else {
      toRead.push(object);
    }
  }
  // Un objet qui repart en lecture perd sa datation précédente (ex. date de nom plus reconnue) : si la lecture
  // échoue, il doit apparaître « non daté », pas garder une date qui ne vaut plus.
  model.remove(options.bucket, toRead.map((object) => object.key));
  model.save(options.bucket, withoutRequest);

  if (toRead.length > 0) await readExifDates(toRead, model, options, run);

  return run;
}

/** Lectures EXIF séquentielles, chacune enregistrée dès obtenue. */
async function readExifDates(
  toRead: BucketObject[],
  model: InventoryDateModel,
  options: DatingOptions,
  run: DatingRun,
): Promise<void> {
  const reader = options.getReader();
  let consecutiveFailures = 0;
  for (const [index, object] of toRead.entries()) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      run.aborted = true;
      return;
    }
    try {
      const { date, bytesRead } = await readExifDate(reader, object);
      // Enregistré immédiatement : une interruption ne fait pas relire les EXIF déjà obtenus.
      model.save(options.bucket, [
        date
          ? dating(object, 'exif', date.takenAt, date.tag, true)
          : dating(object, 'indeterminee', null, `${NO_NAME_DATE} ni dans l'EXIF (${Math.ceil(bytesRead / 1024)} Ko lus)`, true),
      ]);
      run.exifReadCount++;
      consecutiveFailures = 0;
    } catch (error) {
      // Une erreur de lecture n'est PAS une date indéterminée : rien n'est enregistré, l'objet sera relu.
      run.failures.push({ key: object.key, reason: describeError(error) });
      consecutiveFailures++;
    }
    options.onExifProgress?.(index + 1, toRead.length);
  }
}

export interface DatingSummary {
  mediaCount: number;
  bySource: Record<DateSource, number>;
  byExifTag: Record<string, number>;
  indeterminate: ObjectDating[];
  suspects: SuspectDating[]; // date dans le futur, antérieure à 2000, ou issue d'EXIF ModifyDate
  undatedKeys: string[]; // médias sans datation enregistrée (lecture en échec ou pas encore lue)
}

export interface SuspectDating {
  dating: ObjectDating;
  reason: string;
}

/**
 * Raison pour laquelle une datation est suspecte, ou `null`. Suspecte : antérieure à 2000, postérieure à maintenant
 * (quel que soit le fuseau), ou issue d'EXIF `ModifyDate` (souvent une date d'édition ou d'export, pas de prise de vue).
 */
export function suspectReason(row: ObjectDating, now: Date): string | null {
  if (row.takenAt === null) return null;
  const latest = new Date(now.getTime() + FUTURE_MARGIN_MS).toISOString().slice(0, 19);
  if (row.takenAt < SUSPECT_BEFORE) return 'antérieure à 2000';
  if (row.takenAt > latest) return 'dans le futur';
  if (row.source === 'exif' && row.detail === 'ModifyDate') return 'EXIF ModifyDate (date de modification possible)';
  return null;
}

/** Restitution : nombre d'objets par source, indéterminés, suspects, médias non datés. */
export function summarizeDates(media: BucketObject[], datings: ObjectDating[], now: Date = new Date()): DatingSummary {
  const byKey = new Map(datings.map((row) => [row.key, row]));
  const summary: DatingSummary = {
    mediaCount: media.length,
    bySource: { nom_fichier: 0, exif: 0, indeterminee: 0 },
    byExifTag: {},
    indeterminate: [],
    suspects: [],
    undatedKeys: [],
  };

  for (const object of media) {
    const row = byKey.get(object.key);
    if (!isSameObject(row, object)) {
      summary.undatedKeys.push(object.key);
      continue;
    }
    summary.bySource[row.source]++;
    if (row.source === 'exif' && row.detail) {
      summary.byExifTag[row.detail] = (summary.byExifTag[row.detail] ?? 0) + 1;
    }
    const reason = suspectReason(row, now);
    if (row.takenAt === null) {
      summary.indeterminate.push(row);
    } else if (reason) {
      summary.suspects.push({ dating: row, reason });
    }
  }
  return summary;
}
