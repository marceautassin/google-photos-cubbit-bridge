import { Command } from 'commander';
import { registerDisabledCommand } from './disabled-command';

/**
 * `gpb sync` et `gpb resume` : DÉSACTIVÉES (story 3.1). L'ancienne synchronisation déposait les médias par envois
 * parallèles, avec la clé de tout l'espace de travail, dans le bucket de la configuration (`marceau`, exemplaire unique),
 * hors du point d'accès en écriture, et pouvait créer un bucket. Le code d'envoi a été supprimé ; les commandes restent
 * visibles dans l'aide pour qu'un ancien mode d'emploi mène à une explication plutôt qu'à « commande inconnue ».
 */

export const DISABLED_MESSAGE =
  'désactivée : l\'archivage des nouveaux Takeout sera reconstruit sur le point d\'accès en écriture (epic 4). ' +
  'Rien n\'a été envoyé.';

export function register(program: Command): void {
  registerDisabledCommand(program, 'sync', 'Envoyer vers Cubbit les médias Takeout importés en attente', DISABLED_MESSAGE);
  registerDisabledCommand(program, 'resume', 'Reprendre une synchronisation interrompue', DISABLED_MESSAGE);
}
