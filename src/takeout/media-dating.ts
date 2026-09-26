import { ExifDetails } from '../inventory/dating';
import { parseFilenameDate } from '../utils/file-utils';
import { instantToLocalDateTime, instantWithOffset, LocalDateTime, localDateTimeSeconds } from '../utils/local-date-time';

/**
 * Datation d'un média Takeout (story 4.2), source tracée. Règle révisée sur les données réelles (2026-09-16) : l'archive
 * de l'epic 2 est datée par le nom de fichier ou l'EXIF, c'est-à-dire l'heure de l'appareil, juste en voyage ;
 * `photoTakenTime` est un instant UTC, parfois faux (WhatsApp, retouches : date de réception ou d'édition).
 *
 * **La priorité entre EXIF et nom de fichier diffère selon la présence de `photoTakenTime`** : avec `photoTakenTime`,
 * l'EXIF passe avant le nom (cas (a) et (b) ci-dessous), car `photoTakenTime` sert alors de garde-fou (concordance à
 * 14 h près) qui rend l'EXIF fiable ; sans `photoTakenTime`, ce garde-fou n'existe plus et le nom de fichier passe
 * avant l'EXIF, règle héritée de la story 2.2 où l'EXIF seul s'est révélé moins fiable que le nom sur l'archive réelle.
 *
 * Média avec `photoTakenTime` (instant T) :
 * (a) une date locale du nom de fichier ou de l'EXIF `DateTimeOriginal` à 14 h au plus de T (décalage horaire maximal) :
 *     cette date locale est retenue (EXIF d'abord), T noté concordant ;
 * (b) sinon, une date du nom ou de l'EXIF existe : elle est retenue (EXIF si elle concorde avec le nom ou s'il n'y a pas
 *     de nom daté, sinon le nom), avec l'alerte « discordance JSON » ; `creationTime` sert à préciser l'alerte, jamais
 *     de date ;
 * (c) sinon, T converti avec l'EXIF `OffsetTimeOriginal` s'il existe, sinon dans le fuseau choisi.
 * Média sans `photoTakenTime` : nom de fichier, puis EXIF (meilleur champ de date, comme en 2.2), sinon
 * indéterminée. Vidéo de Live Photo (sans métadonnées propres) : date QuickTime `mvhd` (UTC, convertie dans le fuseau),
 * sinon `photoTakenTime` de l'image compagnon, puis la cascade sans `photoTakenTime`.
 * Jamais la date du zip, du fichier ou courante.
 */

export type TakeoutDateSource = 'json_takeout' | 'quicktime' | 'compagnon_live_photo' | 'nom_fichier' | 'exif' | 'indeterminee';

export const TAKEOUT_DATE_SOURCES: readonly TakeoutDateSource[] = ['json_takeout', 'quicktime', 'compagnon_live_photo', 'nom_fichier', 'exif', 'indeterminee'];

/** Écart au-delà duquel la date QuickTime d'une vidéo de Live Photo et celle de son image sont signalées. */
export const LIVE_PHOTO_MAX_GAP_SECONDS = 24 * 60 * 60;
/** Écart maximal entre une heure locale et l'instant UTC correspondant (fuseaux de UTC−12 à UTC+14). */
export const LOCAL_TOLERANCE_SECONDS = 14 * 60 * 60;
/** `photoTakenTime` à moins de ce délai de `creationTime` : probablement une date d'envoi, pas de prise de vue. */
const CREATION_PROXIMITY_SECONDS = 24 * 60 * 60;
/** Début de l'alerte de discordance entre `photoTakenTime` et la date locale retenue. */
export const JSON_DISCORDANCE = 'discordance JSON';

/** Dates lues dans des métadonnées Takeout. */
export interface TakenTime {
  instant: number | null; // photoTakenTime (secondes Unix, UTC)
  creation: number | null; // creationTime : pour l'alerte uniquement, jamais une date retenue
  problem: string | null; // raison de l'absence de photoTakenTime
}

const positiveSeconds = (raw: unknown): number | null => {
  const text = typeof raw === 'number' ? String(raw) : raw;
  return typeof text === 'string' && /^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null;
};

/** Un `timestamp` en secondes Unix réaliste ne dépasse jamais ce seuil (année 5138) ; en millisecondes, il le dépasse
 * toujours (dès l'an 5138 en ms, donc systématiquement pour toute date plausible) : sert à détecter un champ
 * `photoTakenTime.timestamp` fourni par erreur en millisecondes plutôt qu'en secondes. */
