#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config';
import { initLogger } from './utils/logger';
import { initDatabase } from './database/connection';
import * as setupCommand from './commands/setup';
import * as takeoutCommand from './commands/takeout';
import * as inventoryCommand from './commands/inventory';
import * as planCommand from './commands/plan';
import * as etatCommand from './commands/etat';
import * as reparationCommand from './commands/reparation';

const program = new Command();

async function main(): Promise<void> {
  try {
    // Configuration du programme CLI
    program
      .name('gpb')
      .description('Google Photos to Cubbit Bridge - Archive vos exports Google Takeout vers Cubbit')
      .version('1.0.0');

    // Charger la configuration
    const config = await loadConfig();
    
    // Initialiser le logger
    initLogger(config.logging);
    
    // Initialiser la base de données
    await initDatabase(config.database);

    // Enregistrer les commandes
    setupCommand.register(program);
    takeoutCommand.register(program, config);
    inventoryCommand.register(program, config);
    planCommand.register(program, config);
    etatCommand.register(program, config);
    reparationCommand.register(program, config);

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
