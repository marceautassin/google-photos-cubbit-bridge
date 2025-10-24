import * as fs from 'fs-extra';
import * as path from 'path';
import * as mime from 'mime-types';
import { getLogger } from './logger';

/**
 * Vérifie si un fichier est supporté basé sur son extension
 */
export function isSupportedFormat(filename: string, supportedFormats: string[]): boolean {
  const ext = path.extname(filename).toLowerCase();
  // Vérifier si les formats supportés incluent le point ou non
  if (supportedFormats.some(format => format.startsWith('.'))) {
    return supportedFormats.includes(ext);
  }
  // Si les formats n'ont pas de point, comparer sans le point
  return supportedFormats.includes(ext.slice(1));
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
 * Formate une taille en octets en format lisible
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
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
 * Extrait la date du nom de fichier si elle est présente
 * Supporte les formats courants comme IMG_20190817_181059.jpg, DSC_20240315_123456.jpg, etc.
 */
export function extractDateFromFilename(filename: string): Date | null {
  try {
    // Pattern pour les formats courants de noms de fichiers avec dates
    const patterns = [
      // IMG_20190817_181059.jpg ou IMG_20190817_181059(1).jpg
      /(?:IMG|DSC|PHOTO|VID|MOV)_?(\d{8})_?(\d{6})/i,
      // 20190817_181059.jpg
      /(\d{8})_?(\d{6})/,
      // IMG-20190817-WA0001.jpg (format WhatsApp)
      /(?:IMG|VID)-?(\d{8})-/i,
      // 2019-08-17_18-10-59.jpg
      /(\d{4})-(\d{2})-(\d{2})_?(\d{2})-?(\d{2})-?(\d{2})/,
      // 2019.08.17_18.10.59.jpg
      /(\d{4})\.(\d{2})\.(\d{2})_?(\d{2})\.(\d{2})\.(\d{2})/,
    ];

    for (const pattern of patterns) {
      const match = filename.match(pattern);
      if (match) {
        let year: number, month: number, day: number, hour = 0, minute = 0, second = 0;

        if (match[1] && match[1].length === 8) {
          // Format YYYYMMDD
          const dateStr = match[1];
          year = parseInt(dateStr.substr(0, 4));
          month = parseInt(dateStr.substr(4, 2));
          day = parseInt(dateStr.substr(6, 2));
          
          if (match[2] && match[2].length === 6) {
            // Format HHMMSS
            const timeStr = match[2];
            hour = parseInt(timeStr.substr(0, 2));
            minute = parseInt(timeStr.substr(2, 2));
            second = parseInt(timeStr.substr(4, 2));
          }
        } else if (match[1] && match[1].length === 4 && match[2] && match[3]) {
          // Format YYYY-MM-DD
          year = parseInt(match[1]);
          month = parseInt(match[2]);
          day = parseInt(match[3]);
          
          if (match[4] && match[5] && match[6]) {
            hour = parseInt(match[4]);
            minute = parseInt(match[5]);
            second = parseInt(match[6]);
          }
        } else {
          continue;
        }

        // Valider les valeurs
        if (year >= 1970 && year <= new Date().getFullYear() + 1 &&
            month >= 1 && month <= 12 &&
            day >= 1 && day <= 31 &&
            hour >= 0 && hour <= 23 &&
            minute >= 0 && minute <= 59 &&
            second >= 0 && second <= 59) {
          
          return new Date(year, month - 1, day, hour, minute, second);
        }
      }
    }
    
    return null;
  } catch (error) {
    getLogger().debug(`Erreur lors de l'extraction de la date du nom de fichier ${filename}:`, error);
    return null;
  }
}
