import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { SyncManager, SyncOptions, SyncProgress } from '../sync/sync-manager';
import { GooglePhotosClient } from '../clients/google-photos';

export function register(program: Command, config: AppConfig): void {
  program
    .command('sync')
    .description('Synchroniser les photos vers Cubbit')
    .option('--album <name>', 'Synchroniser un album spécifique (nom)')
    .option('--album-id <id>', 'Synchroniser un album spécifique (ID)')
    .option('--from <date>', 'Date de début (YYYY-MM-DD)')
    .option('--to <date>', 'Date de fin (YYYY-MM-DD)')
    .option('--type <type>', 'Type de média (photo, video, all)', 'all')
    .option('--force', 'Forcer la resynchronisation des éléments déjà synchronisés')
    .option('--dry-run', 'Simuler la synchronisation sans télécharger')
    .option('--concurrent <number>', 'Nombre de téléchargements simultanés', '3')
    .option('--all', 'Synchroniser toutes les photos')
    .option('--takeout-only', 'Synchroniser uniquement les données Takeout importées (sans authentification Google)')
    .action(async (options) => {
      try {
        await syncCommand(config, options);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la synchronisation:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('resume')
    .description('Reprendre une synchronisation interrompue')
    .action(async () => {
      try {
        await resumeCommand(config);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la reprise:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('cleanup')
    .description('Nettoyer les fichiers temporaires')
    .action(async () => {
      try {
        await cleanupCommand(config);
      } catch (error) {
        console.error(chalk.red('Erreur lors du nettoyage:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

async function syncCommand(config: AppConfig, options: any): Promise<void> {
  const syncManager = new SyncManager(config);
  const googlePhotos = new GooglePhotosClient(config.googlePhotos);

  // Vérifications préalables (sauf pour takeout-only)
  if (!options.takeoutOnly && !(await googlePhotos.isAuthenticated())) {
    console.log(chalk.red('❌ Non authentifié sur Google Photos.'));
    console.log(chalk.yellow('Utilisez ' + chalk.cyan('gpb auth login') + ' pour vous connecter.'));
    return;
  }

  // Valider les options
  if (!options.album && !options.albumId && !options.from && !options.to && !options.all) {
    console.log(chalk.yellow('⚠️  Vous devez spécifier au moins un critère de synchronisation:'));
    console.log(chalk.blue('  • --album \"Nom Album\"     : Synchroniser un album'));
    console.log(chalk.blue('  • --from YYYY-MM-DD      : Synchroniser à partir d\'une date'));
    console.log(chalk.blue('  • --to YYYY-MM-DD        : Synchroniser jusqu\'à une date'));
    console.log(chalk.blue('  • --all                  : Synchroniser toutes les photos'));
    console.log('\\n' + chalk.blue('Exemple: ' + chalk.cyan('gpb sync --album \"Vacances 2024\"')));
    return;
  }

  let syncOptions: SyncOptions = {};
  let syncTitle = 'Synchronisation';

  // Résoudre l'album par nom si nécessaire
  if (options.album) {
    console.log(chalk.blue(`🔍 Recherche de l'album "${options.album}"...`));
    
    const albums = await googlePhotos.getAlbums();
    const album = albums.find(a => 
      a.title.toLowerCase().includes(options.album.toLowerCase())
    );
    
    if (!album) {
      console.log(chalk.red(`❌ Album "${options.album}" non trouvé.`));
      console.log(chalk.yellow('Utilisez ' + chalk.cyan('gpb list albums') + ' pour voir les albums disponibles.'));
      return;
    }
    
    syncOptions.albumId = album.id;
    syncOptions.albumTitle = album.title;
    syncTitle = `Synchronisation de l'album "${album.title}"`;
  } else if (options.albumId) {
    syncOptions.albumId = options.albumId;
    syncTitle = `Synchronisation de l'album ID ${options.albumId}`;
  }

  // Filtres de date
  if (options.from || options.to) {
    syncOptions.dateRange = {
      startDate: options.from || '1900-01-01',
      endDate: options.to || '2099-12-31'
    };
    syncTitle += ` (du ${options.from || 'début'} au ${options.to || 'fin'})`;
  }

  // Type de média
  if (options.type !== 'all') {
    syncOptions.mediaTypes = options.type === 'photo' ? ['PHOTO'] : ['VIDEO'];
    syncTitle += ` (${options.type}s seulement)`;
  }

  // Options de synchronisation
  syncOptions.forceResync = options.force || false;
  syncOptions.dryRun = options.dryRun || false;
  syncOptions.maxConcurrent = parseInt(options.concurrent) || 3;
  syncOptions.takeoutOnly = options.takeoutOnly || false;

  console.log(chalk.blue.bold(`🚀 ${syncTitle}${options.dryRun ? ' (SIMULATION)' : ''}\n`));

  if (options.force) {
    console.log(chalk.yellow('⚠️  Mode force activé - les fichiers déjà synchronisés seront re-téléchargés.\n'));
  }

  // Configuration du suivi de progression
  let lastProgress: SyncProgress | null = null;
  
  syncManager.setProgressCallback((progress: SyncProgress) => {
    // Afficher la progression seulement si elle a changé
    if (!lastProgress || 
        lastProgress.processedItems !== progress.processedItems || 
        lastProgress.currentItem !== progress.currentItem) {
      
      const percentage = progress.totalItems > 0 
        ? Math.round((progress.processedItems / progress.totalItems) * 100) 
        : 0;
      
      const progressBar = createProgressBar(percentage, 40);
      
      // Effacer la ligne précédente et afficher la nouvelle progression
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      process.stdout.write(
        `${progressBar} ${percentage}% ` +
        `(${progress.processedItems}/${progress.totalItems}) ` +
        `${progress.currentItem ? `- ${progress.currentItem.substring(0, 30)}...` : ''}`
      );
      
      lastProgress = progress;
    }
  });

  try {
    const result = await syncManager.sync(syncOptions);
    
    // Effacer la ligne de progression
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    
    console.log(chalk.green.bold('\n✅ Synchronisation terminée!\n'));
    console.log(chalk.blue('📊 Résumé:'));
    console.log(chalk.green(`   ✅ Réussies: ${result.successItems}`));
    if (result.skippedItems > 0) {
      console.log(chalk.yellow(`   ⏭️  Ignorées: ${result.skippedItems}`));
    }
    if (result.errorItems > 0) {
      console.log(chalk.red(`   ❌ Erreurs: ${result.errorItems}`));
      console.log(chalk.yellow('   Utilisez ' + chalk.cyan('gpb status') + ' pour voir les détails des erreurs.'));
    }
    
    const totalSizeMB = Math.round(result.processedBytes / 1024 / 1024);
    if (totalSizeMB > 0) {
      console.log(chalk.blue(`   📦 Données transférées: ~${totalSizeMB} MB`));
    }

  } catch (error) {
    // Effacer la ligne de progression
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    throw error;
  }
}

async function resumeCommand(config: AppConfig): Promise<void> {
  const syncManager = new SyncManager(config);

  console.log(chalk.blue('🔄 Tentative de reprise de synchronisation...\n'));

  try {
    const result = await syncManager.resumeSync();
    
    if (!result) {
      console.log(chalk.yellow('ℹ️  Aucune synchronisation à reprendre.'));
      return;
    }

    console.log(chalk.green.bold('✅ Synchronisation reprise et terminée!\n'));
    console.log(chalk.blue('📊 Résumé:'));
    console.log(chalk.green(`   ✅ Réussies: ${result.successItems}`));
    if (result.errorItems > 0) {
      console.log(chalk.red(`   ❌ Erreurs: ${result.errorItems}`));
    }

  } catch (error) {
    console.error(chalk.red('Erreur lors de la reprise:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

async function cleanupCommand(config: AppConfig): Promise<void> {
  const syncManager = new SyncManager(config);

  console.log(chalk.blue('🧹 Nettoyage des fichiers temporaires...'));

  try {
    const deletedCount = await syncManager.cleanup();
    
    if (deletedCount > 0) {
      console.log(chalk.green(`✅ ${deletedCount} fichiers temporaires supprimés.`));
    } else {
      console.log(chalk.yellow('ℹ️  Aucun fichier temporaire à supprimer.'));
    }

  } catch (error) {
    console.error(chalk.red('Erreur lors du nettoyage:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Crée une barre de progression textuelle
 */
function createProgressBar(percentage: number, width: number = 40): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
