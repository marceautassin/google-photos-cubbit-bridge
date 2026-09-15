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
