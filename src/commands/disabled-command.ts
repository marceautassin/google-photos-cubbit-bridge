import { Command } from 'commander';
import chalk from 'chalk';

/**
 * Enregistre une commande désactivée : visible dans l'aide avec la mention « (désactivée) », elle accepte n'importe quels
 * arguments et options pour qu'un ancien mode d'emploi mène à une explication plutôt qu'à « commande inconnue », refuse
 * avec un message en français et un code de sortie 1, sans rien lire ni envoyer.
 */
export function registerDisabledCommand(parent: Command, name: string, description: string, message: string): Command {
  const label = parent.parent ? `${parent.name()} ${name}` : name;
  return parent
    .command(name)
    .description(`(désactivée) ${description}`)
    .allowUnknownOption()
    .allowExcessArguments(true)
    .action(() => {
      console.error(chalk.red(`❌ gpb ${label} : ${message}`));
      process.exitCode = 1;
    });
}
