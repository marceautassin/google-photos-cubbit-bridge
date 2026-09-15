import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { InventoryDateModel } from '../database/inventory-date-model';
import { InventoryModel, InventoryRun } from '../database/inventory-model';
import { PlanSaveOutcome, RepairPlanModel } from '../database/repair-plan-model';
import {
  bucketMismatchHint,
  buildRepairPlan,
  IndexState,
  InventoryStamp,
  occupiedFrom,
  planExport,
  PlanInput,
  PlanRefusedError,
  RepairPlan,
  summarizePlan,
  UNRECOGNIZED_HINT,
  verifyStoredPlan,
} from '../inventory/repair-plan';
import { formatBytes } from '../utils/format';
import { getLogger } from '../utils/logger';
import { runCommand } from './run-command';

/**
 * `gpb plan` : plan de réparation calculé depuis l'index local (story 2.4). Aucun client S3 n'est créé ici : aucune
 * lecture réseau, aucune écriture sur aucun bucket.
 */

interface GenerateOptions {
  bucket?: string;
  destination?: string;
  export?: string;
}

interface ShowOptions {
  bucket?: string;
  destination?: string;
  export?: string;
}

/** Au-delà, les exclusions sont résumées par raison à l'écran ; la liste complète reste dans l'export. */
const MAX_LISTED_EXCLUSIONS = 50;

export function register(program: Command, config: AppConfig): void {
  const planCmd = program
    .command('plan')
    .description('Plan de réparation de l\'archive, calculé depuis l\'index local, sans aucune écriture S3');

  planCmd
    .command('generer')
    .description(
      'Calculer le plan (inventaire + datations + doublons) et le conserver localement ; refusé si l\'index est ' +
        'incomplet. Préfixes source, albums conservés et fichiers ignorés : section « repair » de la configuration',
    )
    .option('--bucket <nom>', 'Bucket source inventorié (défaut : bucket de la configuration)')
    .option('--destination <nom>', 'Bucket dédié (défaut : repair.destinationBucket ou CUBBIT_DESTINATION_BUCKET)')
    .option('--export <fichier>', 'Exporter le plan complet ligne à ligne (.csv ou .json)')
    .action((options: GenerateOptions) => run(() => generateCommand(config, options)));

  planCmd
    .command('afficher')
    .description(
      'Afficher le plan conservé localement et le vérifier contre l\'index et la configuration actuels ' +
        '(plan périmé, empreinte recalculée) ; mêmes options --bucket et --destination qu\'à la génération',
    )
    .option('--bucket <nom>', 'Bucket source inventorié (défaut : bucket de la configuration)')
    .option('--destination <nom>', 'Bucket dédié (défaut : repair.destinationBucket ou CUBBIT_DESTINATION_BUCKET)')
    .option('--export <fichier>', 'Exporter le plan complet ligne à ligne (.csv ou .json)')
    .action((options: ShowOptions) => run(() => showCommand(config, options)));
}

function run(command: () => Promise<void>): Promise<void> {
  return runCommand('Plan de réparation :', async () => {
    try {
      await command();
    } catch (error) {
      if (error instanceof PlanRefusedError) {
        throw new Error(`plan refusé, aucun plan produit ni remplacé — ${error.message}`);
      }
      throw error;
    }
  });
}

const stampOf = (run: InventoryRun | null): InventoryStamp | null =>
  run ? { completedAt: run.completedAt.toISOString(), objectCount: run.objectCount } : null;

/** État actuel de l'index local pour un couple de buckets ; `null` si le bucket source n'est pas inventorié. */
function readIndexState(sourceBucket: string, destinationBucket: string): IndexState | null {
  const inventory = new InventoryModel();
  const sourceInventory = stampOf(inventory.findRun(sourceBucket));
  if (!sourceInventory) return null;
  const hasDestination = destinationBucket !== '' && destinationBucket !== sourceBucket;
  return {
    sourceInventory,
    destinationInventory: hasDestination ? stampOf(inventory.findRun(destinationBucket)) : null,
    datings: new InventoryDateModel().stamp(sourceBucket),
  };
}

/** Buckets source et dédié : options de la commande, sinon configuration. */
export function resolveBuckets(config: AppConfig, options: { bucket?: string; destination?: string }): { bucket: string; destination: string } {
  return { bucket: options.bucket ?? config.cubbit.bucket, destination: options.destination ?? config.repair.destinationBucket };
}

