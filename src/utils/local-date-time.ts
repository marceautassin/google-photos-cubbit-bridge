/**
 * Date-heure de prise de vue : « heure locale nominale », SANS fuseau, au format `AAAA-MM-JJTHH:MM:SS`.
 *
 * Ni un nom de fichier ni l'EXIF `DateTimeOriginal` ne portent de fuseau : ils donnent l'heure affichée par
 * l'appareil. La convertir en instant (`Date`) obligerait à inventer un fuseau et ferait dépendre l'année ou le
 * mois du fuseau de la machine qui exécute l'outil. La chaîne est triable, comparable, stockable telle quelle,
 * et le dossier `photos/AAAA/AAAA-MM/` s'en déduit par simple découpage.
 */
export type LocalDateTime = string;

/** Années acceptées structurellement ; les dates hors de [2000, maintenant] sont signalées suspectes ailleurs. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * Construit une `LocalDateTime` si les composantes forment une date calendaire réelle (31 février refusé),
 * sinon `null`. La validation passe par `Date.UTC`, qui ne dépend d'aucun fuseau.
 */
export function buildLocalDateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): LocalDateTime | null {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null;
  if (year < MIN_YEAR || year > MAX_YEAR || hour > 23 || minute > 59 || second > 59) return null;

  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** Composantes numériques d'une `LocalDateTime` (année, mois, jour, heure, minute, seconde). */
export function localDateTimeParts(value: LocalDateTime): number[] {
  return value.split(/[-T:]/).map(Number);
}

/**
 * Heure locale nominale d'un instant (secondes depuis l'époque Unix, UTC) dans un fuseau IANA explicite (story 4.2 :
 * `photoTakenTime` des métadonnées Takeout, `mvhd` des vidéos). Ne dépend jamais du fuseau de la machine ; `null` si
 * l'instant n'est pas représentable. Lève une `RangeError` si le fuseau est inconnu.
 */
export function instantToLocalDateTime(epochSeconds: number, timeZone: string): LocalDateTime | null {
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(epochSeconds) || Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return buildLocalDateTime(Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** Vérifie qu'un fuseau IANA est connu ; lève une erreur en français sinon. */
export function checkTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    throw new Error(`fuseau horaire inconnu « ${timeZone} » (attendu : un nom IANA, ex. Europe/Paris)`);
  }
}

/** Secondes « nominales » d'une `LocalDateTime` (lue comme si elle était en UTC), pour mesurer des écarts. */
export function localDateTimeSeconds(value: LocalDateTime): number {
  const [year, month, day, hour, minute, second] = localDateTimeParts(value) as [number, number, number, number, number, number];
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/** Heure locale nominale d'un instant avec un décalage fixe `±HH:MM` (EXIF `OffsetTimeOriginal`) ; `null` si invalide. */
export function instantWithOffset(epochSeconds: number, offset: string): LocalDateTime | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) return null;
  const shifted = new Date((epochSeconds + (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60)) * 1000);
  if (Number.isNaN(shifted.getTime())) return null;
  return buildLocalDateTime(
    shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(),
  );
}
