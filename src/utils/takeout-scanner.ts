import * as path from 'path';
import * as fs from 'fs-extra';
import { MediaItem } from '../clients/types';
import { getLogger } from './logger';
import { isSupportedFormat } from './file-utils';

export interface TakeoutMediaItem extends MediaItem {
  localPath: string;
  jsonMetadata?: any;
  album?: string;
}

export interface TakeoutScanResult {
  mediaItems: TakeoutMediaItem[];
  totalFiles: number;
  supportedFiles: number;
  albums: string[];
  errors: string[];
}

/**
 * Scanner pour les archives Google Takeout
 */
export class TakeoutScanner {
  private supportedFormats: string[];
  
  constructor(supportedFormats: string[] = []) {
    this.supportedFormats = supportedFormats.length > 0 ? supportedFormats : [
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff',
      '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'
    ];
  }

  /**
   * Scanne un répertoire Takeout pour trouver les médias
   */
  async scanTakeoutDirectory(takeoutPath: string): Promise<TakeoutScanResult> {
    if (!await fs.pathExists(takeoutPath)) {
      throw new Error(`Le répertoire Takeout n'existe pas: ${takeoutPath}`);
    }

    const result: TakeoutScanResult = {
      mediaItems: [],
      totalFiles: 0,
      supportedFiles: 0,
      albums: [],
      errors: []
    };

    try {
      // Rechercher le dossier "Google Photos"
      const googlePhotosPath = await this.findGooglePhotosFolder(takeoutPath);
      if (!googlePhotosPath) {
        throw new Error('Dossier "Google Photos" non trouvé dans l\'archive Takeout');
      }

      getLogger().info(`Scanning Google Photos folder: ${googlePhotosPath}`);
      
      // Scanner récursivement tous les médias
      await this.scanDirectory(googlePhotosPath, result);

      // Trier les éléments par date de création
      result.mediaItems.sort((a, b) => 
        new Date(a.creationTime).getTime() - new Date(b.creationTime).getTime()
      );

      getLogger().info(`Scan terminé: ${result.supportedFiles}/${result.totalFiles} fichiers supportés trouvés`);
      
    } catch (error) {
      const errorMsg = `Erreur lors du scan Takeout: ${(error as Error).message}`;
      result.errors.push(errorMsg);
      getLogger().error(errorMsg);
    }

    return result;
  }