/** Entrée du plan depuis l'index local et la configuration actuels ; refus si le bucket source n'est pas inventorié. */
export function readPlanInput(config: AppConfig, options: { bucket?: string; destination?: string }): PlanInput {
  const { bucket, destination } = resolveBuckets(config, options);
  const index = readIndexState(bucket, destination);
  if (!index) throw new PlanRefusedError(`aucun inventaire local pour le bucket « ${bucket} ». Lancez : gpb inventory scan`);
  const inventory = new InventoryModel();
  return {
    sourceBucket: bucket,
    destinationBucket: destination,
    sourcePrefixes: config.repair.sourcePrefixes,
    supportedFormats: config.sync.supportedFormats,
    keptAlbums: config.repair.keptAlbums,
    ignoredFileNames: config.repair.ignoredFileNames,
    ignoredExtensions: config.repair.ignoredExtensions,
    objects: inventory.findAll(bucket),
    datings: new InventoryDateModel().findAll(bucket),
    index,
    occupied: index.destinationInventory ? occupiedFrom(inventory.findAll(destination)) : [],
  };
}

async function generateCommand(config: AppConfig, options: GenerateOptions): Promise<void> {
  const model = new RepairPlanModel();
  let plan: RepairPlan;
  try {
    plan = buildRepairPlan(readPlanInput(config, options));
  } catch (error) {
    // Le plan courant reste en place, mais « plan afficher » et la 3.1 sauront que la dernière génération a échoué.
    if (error instanceof PlanRefusedError) model.recordRefusal(error.message);
    throw error;
  }
  const outcome = model.save(plan);
  // Plan inchangé : la date de génération reste celle du plan enregistré.
  const generatedAt = model.findCurrent()!.generatedAt;
  getLogger().info(
    `Plan de réparation ${plan.id} (${outcome}) : ${plan.lines.length} lignes, exécutable ${plan.executable}, ` +
      `${plan.exclusions.length} exclusions, ${plan.unrecognized.length} non reconnus, ` +
      `${plan.namingAnomalies.length} anomalies, ${plan.violations.length} invariants en échec`,
  );

  display(plan, generatedAt, outcome, []);
  if (options.export) await exportPlan(plan, options.export, generatedAt);
  if (!plan.executable) process.exitCode = 1;
}

async function showCommand(config: AppConfig, options: ShowOptions): Promise<void> {
  const model = new RepairPlanModel();
  const stored = model.findCurrent();
  const lastRefusal = model.findLastRefusal();
  if (!stored) {
    console.log(chalk.yellow('Aucun plan de réparation local. Lancez : gpb plan generer'));
    if (lastRefusal) console.log(chalk.red(`La dernière génération a été refusée le ${lastRefusal.refusedAt.toLocaleString('fr-FR')} : ${lastRefusal.reason}`));
    return;
  }
  const { plan, generatedAt } = stored;
  let problems: string[];
  try {
    problems = verifyStoredPlan(plan, readPlanInput(config, options), lastRefusal);
  } catch (error) {
    if (!(error instanceof PlanRefusedError)) throw error;
    problems = [`plan périmé : vérification impossible — ${error.message}`];
  }
  const { bucket, destination } = resolveBuckets(config, options);
  const hint = bucketMismatchHint(plan, bucket, destination);
  if (problems.length > 0 && hint) problems.push(hint);
  display(plan, generatedAt, null, problems);
  if (options.export) await exportPlan(plan, options.export, generatedAt);
  if (!plan.executable || problems.length > 0) process.exitCode = 1;
}

async function exportPlan(plan: RepairPlan, file: string, generatedAt: Date): Promise<void> {
  const content = planExport(plan, file, generatedAt);
  await fs.ensureDir(path.dirname(path.resolve(file)));
  await fs.writeFile(file, content, 'utf8');
  const count = plan.lines.length + plan.exclusions.length + plan.unrecognized.length;
  console.log(chalk.green(`\n📄 Plan complet exporté (${count.toLocaleString('fr-FR')} objets) : ${path.resolve(file)}`));
}

const OUTCOME_LABELS: Record<PlanSaveOutcome, string> = {
  cree: 'nouveau plan enregistré',
  remplace: 'plan différent : il remplace le précédent',
  inchange: 'identique au plan déjà enregistré, rien n\'a été réécrit',
  repare: 'plan en base altéré : réécrit à l\'identique',
};

