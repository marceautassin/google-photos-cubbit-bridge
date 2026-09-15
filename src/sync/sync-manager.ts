import * as fs from 'fs-extra';
import { AppConfig } from '../config/types';
import { CubbitClient } from '../clients/cubbit';
import { SyncRecordModel, SyncSessionModel } from '../database/models';
import { MediaItem, SyncRecord, SyncSession, SyncStatus } from '../clients/types';
import { getLogger, logError } from '../utils/logger';
import { isSupportedFormat } from '../utils/file-utils';
import { formatBytes } from '../utils/format';

export interface SyncOptions {
  maxConcurrent?: number;
  dryRun?: boolean;
}

export interface SyncProgress {
  sessionId: number;
  totalItems: number;
  processedItems: number;
  successItems: number;
  errorItems: number;
  skippedItems: number;
  currentItem?: string;
  totalBytes: number;
  processedBytes: number;
}

export class SyncManager {
  private config: AppConfig;
  private cubbit: CubbitClient;
  private syncRecords: SyncRecordModel;
  private syncSessions: SyncSessionModel;
  private currentSession?: SyncSession;
  
  private progressCallback?: (progress: SyncProgress) => void;

  constructor(config: AppConfig) {
    this.config = config;
    this.cubbit = new CubbitClient(config.cubbit);
    this.syncRecords = new SyncRecordModel();
    this.syncSessions = new SyncSessionModel();
  }

