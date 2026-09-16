import * as fs from 'fs-extra';
import * as path from 'path';
import * as mime from 'mime-types';
import { getLogger } from './logger';
import { buildLocalDateTime, LocalDateTime, localDateTimeParts } from './local-date-time';

/** Extension comparable : sans espaces ni point initial, en minuscules (`.JPG` → `jpg`). */
export const normalizeExtension = (value: string): string => value.trim().toLowerCase().replace(/^\.+/, '');

/**
 * Vérifie si un fichier est supporté d'après son extension. Seule règle de reconnaissance des médias :
 * le plan de réparation et la datation doivent classer les fichiers de la même façon.
 */
export function isSupportedFormat(filename: string, supportedFormats: string[]): boolean {
  // Nom après le dernier « / » : un marqueur de dossier (`x.jpg/`) n'a ni nom ni extension
  const name = filename.slice(filename.lastIndexOf('/') + 1);
  const extension = normalizeExtension(path.posix.extname(name));
  return extension !== '' && supportedFormats.some((format) => normalizeExtension(format) === extension);
}

/**
 * Génère un nom de fichier sécurisé
 */
export function sanitizeFilename(filename: string): string {
  // Remplacer les caractères invalides
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Génère un chemin de fichier avec structure de dossiers basée sur la date
 */
export function generateDatePath(date: Date, preserveStructure: boolean = true): string {
  if (!preserveStructure) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return path.join(year.toString(), `${year}-${month}`, `${year}-${month}-${day}`);
}

/**
 * Crée tous les répertoires nécessaires pour un chemin
 */
export async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
}

/**
 * Vérifie si un fichier existe et obtient ses informations
 */
export async function getFileStats(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Calcule la taille d'un répertoire
 */
export async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item.name);
      
      if (item.isDirectory()) {
        totalSize += await getDirectorySize(itemPath);
      } else if (item.isFile()) {
        const stats = await fs.stat(itemPath);
        totalSize += stats.size;
      }
    }
  } catch (error) {
    getLogger().warn(`Erreur lors du calcul de la taille du répertoire ${dirPath}:`, error);
  }
  
  return totalSize;
}

/**
 * Supprime les fichiers temporaires plus anciens que X jours
 */
export async function cleanupOldFiles(dirPath: string, maxAgeInDays: number = 7): Promise<number> {
  let deletedCount = 0;
  const maxAge = Date.now() - (maxAgeInDays * 24 * 60 * 60 * 1000);
  
  try {
    if (!(await fs.pathExists(dirPath))) {
      return deletedCount;
    }

    const items = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item.name);
      
      if (item.isFile()) {
        const stats = await fs.stat(itemPath);
        if (stats.mtime.getTime() < maxAge) {
          await fs.remove(itemPath);
          deletedCount++;
          getLogger().debug(`Fichier temporaire supprimé: ${itemPath}`);
        }
      }
    }
  } catch (error) {
    getLogger().error(`Erreur lors du nettoyage des fichiers dans ${dirPath}:`, error);
  }
  
  return deletedCount;
}

/**
 * Obtient le type MIME d'un fichier
 */
export function getMimeType(filename: string): string {
  return mime.lookup(filename) || 'application/octet-stream';
}

/**
 * Vérifie si un fichier est une image
 */
export function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Vérifie si un fichier est une vidéo
 */
export function isVideo(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

/**
 * Génère un nom de fichier unique en ajoutant un suffixe numérique si nécessaire
 */
export async function generateUniqueFilename(dirPath: string, filename: string): Promise<string> {
  let uniqueFilename = filename;
  let counter = 1;
  
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);
  
  while (await fs.pathExists(path.join(dirPath, uniqueFilename))) {
    uniqueFilename = `${baseName}_${counter}${ext}`;
    counter++;
  }
  
  return uniqueFilename;
}

/**
 * Motifs de date dans un nom de fichier, du plus spécifique au plus générique. Groupes : soit
 * (AAAAMMJJ, HHMMSS?), soit (AAAA, MM, JJ, HH, MM, SS).
 */
const FILENAME_DATE_PATTERNS: RegExp[] = [
  // IMG_20190817_181059.jpg, PXL_20240315_180000123.jpg, VID_…, MVIMG_…, PANO_…, BURST20210614174503123
  // (jusqu'à 3 chiffres de millisecondes tolérés après l'heure, pas davantage)
  /(?:IMG|DSC|PHOTO|VID|MOV|PXL|MVIMG|PANO|BURST)_?(\d{8})_?(\d{6})(?!\d{4})/gi,
  // 20190817_181059.jpg, Screenshot_20190817-181059.png, 16587232_20190101235959.jpg : bloc isolé, ni précédé
  // d'une lettre ou d'un chiffre (`hash19991231235959abc`), ni suivi de 4 chiffres ou plus (`201908171234567890`)
  /(?<![A-Za-z0-9])(\d{8})[_-]?(\d{6})(?!\d{4})/g,
  // IMG-20190817-WA0001.jpg (format WhatsApp, sans heure)
  /(?:IMG|VID)-?(\d{8})-/gi,
  // Formats séparés : 2019-08-17_18-10-59.jpg, 2019-08-17 18.10.59.jpg, Screenshot_2019-08-17-18-10-59.png,
  // 2019.08.17_18.10.59.jpg, WhatsApp Image 2019-08-17 at 18.10.59.jpeg, Capture d'écran 2019-08-17 à 18.10.59.png
  /(?<!\d)(\d{4})[-.](\d{2})[-.](\d{2})(?: at | à |[ _T.-])?(\d{2})[-.:h]?(\d{2})[-.:m]?(\d{2})(?!\d)/g,
];

/**
 * Extrait la date de prise de vue du nom de fichier, en heure locale nominale sans fuseau
 * (`AAAA-MM-JJTHH:MM:SS`), ou `null` si aucun motif ne donne une date calendaire valide.
 * Aucune date par défaut : l'absence de date est un résultat.
 */
export function parseFilenameDate(filename: string): LocalDateTime | null {
  // Toutes les occurrences de chaque motif sont essayées : la première date calendaire valide l'emporte.
  // NFC : macOS écrit les accents décomposés (« à » en « a » + accent), qui ne correspondraient pas au motif
  const normalized = filename.normalize('NFC');
  for (const pattern of FILENAME_DATE_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const date = toLocalDateTime(match);
      if (date) return date;
    }
  }
  return null;
}

function toLocalDateTime(match: RegExpMatchArray): LocalDateTime | null {
  const [, first, ...rest] = match;
  let parts: number[];
  if (first?.length === 8) {
    const time = rest[0] ?? '000000';
    parts = [
      first.slice(0, 4),
      first.slice(4, 6),
      first.slice(6, 8),
      time.slice(0, 2),
      time.slice(2, 4),
      time.slice(4, 6),
    ].map(Number);
  } else {
    parts = [first, ...rest].map(Number);
  }

  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return buildLocalDateTime(year, month, day, hour, minute, second);
}

/**
 * Extrait la date du nom de fichier sous forme de `Date` en heure locale (contrat historique de
 * l'ancien import Takeout, supprimé en story 4.1 ; cascade revue en story 4.2). Bornée à [1970, année courante + 1].
 */
export function extractDateFromFilename(filename: string): Date | null {
  const date = parseFilenameDate(filename);
  if (!date) return null;
  const [year, month, day, hour, minute, second] = localDateTimeParts(date) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1970 || year > new Date().getFullYear() + 1) return null;
  return new Date(year, month - 1, day, hour, minute, second);
}
