import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';
import { BucketObject } from '../clients/types';
import { AppConfig } from '../config/types';
import { InventoryModel } from '../database/inventory-model';
import { RepairExecutionModel } from '../database/repair-execution-model';
import { RepairPlanModel } from '../database/repair-plan-model';
import { executionCommandLine, VolumeCount } from '../inventory/plan-execution';
import { PlanRefusedError } from '../inventory/repair-plan';
import {
  ArrivalCheck,
  buildRepairReport,
  deletionKeysCsv,
  MAX_INVENTORY_AGE_HOURS,
  RepairReport,
  reportExport,
  SourceObjectState,
  sourceFreshnessProblems,
} from '../inventory/repair-report';
import { writeNewFile, NewFileOutcome } from '../utils/file-utils';
import { formatBytes, formatNumber } from '../utils/format';
import { getLogger } from '../utils/logger';
import { readPlanInput } from './plan';

/**
 * `gpb reparation rapport` (story 3.3) : rapport de la réparation depuis l'index local. Aucun client S3, aucune requête
 * réseau, aucune écriture, aucune suppression. La vérification de l'arrivée (`--verifier`) s'appuie sur l'inventaire du
 * bucket dédié (`gpb inventory scan --bucket <dédié>`, listing en lecture seule).
 */

export interface ReportOptions {
  bucket?: string;
  verifier?: boolean;
  export?: string;
  exportSuppression?: string;
}

/** Au-delà, les lignes en échec, manquants et non conformes sont tronqués à l'écran ; l'export reste complet. */
const MAX_LISTED = 50;

const n = (value: number): string => chalk.white(formatNumber(value));
const volume = ({ count, size }: VolumeCount): string => `${n(count)} (${formatBytes(size)})`;

/** Exécute la commande ; rend le code de sortie (0 seulement si l'attestation est accordée). */
export async function reportCommand(config: AppConfig, options: ReportOptions, now: () => Date = (): Date => new Date()): Promise<number> {
  console.log(chalk.blue.bold('📑 Rapport de la réparation (index local, aucune requête réseau, aucune écriture)\n'));
  if (options.export && options.exportSuppression && path.resolve(options.export) === path.resolve(options.exportSuppression)) {
    console.log(chalk.red('❌ --export et --export-suppression désignent le même fichier : choisissez deux fichiers distincts.'));
    return 1;
  }
  const planModel = new RepairPlanModel();
  const stored = planModel.findCurrent();
  if (!stored) {
    console.log(chalk.red('❌ Aucun plan de réparation enregistré : rien à rapporter. Lancez : gpb plan generer'));
    return 1;
  }
  const { plan } = stored;
  const journal = new RepairExecutionModel();

  const executionEnd = journal.lastUpdate(plan.id);
  let sourceObjects: BucketObject[];
  let sourceProblems: string[];
  let sourceInventoryCompletedAt: Date | null;
  try {
    // Objets et date de l'inventaire source viennent de la même lecture de l'index.
    const current = readPlanInput(config, { bucket: options.bucket, destination: config.repair.destinationBucket });
    sourceObjects = current.objects;
    sourceInventoryCompletedAt = new Date(current.index.sourceInventory.completedAt);
    sourceProblems = sourceFreshnessProblems(plan, current, planModel.findLastRefusal(), executionEnd);
  } catch (error) {
    if (!(error instanceof PlanRefusedError)) throw error;
    sourceObjects = [];
    sourceInventoryCompletedAt = null;
    sourceProblems = [`vérification impossible — ${error.message}`];
  }

  const inventory = new InventoryModel();
  const destinationRun = options.verifier ? inventory.findRun(plan.config.destinationBucket) : null;
  const reportedAt = now();
  const report = buildRepairReport({
    plan,
    states: journal.findStates(plan.id),
    executionEnd,
    lockHeld: journal.findLock() !== null,
    journaledPlanIds: journal.findPlanIds(),
    sourceObjects,
    sourceProblems,
    sourceInventoryCompletedAt,
    now: reportedAt,
    verificationRequested: options.verifier === true,
    destinationInventory: destinationRun
      ? { completedAt: destinationRun.completedAt, objects: inventory.findAll(plan.config.destinationBucket) }
      : null,
  });
  getLogger().info(
    `Rapport du plan ${plan.id} : journal ${report.journal.status}, vérification ${report.verification ? 'faite' : 'absente'}, ` +
      `${report.anomalies.length} anomalie(s), attestation ${report.attestation.granted ? 'accordée' : 'refusée'}`,
  );

  // Le fichier de suppression est écrit AVANT l'attestation : l'écran ne désigne jamais un fichier qui n'a pas été produit.
  const suppression = report.attestation.granted && options.exportSuppression
    ? await writeNewFile(options.exportSuppression, deletionKeysCsv(report, reportedAt))
    : null;

  displayJournal(report, options.bucket);
  displayVerification(report);
  displayCounterMetrics(report);
  displayAttestation(report, options, suppression);
  if (options.export) {
    await writeExport(options.export, reportExport(report, options.export, reportedAt));
    console.log(chalk.green(`\n📄 Rapport exporté : ${path.resolve(options.export)}`));
  }
  if (options.exportSuppression) {
    if (!report.attestation.granted) {
      console.log(chalk.red(`\n❌ Liste de suppression refusée, rien n'a été écrit : la réparation n'est pas attestée.`));
      return 1;
    }
    if (suppression?.written !== true) return 1;
  }
  return report.attestation.granted ? 0 : 1;
}

