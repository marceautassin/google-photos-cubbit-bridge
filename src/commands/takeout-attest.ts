import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { InventoryModel } from '../database/inventory-model';
import { RepairExecutionModel } from '../database/repair-execution-model';
import { TakeoutAnalysisModel } from '../database/takeout-analysis-model';
import { TakeoutPlanModel } from '../database/takeout-plan-model';
import { MAX_INVENTORY_AGE_HOURS } from '../inventory/repair-report';
import {
  AttestationGap,
  AttestationReport,
  buildAttestation,
  coveredMediaCsv,
  GAP_TYPES,
  gapsCsv,
  GapType,
  RemoteZipState,
} from '../takeout/takeout-attestation';
import { analyzeExport } from '../takeout/takeout-validation';
import { NewFileOutcome, writeNewFile } from '../utils/file-utils';
import { formatBytes, formatNumber } from '../utils/format';
import { getLogger } from '../utils/logger';
import { defaultSources, ensureLocalZips, localExportGroup, localZipsDirectory, parsePartCount, selectGroups, TakeoutSources } from './takeout';
import { runCommand } from './run-command';

/**
 * `gpb takeout attester` (story 4.5) : attestation fichier par fichier, avant que Marceau supprime les zips de `backups/`
 * et ses photos dans Google Photos. Lecture seule partout : listing de `backups/`, lectures partielles et revérification
 * des zips locaux, inventaire local du bucket dédié. Aucun point d'accès en écriture n'est construit, rien n'est supprimé.
 */

interface AttesterOptions {
  export: string;
  parties: string;
  dossier?: string;
  exportListe?: string;
  exportEcarts?: string;
}

/** Au-delà, les écarts d'un même type sont tronqués à l'écran ; la liste complète va dans `--export-ecarts`. */
const MAX_EXAMPLES = 20;

export function register(takeoutCmd: Command, config: AppConfig, sources: TakeoutSources = defaultSources(config)): void {
  takeoutCmd
    .command('attester')
    .description(
      'Attester qu\'un export archivé est entièrement présent et conforme dans le bucket dédié avant de supprimer ses zips ' +
        '(backups/) et les photos dans Google Photos : revérifie les zips, le journal d\'archivage et l\'inventaire du bucket ' +
        'dédié, média par média. Lecture seule, ne supprime jamais rien. Code de sortie 0 seulement si l\'attestation est accordée',
    )
    .requiredOption('--export <horodatage>', 'Export archivé (gpb takeout archiver)')
    .requiredOption('--parties <n>', 'Nombre de parties annoncé par Google : exigé, tout écart refuse l\'attestation')
    .option('--dossier <chemin>', 'Dossier de travail local des zips (défaut : data/takeout/<export>/)')
    .option('--export-liste <fichier.csv>', 'Liste des médias couverts (écrite seulement si l\'attestation est accordée ; jamais écrasée)')
    .option('--export-ecarts <fichier.csv>', 'Liste complète des écarts de rapprochement (jamais écrasée)')
    .action((options: AttesterOptions) =>
      runCommand('Attestation Takeout :', async () => {
        process.exitCode = await attesterCommand(config, sources, options);
      }),
    );
}

const refuse = (message: string): number => {
  console.log(chalk.red(`❌ Attestation refusée — ${message}`));
  return 1;
};

/** Identifiant complet de l'export analysé, depuis la seule base locale (aucun réseau). */
function resolveExportId(exportId: string): string | string[] {
  const ids = new TakeoutAnalysisModel().exportIds().filter((id) => id === exportId || id.startsWith(`${exportId}-`));
  return ids.length === 1 ? ids[0]! : ids;
}

