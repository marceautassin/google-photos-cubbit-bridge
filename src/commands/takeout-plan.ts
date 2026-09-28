import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { InventoryModel } from '../database/inventory-model';
import { StoredTakeoutAnalysis, TakeoutAnalysisModel } from '../database/takeout-analysis-model';
import { ArchivePlanSaveOutcome, TakeoutPlanModel } from '../database/takeout-plan-model';
import { csvDocument } from '../inventory/repair-plan';
import {
  archivedObjectsFrom,
  ArchivePlanRefusedError,
  buildArchivePlan,
  TAKEOUT_PLAN_ACTIONS,
  TakeoutArchivePlan,
  TakeoutPlanAction,
  TakeoutPlanInput,
} from '../takeout/archive-plan';
import { linesToSend } from '../takeout/archive-execution';
import { archivedScope, summarizeAnalysis } from '../takeout/takeout-analysis';
import { formatBytes, formatNumber } from '../utils/format';
import { getLogger } from '../utils/logger';
import { defaultSources, selectGroups, TakeoutSources } from './takeout';
import { runCommand } from './run-command';

/**
 * `gpb takeout planifier` (story 4.3) : plan d'archivage d'un export déjà analysé (4.2), calculé depuis l'analyse
 * enregistrée et l'inventaire local du bucket dédié. Aucune écriture, ni dans un bucket, ni en dehors de la base
 * locale (plan enregistré pour `gpb takeout archiver`).
 */

interface PlanifierOptions {
  export: string;
  sortie?: string[];
}

export function register(takeoutCmd: Command, config: AppConfig, sources: TakeoutSources = defaultSources(config)): void {
  takeoutCmd
    .command('planifier')
    .description(
      'Générer (ou revérifier) le plan d\'archivage d\'un export analysé (gpb takeout analyser) : une ligne par média ' +
        '— envoyer, déjà archivé, doublon interne, à reclasser ou en quarantaine. Aucune écriture. Exige une analyse ' +
        'valide et un inventaire du bucket dédié au moins aussi récent que celui utilisé par l\'analyse',
    )
    .requiredOption('--export <horodatage>', 'Export déjà analysé (ex. 20260806T062636Z)')
    .option('--sortie <fichiers...>', 'Exporter le plan complet ligne à ligne (.csv et/ou .json)')
    .action((options: PlanifierOptions) => runCommand('Plan d\'archivage Takeout :', () => planifierCommand(config, sources, options)));
}

export interface ArchivePlanContext {
  input: TakeoutPlanInput;
  analysis: StoredTakeoutAnalysis;
}

/**
 * Entrée du plan depuis l'analyse enregistrée et l'inventaire local actuels ; refuse (sans écrire) si l'analyse est
 * absente ou périmée (zips ou albums conservés différents), ou si l'inventaire du bucket dédié est antérieur à celui
 * utilisé par l'analyse. Un inventaire plus récent est accepté et utilisé pour les destinations occupées : les statuts
 * d'archivage de l'analyse (4.2) ne sont jamais recalculés ici.
 */
export async function readArchivePlanInput(config: AppConfig, sources: TakeoutSources, exportId: string): Promise<ArchivePlanContext> {
  const bucket = config.repair.destinationBucket;
  if (!bucket) throw new ArchivePlanRefusedError('aucun bucket dédié configuré (CUBBIT_DESTINATION_BUCKET ou repair.destinationBucket)');

  const { zips } = await sources.remoteZips();
  const groups = selectGroups(zips, exportId);
  if (groups.length > 1) {
    throw new ArchivePlanRefusedError(`« ${exportId} » désigne plusieurs exports (${groups.map((g) => g.id).join(', ')}) : précisez l'identifiant complet`);
  }
  const group = groups[0]!;
  const currentZips = group.parts.map((p) => ({ name: p.zip.name, size: p.zip.size, etag: p.zip.etag ?? null }));

  const analysis = new TakeoutAnalysisModel().findValid(group.id, {
    zips: currentZips,
    inventoryCompletedAt: undefined, // vérifié séparément ci-dessous (postérieur ou égal accepté, pas seulement égal)
    keptAlbums: config.takeout.keptAlbums,
  });
  if (!analysis) {
    throw new ArchivePlanRefusedError(
      `aucune analyse valide pour l'export ${group.id} (absente, zips ou albums conservés différents) : relancez ` +
        `gpb takeout analyser --export ${group.id} --parties <n>`,
    );
  }

  const inventory = new InventoryModel();
  const inventoryRun = inventory.findRun(bucket);
  if (!inventoryRun) {
    throw new ArchivePlanRefusedError(`aucun inventaire local du bucket dédié « ${bucket} » : lancez gpb inventory scan --bucket ${bucket}`);
  }
  const completedAt = inventoryRun.completedAt.toISOString();
  if (completedAt < analysis.inventoryCompletedAt!) {
    throw new ArchivePlanRefusedError(
      `inventaire du bucket dédié « ${bucket} » (${completedAt}) antérieur à celui utilisé par l'analyse ` +
        `(${analysis.inventoryCompletedAt}) : lancez gpb inventory scan --bucket ${bucket}`,
    );
  }

  const input: TakeoutPlanInput = {
    exportId: analysis.exportId,
    destinationBucket: bucket,
    keptAlbums: config.takeout.keptAlbums,
    analysisAnalyzedAt: analysis.analyzedAt,
    media: analysis.media,
    occupied: archivedObjectsFrom(archivedScope(inventory.findAll(bucket))),
    destinationInventoryCompletedAt: completedAt,
  };
  return { input, analysis };
}

