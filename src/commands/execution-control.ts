import chalk from 'chalk';
import { RepairExecutionModel } from '../database/repair-execution-model';

/**
 * Pilotage commun des exécutions longues qui écrivent (`gpb reparation executer`, `gpb takeout archiver`) : signaux de
 * fin et levée du verrou global.
 */

/** `Ctrl-C`, `kill` simple et terminal fermé sont traités de la même façon. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface StopHandlers {
  stopRequested: () => boolean;
  /** Retire les gestionnaires (fin d'exécution). */
  dispose: () => void;
}

/**
 * Premier signal : arrêt demandé, l'exécution finit le média (ou la ligne) en cours puis s'arrête. Second signal : sortie
 * immédiate (130), verrou libéré ; la ligne en cours reste « a_faire » ou « copie_en_cours », jamais « copie » : la relance
 * la reprend par un HEAD.
 */
export function installStopHandlers(unit: string, releaseLock: () => void): StopHandlers {
  let requested = false;
  // Terminal fermé (SIGHUP) : écrire sur un TTY raccroché échoue (EIO). L'erreur est ignorée pour que l'arrêt reste
  // propre (fin de la ligne en cours, verrou libéré) au lieu de tuer le processus verrou posé.
  const write = (text: string): void => {
    try {
      process.stdout.write(text);
    } catch {
      // sortie perdue, sans conséquence
    }
  };
  const ignoreOutputError = (): void => {};
  const onSignal = (): void => {
    if (requested) {
      releaseLock();
      write('\n');
      process.exit(130);
    }
    requested = true;
    write(chalk.yellow(`\n⏸️  Arrêt demandé : fin ${unit} en cours (écriture et vérification), puis arrêt. Signal ou Ctrl-C à nouveau pour quitter.\n`));
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  process.stdout.on('error', ignoreOutputError);
  return {
    stopRequested: () => requested,
    dispose: () => {
      for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
      process.stdout.off('error', ignoreOutputError);
    },
  };
}

/** `--lever-verrou` : lève le verrou global et dit pourquoi. Lève une erreur si la levée est refusée. */
export function liftLock(journal: RepairExecutionModel, now: Date): void {
  const lifted = journal.forceReleaseLock(now);
  console.log(
    lifted
      ? chalk.yellow(
          `🔓 Verrou levé (${lifted.reason}) : plan ${lifted.planId}, processus ${lifted.pid} sur ${lifted.host}, ` +
            `pris le ${lifted.acquiredAt.toISOString()}, dernière activité le ${lifted.lastActivityAt.toISOString()}\n`,
        )
      : chalk.gray('   Aucun verrou d\'exécution à lever.\n'),
  );
}
