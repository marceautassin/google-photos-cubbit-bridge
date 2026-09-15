import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { InventoryModel } from '../database/inventory-model';
import { RepairPlanModel } from '../database/repair-plan-model';
import { ArchiveState, buildArchiveState, PlanState, recommendAction, VolumeCount } from '../inventory/archive-state';
import { formatBytes, formatDate, formatNumber } from '../utils/format';
import { readPlanInput, resolveBuckets } from './plan';
import { runCommand } from './run-command';

/**
 * `gpb etat` : état de l'archive à la demande (story 2.5), depuis l'index local uniquement. Aucun client S3 créé, aucune
 * écriture (ni S3, ni base).
 */

interface EtatOptions {
  bucket?: string;
  destination?: string;
}

export function register(program: Command, config: AppConfig): void {
  program
    .command('etat')
    .description(
      'État de l\'archive depuis l\'index local, sans appel réseau : inventaire, périmètre photo, répartition par année, ' +
        'doublons, quarantaine, état du plan et prochaine action recommandée. Écran de consultation : code de sortie ' +
        'toujours 0. Pour un contrôle, « gpb plan afficher » vérifie le plan et renvoie 1 s\'il n\'est pas exécutable',
    )
    .option('--bucket <nom>', 'Bucket source inventorié (défaut : bucket de la configuration)')
    .option('--destination <nom>', 'Bucket dédié (défaut : repair.destinationBucket ou CUBBIT_DESTINATION_BUCKET)')
    .action((options: EtatOptions) => runCommand('État de l\'archive :', async () => etatCommand(config, options)));
}

async function etatCommand(config: AppConfig, options: EtatOptions): Promise<void> {
  const { bucket } = resolveBuckets(config, options);
  const inventoryRun = new InventoryModel().findRun(bucket);
  console.log(chalk.blue.bold('🗄️  État de l\'archive (index local, aucun appel réseau)\n'));
  if (!inventoryRun) {
    console.log(chalk.yellow(`Aucun inventaire local pour le bucket « ${bucket} ».`));
    console.log(chalk.green(`\n👉 Prochaine action : ${recommendAction(null)}`));
    return;
  }
  const model = new RepairPlanModel();
  display(
    buildArchiveState({
      inventoryRun,
      planInput: readPlanInput(config, options),
      storedPlan: model.findCurrent(),
      lastRefusal: model.findLastRefusal(),
    }),
  );
}

const volume = ({ count, size }: VolumeCount, unit = 'média(s)'): string =>
  `${chalk.white(formatNumber(count))} ${unit} (${formatBytes(size)})`;

const PLAN_LABELS: Record<PlanState, string> = {
  absent: chalk.yellow('aucun plan enregistré'),
  a_jour: chalk.green('à jour et exécutable'),
  perime: chalk.red('périmé'),
  non_executable: chalk.red('non exécutable en l\'état'),
};

function display(state: ArchiveState): void {
  const { inventory, scope, years, duplicates, plan } = state;

  console.log(chalk.cyan(`📋 Inventaire du bucket « ${inventory.bucket} »`));
  console.log(`   Dernier scan : ${formatDate(inventory.completedAt)}`);
  console.log(`   Volumétrie totale : ${volume({ count: inventory.objectCount, size: inventory.totalSize }, 'objet(s)')}`);

  if (scope.prefixes.length === 0) {
    console.log('\n' + chalk.red('📸 Périmètre photo : aucun préfixe source configuré (repair.sourcePrefixes est vide)'));
  } else {
    console.log('\n' + chalk.cyan(`📸 Périmètre photo (${scope.prefixes.join(', ')})`));
  }
  console.log(`   Objets sous les préfixes : ${volume(scope.objects, 'objet(s)')}`);
  console.log(`   Médias                   : ${volume(scope.media)}`);
  console.log(`   Exclusions déclarées     : ${volume(scope.exclusions, 'objet(s)')}`);
  const unrecognized = `   Non reconnus             : ${volume(scope.unrecognized, 'objet(s)')}`;
  console.log(
    scope.unrecognized.count > 0 ? chalk.red(`${unrecognized} — ${scope.unrecognized.extensions.join(', ')}`) : unrecognized,
  );

  console.log('\n' + chalk.cyan('🗓️  Répartition par année (date reconstruite)'));
  if (years.years.length === 0) console.log('   Aucun média daté.');
  for (const row of years.years) {
    const suspects = row.suspectCount > 0 ? chalk.yellow(` — dont ${formatNumber(row.suspectCount)} date(s) suspecte(s)`) : '';
    console.log(`   ${row.year} : ${formatNumber(row.count).padStart(7)} média(s) ${formatBytes(row.size).padStart(10)}${suspects}`);
  }
  console.log(`   Date indéterminée : ${volume(years.indeterminate)}`);
  const undated = `   Non datés (datation absente ou périmée) : ${volume(years.undated)}`;
  console.log(years.undated.count > 0 ? chalk.yellow(undated) : undated);

  console.log('\n' + chalk.cyan('📑 Doublons'));
  console.log(
    `   Confirmés : ${chalk.white(formatNumber(duplicates.groupCount))} groupe(s), ${chalk.white(formatNumber(duplicates.extraCopyCount))} ` +
      `copie(s) en trop — volume récupérable ${chalk.white(formatBytes(duplicates.recoverableSize))}`,
  );
  console.log(
    `   Présumés non confirmables (ETag absent ou différent) : ${chalk.white(formatNumber(duplicates.unconfirmedGroupCount))} ` +
      `groupe(s), au plus ${formatBytes(duplicates.unconfirmedSize)} — hors volume récupérable`,
  );

  console.log('\n' + chalk.cyan('🚧 Quarantaine'));
  const { quarantine } = state;
  if (quarantine.kind === 'plan') {
    const stale = quarantine.planUpToDate ? '' : chalk.yellow(' (d\'après un plan qui n\'est pas à jour)');
    console.log(`   Prévue par le plan : ${volume(quarantine.volume)}${stale}`);
  } else if (quarantine.kind === 'estimation_impossible') {
    console.log(chalk.yellow(`   Aucun plan : estimation impossible, ${formatNumber(quarantine.undatedCount)} média(s) non daté(s)`));
  } else {
    console.log(`   Aucun plan : au plus ${volume(quarantine.volume)} à date indéterminée (albums et doublons compris)`);
  }

  console.log('\n' + chalk.cyan('🧭 Plan de réparation'));
  console.log(`   État : ${PLAN_LABELS[plan.state]}`);
  if (plan.id && plan.generatedAt) console.log(chalk.gray(`   Plan ${plan.id.slice(0, 12)}… généré le ${formatDate(plan.generatedAt)}`));
  for (const reason of plan.reasons) console.log(chalk.red(`   ⚠️  ${reason}`));

  console.log(chalk.green(`\n👉 Prochaine action : ${state.nextAction}`));
}
