import { Command } from 'commander';
import chalk from 'chalk';
import { S3ArchiveWriter, WriterScope } from '../clients/archive-writer';
import { createS3Client } from '../clients/s3-client';
import { ArchiveWriter, IncompleteMultipartUpload } from '../clients/types';
import { AppConfig } from '../config/types';
import {
  currentOwner,
  ExecutionLockedError,
  isProcessAlive,
  LOCK_IDLE_MINUTES,
  RepairExecutionModel,
} from '../database/repair-execution-model';
import { TakeoutPlanModel } from '../database/takeout-plan-model';
import {
  archiveConfirmationMatches,
  ARCHIVE_CONFIRMATION_LENGTH,
  archiveExecutionCommandLine,
  ArchiveExecutionRefusedError,
  ArchiveExecutionResult,
  ArchiveExecutionProgress,
  ArchiveWriteLine,
  executeArchivePlan,
  isArchiveLineDone,
  linesToSend,
} from '../takeout/archive-execution';
import { ArchivePlanRefusedError, locationKey, TakeoutArchivePlan, verifyStoredArchivePlan } from '../takeout/archive-plan';
import { readZipDirectory, localZipSource, ZipEntry } from '../takeout/zip-directory';
import { readWholeZipEntry } from '../takeout/zip-entry-stream';
import { describeError, formatBytes, formatNumber } from '../utils/format';
import { getLogger } from '../utils/logger';
import { ArchivePlanContext, readArchivePlanInput } from './takeout-plan';
import { defaultSources, ensureLocalZips, selectGroups, TakeoutSources } from './takeout';
import { installStopHandlers, liftLock } from './execution-control';
import { runCommand } from './run-command';

/**
 * `gpb takeout archiver` (story 4.3) : envoi des médias `envoyer`/`reclasser_quarantaine`/`quarantaine` du plan
 * d'archivage enregistré (gpb takeout planifier), par le seul point d'accès en écriture (`S3ArchiveWriter.uploadFile`).
 * Sans `--confirmer`, simulation : résumé affiché, aucun client S3 créé, rien d'écrit. Relançable après toute coupure (story 4.4).
 */

export interface ArchiverOptions {
  export: string;
  dossier?: string;
  confirmer?: string;
  leverVerrou?: boolean;
}

export interface ArchiverDeps {
  createWriter: (config: AppConfig, scope: WriterScope) => ArchiveWriter;
  now?: () => Date;
}

export const defaultArchiverDeps: ArchiverDeps = {
  createWriter: (config, scope) => new S3ArchiveWriter(createS3Client(config.cubbit), scope),
};

export function register(takeoutCmd: Command, config: AppConfig, sources: TakeoutSources = defaultSources(config)): void {
  takeoutCmd
    .command('archiver')
    .description(
      'Vérifier le plan d\'archivage enregistré (gpb takeout planifier) contre l\'analyse et l\'inventaire actuels, puis ' +
        `le simuler (défaut) ou l'exécuter avec --confirmer <empreinte> (au moins ${ARCHIVE_CONFIRMATION_LENGTH} caractères). ` +
        'Chaque média est envoyé depuis son zip local vérifié (jamais réextrait sur disque), jamais en écrasant un objet ' +
        'existant. Relançable : reprend une exécution interrompue là où elle s\'est arrêtée, sans rien renvoyer',
    )
    .requiredOption('--export <horodatage>', 'Export dont le plan a été généré (gpb takeout planifier)')
    .option('--dossier <chemin>', 'Dossier de travail local des zips (défaut : data/takeout/<export>/)')
    .option('--confirmer <empreinte>', 'Empreinte du plan (complète ou 12 premiers caractères) : exécute réellement')
    .option(
      '--lever-verrou',
      `Lever le verrou global d'exécution (partagé avec « gpb reparation executer » : une seule passe d'écriture à la fois) d'une exécution ` +
        `arrêtée sans le libérer. Immédiat si le processus qui le détient n'existe plus sur ce poste (coupure, extinction) ; ` +
        `sinon refusé si sa dernière activité date de moins de ${LOCK_IDLE_MINUTES} min`,
    )
    .action((options: ArchiverOptions) =>
      runCommand('Archivage Takeout :', async () => {
        process.exitCode = await archiverCommand(config, sources, options);
      }),
    );
}

const refuse = (message: string): number => {
  console.log(chalk.red(`❌ Exécution refusée, rien n'a été envoyé — ${message}`));
  return 1;
};

const volume = (v: { count: number; size: number }): string => `${chalk.white(formatNumber(v.count))} (${formatBytes(v.size)})`;

