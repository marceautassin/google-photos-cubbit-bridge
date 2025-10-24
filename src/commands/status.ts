import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { SyncManager } from '../sync/sync-manager';
import { SyncRecordModel, SyncSessionModel } from '../database/models';
import { SyncStatus } from '../clients/types';
import { formatBytes } from '../utils/file-utils';

export function register(program: Command, config: AppConfig): void {
  program
    .command('status')
    .description('Afficher le statut des synchronisations')
    .option('--detailed', 'Afficher les détails des erreurs')
    .option('--recent <number>', 'Nombre de sessions récentes à afficher', '5')
    .action(async (options) => {
      try {
        await statusCommand(config, options);
      } catch (error) {
        console.error(chalk.red('Erreur lors de l\'affichage du statut:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('history')
    .description('Afficher l\'historique des synchronisations')
    .option('--limit <number>', 'Nombre de sessions à afficher', '10')
    .action(async (options) => {
      try {
        await historyCommand(config, options);
      } catch (error) {
        console.error(chalk.red('Erreur lors de l\'affichage de l\'historique:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

async function statusCommand(config: AppConfig, options: any): Promise<void> {
  const syncManager = new SyncManager(config);
  const syncRecords = new SyncRecordModel();
  const syncSessions = new SyncSessionModel();

  console.log(chalk.blue.bold('📊 Statut des synchronisations\n'));

  try {
    // Statistiques générales
    const stats = await syncManager.getSyncStats();
    
    console.log(chalk.cyan('📋 Statistiques générales:'));
    console.log(`   Total d'enregistrements: ${chalk.white(stats.totalRecords)}`);
    console.log(`   Synchronisés: ${chalk.green(stats.syncedRecords)}`);
    console.log(`   En attente: ${chalk.yellow(stats.pendingRecords)}`);
    console.log(`   Erreurs: ${chalk.red(stats.errorRecords)}`);
    
    if (stats.lastSync) {
      console.log(`   Dernière sync: ${chalk.blue(stats.lastSync.toLocaleString('fr-FR'))}`);
    }

    // Statistiques Cubbit
    console.log('\n' + chalk.cyan('🗃️  Stockage Cubbit:'));
    console.log(`   Fichiers stockés: ${chalk.white(stats.cubbitStorage.fileCount)}`);
    console.log(`   Espace utilisé: ${chalk.white(stats.cubbitStorage.totalSizeFormatted)}`);

    // Session en cours
    const lastSession = await syncSessions.findLast();
    if (lastSession && lastSession.status === 'running') {
      console.log('\n' + chalk.yellow.bold('⚠️  Synchronisation en cours détectée!'));
      console.log(`   Session ID: ${lastSession.id}`);
      console.log(`   Démarrée: ${lastSession.startTime.toLocaleString('fr-FR')}`);
      console.log(`   Fichiers traités: ${lastSession.filesProcessed}`);
      console.log(`   Réussites: ${chalk.green(lastSession.filesSuccess)}`);
      console.log(`   Erreurs: ${chalk.red(lastSession.filesError)}`);
    }

    // Détail des erreurs si demandé
    if (options.detailed && stats.errorRecords > 0) {
      console.log('\n' + chalk.red.bold('❌ Détail des erreurs:'));
      
      const errorRecords = await syncRecords.findByStatus(SyncStatus.ERROR, 10);
      
      for (const record of errorRecords) {
        console.log(chalk.red(`\n   • ${record.filename}`));
        console.log(chalk.gray(`     Erreur: ${record.errorMessage || 'Erreur inconnue'}`));
        console.log(chalk.gray(`     Date: ${record.updatedAt?.toLocaleString('fr-FR') || 'N/A'}`));
      }
      
      if (errorRecords.length < stats.errorRecords) {
        console.log(chalk.gray(`\n   ... et ${stats.errorRecords - errorRecords.length} autres erreurs`));
      }
    }

    // Sessions récentes
    const recentLimit = parseInt(options.recent) || 5;
    const recentSessions = await syncSessions.findAll(0, recentLimit);
    
    if (recentSessions.length > 0) {
      console.log('\n' + chalk.cyan(`📅 ${recentLimit} sessions récentes:`));
      console.log(
        chalk.bold('ID'.padEnd(5)) +
        chalk.bold('Début'.padEnd(20)) +
        chalk.bold('Statut'.padEnd(12)) +
        chalk.bold('Fichiers'.padEnd(10)) +
        chalk.bold('Réussies/Erreurs')
      );
      console.log('-'.repeat(65));

      for (const session of recentSessions) {
        const id = session.id?.toString().padEnd(5) || '?'.padEnd(5);
        const startTime = session.startTime.toLocaleString('fr-FR').padEnd(20);
        const status = getStatusDisplay(session.status).padEnd(12);
        const processed = session.filesProcessed.toString().padEnd(10);
        const results = `${chalk.green(session.filesSuccess)}/${chalk.red(session.filesError)}`;
        
        console.log(
          chalk.white(id) +
          chalk.blue(startTime) +
          status +
          chalk.white(processed) +
          results
        );
      }
    }

    // Actions suggérées
    console.log('\n' + chalk.blue('💡 Actions disponibles:'));
    
    if (stats.pendingRecords > 0) {
      console.log(`   • ${chalk.cyan('gpb resume')} - Reprendre la synchronisation`);
    }
    
    if (stats.errorRecords > 0) {
      console.log(`   • ${chalk.cyan('gpb sync --force')} - Forcer la resynchronisation des erreurs`);
      
      if (!options.detailed) {
        console.log(`   • ${chalk.cyan('gpb status --detailed')} - Voir les détails des erreurs`);
      }
    }
    
    console.log(`   • ${chalk.cyan('gpb cleanup')} - Nettoyer les fichiers temporaires`);
    console.log(`   • ${chalk.cyan('gpb history')} - Voir l'historique complet`);

  } catch (error) {
    console.error(chalk.red('Erreur lors de la récupération du statut:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

async function historyCommand(config: AppConfig, options: any): Promise<void> {
  const syncSessions = new SyncSessionModel();

  console.log(chalk.blue.bold('📜 Historique des synchronisations\n'));

  try {
    const limit = parseInt(options.limit) || 10;
    const sessions = await syncSessions.findAll(0, limit);

    if (sessions.length === 0) {
      console.log(chalk.yellow('Aucune session de synchronisation trouvée.'));
      return;
    }

    // En-tête du tableau
    console.log(
      chalk.bold('ID'.padEnd(5)) +
      chalk.bold('Début'.padEnd(20)) +
      chalk.bold('Fin'.padEnd(20)) +
      chalk.bold('Durée'.padEnd(12)) +
      chalk.bold('Statut'.padEnd(12)) +
      chalk.bold('Fichiers'.padEnd(12)) +
      chalk.bold('Taille')
    );
    console.log('-'.repeat(95));

    for (const session of sessions) {
      const id = session.id?.toString().padEnd(5) || '?'.padEnd(5);
      const startTime = session.startTime.toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).padEnd(20);
      
      const endTime = session.endTime 
        ? session.endTime.toLocaleString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          }).padEnd(20)
        : 'En cours...'.padEnd(20);
      
      const duration = session.endTime
        ? formatDuration(session.endTime.getTime() - session.startTime.getTime()).padEnd(12)
        : 'En cours'.padEnd(12);
      
      const status = getStatusDisplay(session.status).padEnd(12);
      
      const filesInfo = `${session.filesSuccess}/${session.filesProcessed}`.padEnd(12);
      
      const size = session.totalSize > 0 
        ? formatBytes(session.totalSize)
        : 'N/A';
      
      console.log(
        chalk.white(id) +
        chalk.blue(startTime) +
        chalk.blue(endTime) +
        chalk.white(duration) +
        status +
        chalk.white(filesInfo) +
        chalk.yellow(size)
      );

      // Afficher la configuration de la session si disponible
      if (session.config && Object.keys(session.config).length > 0) {
        const configLines: string[] = [];
        
        if (session.config.albumTitle) {
          configLines.push(`Album: ${session.config.albumTitle}`);
        }
        
        if (session.config.dateRange) {
          configLines.push(`Période: ${session.config.dateRange.startDate} - ${session.config.dateRange.endDate}`);
        }
        
        if (session.config.mediaTypes) {
          configLines.push(`Types: ${session.config.mediaTypes.join(', ')}`);
        }
        
        if (session.config.forceResync) {
          configLines.push('Mode: Force');
        }
        
        if (session.config.dryRun) {
          configLines.push('Mode: Simulation');
        }

        if (configLines.length > 0) {
          console.log(chalk.gray('      ' + configLines.join(' • ')));
        }
      }
    }

    // Statistiques globales
    const completedSessions = sessions.filter(s => s.status === 'completed');
    const totalFiles = sessions.reduce((sum, s) => sum + s.filesSuccess, 0);
    const totalSize = sessions.reduce((sum, s) => sum + s.totalSize, 0);

    console.log('\n' + chalk.blue('📊 Statistiques:'));
    console.log(`   Sessions complétées: ${chalk.green(completedSessions.length)}/${sessions.length}`);
    console.log(`   Total fichiers synchronisés: ${chalk.white(totalFiles)}`);
    console.log(`   Volume total traité: ${chalk.white(formatBytes(totalSize))}`);

    if (sessions.length >= limit) {
      console.log('\n' + chalk.yellow(`Seules les ${limit} sessions les plus récentes sont affichées.`));
      console.log(chalk.blue(`Utilisez ${chalk.cyan('--limit <number>')} pour en voir plus.`));
    }

  } catch (error) {
    console.error(chalk.red('Erreur lors de la récupération de l\'historique:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

function getStatusDisplay(status: string): string {
  switch (status) {
    case 'completed':
      return chalk.green('✅ Terminé');
    case 'running':
      return chalk.yellow('🔄 En cours');
    case 'failed':
      return chalk.red('❌ Échec');
    case 'cancelled':
      return chalk.gray('⏹️ Annulé');
    default:
      return chalk.gray(`❓ ${status}`);
  }
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