export const MILLISECOND_TIMESTAMP_THRESHOLD = 1e11;

/** Lit `photoTakenTime.timestamp` (et `creationTime.timestamp` pour les alertes). */
export function parsePhotoTakenTime(content: string): TakenTime {
  let json: { photoTakenTime?: { timestamp?: unknown }; creationTime?: { timestamp?: unknown } } | null;
  try {
    json = JSON.parse(content);
  } catch {
    return { instant: null, creation: null, problem: 'métadonnées JSON illisibles' };
  }
  const creation = positiveSeconds(json?.creationTime?.timestamp);
  const raw = json?.photoTakenTime?.timestamp;
  if (raw === undefined) return { instant: null, creation, problem: 'photoTakenTime absent des métadonnées' };
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
  if (numeric !== null && numeric >= MILLISECOND_TIMESTAMP_THRESHOLD) {
    return { instant: null, creation, problem: 'photoTakenTime en millisecondes ?' };
  }
  const instant = positiveSeconds(raw);
  return instant === null ? { instant: null, creation, problem: `photoTakenTime invalide (${JSON.stringify(raw)})` } : { instant, creation, problem: null };
}

export interface MediaDateEvidence {
  fileName: string;
  timeZone: string;
  /** Métadonnées appariées : `null` si le média n'en a pas. */
  takenTime: TakenTime | null;
  /** Vidéo de Live Photo : date QuickTime et `photoTakenTime` de l'image compagnon. */
  livePhoto: { quicktime: number | null; companion: string; companionTakenTime: TakenTime | null } | null;
  /** Lecture EXIF des premiers octets du média. */
  readExif: () => Promise<ExifDetails | null>;
  exifReadable: boolean; // format dont l'EXIF est lisible
}

export interface MediaDate {
  takenAt: LocalDateTime | null;
  source: TakeoutDateSource;
  detail: string | null; // champ, instant, concordance, ou raisons de l'indétermination
  instant: number | null; // instant UTC d'origine (photoTakenTime, QuickTime), pour mesurer l'effet du fuseau
  warning: string | null; // discordance JSON, écart Live Photo
}

const iso = (instant: number): string => new Date(instant * 1000).toISOString().replace('.000Z', 'Z');
const hoursLabel = (seconds: number): string => `${(seconds / 3600).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`;
const daysLabel = (seconds: number): string => `${(seconds / 86400).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} j`;

/** Date locale candidate (nom de fichier ou EXIF). Un nom à minuit pile ne porte souvent qu'un jour (WhatsApp). */
interface LocalCandidate {
  takenAt: LocalDateTime;
  source: 'nom_fichier' | 'exif';
  dayOnly: boolean;
}

/** Écart entre une date locale et un instant, en tenant compte des fuseaux ; 0 si compatible. */
function gapBeyondTolerance(candidate: LocalCandidate, instant: number): number {
  const start = localDateTimeSeconds(candidate.takenAt);
  const end = start + (candidate.dayOnly ? 86400 - 1 : 0);
  const gap = instant < start ? start - instant : instant > end ? instant - end : 0;
  return gap > LOCAL_TOLERANCE_SECONDS ? gap : 0;
}