function display(plan: RepairPlan, generatedAt: Date, outcome: PlanSaveOutcome | null, problems: string[]): void {
  const n = (value: number): string => chalk.white(value.toLocaleString('fr-FR'));
  const summary = summarizePlan(plan);
  const { copier, quarantaine, ignorer_doublon: doublon, ignorer_deja_archive: archive } = summary.byAction;
  const { destinationInventory } = plan.index;
  const { config } = plan;

  console.log(chalk.blue.bold('🧭 Plan de réparation (index local, aucune écriture S3)\n'));
  console.log(`   Empreinte : ${chalk.white(plan.id)}`);
  console.log(`   Généré le : ${generatedAt.toLocaleString('fr-FR')}`);
  if (outcome) console.log(`   Enregistrement : ${OUTCOME_LABELS[outcome]}`);
  console.log(`   Bucket source : ${config.sourceBucket} (préfixes : ${config.sourcePrefixes.join(', ')}) → bucket dédié : ${config.destinationBucket}`);
  console.log(
    chalk.gray(
      `   Albums conservés : ${config.keptAlbums.join(', ') || 'aucun'} — formats : ${config.supportedFormats.join(', ')} — ` +
        `extensions ignorées : ${config.ignoredExtensions.join(', ') || 'aucune'}`,
    ),
  );
  console.log(
    destinationInventory
      ? `   Bucket dédié inventorié : oui (${destinationInventory.objectCount.toLocaleString('fr-FR')} objets, destinations occupées prises en compte)`
      : chalk.yellow(
          `   Bucket dédié inventorié : non — destinations occupées supposées vides (gpb inventory scan --bucket ${config.destinationBucket})`,
        ),
  );

  const scopeCount = summary.total + plan.exclusions.length + plan.unrecognized.length;
  console.log('\n' + chalk.cyan(`📋 ${scopeCount.toLocaleString('fr-FR')} objets sous les préfixes source, dont ${summary.total.toLocaleString('fr-FR')} médias dans le plan :`));
  console.log(`   À copier               : ${n(copier.count)} (${formatBytes(copier.size)})`);
  console.log(`   En quarantaine         : ${n(quarantaine.count)} (${formatBytes(quarantaine.size)})`);
  console.log(`   Doublons ignorés       : ${n(doublon.count)} — volume économisé ${chalk.white(formatBytes(doublon.size))}`);
  console.log(`   Déjà archivés          : ${n(archive.count)} (${formatBytes(archive.size)})`);
  console.log(`   Volume total à copier  : ${chalk.white(formatBytes(copier.size + quarantaine.size))} (copies et quarantaine)`);
  const albums = summary.albums.map((a) => `${a.album} ${a.count.toLocaleString('fr-FR')} (${formatBytes(a.size)})`).join(', ');
  console.log(`   Albums conservés       : ${albums || 'aucun média'}`);
  console.log(`   Noms suffixés (collisions de noms) : ${n(summary.renamedCount)}`);
  console.log(`   Exclusions déclarées (noms ou extensions ignorés, marqueurs de dossier) : ${n(plan.exclusions.length)}`);
  for (const { reason, keys, size } of summary.exclusionsByReason) {
    console.log(chalk.gray(`     ${reason} : ${keys.length.toLocaleString('fr-FR')} (${formatBytes(size)})`));
    if (plan.exclusions.length <= MAX_LISTED_EXCLUSIONS) for (const key of keys) console.log(chalk.gray(`       ${key}`));
  }
  if (plan.exclusions.length > MAX_LISTED_EXCLUSIONS) console.log(chalk.gray('     Liste complète : --export'));

  if (plan.unrecognized.length > 0) {
    console.log(chalk.red(`\n❌ ${plan.unrecognized.length.toLocaleString('fr-FR')} objet(s) non reconnu(s) sous les préfixes source (ni média, ni exclusion) :`));
    for (const { extension, keys } of summary.unrecognizedByExtension) {
      console.log(chalk.red(`   ${extension} (${keys.length.toLocaleString('fr-FR')}) :`));
      for (const key of keys) console.log(chalk.red(`     ${key}`));
    }
    console.log(chalk.yellow(`   Pour chacun : ${UNRECOGNIZED_HINT}, puis régénérez le plan.`));
  }

  const invariantsOk = plan.violations.length === 0;
  console.log(`\n${invariantsOk ? chalk.green('✅') : chalk.red('❌')} Invariants de comptes : ${invariantsOk ? 'OK' : 'KO'}`);
  for (const violation of plan.violations) console.log(chalk.red(`   ${violation}`));
  if (plan.namingAnomalies.length > 0) {
    console.log(chalk.red(`❌ ${plan.namingAnomalies.length.toLocaleString('fr-FR')} anomalie(s) de nommage (aucune destination possible) :`));
    for (const anomaly of plan.namingAnomalies) console.log(chalk.red(`   ${anomaly.destination} ← ${anomaly.id} — ${anomaly.reason}`));
  }
  for (const problem of problems) console.log(chalk.red(`⚠️  ${problem}`));

  if (!plan.executable) {
    console.log(chalk.red('❌ Plan exécutable : non — corrigez les points ci-dessus puis régénérez le plan'));
  } else if (problems.length > 0) {
    console.log(chalk.red('❌ Plan exécutable : non en l\'état — plan périmé, différent du recalcul ou dernière génération refusée : régénérez-le (gpb plan generer)'));
  } else {
    console.log(chalk.green('✅ Plan exécutable : oui'));
  }
  console.log(chalk.gray('   Détail ligne à ligne : gpb plan afficher --export plan.csv (ou plan.json)'));
}
