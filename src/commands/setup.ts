import { Command } from 'commander';
import * as readline from 'readline';
import chalk from 'chalk';
import { saveConfig, loadConfig, validateConfig } from '../config';

export function register(program: Command): void {
  program
    .command('setup')
    .description('Configuration initiale de l\'application')
    .option('--reset', 'Réinitialiser la configuration existante')
    .action(async (options) => {
      try {
        await setupCommand(options);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la configuration:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

async function setupCommand(options: { reset?: boolean }): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query: string): Promise<string> => {
    return new Promise(resolve => rl.question(query, resolve));
  };

  try {
    console.log(chalk.blue.bold('🚀 Configuration Google Photos → Cubbit Bridge\\n'));

    // Charger la configuration existante
    const config = await loadConfig();
    
    if (options.reset) {
      console.log(chalk.yellow('Réinitialisation de la configuration...\\n'));
    }

    console.log(chalk.cyan('🗃️  Configuration Cubbit:'));
    
    const cubbitEndpoint = await question(`Endpoint Cubbit (actuel: ${config.cubbit.endpoint || 'non défini'}): `);
    if (cubbitEndpoint.trim()) {
      config.cubbit.endpoint = cubbitEndpoint.trim();
    }

    const cubbitAccessKey = await question(`Access Key ID (actuel: ${config.cubbit.accessKeyId || 'non défini'}): `);
    if (cubbitAccessKey.trim()) {
      config.cubbit.accessKeyId = cubbitAccessKey.trim();
    }

    const cubbitSecretKey = await question(`Secret Access Key (actuel: ${config.cubbit.secretAccessKey ? '***masqué***' : 'non défini'}): `);
    if (cubbitSecretKey.trim()) {
      config.cubbit.secretAccessKey = cubbitSecretKey.trim();
    }

    const cubbitBucket = await question(`Nom du bucket (actuel: ${config.cubbit.bucket}): `);
    if (cubbitBucket.trim()) {
      config.cubbit.bucket = cubbitBucket.trim();
    }

    const cubbitRegion = await question(`Région (actuel: ${config.cubbit.region}): `);
    if (cubbitRegion.trim()) {
      config.cubbit.region = cubbitRegion.trim();
    }

    console.log('\\n' + chalk.cyan('⚙️  Configuration de synchronisation:'));
    
    const maxConcurrent = await question(`Téléchargements simultanés max (actuel: ${config.sync.maxConcurrentDownloads}): `);
    if (maxConcurrent.trim() && !isNaN(parseInt(maxConcurrent))) {
      config.sync.maxConcurrentDownloads = parseInt(maxConcurrent);
    }

    const preserveStructure = await question(`Préserver la structure de dossiers? (y/n, actuel: ${config.sync.preserveFolderStructure ? 'y' : 'n'}): `);
    if (preserveStructure.toLowerCase() === 'y' || preserveStructure.toLowerCase() === 'n') {
      config.sync.preserveFolderStructure = preserveStructure.toLowerCase() === 'y';
    }

    // Valider la configuration
    const errors = validateConfig(config);
    if (errors.length > 0) {
      console.log('\\n' + chalk.red('❌ Erreurs de configuration:'));
      errors.forEach(error => console.log(chalk.red(`  • ${error}`)));
      console.log('\\n' + chalk.yellow('⚠️  La configuration sera sauvegardée mais certaines fonctionnalités ne marcheront pas.'));
    }

    // Sauvegarder la configuration
    await saveConfig(config);

    console.log('\\n' + chalk.green('✅ Configuration sauvegardée avec succès!\\n'));

    if (errors.length === 0) {
      console.log(chalk.blue('📋 Prochaines étapes:'));
      console.log('  1. Validez vos exports Takeout avec ' + chalk.cyan('gpb takeout valider'));
      console.log('  2. Suivez ensuite le cycle complet décrit dans ' + chalk.cyan('docs/RUNBOOK.md'));
    } else {
      console.log(chalk.yellow('⚠️  Corrigez les erreurs de configuration avant de continuer.'));
    }

  } finally {
    rl.close();
  }
}