export async function dateMedia(evidence: MediaDateEvidence): Promise<MediaDate> {
  const { timeZone } = evidence;
  const reasons: string[] = [];
  const fromInstant = (source: TakeoutDateSource, label: string, instant: number, warning: string | null = null): MediaDate | null => {
    const takenAt = instantToLocalDateTime(instant, timeZone);
    if (takenAt === null) {
      reasons.push(`${label} hors limites (${instant})`);
      return null;
    }
    return { takenAt, source, detail: `${label} ${iso(instant)} converti en ${timeZone}`, instant, warning };
  };

  const nameDate = parseFilenameDate(evidence.fileName);
  const exif = evidence.exifReadable ? await evidence.readExif() : null;
  const instant = evidence.takenTime?.instant ?? null;
  if (evidence.takenTime && instant === null) reasons.push(evidence.takenTime.problem ?? 'photoTakenTime absent');

  // Vidéo de Live Photo : la date QuickTime (`mvhd`) prime sur `photoTakenTime`, y compris quand la vidéo possède
  // son propre JSON (AC 7) — testée avant la branche `instant` ci-dessous.
  const live = evidence.livePhoto;
  if (live && live.quicktime !== null) {
    const companionInstant = live.companionTakenTime?.instant ?? null;
    const gap = companionInstant === null ? 0 : Math.abs(live.quicktime - companionInstant);
    const warning = gap > LIVE_PHOTO_MAX_GAP_SECONDS ? `date QuickTime à ${daysLabel(gap)} de celle de l'image compagnon ${live.companion}` : null;
    const date = fromInstant('quicktime', 'mvhd', live.quicktime, warning);
    if (date) return date;
  }

  if (instant !== null) {
    const name: LocalCandidate | null = nameDate ? { takenAt: nameDate, source: 'nom_fichier', dayOnly: nameDate.endsWith('T00:00:00') } : null;
    const original: LocalCandidate | null = exif?.dateTimeOriginal ? { takenAt: exif.dateTimeOriginal, source: 'exif', dayOnly: false } : null;
    const describe = (c: LocalCandidate): string => (c.source === 'exif' ? 'DateTimeOriginal' : 'nom de fichier');
    // (a) date locale compatible avec l'instant : heure de l'appareil.
    const concordant = [original, name].find((c): c is LocalCandidate => c !== null && gapBeyondTolerance(c, instant) === 0);
    if (concordant) {
      const gap = Math.abs(localDateTimeSeconds(concordant.takenAt) - instant);
      return {
        takenAt: concordant.takenAt, source: concordant.source, instant, warning: null,
        detail: `${describe(concordant)} ; photoTakenTime ${iso(instant)} concordant (écart ${hoursLabel(gap)})`,
      };
    }
    // (b) date locale discordante : retenue, avec alerte.
    const chosen = original && name ? (gapBeyondTolerance(name, localDateTimeSeconds(original.takenAt)) === 0 ? original : name) : (original ?? name);
    if (chosen) {
      const nearUpload = evidence.takenTime!.creation !== null && Math.abs(instant - evidence.takenTime!.creation) <= CREATION_PROXIMITY_SECONDS;
      return {
        takenAt: chosen.takenAt, source: chosen.source, instant, detail: describe(chosen),
        warning:
          `${JSON_DISCORDANCE} : photoTakenTime ${iso(instant)} à ${daysLabel(gapBeyondTolerance(chosen, instant))} de la date ` +
          `${chosen.source === 'exif' ? 'EXIF' : 'du nom'} ${chosen.takenAt}${nearUpload ? ' ; photoTakenTime proche de creationTime (date d\'envoi probable)' : ''}`,
      };
    }
    // (c) ni nom ni EXIF : l'instant, avec le décalage de l'appareil s'il est connu.
    const offset = exif?.offsetTimeOriginal ?? null;
    const withOffset = offset === null ? null : instantWithOffset(instant, offset);
    if (withOffset !== null) {
      return { takenAt: withOffset, source: 'json_takeout', instant, warning: null, detail: `photoTakenTime ${iso(instant)} avec OffsetTimeOriginal ${offset}` };
    }
    const date = fromInstant('json_takeout', 'photoTakenTime', instant);
    if (date) return date;
  }

  if (live) {
    // La date QuickTime a déjà été tentée plus haut (avant la branche `instant`) quand elle existe ; ici, seul le
    // repli sur `photoTakenTime` de l'image compagnon reste à traiter.
    const companionInstant = live.companionTakenTime?.instant ?? null;
    if (live.quicktime === null) reasons.push('aucune date QuickTime (mvhd)');
    if (companionInstant !== null) {
      const date = fromInstant('compagnon_live_photo', `photoTakenTime de ${live.companion}`, companionInstant);
      if (date) return date;
    } else reasons.push(`aucun photoTakenTime pour l'image compagnon ${live.companion}`);
  }

  if (nameDate) return { takenAt: nameDate, source: 'nom_fichier', detail: null, instant: null, warning: null };
  reasons.push('aucune date dans le nom');
  if (!evidence.exifReadable) {
    reasons.push('format sans EXIF lisible');
  } else if (exif?.best) {
    return { takenAt: exif.best.takenAt, source: 'exif', detail: exif.best.tag, instant: null, warning: null };
  } else {
    reasons.push('aucune date EXIF');
  }
  return { takenAt: null, source: 'indeterminee', detail: reasons.join(' ; '), instant: null, warning: null };
}
