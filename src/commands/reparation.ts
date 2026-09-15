import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { S3ArchiveWriter, WriterScope } from '../clients/archive-writer';
import { createS3Client, destinationClientConfig } from '../clients/s3-client';
import { ArchiveWriter } from '../clients/types';
import {
  currentOwner,
  ExecutionLockedError,
  isProcessAlive,
  LOCK_IDLE_MINUTES,
  RepairExecutionModel,
} from '../database/repair-execution-model';
import { RepairPlanModel } from '../database/repair-plan-model';
import {
  CONFIRMATION_LENGTH,
  confirmationMatches,
  executePlan,
  ExecutionOverview,
  ExecutionProgress,
  ExecutionRefusedError,
  ExecutionResult,
  summarizeExecution,
  VolumeCount,
} from '../inventory/plan-execution';
import { bucketMismatchHint, PlanRefusedError, RepairPlan, verifyStoredPlan } from '../inventory/repair-plan';
import { formatBytes, formatNumber } from '../utils/format';
import { getLogger } from '../utils/logger';
import { readPlanInput } from './plan';
import { runCommand } from './run-command';

/**
 * `gpb reparation executer` : exécution du plan de réparation enregistré vers le bucket dédié (story 3.1). Sans
 * `--confirmer`, simulation : résumé affiché, aucun client S3 créé, rien d'écrit. Toute écriture passe par le point
 * d'accès `S3ArchiveWriter`. Relançable (story 3.2) : la même commande reprend une exécution interrompue.
 */

export interface ExecuteOptions {
  bucket?: string;
  confirmer?: string;
  leverVerrou?: boolean;
}

export interface ExecuteDeps {
  /** Point d'accès en écriture ; créé seulement après vérification du plan et confirmation. */
  createWriter: (config: AppConfig, scope: WriterScope) => ArchiveWriter;
  /** Horloge (activité et levée du verrou) ; injectée par les tests. */
  now?: () => Date;
}

export const defaultDeps: ExecuteDeps = {
  createWriter: (config, scope) => {
    const { config: clientConfig, dedicated } = destinationClientConfig(config.cubbit);
    console.log(
      chalk.gray(`   Identifiants : ${dedicated ? 'paire dédiée au bucket dédié (CUBBIT_DESTINATION_*)' : 'paire principale (CUBBIT_ACCESS_KEY_ID)'}`),
    );
    return new S3ArchiveWriter(createS3Client(clientConfig), scope);
  },
};

export function register(program: Command, config: AppConfig): void {
  const reparationCmd = program
    .command('reparation')
    .description('Exécution du plan de réparation vers le bucket dédié (copie côté serveur, aucune suppression)');

  reparationCmd
    .command('executer')
    .description(
      'Vérifier le plan enregistré contre l\'index et la configuration actuels, puis le simuler (défaut) ou l\'exécuter ' +
        `avec --confirmer <empreinte> (au moins ${CONFIRMATION_LENGTH} caractères). Bucket dédié : repair.destinationBucket ` +
        'ou CUBBIT_DESTINATION_BUCKET, jamais une option. Relançable : reprend une exécution interrompue là où elle ' +
        's\'est arrêtée, sans recopier ce qui est déjà copié',
    )
    .option('--bucket <nom>', 'Bucket source du plan (défaut : bucket de la configuration)')
    .option('--confirmer <empreinte>', 'Empreinte du plan (complète ou 12 premiers caractères) : exécute réellement')
    .option(
      '--lever-verrou',
      `Lever le verrou d'une exécution arrêtée sans le libérer (refusé si sa dernière activité date de moins de ${LOCK_IDLE_MINUTES} min)`,
    )
    .action((options: ExecuteOptions) =>
      runCommand('Exécution du plan :', async () => {
        process.exitCode = await executeCommand(config, options);
      }),
    );
}

const refuse = (message: string): number => {
  console.log(chalk.red(`❌ Exécution refusée, rien n'a été écrit — ${message}`));
  return 1;
};

const volume = ({ count, size }: VolumeCount): string => `${chalk.white(formatNumber(count))} (${formatBytes(size)})`;

