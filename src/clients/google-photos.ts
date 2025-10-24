import { google } from 'googleapis';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { AppConfig, SearchFilters } from '../config/types';
import { GoogleAuth } from '../auth/google-auth';
import { MediaItem, Album } from './types';
import { getLogger } from '../utils/logger';
import { sanitizeFilename } from '../utils/file-utils';

export class GooglePhotosClient {
  private auth: GoogleAuth;
  private config: AppConfig['googlePhotos'];

  constructor(config: AppConfig['googlePhotos']) {
    this.config = config;
    this.auth = new GoogleAuth(config);
  }

  /**
   * Vérifie si le client est authentifié
   */
  async isAuthenticated(): Promise<boolean> {
    return await this.auth.isAuthenticated();
  }

  /**
   * Lance l'authentification
   */
  async authenticate(): Promise<void> {
    await this.auth.authenticate();
  }

  /**
   * Récupère tous les albums de l'utilisateur
   */
  async getAlbums(): Promise<Album[]> {
    await this.auth.refreshTokensIfNeeded();
    const authClient = await this.auth.getAuthenticatedClient();
    
    const albums: Album[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const response = await axios.get('https://photoslibrary.googleapis.com/v1/albums', {
          headers: {
            'Authorization': `Bearer ${authClient.credentials.access_token}`,
            'Content-Type': 'application/json',
          },
          params: {
            pageSize: 50,
            pageToken,
          },
        });

        if (response.data.albums) {
          for (const album of response.data.albums) {
            albums.push({
              id: album.id,
              title: album.title,
              productUrl: album.productUrl,
              mediaItemsCount: album.mediaItemsCount || '0',
              coverPhotoBaseUrl: album.coverPhotoBaseUrl,
              coverPhotoMediaItemId: album.coverPhotoMediaItemId,
            });
          }
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

      getLogger().info(`${albums.length} albums récupérés`);
      return albums;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      getLogger().error('Erreur lors de la récupération des albums:', errorMessage);
      throw new Error(`Erreur lors de la récupération des albums: ${errorMessage}`);
    }
  }

  /**
   * Recherche des éléments médias avec des filtres
   */
  async searchMediaItems(filters: SearchFilters = {}): Promise<MediaItem[]> {
    await this.auth.refreshTokensIfNeeded();
    const authClient = await this.auth.getAuthenticatedClient();
    
    const mediaItems: MediaItem[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const requestBody: any = {
          pageSize: 100,
        };

        if (pageToken) {
          requestBody.pageToken = pageToken;
        }

        // Ajouter les filtres
        if (filters.albumId) {
          requestBody.albumId = filters.albumId;
        }

        if (filters.dateRange || filters.mediaTypes) {
          requestBody.filters = {};
          
          if (filters.dateRange) {
            const startDate = new Date(filters.dateRange.startDate);
            const endDate = new Date(filters.dateRange.endDate);
            
            requestBody.filters.dateFilter = {
              ranges: [{
                startDate: {
                  year: startDate.getFullYear(),
                  month: startDate.getMonth() + 1,
                  day: startDate.getDate(),
                },
                endDate: {
                  year: endDate.getFullYear(),
                  month: endDate.getMonth() + 1,
                  day: endDate.getDate(),
                },
              }],
            };
          }

          if (filters.mediaTypes) {
            requestBody.filters.mediaTypeFilter = {
              mediaTypes: filters.mediaTypes,
            };
          }
        }

        const response = await axios.post(
          'https://photoslibrary.googleapis.com/v1/mediaItems:search',
          requestBody,
          {
            headers: {
              'Authorization': `Bearer ${authClient.credentials.access_token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (response.data.mediaItems) {
          for (const item of response.data.mediaItems) {
            mediaItems.push(this.mapApiItemToMediaItem(item));
          }
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

      getLogger().info(`${mediaItems.length} éléments média trouvés`);
      return mediaItems;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      getLogger().error('Erreur lors de la recherche d\'éléments média:', errorMessage);
      throw new Error(`Erreur lors de la recherche d'éléments média: ${errorMessage}`);
    }
  }

  /**
   * Récupère les éléments média d'un album spécifique
   */
  async getAlbumMediaItems(albumId: string): Promise<MediaItem[]> {
    return await this.searchMediaItems({ albumId });
  }

  /**
   * Récupère tous les éléments média de l'utilisateur
   */
  async getAllMediaItems(): Promise<MediaItem[]> {
    await this.auth.refreshTokensIfNeeded();
    const authClient = await this.auth.getAuthenticatedClient();
    
    const mediaItems: MediaItem[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const response = await axios.get('https://photoslibrary.googleapis.com/v1/mediaItems', {
          headers: {
            'Authorization': `Bearer ${authClient.credentials.access_token}`,
            'Content-Type': 'application/json',
          },
          params: {
            pageSize: 100,
            pageToken,
          },
        });

        if (response.data.mediaItems) {
          for (const item of response.data.mediaItems) {
            mediaItems.push(this.mapApiItemToMediaItem(item));
          }
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

      getLogger().info(`${mediaItems.length} éléments média récupérés au total`);
      return mediaItems;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      getLogger().error('Erreur lors de la récupération de tous les éléments média:', errorMessage);
      throw new Error(`Erreur lors de la récupération de tous les éléments média: ${errorMessage}`);
    }
  }

  /**
   * Télécharge un élément média
   */
  async downloadMediaItem(item: MediaItem, destPath: string): Promise<void> {
    try {
      // Créer le répertoire de destination si nécessaire
      await fs.ensureDir(path.dirname(destPath));

      // Construire l'URL de téléchargement
      let downloadUrl = item.baseUrl;
      
      // Ajouter les paramètres de téléchargement selon le type
      if (item.mimeType.startsWith('image/')) {
        downloadUrl += '=d'; // Télécharger l'image originale
      } else if (item.mimeType.startsWith('video/')) {
        downloadUrl += '=dv'; // Télécharger la vidéo originale
      }

      getLogger().debug(`Téléchargement de ${item.filename} vers ${destPath}`);

      // Télécharger le fichier
      const response = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream',
        timeout: 300000, // 5 minutes
      });

      // Sauvegarder le fichier
      const writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          getLogger().debug(`${item.filename} téléchargé avec succès`);
          resolve();
        });
        writer.on('error', (error) => {
          getLogger().error(`Erreur lors de l'écriture de ${item.filename}:`, error);
          reject(error);
        });
      });
    } catch (error) {
      getLogger().error(`Erreur lors du téléchargement de ${item.filename}:`, error);
      throw error;
    }
  }

  /**
   * Obtient les informations détaillées d'un élément média
   */
  async getMediaItemDetails(mediaItemId: string): Promise<MediaItem | null> {
    await this.auth.refreshTokensIfNeeded();
    const authClient = await this.auth.getAuthenticatedClient();

    try {
      const response = await axios.get(
        `https://photoslibrary.googleapis.com/v1/mediaItems/${mediaItemId}`,
        {
          headers: {
            'Authorization': `Bearer ${authClient.credentials.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return this.mapApiItemToMediaItem(response.data);
    } catch (error) {
      getLogger().error(`Erreur lors de la récupération des détails de l'élément ${mediaItemId}:`, error);
      return null;
    }
  }

  /**
   * Obtient les informations utilisateur
   */
  async getUserInfo(): Promise<any> {
    return await this.auth.getUserInfo();
  }

  /**
   * Se déconnecte
   */
  async logout(): Promise<void> {
    await this.auth.logout();
  }

  /**
   * Mappe un élément de l'API vers le type MediaItem
   */
  private mapApiItemToMediaItem(apiItem: any): MediaItem {
    const creationTime = new Date(apiItem.mediaMetadata.creationTime);
    let filename = apiItem.filename;
    
    // Assainir le nom de fichier
    if (filename) {
      filename = sanitizeFilename(filename);
    } else {
      // Générer un nom de fichier basé sur la date et l'ID si pas de nom
      const dateStr = creationTime.toISOString().slice(0, 10).replace(/-/g, '');
      const extension = this.getExtensionFromMimeType(apiItem.mimeType);
      filename = `${dateStr}_${apiItem.id.slice(-8)}${extension}`;
    }

    return {
      id: apiItem.id,
      filename,
      mimeType: apiItem.mimeType,
      creationTime,
      width: apiItem.mediaMetadata?.width,
      height: apiItem.mediaMetadata?.height,
      description: apiItem.description,
      baseUrl: apiItem.baseUrl,
      productUrl: apiItem.productUrl,
    };
  }

  /**
   * Obtient l'extension de fichier basée sur le type MIME
   */
  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/bmp': '.bmp',
      'image/webp': '.webp',
      'image/tiff': '.tiff',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'video/x-matroska': '.mkv',
    };

    return mimeToExt[mimeType] || '.bin';
  }
}