async function writeExport(file: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(path.resolve(file)));
  await fs.writeFile(file, content, 'utf8');
}

function listed<T>(items: T[], line: (item: T) => string, max = MAX_LISTED): void {
  for (const item of items.slice(0, max)) console.log(line(item));
  if (items.length > max) console.log(chalk.gray(`     … ${formatNumber(items.length - max)} de plus (liste complète : --export)`));
}

const STATUS_LABELS = {
  non_executee: chalk.yellow('aucune exécution journalisée pour ce plan'),
  complete: chalk.green('complète'),
  incomplete: chalk.yellow('incomplète'),
  bloquee: chalk.red('bloquée (lignes en échec à examiner)'),
};

function displayJournal(report: RepairReport, bucket: string | undefined): void {
  const { journal: j } = report;
  console.log(chalk.cyan('━━ Niveau 1 — Rapport du journal (ce que l\'exécution déclare, sans contrôle du bucket) ━━'));
  console.log(`   Plan : ${chalk.white(report.planId)}`);
  console.log(`   ${report.sourceBucket} (lecture seule) → ${report.destinationBucket}`);
  console.log(`   Exécution : ${STATUS_LABELS[j.status]}${report.executionEnd ? ` — dernière écriture du journal le ${report.executionEnd.toISOString()}` : ''}`);
  if (report.otherJournaledPlans.length > 0) {
    console.log(chalk.yellow(`   Journal d'un autre plan : ${report.otherJournaledPlans.join(', ')} (plan régénéré après exécution ?)`));
  }
  console.log(`   Attendus : copier ${volume(j.expectedCopies)}, quarantaine ${volume(j.expectedQuarantine)}`);
  console.log(`   Copiés et vérifiés à la copie (copie) : ${volume(j.copied)}`);
  console.log(`   Déjà présents identiques (deja_present) : ${volume(j.alreadyPresent)}`);
  console.log(`   Restants : à faire ${volume(j.notStarted)}, copies en cours ${volume(j.inProgress)}, en échec ${volume(j.failed)}`);
  console.log(`   Doublons écartés (non copiés) : ${n(j.duplicates.count)} — espace économisé ${chalk.white(formatBytes(j.duplicates.size))}`);
  console.log(`   Déjà archivés avant exécution : ${volume(j.alreadyArchived)}`);
  if (report.lockHeld) console.log(chalk.yellow('   ⚠️  Verrou d\'exécution présent : une exécution est peut-être en cours.'));
  listed(j.failures, (f) => chalk.red(`   ❌ ${f.sourceKey} → ${f.destination} : ${f.reason}`));
  if (j.status === 'incomplete' || j.status === 'bloquee' || j.status === 'non_executee') {
    console.log(chalk.yellow(`   Pour ${j.status === 'non_executee' ? 'exécuter' : 'reprendre'} : ${executionCommandLine(report.planId, bucket)}`));
  }
  console.log(`   Exclusions du plan (non copiées) : ${n(report.exclusions.length)}`);
  listed(report.exclusions, (e) => chalk.gray(`     ${e.sourceKey} — ${e.reason}`), Infinity);
  console.log(`   En quarantaine (à dater à la main plus tard) : ${n(report.quarantine.length)}`);
  listed(report.quarantine, (q) => chalk.gray(`     ${q.sourceKey} → ${q.destination}`), Infinity);
  for (const problem of report.sourceProblems) console.log(chalk.red(`   ⚠️  Plan exécuté non vérifiable contre l'index source : ${problem}`));
}