  /**
   * Trouve le dossier Google Photos dans l'archive Takeout
   */
  private async findGooglePhotosFolder(takeoutPath: string): Promise<string | null> {
    const entries = await fs.readdir(takeoutPath, { withFileTypes: true });
    
    // Chercher "Google Photos" directement
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === 'Google Photos') {
        return path.join(takeoutPath, entry.name);
      }
    }

    // Chercher dans les sous-dossiers (parfois dans "Takeout/Google Photos")
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(takeoutPath, entry.name);
        const subEntries = await fs.readdir(subPath, { withFileTypes: true });
        
        for (const subEntry of subEntries) {
          if (subEntry.isDirectory() && subEntry.name === 'Google Photos') {
            return path.join(subPath, subEntry.name);
          }
        }
      }
    }

    return null;
  }

  /**
   * Scanne récursivement un répertoire pour les médias
   */
  private async scanDirectory(dirPath: string, result: TakeoutScanResult, albumName?: string): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // Ignorer certains dossiers spéciaux
          if (this.shouldIgnoreDirectory(entry.name)) {
            continue;
          }

          // Récursion dans le sous-dossier
          const subAlbumName = albumName || entry.name;
          if (!result.albums.includes(subAlbumName)) {
            result.albums.push(subAlbumName);
          }
          
          await this.scanDirectory(fullPath, result, subAlbumName);
          
        } else if (entry.isFile()) {
          result.totalFiles++;
          
          // Ignorer les fichiers JSON de métadonnées (traités séparément)
          if (entry.name.endsWith('.json')) {
            continue;
          }

          // Vérifier si le format est supporté
          if (!isSupportedFormat(entry.name, this.supportedFormats)) {
            continue;
          }

          result.supportedFiles++;

          try {
            const mediaItem = await this.createMediaItemFromFile(fullPath, albumName);
            result.mediaItems.push(mediaItem);
          } catch (error) {
            const errorMsg = `Erreur lors du traitement de ${fullPath}: ${(error as Error).message}`;
            result.errors.push(errorMsg);
            getLogger().debug(errorMsg);
          }
        }
      }
    } catch (error) {
      const errorMsg = `Erreur lors du scan de ${dirPath}: ${(error as Error).message}`;
      result.errors.push(errorMsg);
      getLogger().debug(errorMsg);
    }
  }

  /**
   * Vérifie si un répertoire doit être ignoré
   */
  private shouldIgnoreDirectory(dirName: string): boolean {
    const ignoredDirs = [
      'archive_browser.html',
      'Metadata',
      'Shared album comments',
      'Print subscriptions'
    ];
    
    return ignoredDirs.includes(dirName);
  }

  /**
   * Crée un MediaItem à partir d'un fichier local
   */
  private async createMediaItemFromFile(filePath: string, albumName?: string): Promise<TakeoutMediaItem> {
    const stats = await fs.stat(filePath);
    const filename = path.basename(filePath);
    
    // Chercher le fichier JSON de métadonnées correspondant
    const jsonPath = filePath + '.json';
    let metadata: any = {};
    
    if (await fs.pathExists(jsonPath)) {
      try {
        const jsonContent = await fs.readJson(jsonPath);
        metadata = jsonContent;
      } catch (error) {
        getLogger().debug(`Impossible de lire les métadonnées JSON pour ${filename}: ${(error as Error).message}`);
      }
    }

    // Extraire les informations des métadonnées ou utiliser les infos du fichier
    const creationTime = metadata.photoTakenTime?.timestamp 
      ? new Date(parseInt(metadata.photoTakenTime.timestamp) * 1000)
      : metadata.creationTime?.timestamp
      ? new Date(parseInt(metadata.creationTime.timestamp) * 1000)
      : stats.birthtime;

    // Générer un ID basé sur le chemin et la taille pour l'unicité
    const id = this.generateFileId(filePath, stats.size);

    // Déterminer le type MIME
    const mimeType = this.getMimeType(filename);

    const mediaItem: TakeoutMediaItem = {
      id,
      filename,
      baseUrl: filePath, // Utiliser le chemin local comme baseUrl
      localPath: filePath,
      mimeType,
      creationTime: creationTime,
      productUrl: '',
      description: metadata.description || '',
      width: metadata.width,
      height: metadata.height,
      jsonMetadata: metadata,
      album: albumName
    };

    return mediaItem;
  }

  /**
   * Génère un ID unique pour un fichier
   */
  private generateFileId(filePath: string, fileSize: number): string {
    // Utiliser le chemin relatif et la taille pour créer un ID unique
    const relativePath = path.relative(process.cwd(), filePath);
    return Buffer.from(`takeout:${relativePath}:${fileSize}`).toString('base64').slice(0, 32);
  }

  /**
   * Détermine le type MIME à partir de l'extension
   */
  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    
    const mimeTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.flv': 'video/x-flv'
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Convertit un TakeoutMediaItem en MediaItem standard
   */
  static toMediaItem(takeoutItem: TakeoutMediaItem): MediaItem {
    return {
      id: takeoutItem.id,
      filename: takeoutItem.filename,
      baseUrl: takeoutItem.localPath, // Important: utiliser le chemin local
      mimeType: takeoutItem.mimeType,
      creationTime: typeof takeoutItem.creationTime === 'string' 
        ? new Date(takeoutItem.creationTime) 
        : takeoutItem.creationTime,
      productUrl: takeoutItem.productUrl,
      description: takeoutItem.description,
      width: takeoutItem.width,
      height: takeoutItem.height
    };
  }
}

/**
 * Fonction utilitaire pour scanner rapidement un répertoire Takeout
 */
export async function scanTakeout(takeoutPath: string, supportedFormats?: string[]): Promise<TakeoutScanResult> {
  const scanner = new TakeoutScanner(supportedFormats);
  return await scanner.scanTakeoutDirectory(takeoutPath);
}