  /**
   * Définit une callback pour le suivi de la progression
   */
  setProgressCallback(callback: (progress: SyncProgress) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Lance une synchronisation
   */
  async sync(options: SyncOptions = {}): Promise<SyncProgress> {
    if (!(await this.cubbit.testConnection())) {
      throw new Error('Impossible de se connecter à Cubbit. Vérifiez votre configuration.');
    }

    // S'assurer que le bucket existe
    await this.cubbit.ensureBucketExists();

    // Créer une nouvelle session de synchronisation
    const sessionId = await this.createSyncSession(options);
    
    try {
      // Récupérer les éléments média à synchroniser
      const mediaItems = await this.getMediaItemsToSync();
      
      if (mediaItems.length === 0) {
        getLogger().info('Aucun élément média à synchroniser');
        await this.endSyncSession(sessionId, 'completed');
        return this.getCurrentProgress(sessionId);
      }

      getLogger().info(`${mediaItems.length} éléments média à synchroniser`);

      // Calculer la taille totale
      const totalBytes = mediaItems.reduce((sum, item) => {
        // Estimation basée sur les dimensions pour les images, ou taille par défaut
        return sum + this.estimateFileSize(item);
      }, 0);

      await this.updateSessionStats(sessionId, {
        filesProcessed: 0,
        filesSuccess: 0,
        filesError: 0,
        totalSize: totalBytes,
      });

      // Lancer la synchronisation en parallèle
      const maxConcurrent = options.maxConcurrent || this.config.sync.maxConcurrentDownloads;
      await this.processSyncQueue(sessionId, maxConcurrent, options.dryRun || false);

      // Finaliser la session
      await this.endSyncSession(sessionId, 'completed');
      
      const finalProgress = await this.getCurrentProgress(sessionId);
      getLogger().info(`Synchronisation terminée: ${finalProgress.successItems} réussites, ${finalProgress.errorItems} erreurs`);
      
      return finalProgress;
    } catch (error) {
      logError(error as Error, { sessionId });
      await this.endSyncSession(sessionId, 'failed');
      throw error;
    }
  }

  /**
   * Reprend une synchronisation interrompue
   */
  async resumeSync(): Promise<SyncProgress | null> {
    // Chercher une session en cours
    const lastSession = await this.syncSessions.findLast();
    
    if (!lastSession || lastSession.status !== 'running') {
      getLogger().info('Aucune synchronisation à reprendre');
      return null;
    }

    getLogger().info(`Reprise de la synchronisation ${lastSession.id}`);
    
    // Reprendre le traitement de la queue
    await this.processSyncQueue(lastSession.id!, this.config.sync.maxConcurrentDownloads, false);
    
    await this.endSyncSession(lastSession.id!, 'completed');
    return await this.getCurrentProgress(lastSession.id!);
  }

  /**
   * Obtient les statistiques de synchronisation
   */
  async getSyncStats(): Promise<any> {
    const [
      totalRecords,
      syncedRecords,
      errorRecords,
      pendingRecords,
    ] = await Promise.all([
      this.syncRecords.countByStatus(),
      this.syncRecords.countByStatus(SyncStatus.SYNCED),
      this.syncRecords.countByStatus(SyncStatus.ERROR),
      this.syncRecords.countByStatus(SyncStatus.PENDING),
    ]);

    const lastSession = await this.syncSessions.findLast();
    const cubbitStats = await this.cubbit.getBucketStats();

    return {
      totalRecords,
      syncedRecords,
      errorRecords,
      pendingRecords,
      lastSync: lastSession?.startTime,
      cubbitStorage: {
        fileCount: cubbitStats.fileCount,
        totalSize: cubbitStats.totalSize,
        totalSizeFormatted: formatBytes(cubbitStats.totalSize),
      },
    };
  }

  /**
   * Crée une session de synchronisation
   */
  private async createSyncSession(options: SyncOptions): Promise<number> {
    const session: Omit<SyncSession, 'id' | 'createdAt'> = {
      startTime: new Date(),
      status: 'running',
      filesProcessed: 0,
      filesSuccess: 0,
      filesError: 0,
      totalSize: 0,
      config: {
        maxConcurrent: options.maxConcurrent,
        dryRun: options.dryRun,
      },
    };

    const sessionId = await this.syncSessions.create(session);
    this.currentSession = { ...session, id: sessionId };
    
    getLogger().info(`Session de synchronisation ${sessionId} créée`);
    return sessionId;
  }

  /**
   * Finalise une session de synchronisation
   */
  private async endSyncSession(sessionId: number, status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    await this.syncSessions.update(sessionId, {
      endTime: new Date(),
      status,
    });

    getLogger().info(`Session de synchronisation ${sessionId} terminée avec le statut: ${status}`);
  }

  /**
   * Met à jour les statistiques d'une session
   */
  private async updateSessionStats(sessionId: number, stats: Partial<SyncSession>): Promise<void> {
    await this.syncSessions.update(sessionId, stats);
  }

  /**
   * Récupère les éléments média à synchroniser : les enregistrements Takeout en attente
   */
  private async getMediaItemsToSync(): Promise<MediaItem[]> {
    const syncRecords = await this.syncRecords.findByStatus(SyncStatus.PENDING);
    const mediaItems = syncRecords
        .filter(record => record.metadata && typeof record.metadata === 'object' && 'source' in record.metadata && record.metadata.source === 'takeout')
        .map(record => ({
          id: record.googlePhotoId,
          filename: record.filename,
          baseUrl: record.googleUrl, // Contient le chemin local pour Takeout
          mimeType: record.mimeType,
          creationTime: record.createdDate,
          productUrl: '',
          width: record.metadata?.width,
          height: record.metadata?.height,
          description: record.metadata?.description,
        }));

    // Filtrer les formats supportés
    return mediaItems.filter(item =>
      isSupportedFormat(item.filename, this.config.sync.supportedFormats)
    );
  }

  /**
   * Traite la queue de synchronisation
   */
  private async processSyncQueue(sessionId: number, maxConcurrent: number, dryRun: boolean): Promise<void> {
    const pendingRecords = await this.syncRecords.findByStatus(SyncStatus.PENDING);
    
    if (pendingRecords.length === 0) {
      getLogger().info('Aucun enregistrement en attente');
      return;
    }

    getLogger().info(`Traitement de ${pendingRecords.length} enregistrements avec ${maxConcurrent} threads`);

    // Traitement par lots parallèles
    const chunks: SyncRecord[][] = [];
    for (let i = 0; i < pendingRecords.length; i += maxConcurrent) {
      chunks.push(pendingRecords.slice(i, i + maxConcurrent));
    }

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(record => this.processRecord(record, sessionId, dryRun))
      );
    }
  }

  /**
   * Traite un enregistrement de synchronisation
   */
  private async processRecord(record: SyncRecord, sessionId: number, dryRun: boolean): Promise<void> {
    try {
      // Simulation : aucun statut n'est modifié, sinon l'élément passerait pour archivé sans l'être
      if (dryRun) {
        getLogger().info(`[DRY RUN] ${record.filename} -> ${record.cubbitPath}`);
        return;
      }

      await this.syncRecords.update(record.id!, { status: SyncStatus.DOWNLOADING });
      
      // Notifier la progression
      if (this.progressCallback) {
        const progress = await this.getCurrentProgress(sessionId);
        progress.currentItem = record.filename;
        this.progressCallback(progress);
      }

      // Vérifier si le fichier existe déjà sur Cubbit
      const exists = await this.cubbit.fileExists(record.cubbitPath);
      if (exists) {
        getLogger().info(`Fichier ${record.cubbitPath} existe déjà, ignoré`);
        await this.syncRecords.update(record.id!, { 
          status: SyncStatus.SKIPPED,
          syncDate: new Date()
        });
        return;
      }

      // googleUrl contient le chemin local du fichier Takeout
      const sourceFilePath = record.googleUrl;
      if (!fs.existsSync(sourceFilePath)) {
        throw new Error(`Fichier source Takeout introuvable: ${sourceFilePath}`);
      }

      await this.syncRecords.update(record.id!, { status: SyncStatus.UPLOADING });

      // Upload vers Cubbit
      await this.cubbit.uploadFile(sourceFilePath, record.cubbitPath);

      // Marquer comme synchronisé
      await this.syncRecords.update(record.id!, { 
        status: SyncStatus.SYNCED,
        syncDate: new Date()
      });

      // Mettre à jour les stats de la session
      const session = await this.syncSessions.findById(sessionId);
      if (session) {
        await this.updateSessionStats(sessionId, {
          filesProcessed: session.filesProcessed + 1,
          filesSuccess: session.filesSuccess + 1,
        });
      }

      getLogger().info(`✅ ${record.filename} synchronisé avec succès`);

    } catch (error) {
      logError(error as Error, { recordId: record.id, filename: record.filename });

      await this.syncRecords.update(record.id!, { 
        status: SyncStatus.ERROR,
        errorMessage: (error as Error).message
      });

      // Mettre à jour les stats de la session
      const session = await this.syncSessions.findById(sessionId);
      if (session) {
        await this.updateSessionStats(sessionId, {
          filesProcessed: session.filesProcessed + 1,
          filesError: session.filesError + 1,
        });
      }
    }
  }

  /**
   * Obtient la progression actuelle
   */
  private async getCurrentProgress(sessionId: number): Promise<SyncProgress> {
    const session = await this.syncSessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} non trouvée`);
    }

    const [totalItems, processedItems, successItems, errorItems] = await Promise.all([
      this.syncRecords.countByStatus(),
      this.syncRecords.countByStatus(SyncStatus.SYNCED),
      this.syncRecords.countByStatus(SyncStatus.SYNCED),
      this.syncRecords.countByStatus(SyncStatus.ERROR),
    ]);

    const skippedItems = await this.syncRecords.countByStatus(SyncStatus.SKIPPED);

    return {
      sessionId,
      totalItems,
      processedItems: processedItems + errorItems + skippedItems,
      successItems,
      errorItems,
      skippedItems,
      totalBytes: session.totalSize,
      processedBytes: Math.round((session.filesProcessed / totalItems) * session.totalSize),
    };
  }

  /**
   * Estime la taille d'un fichier média
   */
  private estimateFileSize(item: MediaItem): number {
    // Estimation basique basée sur le type et les dimensions
    if (item.mimeType.startsWith('image/')) {
      const pixels = (item.width || 1920) * (item.height || 1080);
      return Math.round(pixels * 0.5); // ~0.5 bytes par pixel pour JPEG compressé
    } else if (item.mimeType.startsWith('video/')) {
      return 50 * 1024 * 1024; // 50MB par défaut pour les vidéos
    }
    
    return 1024 * 1024; // 1MB par défaut
  }
}