/** Exécute la commande ; rend le code de sortie. */
export async function executeCommand(config: AppConfig, options: ExecuteOptions, deps: ExecuteDeps = defaultDeps): Promise<number> {
  console.log(chalk.blue.bold('🚚 Exécution du plan de réparation\n'));
  const planModel = new RepairPlanModel();
  const stored = planModel.findCurrent();
  if (!stored) return refuse('aucun plan de réparation enregistré. Lancez : gpb plan generer');
  const { plan } = stored;

  const destination = config.repair.destinationBucket;
  if (destination === '') return refuse('aucun bucket dédié configuré (repair.destinationBucket ou CUBBIT_DESTINATION_BUCKET)');
  if (plan.config.destinationBucket !== destination) {
    return refuse(
      `le plan vise le bucket dédié « ${plan.config.destinationBucket} », la configuration « ${destination} » : ` +
        'régénérez le plan avec le bucket dédié configuré',
    );
  }

  const problems = verifyPlan(config, options, plan, planModel);
  if (problems.length > 0) {
    for (const problem of problems) console.log(chalk.red(`⚠️  ${problem}`));
    return refuse(`le plan enregistré ${plan.id} n'est pas exécutable en l'état : régénérez-le (gpb plan generer)`);
  }

  const now = deps.now ?? ((): Date => new Date());
  const journal = new RepairExecutionModel();
  if (options.leverVerrou) {
    let lifted;
    try {
      lifted = journal.forceReleaseLock(now());
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
    console.log(
      lifted
        ? chalk.yellow(
            `🔓 Verrou levé : processus ${lifted.pid} sur ${lifted.host}, pris le ${lifted.acquiredAt.toISOString()}, ` +
              `dernière activité le ${lifted.lastActivityAt.toISOString()}\n`,
          )
        : chalk.gray('   Aucun verrou d\'exécution à lever.\n'),
    );
  }
  displayOverview(plan, summarizeExecution(plan, journal.findStates(plan.id)));

  if (options.confirmer === undefined) {
    console.log(chalk.yellow('\n🔎 Simulation : rien n\'a été écrit.'));
    const bucketOption = options.bucket ? ` --bucket ${options.bucket}` : '';
    console.log(`   Pour exécuter : gpb reparation executer${bucketOption} --confirmer ${plan.id.slice(0, CONFIRMATION_LENGTH)}`);
    return 0;
  }
  if (!confirmationMatches(plan.id, options.confirmer)) {
    return refuse(
      `la confirmation « ${options.confirmer} » ne correspond pas à l'empreinte du plan ${plan.id} ` +
        `(empreinte complète ou ses ${CONFIRMATION_LENGTH} premiers caractères)`,
    );
  }

  console.log(chalk.cyan(`\n▶️  Exécution confirmée du plan ${plan.id}`));
  let writer: ArchiveWriter;
  try {
    writer = deps.createWriter(config, {
      sourceBucket: plan.config.sourceBucket,
      sourcePrefixes: plan.config.sourcePrefixes,
      destinationBucket: destination,
    });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  const owner = currentOwner();
  try {
    journal.acquireLock(plan.id, owner, isProcessAlive, now());
  } catch (error) {
    if (error instanceof ExecutionLockedError) return refuse(error.message);
    throw error;
  }

  let stopRequested = false;
  const onSigint = (): void => {
    if (stopRequested) {
      // Second Ctrl-C : sortie immédiate, verrou libéré. La ligne en cours reste « a_faire » ou « copie_en_cours », jamais
      // « copie » : la relance la reprend par un HEAD.
      journal.releaseLock(owner);
      process.stdout.write('\n');
      process.exit(130);
    }
    stopRequested = true;
    process.stdout.write(chalk.yellow('\n⏸️  Arrêt demandé : fin de la ligne en cours (copie et vérification), puis arrêt. Ctrl-C à nouveau pour quitter.\n'));
  };
  process.on('SIGINT', onSigint);
  let result: ExecutionResult;
  try {
    result = await executePlan(plan, {
      writer,
      journal,
      shouldStop: () => stopRequested,
      keepAlive: () => journal.touchLock(owner, now()),
      onProgress: displayProgress,
    });
  } catch (error) {
    if (error instanceof ExecutionRefusedError) return refuse(error.message);
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    journal.releaseLock(owner);
  }
  return displayResult(plan, result);
}

/** Consignes 2.4 : vérification complète du plan relu (fraîcheur, empreinte, invariants, recalcul). */
function verifyPlan(config: AppConfig, options: ExecuteOptions, plan: RepairPlan, planModel: RepairPlanModel): string[] {
  const destination = config.repair.destinationBucket;
  let problems: string[];
  try {
    problems = verifyStoredPlan(plan, readPlanInput(config, { bucket: options.bucket, destination }), planModel.findLastRefusal());
  } catch (error) {
    if (!(error instanceof PlanRefusedError)) throw error;
    problems = [`plan périmé : vérification impossible — ${error.message}`];
  }
  const hint = bucketMismatchHint(plan, options.bucket ?? config.cubbit.bucket, destination);
  if (problems.length > 0 && hint) problems.push(hint);
  return problems;
}

function displayOverview(plan: RepairPlan, overview: ExecutionOverview): void {
  console.log(`   Plan : ${chalk.white(plan.id)}`);
  console.log(`   Bucket source : ${plan.config.sourceBucket} (lecture seule) → bucket dédié : ${plan.config.destinationBucket}`);
  console.log(`   À copier (photos/, albums/) : ${volume(overview.copier)}`);
  console.log(`   En quarantaine (quarantaine/) : ${volume(overview.quarantaine)}`);
  console.log(`   Déjà faites d'après le journal de ce plan : ${volume(overview.done)}`);
  console.log(`   Restantes : ${volume(overview.remaining)}`);
  if (overview.done.count + overview.inProgress.count + overview.failed.count > 0) {
    console.log(chalk.cyan('   Reprise d\'une exécution précédente de ce plan :'));
    console.log(`     déjà copiés ou présents : ${volume(overview.done)}`);
    console.log(`     copies en cours, à vérifier (HEAD, sans recopie si conformes) : ${volume(overview.inProgress)}`);
    console.log(`     en échec, à retenter : ${volume(overview.failed)}`);
    console.log(`     jamais traitées : ${volume(overview.notStarted)}`);
    for (const failure of overview.failures) {
      console.log(chalk.yellow(`     ⚠️  ${failure.sourceKey} → ${failure.destination} : ${failure.reason}`));
    }
  }
  console.log(chalk.gray('   Doublons et déjà archivés : aucune écriture. Aucune suppression, nulle part.'));
}

function displayProgress(p: ExecutionProgress): void {
  process.stdout.write(
    `\r   Copiés ${formatNumber(p.copied.count)} (${formatBytes(p.copied.size)}), reprises vérifiées ${formatNumber(p.recovered)}, ` +
      `déjà présents ${formatNumber(p.alreadyPresent)}, ` +
      `restants ${formatNumber(p.remaining)}   `,
  );
}

function displayResult(plan: RepairPlan, result: ExecutionResult): number {
  process.stdout.write('\n');
  getLogger().info(
    `Exécution du plan ${plan.id} : ${result.copied.count} copiés (${result.copied.size} octets), ${result.recovered} reprises ` +
      `vérifiées, ${result.alreadyPresent} déjà ` +
      `présents, ${result.skipped} déjà faits, ${result.remaining} restants, arrêt ${result.stop ? 'de sûreté' : result.interrupted ? 'demandé' : 'aucun'}`,
  );
  console.log(chalk.cyan('\n📋 Bilan :'));
  console.log(`   Copiés et vérifiés : ${volume(result.copied)}`);
  console.log(`   Copies d'une exécution précédente vérifiées à la reprise (non recopiées) : ${chalk.white(formatNumber(result.recovered))}`);
  console.log(`   Déjà présents (identiques, non recopiés) : ${chalk.white(formatNumber(result.alreadyPresent))}`);
  console.log(`   Déjà faits d'après le journal : ${chalk.white(formatNumber(result.skipped))}`);
  console.log(`   Restants : ${chalk.white(formatNumber(result.remaining))}`);
  if (result.stop) {
    getLogger().error(`Arrêt de sûreté sur ${result.stop.sourceKey} → ${result.stop.destination} : ${result.stop.reason}`);
    console.log(chalk.red(`\n❌ Arrêt de sûreté sur ${result.stop.sourceKey}`));
    console.log(chalk.red(`   → ${result.stop.destination}`));
    console.log(chalk.red(`   ${result.stop.reason}`));
    console.log(chalk.yellow('   Rien n\'a été écrasé ni supprimé. Examinez l\'anomalie avant de relancer la commande.'));
    console.log(
      chalk.yellow(
        '   Cause passagère (réseau, serveur) : relancez, la ligne sera retentée. Anomalie (objet différent, source ' +
          'modifiée) : la relance s\'arrêtera sur cette ligne tant qu\'elle subsiste.',
      ),
    );
    return 1;
  }
  if (result.interrupted) {
    console.log(chalk.yellow('\n⏸️  Exécution interrompue. Relancez la même commande : elle reprendra où elle s\'est arrêtée, sans recopier.'));
    return 1;
  }
  console.log(chalk.green('\n✅ Plan exécuté : toutes les lignes à écrire sont copiées et vérifiées, ou déjà présentes.'));
  return 0;
}