async function planifierCommand(config: AppConfig, sources: TakeoutSources, options: PlanifierOptions): Promise<void> {
  console.log(chalk.blue.bold('🗂️  Plan d\'archivage Takeout (lecture seule, aucune écriture)\n'));
  const model = new TakeoutPlanModel();
  let context: ArchivePlanContext;
  try {
    context = await readArchivePlanInput(config, sources, options.export);
  } catch (error) {
    if (!(error instanceof ArchivePlanRefusedError)) throw error;
    console.log(chalk.red(`❌ ${error.message}`));
    process.exitCode = 1;
    return;
  }

  let plan: TakeoutArchivePlan;
  try {
    plan = buildArchivePlan(context.input);
  } catch (error) {
    if (!(error instanceof ArchivePlanRefusedError)) throw error;
    model.recordRefusal(context.input.exportId, error.message);
    console.log(chalk.red(`❌ plan refusé, aucun plan produit ni remplacé — ${error.message}`));
    process.exitCode = 1;
    return;
  }
  const outcome = model.save(plan);
  getLogger().info(
    `Plan d'archivage ${plan.id} (${outcome}) de l'export ${plan.exportId} : ${plan.lines.length} lignes, ` +
      `exécutable ${plan.executable}, ${plan.namingAnomalies.length} anomalies, ${plan.violations.length} invariants en échec`,
  );

  display(plan, context, outcome);
  for (const file of options.sortie ?? []) await exportPlan(plan, file);
  if (!plan.executable) process.exitCode = 1;
}

const OUTCOME_LABELS: Record<ArchivePlanSaveOutcome, string> = {
  cree: 'nouveau plan enregistré',
  remplace: 'plan différent : il remplace le précédent',
  inchange: 'identique au plan déjà enregistré, rien n\'a été réécrit',
  repare: 'plan en base altéré : réécrit à l\'identique',
};

const ACTION_LABELS: Record<TakeoutPlanAction, string> = {
  envoyer: 'À envoyer',
  ignorer_deja_archive: 'Déjà archivés (ignorés)',
  ignorer_doublon_interne: 'Doublons internes (ignorés)',
  reclasser_quarantaine: 'À reclasser (actuellement en quarantaine)',
  quarantaine: 'En quarantaine (date indéterminée)',
};

function byAction(plan: TakeoutArchivePlan): Map<TakeoutPlanAction, { count: number; size: number }> {
  const totals = new Map(TAKEOUT_PLAN_ACTIONS.map((a) => [a, { count: 0, size: 0 }]));
  for (const l of plan.lines) {
    const v = totals.get(l.action)!;
    v.count++;
    v.size += l.size;
  }
  return totals;
}

