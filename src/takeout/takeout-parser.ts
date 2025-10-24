import * as fs from 'fs-extra';
import * as path from 'path';
import { getLogger } from '../utils/logger';
import { extractDateFromFilename } from '../utils/file-utils';

export interface TakeoutMetadata {
  title: string;
  description?: string;
  imageViews?: string;
  creationTime: {
    timestamp: string;
    formatted: string;
  };
  photoTakenTime?: {
    timestamp: string;
    formatted: string;
  };
  geoData?: {
    latitude: number;
    longitude: number;
    altitude?: number;
    latitudeSpan?: number;
    longitudeSpan?: number;
  };
  geoDataExif?: {
    latitude: number;
    longitude: number;
    altitude?: number;
    latitudeSpan?: number;
    longitudeSpan?: number;
  };
  url?: string;
  googlePhotosOrigin?: {
    mobileUpload?: {
      deviceType: string;
    };
  };
}

export interface TakeoutMediaItem {
  filename: string;
  filepath: string;
  metadata: TakeoutMetadata;
  creationDate: Date;
  fileSize: number;
  mimeType: string;
  album?: string;
}

export class TakeoutParser {
  private supportedExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff',
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'
  ];

  /**
   * Parse un dossier d'export Google Takeout
   */
  async parseTakeoutDirectory(takeoutPath: string): Promise<TakeoutMediaItem[]> {
    const googlePhotosPath = path.join(takeoutPath, 'Google Photos');
    
    if (!(await fs.pathExists(googlePhotosPath))) {
      throw new Error(`Dossier Google Photos non trouvé dans ${takeoutPath}`);
    }

    const mediaItems: TakeoutMediaItem[] = [];
    
    getLogger().info(`Analyse du dossier Takeout: ${googlePhotosPath}`);
    
    // Analyser les photos par année
    const yearFolders = await this.findYearFolders(googlePhotosPath);
    for (const yearFolder of yearFolders) {
      const items = await this.parseMediaFolder(yearFolder);
      mediaItems.push(...items);
    }
    
    // Analyser les albums
    const albumsPath = path.join(googlePhotosPath, 'Albums');
    if (await fs.pathExists(albumsPath)) {
      const albumItems = await this.parseAlbumsFolder(albumsPath);
      mediaItems.push(...albumItems);
    }
    
    getLogger().info(`${mediaItems.length} éléments média trouvés`);
    return mediaItems;
  }

  /**
   * Trouve tous les dossiers "Photos from YYYY"
   */
  private async findYearFolders(googlePhotosPath: string): Promise<string[]> {
    const entries = await fs.readdir(googlePhotosPath, { withFileTypes: true });
    const yearFolders: string[] = [];
    
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('Photos from ')) {
        yearFolders.push(path.join(googlePhotosPath, entry.name));
      }
    }
    
    return yearFolders;
  }

  /**
   * Parse un dossier de médias (année ou album)
   */
  private async parseMediaFolder(folderPath: string, albumName?: string): Promise<TakeoutMediaItem[]> {
    const mediaItems: TakeoutMediaItem[] = [];
    const entries = await fs.readdir(folderPath);
    
    // Grouper les fichiers par nom de base (sans extension)
    const fileGroups = new Map<string, { media?: string, json?: string }>();
    
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry);
      const stat = await fs.stat(fullPath);
      
      if (stat.isFile()) {
        const ext = path.extname(entry).toLowerCase();
        const baseName = path.basename(entry, ext);
        
        if (!fileGroups.has(baseName)) {
          fileGroups.set(baseName, {});
        }
        
        if (ext === '.json') {
          fileGroups.get(baseName)!.json = fullPath;
        } else if (this.supportedExtensions.includes(ext)) {
          fileGroups.get(baseName)!.media = fullPath;
        }
      }
    }
    
    // Traiter chaque groupe de fichiers
    for (const [baseName, files] of fileGroups) {
      if (files.media && files.json) {
        try {
          const item = await this.parseMediaItem(files.media, files.json, albumName);
          if (item) {
            mediaItems.push(item);
          }
        } catch (error) {
          getLogger().warn(`Erreur lors du parsing de ${baseName}:`, error);
        }
      } else if (files.media) {
        // Fichier média sans métadonnées JSON
        try {
          const item = await this.parseMediaItemWithoutMetadata(files.media, albumName);
          if (item) {
            mediaItems.push(item);
          }
        } catch (error) {
          getLogger().warn(`Erreur lors du parsing de ${baseName} (sans JSON):`, error);
        }
      }
    }
    
    return mediaItems;
  }

  /**
   * Parse les albums
   */
  private async parseAlbumsFolder(albumsPath: string): Promise<TakeoutMediaItem[]> {
    const mediaItems: TakeoutMediaItem[] = [];
    const albums = await fs.readdir(albumsPath, { withFileTypes: true });
    
    for (const album of albums) {
      if (album.isDirectory()) {
        const albumPath = path.join(albumsPath, album.name);
        const items = await this.parseMediaFolder(albumPath, album.name);
        mediaItems.push(...items);
      }
    }
    
    return mediaItems;
  }

  /**
   * Parse un élément média avec ses métadonnées JSON
   */
  private async parseMediaItem(mediaPath: string, jsonPath: string, albumName?: string): Promise<TakeoutMediaItem | null> {
    try {
      // Lire les métadonnées JSON
      const jsonContent = await fs.readJson(jsonPath) as TakeoutMetadata;
      
      // Statistiques du fichier
      const stats = await fs.stat(mediaPath);
      
      // Déterminer le type MIME
      const mimeType = this.getMimeType(mediaPath);
      
      // Date de création avec priorité intelligent :
      // 1. Extraire du nom de fichier si possible (plus fiable)
      // 2. Sinon utiliser photoTakenTime des métadonnées JSON
      // 3. En dernier recours, utiliser creationTime
      let creationDate: Date;
      
      const filenameDate = extractDateFromFilename(path.basename(mediaPath));
      if (filenameDate) {
        creationDate = filenameDate;
        getLogger().debug(`Date extraite du nom de fichier pour ${path.basename(mediaPath)}: ${creationDate.toISOString()}`);
      } else {
        const creationTimestamp = jsonContent.photoTakenTime?.timestamp || jsonContent.creationTime.timestamp;
        creationDate = new Date(parseInt(creationTimestamp) * 1000);
        getLogger().debug(`Date extraite des métadonnées JSON pour ${path.basename(mediaPath)}: ${creationDate.toISOString()}`);
      }
      
      return {
        filename: path.basename(mediaPath),
        filepath: mediaPath,
        metadata: jsonContent,
        creationDate,
        fileSize: stats.size,
        mimeType,
        album: albumName,
      };
      
    } catch (error) {
      getLogger().error(`Erreur lors du parsing de ${mediaPath}:`, error);
      return null;
    }
  }

  /**
   * Parse un élément média sans métadonnées JSON
   */
  private async parseMediaItemWithoutMetadata(mediaPath: string, albumName?: string): Promise<TakeoutMediaItem | null> {
    try {
      const stats = await fs.stat(mediaPath);
      const mimeType = this.getMimeType(mediaPath);
      
      // Extraire la date du nom de fichier si possible, sinon utiliser la date de modification
      let creationDate: Date;
      
      const filenameDate = extractDateFromFilename(path.basename(mediaPath));
      if (filenameDate) {
        creationDate = filenameDate;
        getLogger().debug(`Date extraite du nom de fichier pour ${path.basename(mediaPath)} (sans JSON): ${creationDate.toISOString()}`);
      } else {
        creationDate = stats.mtime;
        getLogger().debug(`Date de modification utilisée pour ${path.basename(mediaPath)} (sans JSON): ${creationDate.toISOString()}`);
      }
      
      // Créer des métadonnées minimales
      const metadata: TakeoutMetadata = {
        title: path.basename(mediaPath),
        creationTime: {
          timestamp: Math.floor(creationDate.getTime() / 1000).toString(),
          formatted: creationDate.toISOString(),
        },
      };
      
      return {
        filename: path.basename(mediaPath),
        filepath: mediaPath,
        metadata,
        creationDate,
        fileSize: stats.size,
        mimeType,
        album: albumName,
      };
      
    } catch (error) {
      getLogger().error(`Erreur lors du parsing de ${mediaPath} (sans JSON):`, error);
      return null;
    }
  }

  /**
   * Détermine le type MIME basé sur l'extension
   */
  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.tiff': 'image/tiff',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.m4v': 'video/x-m4v',
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }
}
