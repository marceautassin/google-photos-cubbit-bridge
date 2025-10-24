#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, validateConfig } from './config';
import { initLogger } from './utils/logger';
import { initDatabase } from './database/connection';
import * as setupCommand from './commands/setup';
import * as authCommand from './commands/auth';
import * as listCommand from './commands/list';
import * as syncCommand from './commands/sync';
import * as statusCommand from './commands/status';
import * as takeoutCommand from './commands/takeout';
import { createArchiveCommand } from './commands/archive';

const program = new Command();

async function main(): Promise<void> {
  try {
    // Configuration du programme CLI
    program
      .name('gpb')
      .description('Google Photos to Cubbit Bridge - Synchronise vos photos Google Photos vers Cubbit')
      .version('1.0.0');

    // Charger la configuration
    const config = await loadConfig();
    
    // Initialiser le logger
    initLogger(config.logging);
    
    // Initialiser la base de données
    await initDatabase(config.database);

    // Enregistrer les commandes
    setupCommand.register(program);
    authCommand.register(program, config);
    listCommand.register(program, config);
    syncCommand.register(program, config);
    statusCommand.register(program, config);
    takeoutCommand.register(program, config);
    program.addCommand(createArchiveCommand());

    // Commande par défaut (aide)
    program.action(() => {
      program.help();
    });

    // Parser les arguments de la ligne de commande
    await program.parseAsync(process.argv);

  } catch (error) {
    console.error('Erreur fatale:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Point d'entrée
if (require.main === module) {
  main().catch(error => {
    console.error('Erreur non gérée:', error);
    process.exit(1);
  });
}

export { main };
