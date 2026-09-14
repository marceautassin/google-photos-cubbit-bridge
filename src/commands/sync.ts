import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { SyncManager, SyncOptions, SyncProgress } from '../sync/sync-manager';

export function register(program: Command, config: AppConfig): void {
  program
    .command('sync')
    .description('Envoyer vers Cubbit les médias Takeout importés en attente')
    .option('--dry-run', 'Simuler la synchronisation sans envoyer')
    .option('--concurrent <number>', 'Nombre d\'envois simultanés', '3')
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
}

async function syncCommand(config: AppConfig, options: any): Promise<void> {
  const syncManager = new SyncManager(config);

  const syncOptions: SyncOptions = {
    dryRun: options.dryRun || false,
    maxConcurrent: parseInt(options.concurrent) || 3,
  };
  const syncTitle = 'Synchronisation des médias Takeout importés';

  console.log(chalk.blue.bold(`🚀 ${syncTitle}${options.dryRun ? ' (SIMULATION)' : ''}\n`));

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

/**
 * Crée une barre de progression textuelle
 */
function createProgressBar(percentage: number, width: number = 40): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
