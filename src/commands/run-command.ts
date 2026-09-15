import chalk from 'chalk';

/** Exécute une commande CLI : toute erreur est affichée en une ligne, code de sortie 1. */
export async function runCommand(errorLabel: string, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    console.error(chalk.red(errorLabel), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