export async function attesterCommand(config: AppConfig, sources: TakeoutSources, options: AttesterOptions, now: () => Date = (): Date => new Date()): Promise<number> {
  console.log(chalk.blue.bold('🔐 Attestation d\'un export Takeout (lecture seule, aucune suppression)\n'));
  const expectedParts = parsePartCount(options.parties)!;

  const files = [options.exportListe, options.exportEcarts].filter((f): f is string => f !== undefined).map((f) => path.resolve(f));
  if (new Set(files).size !== files.length) return refuse('--export-liste et --export-ecarts désignent le même fichier : choisissez deux fichiers distincts');
  for (const file of files) if (fs.existsSync(file)) return refuse(`« ${file} » existe déjà : un fichier existant n'est jamais écrasé, choisissez un nouveau nom`);

  const bucket = config.repair.destinationBucket;
  if (!bucket) return refuse('aucun bucket dédié configuré (CUBBIT_DESTINATION_BUCKET ou repair.destinationBucket)');
  const resolved = resolveExportId(options.export);
  if (typeof resolved !== 'string') {
    return refuse(
      resolved.length === 0
        ? `aucune analyse pour l'export ${options.export} : lancez gpb takeout analyser --export ${options.export} --parties ${expectedParts}`
        : `« ${options.export} » désigne plusieurs exports (${resolved.join(', ')}) : précisez l'identifiant complet`,
    );
  }
  const analysis = new TakeoutAnalysisModel().find(resolved)!;
  const stored = new TakeoutPlanModel().find(resolved);
  if (!stored) return refuse(`aucun plan d'archivage enregistré pour l'export ${resolved} : lancez gpb takeout planifier --export ${resolved}`);
  const { plan } = stored;
  if (plan.destinationBucket !== bucket) {
    return refuse(`le plan ${plan.id.slice(0, 12)} vise le bucket « ${plan.destinationBucket} », la configuration « ${bucket} » : régénérez le plan`);
  }

  // Revérification des entrées : zips distants listés, zips locaux revérifiés (lecture seule), validation 4.1 rejouée.
  let remoteZips: RemoteZipState[];
  let validation;
  try {
    const { zips } = await sources.remoteZips();
    const group = selectGroups(zips, resolved).find((g) => g.id === resolved);
    if (!group) throw new Error(`export ${resolved} introuvable parmi les zips distants`);
    remoteZips = group.parts.map(({ zip }) => ({ name: zip.name, key: zip.key ?? zip.name, size: zip.size, etag: zip.etag ?? null }));
    const localZips = await ensureLocalZips(config, sources, group, options.dossier);
    validation = await analyzeExport(localExportGroup(group, localZips), config.sync.supportedFormats, expectedParts);
  } catch (error) {
    return refuse(`impossible de revérifier les zips : ${error instanceof Error ? error.message : String(error)}`);
  }

  const inventory = new InventoryModel();
  const run = inventory.findRun(plan.destinationBucket);
  const journal = new RepairExecutionModel();
  const reportedAt = now();
  const report = buildAttestation({
    exportId: resolved,
    expectedParts,
    analysis,
    plan,
    states: journal.findStates(plan.id),
    executionEnd: journal.lastUpdate(plan.id),
    lockHeld: journal.findLock() !== null,
    remoteZips,
    validation,
    inventory: run ? { completedAt: run.completedAt, objects: inventory.findAll(plan.destinationBucket) } : null,
    now: reportedAt,
  });
  getLogger().info(
    `Attestation de l'export ${resolved} (plan ${plan.id}) : ${report.counts.covered} médias couverts sur ${analysis.media.length}, ` +
      `${report.gaps.length} écart(s), ${report.attestation.reasons.length} raison(s) de refus, attestation ${report.attestation.granted ? 'accordée' : 'refusée'}`,
  );

  // Fichiers écrits AVANT l'attestation : l'écran ne désigne jamais un fichier qui n'a pas été produit.
  const list = options.exportListe && report.attestation.granted ? await writeNewFile(options.exportListe, coveredMediaCsv(report)) : null;
  const gaps = options.exportEcarts ? await writeNewFile(options.exportEcarts, gapsCsv(report)) : null;

  displayReport(config, report, options, list, gaps);
  if (options.exportListe && !report.attestation.granted) {
    console.log(chalk.red('\n❌ Liste des médias couverts refusée, rien n\'a été écrit : l\'export n\'est pas attesté.'));
  }
  const produced = (file: NewFileOutcome | null): boolean => file === null || file.written;
  return report.attestation.granted && produced(list) && produced(gaps) ? 0 : 1;
}

const n = (value: number): string => chalk.white(formatNumber(value));

