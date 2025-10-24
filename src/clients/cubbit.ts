import { S3Client, PutObjectCommand, HeadObjectCommand, CreateBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as fs from 'fs-extra';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { FileInfo } from './types';
import { getLogger } from '../utils/logger';
import { getMimeType } from '../utils/file-utils';

export class CubbitClient {
  private s3Client: S3Client;
  private config: AppConfig['cubbit'];

  constructor(config: AppConfig['cubbit']) {
    this.config = config;
    
    this.s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    });
  }

  /**
   * Teste la connexion au service Cubbit
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: 1,
      }));
      
      getLogger().info('Connexion Cubbit réussie');
      return true;
    } catch (error) {
      getLogger().error('Échec de la connexion Cubbit:', error);
      return false;
    }
  }

  /**
   * Crée le bucket s'il n'existe pas
   */
  async ensureBucketExists(): Promise<void> {
    try {
      // Tenter de lister le contenu du bucket pour vérifier qu'il existe
      await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: 1,
      }));
      
      getLogger().debug(`Bucket ${this.config.bucket} existe déjà`);
    } catch (error: any) {
      if (error.name === 'NoSuchBucket') {
        getLogger().info(`Création du bucket ${this.config.bucket}...`);
        
        try {
          await this.s3Client.send(new CreateBucketCommand({
            Bucket: this.config.bucket,
          }));
          
          getLogger().info(`Bucket ${this.config.bucket} créé avec succès`);
        } catch (createError) {
          getLogger().error(`Erreur lors de la création du bucket:`, createError);
          throw createError;
        }
      } else {
        getLogger().error('Erreur lors de la vérification du bucket:', error);
        throw error;
      }
    }
  }

  /**
   * Upload un fichier vers Cubbit
   */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    try {
      if (!(await fs.pathExists(localPath))) {
        throw new Error(`Fichier local non trouvé: ${localPath}`);
      }

      const fileStats = await fs.stat(localPath);
      const mimeType = getMimeType(path.basename(localPath));

      getLogger().debug(`Upload de ${localPath} vers ${remotePath} (${fileStats.size} bytes)`);

      // Utiliser Upload pour les gros fichiers avec support de multipart
      const fileStream = fs.createReadStream(localPath);

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.config.bucket,
          Key: remotePath,
          Body: fileStream,
          ContentType: mimeType,
          Metadata: {
            'original-name': path.basename(localPath),
            'upload-timestamp': new Date().toISOString(),
          },
        },
      });

      await upload.done();
      
      getLogger().debug(`Upload terminé: ${remotePath}`);
    } catch (error) {
      getLogger().error(`Erreur lors de l'upload de ${localPath}:`, error);
      throw error;
    }
  }

  /**
   * Vérifie si un fichier existe sur Cubbit
   */
  async fileExists(remotePath: string): Promise<boolean> {
    try {
      await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: remotePath,
      }));
      
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      
      getLogger().error(`Erreur lors de la vérification du fichier ${remotePath}:`, error);
      throw error;
    }
  }

  /**
   * Obtient les informations d'un fichier
   */
  async getFileInfo(remotePath: string): Promise<FileInfo | null> {
    try {
      const response = await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: remotePath,
      }));

      return {
        path: remotePath,
        size: response.ContentLength || 0,
        lastModified: response.LastModified || new Date(),
        etag: response.ETag,
      };
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      
      getLogger().error(`Erreur lors de la récupération des infos du fichier ${remotePath}:`, error);
      throw error;
    }
  }

  /**
   * Liste les fichiers dans un préfixe donné
   */
  async listFiles(prefix: string = '', maxKeys: number = 1000): Promise<string[]> {
    try {
      const files: string[] = [];
      let continuationToken: string | undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(maxKeys, 1000),
          ContinuationToken: continuationToken,
        });

        const response = await this.s3Client.send(command);

        if (response.Contents) {
          for (const object of response.Contents) {
            if (object.Key) {
              files.push(object.Key);
            }
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken && files.length < maxKeys);

      getLogger().debug(`${files.length} fichiers trouvés avec le préfixe "${prefix}"`);
      return files.slice(0, maxKeys);
    } catch (error) {
      getLogger().error(`Erreur lors du listing des fichiers avec le préfixe "${prefix}":`, error);
      throw error;
    }
  }

  /**
   * Crée un "dossier" (préfixe) en uploadant un objet vide
   */
  async createFolder(folderPath: string): Promise<void> {
    // S3 ne supporte pas vraiment les dossiers, mais on peut créer un objet vide
    // avec le préfixe souhaité suivi d'un slash
    const folderKey = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
    
    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: folderKey,
        Body: '',
        ContentType: 'application/x-directory',
      }));

      getLogger().debug(`Dossier créé: ${folderKey}`);
    } catch (error) {
      getLogger().error(`Erreur lors de la création du dossier ${folderKey}:`, error);
      throw error;
    }
  }

  /**
   * Génère un chemin de stockage basé sur la structure de dossiers
   */
  generateStoragePath(filename: string, creationDate: Date, albumTitle?: string): string {
    const year = creationDate.getFullYear();
    
    let basePath = `photos/${year}`;
    
    if (albumTitle) {
      // Nettoyer le titre de l'album pour éviter les caractères problématiques
      const cleanAlbumTitle = albumTitle
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
      
      basePath = `albums/${cleanAlbumTitle}`;
    }
    
    return `backup_google_photos/${basePath}/${filename}`;
  }

  /**
   * Calcule la taille totale des fichiers stockés
   */
  async getTotalStorageSize(prefix: string = ''): Promise<number> {
    try {
      let totalSize = 0;
      let continuationToken: string | undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        });

        const response = await this.s3Client.send(command);

        if (response.Contents) {
          for (const object of response.Contents) {
            totalSize += object.Size || 0;
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      return totalSize;
    } catch (error) {
      getLogger().error('Erreur lors du calcul de la taille de stockage:', error);
      throw error;
    }
  }

  /**
   * Obtient les statistiques du bucket
   */
  async getBucketStats(): Promise<{ fileCount: number; totalSize: number }> {
    try {
      let fileCount = 0;
      let totalSize = 0;
      let continuationToken: string | undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: this.config.bucket,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        });

        const response = await this.s3Client.send(command);

        if (response.Contents) {
          fileCount += response.Contents.length;
          for (const object of response.Contents) {
            totalSize += object.Size || 0;
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      return { fileCount, totalSize };
    } catch (error) {
      getLogger().error('Erreur lors de la récupération des statistiques du bucket:', error);
      throw error;
    }
  }
}