export async function archiverCommand(config: AppConfig, sources: TakeoutSources, options: ArchiverOptions, deps: ArchiverDeps = defaultArchiverDeps): Promise<number> {
  console.log(chalk.blue.bold('📤 Archivage Takeout : envoi des médias nouveaux\n'));

  let context: ArchivePlanContext;
  try {
    context = await readArchivePlanInput(config, sources, options.export);
  } catch (error) {
    if (!(error instanceof ArchivePlanRefusedError)) throw error;
    return refuse(error.message);
  }

  const planModel = new TakeoutPlanModel();
  const stored = planModel.find(context.input.exportId);
  if (!stored) return refuse(`aucun plan d'archivage enregistré pour l'export ${context.input.exportId}. Lancez : gpb takeout planifier --export ${context.input.exportId}`);
  const { plan } = stored;

  const problems = verifyStoredArchivePlan(plan, context.input, planModel.findLastRefusal(plan.exportId));
  if (problems.length > 0) {
    for (const problem of problems) console.log(chalk.red(`⚠️  ${problem}`));
    return refuse(`le plan enregistré ${plan.id} n'est pas exécutable en l'état : régénérez-le (gpb takeout planifier --export ${plan.exportId})`);
  }

  const now = deps.now ?? ((): Date => new Date());
  const journal = new RepairExecutionModel();
  if (options.leverVerrou) {
    try {
      liftLock(journal, now());
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  }

  const toSend = linesToSend(plan);
  const states = journal.findStates(plan.id);
  const remaining = toSend.filter((l) => !isArchiveLineDone(l, states));
  console.log(`   Plan : ${chalk.white(plan.id)} (export ${plan.exportId})`);
  console.log(`   Bucket dédié : ${plan.destinationBucket}`);
  console.log(`   À déposer (envois + reclassements + quarantaine) : ${volume({ count: toSend.length, size: toSend.reduce((s, l) => s + l.size, 0) })}`);
  console.log(`   Restant d'après le journal : ${volume({ count: remaining.length, size: remaining.reduce((s, l) => s + l.size, 0) })}`);

  if (options.confirmer === undefined) {
    console.log(chalk.yellow('\n🔎 Simulation : rien n\'a été envoyé.'));
    console.log(`   Pour exécuter : ${archiveExecutionCommandLine(plan.exportId, plan.id)}`);
    return 0;
  }
  if (!archiveConfirmationMatches(plan.id, options.confirmer)) {
    return refuse(`la confirmation « ${options.confirmer} » ne correspond pas à l'empreinte du plan ${plan.id} (empreinte complète ou ses ${ARCHIVE_CONFIRMATION_LENGTH} premiers caractères)`);
  }

  console.log(chalk.cyan(`\n▶️  Exécution confirmée du plan ${plan.id}`));
  const scope: WriterScope = { sourceBucket: config.cubbit.bucket, sourcePrefixes: config.repair.sourcePrefixes, destinationBucket: plan.destinationBucket };
  let writer: ArchiveWriter;
  try {
    writer = deps.createWriter(config, scope);
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

  // Gestionnaires posés dès la prise du verrou : la préparation des zips (téléchargement, revérification) peut être
  // longue, et un signal pendant cette phase ne doit pas laisser le verrou posé.
  const stop = installStopHandlers('du média', () => journal.releaseLock(owner));
  let readMedia: (line: ArchiveWriteLine) => Promise<Buffer>;
  try {
    readMedia = await buildMediaReader(config, sources, plan, options.dossier);
  } catch (error) {
    stop.dispose();
    journal.releaseLock(owner);
    return refuse(error instanceof Error ? error.message : String(error));
  }

  let result: ArchiveExecutionResult;
  try {
    result = await executeArchivePlan(plan, {
      writer,
      journal,
      readMedia,
      shouldStop: stop.stopRequested,
      keepAlive: () => journal.touchLock(owner, now()),
      onProgress: displayProgress,
    });
  } catch (error) {
    if (error instanceof ArchiveExecutionRefusedError) return refuse(error.message);
    throw error;
  } finally {
    stop.dispose();
    journal.releaseLock(owner);
  }

  let incompleteMultipartUploads: IncompleteMultipartUpload[] = [];
  try {
    incompleteMultipartUploads = await writer.listIncompleteMultipartUploads();
  } catch (error) {
    console.log(chalk.yellow(`\n⚠️  Liste des dépôts multipart inachevés impossible (lecture seule, sans conséquence) : ${describeError(error)}`));
  }
  return displayResult(plan, result, incompleteMultipartUploads);
}

/**
 * Lecteur de média : télécharge et vérifie (reprise sans retéléchargement, story 4.2) les zips locaux de l'export, puis
 * lit chaque média en flux depuis son zip, jamais réextrait sur disque.
 */
async function buildMediaReader(config: AppConfig, sources: TakeoutSources, plan: TakeoutArchivePlan, dossier: string | undefined): Promise<(line: ArchiveWriteLine) => Promise<Buffer>> {
  const { zips } = await sources.remoteZips();
  const groups = selectGroups(zips, plan.exportId);
  const group = groups.find((g) => g.id === plan.exportId);
  if (!group) throw new Error(`export ${plan.exportId} introuvable parmi les zips distants`);

  const localZips = await ensureLocalZips(config, sources, group, dossier);

  const entries = new Map<string, { file: string; entry: ZipEntry }>();
  for (const local of localZips) {
    const directoryOf = await readZipDirectory(await localZipSource(local.path));
    for (const entry of directoryOf.entries) entries.set(locationKey({ part: local.name, path: entry.name }), { file: local.path, entry });
  }

  return async (line: ArchiveWriteLine): Promise<Buffer> => {
    const found = entries.get(locationKey(line));
    if (!found) throw new Error(`${line.path} : entrée absente de la partie ${line.part} (zip modifié depuis l'analyse ?)`);
    return readWholeZipEntry(found.file, found.entry);
  };
}

function displayProgress(p: ArchiveExecutionProgress): void {
  process.stdout.write(
    `\r   Envoyés ${formatNumber(p.sent.count)} (${formatBytes(p.sent.size)}), reprises vérifiées ${formatNumber(p.recovered)}, ` +
      `déjà présents ${formatNumber(p.alreadyPresent)}, restants ${formatNumber(p.remaining)}   `,
  );
}

function displayResult(plan: TakeoutArchivePlan, result: ArchiveExecutionResult, incompleteMultipartUploads: IncompleteMultipartUpload[]): number {
  process.stdout.write('\n');
  getLogger().info(
    `Archivage du plan ${plan.id} (export ${plan.exportId}) : ${result.sent.count} envoyés (${result.sent.size} octets), ` +
      `${result.recovered} reprises vérifiées, ${result.alreadyPresent} déjà présents, ${result.skipped} déjà faits, ` +
      `${result.remaining} restants, arrêt ${result.stop ? 'de sûreté' : result.interrupted ? 'demandé' : 'aucun'}, ` +
      `${incompleteMultipartUploads.length} dépôt(s) multipart inachevé(s)`,
  );
  console.log(chalk.cyan('\n📋 Bilan :'));
  console.log(`   Envoyés et vérifiés : ${volume(result.sent)}`);
  console.log(`   Dépôts d'une exécution précédente vérifiés à la reprise (non renvoyés) : ${chalk.white(formatNumber(result.recovered))}`);
  console.log(`   Déjà présents (identiques, non renvoyés) : ${chalk.white(formatNumber(result.alreadyPresent))}`);
  console.log(`   Déjà faits d'après le journal : ${chalk.white(formatNumber(result.skipped))}`);
  console.log(`   Restants : ${chalk.white(formatNumber(result.remaining))}`);
  if (incompleteMultipartUploads.length > 0) {
    console.log(
      chalk.yellow(
        `\n⚠️  ${chalk.white(formatNumber(incompleteMultipartUploads.length))} dépôt(s) multipart inachevé(s) sur ${plan.destinationBucket} — ` +
          'à purger à la main (aws s3api list-multipart-uploads puis abort-multipart-upload, voir docs/RUNBOOK.md) : Cubbit n\'a pas de règle de cycle de vie qui le fasse. Jamais abandonnés par cet outil (NFR-1).',
      ),
    );
  }
  if (result.stop) {
    console.log(chalk.red(`\n❌ Arrêt de sûreté sur ${result.stop.location.part}:${result.stop.location.path} → ${result.stop.destination}`));
    console.log(chalk.red(`   ${result.stop.reason}`));
    console.log(chalk.yellow(`   Relancez : ${archiveExecutionCommandLine(plan.exportId, plan.id)} (après correction)`));
    return 1;
  }
  if (result.interrupted) {
    console.log(chalk.yellow(`\n⏸️  Interrompu. Relancez : ${archiveExecutionCommandLine(plan.exportId, plan.id)}`));
    return 1;
  }
  console.log(chalk.green('\n✅ Terminé. Aucune suppression, nulle part.'));
  return 0;
}