function displayReport(config: AppConfig, report: AttestationReport, options: AttesterOptions, list: NewFileOutcome | null, gaps: NewFileOutcome | null): void {
  const { counts, attestation } = report;
  console.log(`Export : ${chalk.white(report.exportId)} — plan ${report.planId.slice(0, 12)} — bucket dédié ${report.destinationBucket}`);
  console.log(
    `Inventaire du bucket dédié : ${report.inventoryCompletedAt ? `du ${report.inventoryCompletedAt.toISOString()} (il y a ${report.inventoryAgeHours!.toFixed(1)} h, ` +
        `${formatNumber(report.inventoryObjectCount)} objets, au plus ${MAX_INVENTORY_AGE_HOURS} h)` : 'aucun'}`,
  );
  console.log(`Dernière écriture du journal d'archivage : ${report.executionEnd?.toISOString() ?? 'aucune'}`);
  console.log(`Médias couverts : ${n(counts.covered)} sur ${n(report.rows.length)} rapprochés`);

  displayGaps(report.gaps, options.exportEcarts !== undefined);
  if (gaps?.written) console.log(chalk.green(`\n📄 Écarts exportés (${formatNumber(report.gaps.length)}) : ${gaps.file}`));
  else if (gaps) console.log(chalk.red(`\n❌ Fichier des écarts NON produit : « ${gaps.file} » ${gaps.reason}.`));

  console.log(chalk.cyan('\n━━ Attestation ━━'));
  if (!attestation.granted) {
    console.log(chalk.red.bold('🛑 NE SUPPRIMEZ RIEN. L\'export n\'est pas attesté :'));
    for (const reason of attestation.reasons) console.log(chalk.red(`   - ${reason}`));
    return;
  }
  console.log(chalk.green.bold('✅ Export attesté : chaque média de l\'export est présent et conforme dans le bucket dédié.'));
  console.log(
    `   ${n(counts.covered)} médias couverts : ${n(counts.deposited)} déposés par la passe d'archivage, ${n(counts.alreadyArchived)} déjà archivés, ` +
      `${n(counts.internalDuplicates)} doublons internes (couverts par leur représentant)`,
  );
  if (counts.quarantine > 0) {
    console.log(chalk.yellow(`   dont ${n(counts.quarantine)} sans date fiable, rangés en quarantaine/ (à dater à la main plus tard)`));
  }
  console.log(chalk.white.bold('\n   Zips de backups/ supprimables (ceux revérifiés, clé exacte) :'));
  for (const z of report.zips) console.log(`   • ${z.key}  ${formatBytes(z.size)}  ETag ${z.etag ?? 'absent'}`);
  console.log(chalk.gray('\n   Facultatif — dossier local des zips (copie du même contenu ; une fois supprimé, une nouvelle attestation retéléchargerait tout l\'export) :'));
  console.log(chalk.gray(`   • ${localZipsDirectory(config, report.exportId, options.dossier)}`));
  console.log(chalk.white('\n   La suppression des zips et des photos dans Google Photos vous appartient : l\'outil n\'a rien supprimé et ne supprimera jamais rien.'));
  console.log(chalk.yellow(`   Supprimez sans attendre : l'attestation ne vaut que pour l'état des inventaires ci-dessus (au plus ${MAX_INVENTORY_AGE_HOURS} h).`));
  if (list?.written) console.log(chalk.green(`\n📄 Liste des médias couverts (${formatNumber(report.rows.length)}) : ${list.file}`));
  else if (list) console.log(chalk.red.bold(`\n❌ Liste des médias NON produite : « ${list.file} » ${list.reason}. Relancez vers un nouveau nom.`));
  else console.log(chalk.gray('\n   Pour conserver la liste des médias couverts : relancez avec --export-liste <fichier.csv>'));
}

function displayGaps(gaps: AttestationGap[], exported: boolean): void {
  if (gaps.length === 0) return;
  console.log(chalk.red(`\nÉcarts de rapprochement : ${n(gaps.length)}`));
  for (const type of GAP_TYPES) {
    const ofType: AttestationGap[] = gaps.filter((g) => g.type === type);
    if (ofType.length === 0) continue;
    console.log(chalk.red(`   ${TYPE_LABELS[type]} : ${n(ofType.length)}`));
    for (const g of ofType.slice(0, MAX_EXAMPLES)) {
      console.log(chalk.red(`     ${g.part}:${g.path}`));
      console.log(chalk.red(`       clé attendue : ${g.expectedKey ?? '—'}`));
      console.log(chalk.red(`       attendu : ${g.expected} ; trouvé : ${g.found}`));
      console.log(chalk.yellow(`       à faire : ${g.action}`));
    }
    if (ofType.length > MAX_EXAMPLES) {
      console.log(chalk.gray(`     … ${formatNumber(ofType.length - MAX_EXAMPLES)} de plus${exported ? '' : ' (liste complète : --export-ecarts <fichier.csv>)'}`));
    }
  }
}

const TYPE_LABELS: Record<GapType, string> = {
  manquant: 'Manquants (objet absent du bucket dédié)',
  taille_differente: 'Taille différente',
  contenu_different: 'Contenu différent (ETag)',
  non_confirmable: 'Non confirmables (ETag sans preuve)',
  sans_destination: 'Sans destination',
};