function display(plan: TakeoutArchivePlan, context: ArchivePlanContext, outcome: ArchivePlanSaveOutcome | null): void {
  const n = (value: number): string => chalk.white(formatNumber(value));
  const totals = byAction(plan);
  const summary = summarizeAnalysis(context.analysis.media, { timeZone: context.analysis.timeZone, keptAlbums: context.analysis.keptAlbums });

  console.log(`Export : ${chalk.white(plan.exportId)}`);
  console.log(`Empreinte du plan : ${chalk.white(plan.id)}`);
  if (outcome) console.log(`Enregistrement : ${OUTCOME_LABELS[outcome]}`);
  console.log(`Bucket dédié : ${plan.destinationBucket} (inventaire du ${plan.destinationInventoryCompletedAt ?? '—'})`);
  console.log(`Albums conservés : ${plan.keptAlbums.join(', ') || 'aucun'}\n`);

  for (const action of TAKEOUT_PLAN_ACTIONS) {
    const { count, size } = totals.get(action)!;
    console.log(`   ${ACTION_LABELS[action].padEnd(46)} ${n(count)} (${formatBytes(size)})`);
  }
  const toSend = totals.get('envoyer')!;
  console.log(chalk.bold(`\n   Volume à envoyer : ${n(toSend.count)} (${formatBytes(toSend.size)})`));
  // Même total que le « À déposer » affiché par `gpb takeout archiver` (story 4.3, correction : harmonisation des
  // libellés) : celui que Marceau confirme juste avant la première écriture, envois, reclassements et quarantaine
  // compris (`linesToSend`), pas seulement les envois.
  const toDeposit = linesToSend(plan);
  const toDepositSize = toDeposit.reduce((total, l) => total + l.size, 0);
  console.log(chalk.bold(`   À déposer (envois + reclassements + quarantaine) : ${n(toDeposit.length)} (${formatBytes(toDepositSize)})`));

  console.log(
    chalk.cyan(
      `\nRègle des albums (décisions de la revue 4.2) : ${n(summary.albumRule.archivedInPhotosAndKeptAlbum)} contenu(s) déjà ` +
        `archivé(s) et présent(s) dans un album conservé (jamais dupliqués dans albums/) ; ` +
        `${n(summary.albumRule.newInYearAndKeptAlbum)} contenu(s) nouveaux présents dans une année et un album conservé (album prioritaire)`,
    ),
  );

  const reclass = plan.lines.filter((l) => l.action === 'reclasser_quarantaine');
  if (reclass.length > 0) {
    console.log(chalk.yellow(`\n⚠️  ${n(reclass.length)} média(s) à reclasser hors de quarantaine (jamais laissés en l'état) :`));
    for (const l of reclass) console.log(`   ${l.folder}/${l.fileName} → ${l.destination}`);
  }

  if (plan.namingAnomalies.length > 0) {
    console.log(chalk.red(`\n❌ ${n(plan.namingAnomalies.length)} anomalie(s) de nommage (aucune destination possible) :`));
    for (const a of plan.namingAnomalies) console.log(chalk.red(`   ${a.destination} ← ${a.id} — ${a.reason}`));
  }
  const invariantsOk = plan.violations.length === 0;
  console.log(`\n${invariantsOk ? chalk.green('✅') : chalk.red('❌')} Invariants : ${invariantsOk ? 'OK' : 'KO'}`);
  for (const violation of plan.violations) console.log(chalk.red(`   ${violation}`));

  console.log(
    plan.executable
      ? chalk.green('\n✅ Plan exécutable : oui')
      : chalk.red('\n❌ Plan exécutable : non — corrigez les points ci-dessus puis régénérez le plan'),
  );
  console.log(chalk.gray(`   Détail ligne à ligne : gpb takeout planifier --export ${plan.exportId} --sortie plan.csv (ou plan.json)`));
}

const CSV_HEADER = ['partie', 'chemin', 'dossier', 'nom', 'taille_octets', 'md5', 'source_date', 'action', 'destination', 'doublon_de', 'raison'];

function planToCsv(plan: TakeoutArchivePlan): string {
  return csvDocument(
    CSV_HEADER,
    plan.lines.map((l) => [
      l.part, l.path, l.folder, l.fileName, l.size, l.md5, l.dateSource, l.action, l.destination,
      l.keptOf ? `${l.keptOf.part}:${l.keptOf.path}` : null, l.reason,
    ]),
  );
}

function planToJson(plan: TakeoutArchivePlan): string {
  return (
    JSON.stringify(
      {
        export: plan.exportId,
        empreinte: plan.id,
        bucket_dedie: plan.destinationBucket,
        albums_conserves: plan.keptAlbums,
        analyse_du: plan.analysisAnalyzedAt,
        inventaire_bucket_dedie_du: plan.destinationInventoryCompletedAt,
        executable: plan.executable,
        violations: plan.violations,
        anomalies_de_nommage: plan.namingAnomalies,
        lignes: plan.lines.map((l) => ({
          partie: l.part, chemin: l.path, dossier: l.folder, nom: l.fileName, taille_octets: l.size, md5: l.md5,
          source_date: l.dateSource, action: l.action, destination: l.destination,
          doublon_de: l.keptOf ? { partie: l.keptOf.part, chemin: l.keptOf.path } : null, raison: l.reason,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

async function exportPlan(plan: TakeoutArchivePlan, file: string): Promise<void> {
  const extension = path.extname(file).toLowerCase();
  const content = extension === '.csv' ? planToCsv(plan) : extension === '.json' ? planToJson(plan) : null;
  if (content === null) throw new Error(`format d'export non reconnu pour « ${file} » : extension .csv ou .json attendue`);
  await fs.promises.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.promises.writeFile(file, content, 'utf8');
  console.log(chalk.green(`\n📄 Plan complet exporté (${formatNumber(plan.lines.length)} lignes) : ${path.resolve(file)}`));
}