function displayVerification(report: RepairReport): void {
  const scan = `gpb inventory scan --bucket ${report.destinationBucket}`;
  console.log(chalk.cyan('\n━━ Niveau 2 — Vérification de l\'arrivée (inventaire du bucket dédié) ━━'));
  if (!report.verificationRequested) {
    console.log(chalk.yellow(`   Non faite. Après la fin de l'exécution : « ${scan} », puis « gpb reparation rapport --verifier ».`));
    return;
  }
  const v = report.verification;
  if (!v) {
    console.log(chalk.red(`   Impossible : aucun inventaire local du bucket dédié. Lancez « ${scan} ».`));
    return;
  }
  console.log(`   Inventaire du ${v.inventoryCompletedAt.toISOString()} (${n(v.inventoryObjectCount)} objets)`);
  if (!v.afterExecution) console.log(chalk.red(`   ⚠️  Antérieur à la fin de l'exécution : il ne prouve rien. Relancez « ${scan} ».`));
  console.log(`   Conformes : ${n(v.conforming)} — manquants : ${n(v.missing.length)} — non conformes : ${n(v.nonConforming.length)}`);
  const line = (c: ArrivalCheck): string => chalk.red(`     ${c.destination} ← ${c.sourceKey}${c.detail ? ` — ${c.detail}` : ''}`);
  if (v.missing.length > 0) console.log(chalk.red('   Manquants :'));
  listed(v.missing, line);
  if (v.nonConforming.length > 0) console.log(chalk.red('   Non conformes :'));
  listed(v.nonConforming, line);
  if (v.unexpected.length > 0) {
    console.log(chalk.yellow(`   Objets non prévus par le plan sous photos/, albums/, quarantaine/ (non bloquant) : ${n(v.unexpected.length)}`));
    listed(v.unexpected, (key) => chalk.yellow(`     ${key}`));
  }
}

function displayCounterMetrics(report: RepairReport): void {
  const m = report.counterMetrics;
  console.log(chalk.cyan('\n━━ Contre-métriques ━━'));
  console.log(
    `   Objets à l'arrivée (${m.arrivalsFrom === 'verification' ? 'vérifiés' : 'd\'après le journal'}) : ${n(m.arrivals)} — ` +
      `attendus ${n(m.expectedArrivals)} = ${n(m.mediaCount)} médias − ${n(m.duplicates)} doublons`,
  );
  console.log(
    `   Au départ : ${n(m.scopeCount)} objets sous les préfixes source (relevé du PRD : ${formatNumber(m.prdStartCount)}) ` +
      `= ${n(m.mediaCount)} médias + ${n(m.exclusions)} exclusions + ${n(m.unrecognized)} non reconnus`,
  );
  console.log(`   En quarantaine : ${volume(m.quarantine)}`);
  console.log(`   Objets supprimés par l'outil dans « ${report.sourceBucket} » : ${n(m.deletedByTool)} — ${m.deletionGuarantee}`);
  for (const warning of report.warnings) console.log(chalk.yellow(`   ⚠️  ${warning}`));
  for (const anomaly of report.anomalies) console.log(chalk.red(`   ❌ ANOMALIE : ${anomaly}`));
}

/** Commande qui produit la liste exacte des clés à supprimer. */
export const suppressionCommandLine = (bucket?: string): string =>
  `gpb reparation rapport${bucket ? ` --bucket ${bucket}` : ''} --verifier --export-suppression suppression.csv`;

function displayAttestation(report: RepairReport, options: ReportOptions, suppression: NewFileOutcome | null): void {
  console.log(chalk.cyan('\n━━ Attestation ━━'));
  const age = (label: string, date: Date | null, hours: number | null): string =>
    date && hours !== null ? `${label} du ${date.toISOString()} (il y a ${hours.toFixed(1)} h)` : `${label} : aucun`;
  console.log(
    `   ${age('Inventaire source', report.sourceInventoryCompletedAt, report.inventoryAgesHours.source)} — ` +
      `${age('inventaire dédié', report.verification?.inventoryCompletedAt ?? null, report.inventoryAgesHours.destination)} ` +
      `(au plus ${MAX_INVENTORY_AGE_HOURS} h)`,
  );
  const { added, removed, modified } = report.sourceDiff;
  const describe = (o: SourceObjectState): string => `${o.key} (${o.size} octets, ETag ${o.etag ?? 'absent'})`;
  if (added.length > 0) console.log(chalk.red('   Ajoutés au bucket source depuis le plan (non archivés) :'));
  listed(added, (o) => chalk.red(`     ${describe(o)}`));
  if (removed.length > 0) console.log(chalk.red('   Retirés du bucket source depuis le plan :'));
  listed(removed, (o) => chalk.red(`     ${describe(o)}`));
  if (modified.length > 0) console.log(chalk.red('   Modifiés dans le bucket source depuis le plan (non archivés tels quels) :'));
  listed(modified, (d) => chalk.red(`     ${d.key} : ${d.before.size} octets, ETag ${d.before.etag ?? 'absent'} → ${d.after.size} octets, ETag ${d.after.etag ?? 'absent'}`));
  if (!report.attestation.granted) {
    console.log(chalk.red.bold('   🛑 NE SUPPRIMEZ RIEN. La réparation n\'est pas attestée :'));
    for (const reason of report.attestation.reasons) console.log(chalk.red(`   - ${reason}`));
    return;
  }
  console.log(chalk.green.bold('   ✅ Réparation terminée et vérifiée : chaque objet attendu est présent et conforme dans le bucket dédié.'));
  console.log(chalk.white('   La suppression des anciens emplacements vous appartient : l\'outil n\'a rien supprimé et ne supprimera rien.'));
  console.log(chalk.yellow(`   Supprimez sans attendre : l'attestation ne vaut que pour l'état des inventaires ci-dessus (au plus ${MAX_INVENTORY_AGE_HOURS} h).`));
  const sizeOnly = report.verification?.sizeOnlyCopies ?? 0;
  if (sizeOnly > 0) {
    console.log(
      chalk.yellow(
        `   ${formatNumber(sizeOnly)} copie(s) multipart vérifiée(s) sur la taille seule : Cubbit recalcule l'ETag d'une copie, ` +
          'leur contenu est garanti par la copie conditionnée à l\'ETag source, pas par cette vérification.',
      ),
    );
  }
  console.log(chalk.white.bold('   Méthode de suppression : UNIQUEMENT les clés exactes du fichier exporté par --export-suppression.'));
  if (suppression?.written) {
    console.log(chalk.white(`   Fichier des clés à supprimer (${formatNumber(report.deletionKeys.length)} clés) : ${suppression.file}`));
  } else if (suppression) {
    console.log(chalk.red.bold(`   ❌ Fichier des clés NON produit : « ${suppression.file} » ${suppression.reason}. N'utilisez aucun ancien fichier.`));
    console.log(chalk.yellow(`   Relancez vers un nouveau nom : ${suppressionCommandLine(options.bucket).replace('suppression.csv', 'suppression-<date>.csv')}`));
  } else {
    console.log(chalk.yellow(`   Pour produire ce fichier : ${suppressionCommandLine(options.bucket)}`));
  }
  console.log(
    chalk.yellow.bold(
      '   Ne supprimez pas les dossiers entiers depuis la console : tout objet ajouté depuis l\'inventaire serait perdu. ' +
        'Supprimez uniquement les clés du fichier exporté, juste après ce rapport.',
    ),
  );
  console.log(
    chalk.yellow(
      `   Limite : un objet écrasé en place sous une clé existante depuis l'inventaire (au plus ${MAX_INVENTORY_AGE_HOURS} h) serait ` +
        'supprimé avec cette clé. Activez le versioning sur le bucket source si Cubbit le propose.',
    ),
  );
  console.log('   Pour information, emplacements concernés (ne pas les supprimer en bloc) :');
  for (const l of report.locations) {
    console.log(chalk.white(`   • ${l.bucket}/${l.prefix} — ${formatNumber(l.count)} objets (${formatBytes(l.size)})`));
    if (l.topFolder && l.otherCount === 0) {
      console.log(chalk.gray(`     « ${l.topFolder} » ne contient rien d'autre d'après l'inventaire source ; seul « ${l.prefix} » est concerné.`));
    } else if (l.topFolder) {
      console.log(
        chalk.yellow(
          `     Ne supprimez PAS « ${l.topFolder} » en entier : il contient ${formatNumber(l.otherCount)} autre(s) objet(s) hors ` +
            `périmètre (${formatBytes(l.otherSize)}) — seul le sous-dossier « ${l.prefix} » est concerné.`,
        ),
      );
    }
    if (l.exclusions.length > 0) {
      console.log(chalk.yellow(`     dont ${formatNumber(l.exclusions.length)} exclusion(s) non archivée(s) qui seront supprimées (elles figurent dans le fichier des clés) :`));
      for (const e of l.exclusions) console.log(chalk.yellow(`       ${e.sourceKey} — ${e.reason}`));
    }
  }
}
