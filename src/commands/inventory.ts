import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { validateConfig } from '../config';
import { createS3Client } from '../clients/s3-client';
import { S3BucketLister } from '../clients/bucket-lister';
import { S3ObjectRangeReader } from '../clients/object-range-reader';
import { DateSource, InventoryDateModel, ObjectDating } from '../database/inventory-date-model';
import { dateInventory, DatingRun, DatingSummary, selectMedia, summarizeDates } from '../inventory/dating';
import {
  analyzeDuplicates,
  DISAMBIGUATION_RULE,
  DuplicateReport,
  MediaCopy,
  SameNameAndSize,
} from '../inventory/duplicates';
import { InventoryModel, InventoryRun } from '../database/inventory-model';
import { scanBucket, summarizeInventory } from '../inventory/inventory';
import { formatBytes } from '../utils/file-utils';
import { describeError } from '../utils/format';
import { getLogger } from '../utils/logger';
import { runCommand } from './run-command';

interface RawOptions {
  bucket?: string;
  depth: string;
  limit: string;
}

interface InventoryOptions {
  bucket?: string;
  depth: number;
  limit: number;
}

export function register(program: Command, config: AppConfig): void {
  const inventoryCmd = program
    .command('inventory')
    .description('Inventorier le bucket entier (lecture seule) et localiser les médias');

  withDisplayOptions(
    inventoryCmd.command('scan').description('Lister tous les objets du bucket et remplacer l\'inventaire local'),
  ).action((raw: RawOptions) => run(() => scanCommand(config, parseOptions(raw))));

  withDisplayOptions(
    inventoryCmd.command('show').description('Afficher le dernier inventaire local, sans appel réseau'),
  ).action((raw: RawOptions) => run(() => showCommand(config, parseOptions(raw))));

  inventoryCmd
    .command('dates')
    .description(
      'Dater chaque média de l\'inventaire (nom de fichier, puis EXIF par lecture partielle, sinon indéterminée) ' +
        'et afficher les sources ; relançable sans relire les EXIF déjà lus',
    )
    .option('--bucket <nom>', 'Bucket inventorié (défaut : bucket de la configuration)')
    .option('--prefix <préfixes...>', 'Restreindre aux clés commençant par l\'un de ces préfixes (défaut : tout l\'inventaire)')
    .option('--suspects', 'Lister les dates suspectes (futur, antérieures à 2000, ou issues d\'EXIF ModifyDate)')
    .option('--indeterminees', 'Lister les médias à date indéterminée')
    .action((options: DatesOptions) => run(() => datesCommand(config, options)));

  inventoryCmd
    .command('doublons')
    .description(
      'Identifier les doublons (nom + taille + ETag identique) et les collisions de noms par dossier de destination, ' +
        'depuis l\'inventaire daté local, sans appel réseau',
    )
    .option('--bucket <nom>', 'Bucket inventorié (défaut : bucket de la configuration)')
    .option('--prefix <préfixes...>', 'Restreindre aux clés commençant par l\'un de ces préfixes (défaut : tout l\'inventaire)')
    .option('--groupes', 'Lister les groupes de doublons (exemplaire conservé et copies en trop)')
    .option('--collisions', 'Lister les homonymes et les collisions avec les noms désambiguïsés')
    .option('--incoherences', 'Lister les groupes aux dates divergentes et les contenus différents de même nom et taille')
    .option('--empreinte', 'Empreinte (ETag) : lister les doublons présumés non confirmables (même nom et taille, ETag absent ou différent)')
    .action((options: DuplicatesOptions) => run(() => duplicatesCommand(config, options)));
}

interface DuplicatesOptions {
  bucket?: string;
  prefix?: string[];
  groupes?: boolean;
  collisions?: boolean;
  incoherences?: boolean;
  empreinte?: boolean;
}

async function duplicatesCommand(config: AppConfig, options: DuplicatesOptions): Promise<void> {
  const bucket = options.bucket ?? config.cubbit.bucket;
  const inventoryModel = new InventoryModel();
  if (!inventoryModel.findRun(bucket)) {
    console.log(chalk.yellow(`Aucun inventaire local pour le bucket « ${bucket} ». Lancez : gpb inventory scan`));
    return;
  }
  const prefixes = options.prefix ?? [];
  const media = selectMedia(inventoryModel.findAll(bucket), config.sync.supportedFormats, prefixes);
  // Aucune destination occupée : le bucket dédié n'est pas encore inventorié (epic 3).
  const report = analyzeDuplicates(media, new InventoryDateModel().findAll(bucket));
  getLogger().info(
    `Doublons du bucket ${bucket} : ${report.groups.length} groupes, ${report.recoverableSize} octets récupérables, ` +
      `${report.collisions.length} collisions, ${report.etagConflicts.length} conflits d'ETag, ` +
      `${report.namingAnomalies.length} anomalies de nommage`,
  );
  displayDuplicates(report, options, prefixes);
  if (report.namingAnomalies.length > 0) process.exitCode = 1;
}

function displayDuplicates(report: DuplicateReport, options: DuplicatesOptions, prefixes: string[]): void {
  const n = (value: number): string => chalk.white(value.toLocaleString('fr-FR'));
  const hint = (show: boolean | undefined, count: number, option: string): string =>
    count > 0 && !show ? chalk.gray(` — détail : ${option}`) : '';
  const dateMismatches = report.groups.filter((g) => g.dateMismatch);
  const scope = prefixes.length > 0 ? ` sous ${prefixes.join(', ')}` : '';

  console.log(chalk.blue.bold('🧮 Doublons et collisions de noms (lecture seule, aucun appel réseau)\n'));
  console.log(chalk.cyan(`📋 ${report.mediaCount.toLocaleString('fr-FR')} médias${scope} — ${n(report.contentCount)} contenus distincts`));
  if (report.undatedCount > 0) {
    console.log(chalk.yellow(`   ${n(report.undatedCount)} médias non datés : lancez d'abord « gpb inventory dates »`));
  }

  console.log('\n' + chalk.cyan('📑 Doublons confirmés (même nom, même taille, même ETag) :'));
  console.log(`   Groupes : ${n(report.groups.length)}, copies en trop : ${n(report.extraCopyCount)}${hint(options.groupes, report.groups.length, '--groupes')}`);
  console.log(`   Volume récupérable : ${chalk.white(formatBytes(report.recoverableSize))}`);
  console.log(
    `   Doublons présumés non confirmables (ETag absent ou multipart différent, copies conservées) : ` +
      `${n(report.unconfirmed.length)} groupes, au plus ${chalk.white(formatBytes(report.unconfirmedSize))} — hors volume récupérable` +
      hint(options.empreinte, report.unconfirmed.length, '--empreinte'),
  );

  console.log('\n' + chalk.cyan('🏷️  Noms :'));
  console.log(`   Homonymes (même nom, contenus distincts) : ${n(report.homonyms.length)}`);
  console.log(
    `   Collisions dans un même dossier de destination : ${n(report.collisions.length)}` +
      hint(options.collisions, report.homonyms.length, '--collisions'),
  );
  console.log(chalk.gray(`   Règle : ${DISAMBIGUATION_RULE}`));
  // Ce rapport ignore les albums conservés (D1) : le plan peut garder une autre copie que l'exemplaire indiqué ici.
  console.log(
    chalk.gray(
      '   Note : le plan de réparation (gpb plan generer) peut conserver l\'exemplaire situé dans un album conservé ' +
        '(repair.keptAlbums) plutôt que celui indiqué ici, et le copier dans albums/<nom>/.',
    ),
  );
  console.log(`   Exemplaires sans date (aucun dossier daté, quarantaine au plan) : ${n(report.withoutFolder.length)}`);

  const incoherenceCount = dateMismatches.length + report.etagConflicts.length;
  console.log(
    `\n${incoherenceCount > 0 ? chalk.yellow('⚠️ ') : '   '} Incohérences : ${n(dateMismatches.length)} groupes aux dates divergentes, ` +
      `${n(report.etagConflicts.length)} contenus différents sous même nom et taille (ETag MD5 différents)` +
      hint(options.incoherences, incoherenceCount, '--incoherences'),
  );

  const describe = ({ object, dating }: MediaCopy): string =>
    `${object.key} ${chalk.gray(`[${dating?.takenAt ?? 'sans date'}, ${dating?.source ?? 'non daté'}, ETag ${object.etag ?? 'absent'}]`)}`;
  const listCopies = (title: string, sets: SameNameAndSize[]): void => {
    console.log('\n' + chalk.cyan(`${title} (${sets.length.toLocaleString('fr-FR')}) :`));
    for (const set of sets) {
      console.log(`   ${set.name} (${formatBytes(set.size)})`);
      for (const copy of set.copies) console.log(`     ${describe(copy)}`);
    }
  };

  if (options.groupes) {
    console.log('\n' + chalk.cyan(`Groupes de doublons (${report.groups.length.toLocaleString('fr-FR')}) :`));
    for (const group of report.groups) {
      console.log(`   ${group.name} (${formatBytes(group.size)})${group.dateMismatch ? chalk.yellow(' — dates divergentes') : ''}`);
      console.log(`     conservé : ${describe(group.kept)}`);
      for (const other of group.others) console.log(`     en trop  : ${describe(other)}`);
    }
  }
  if (options.empreinte) listCopies('Doublons présumés non confirmables', report.unconfirmed);
  if (options.collisions) {
    console.log('\n' + chalk.cyan(`Homonymes (${report.homonyms.length.toLocaleString('fr-FR')}) :`));
    for (const homonym of report.homonyms) {
      for (const copy of homonym) {
        const target = report.destinations.get(copy.object.key) ?? report.alreadyArchived.get(copy.object.key);
        console.log(`   ${describe(copy)} → ${target ?? chalk.yellow('aucune destination (sans date ou anomalie)')}`);
      }
      console.log('');
    }
    console.log(chalk.cyan(`Collisions (${report.collisions.length.toLocaleString('fr-FR')}) :`));
    for (const collision of report.collisions) {
      for (const { copy, finalName } of collision.entries) {
        const archived = report.alreadyArchived.get(copy.object.key);
        const target = finalName
          ? `${collision.folder}${finalName}`
          : archived
            ? `${archived} ${chalk.gray('(déjà archivé)')}`
            : `${collision.folder}${chalk.red('(anomalie)')}`;
        console.log(`   ${target} ← ${copy.object.key}`);
      }
    }
  }
  if (options.incoherences) {
    listCopies('Groupes aux dates divergentes', dateMismatches.map((g) => ({ name: g.name, size: g.size, copies: [g.kept, ...g.others] })));
    listCopies('Contenus différents sous même nom et taille', report.etagConflicts);
  }

  // Anomalies bloquantes : toujours listées en entier, jamais filtrées.
  if (report.namingAnomalies.length > 0) {
    console.log('\n' + chalk.red(`❌ ${report.namingAnomalies.length.toLocaleString('fr-FR')} anomalie(s) de nommage bloquante(s) (aucune destination possible) :`));
    for (const anomaly of report.namingAnomalies) {
      console.log(`   ${anomaly.destination} ← ${anomaly.id} — ${anomaly.reason}`);
    }
  }
}

interface DatesOptions {
  bucket?: string;
  prefix?: string[];
  suspects?: boolean;
  indeterminees?: boolean;
}

function requireValidConfig(config: AppConfig): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`configuration incomplète (${errors.join(', ')}). Renseignez le fichier .env.`);
  }
}

async function datesCommand(config: AppConfig, options: DatesOptions): Promise<void> {
  const bucket = options.bucket ?? config.cubbit.bucket;
  const prefixes = options.prefix ?? [];
  const inventoryModel = new InventoryModel();
  if (!inventoryModel.findRun(bucket)) {
    console.log(chalk.yellow(`Aucun inventaire local pour le bucket « ${bucket} ». Lancez : gpb inventory scan`));
    return;
  }

  console.log(chalk.blue.bold(`🗓️  Datation des médias du bucket « ${bucket} » (lecture seule)\n`));
  const objects = inventoryModel.findAll(bucket);
  const dateModel = new InventoryDateModel();
  const datingRun = await dateInventory(objects, dateModel, {
    bucket,
    supportedFormats: config.sync.supportedFormats,
    prefixes,
    getReader: () => {
      requireValidConfig(config);
      return new S3ObjectRangeReader(createS3Client(config.cubbit), bucket);
    },
    onExifProgress: (done, total) => {
      process.stdout.write(`\r   EXIF : ${done.toLocaleString('fr-FR')}/${total.toLocaleString('fr-FR')} objets traités…`);
    },
  });
  if (datingRun.exifReadCount + datingRun.failures.length > 0) process.stdout.write('\n\n');

  const summary = summarizeDates(
    selectMedia(objects, config.sync.supportedFormats, prefixes),
    dateModel.findAll(bucket),
  );
  getLogger().info(
    `Datation du bucket ${bucket} : ${summary.bySource.nom_fichier} nom de fichier, ${summary.bySource.exif} EXIF, ` +
      `${summary.bySource.indeterminee} indéterminées, ${summary.suspects.length} suspectes, ` +
      `${summary.undatedKeys.length} non datées, ${datingRun.failures.length} échecs de lecture`,
  );
  displayDates(datingRun, summary, options, prefixes);

  if (datingRun.failures.length > 0) process.exitCode = 1;
}

function displayDates(datingRun: DatingRun, summary: DatingSummary, options: DatesOptions, prefixes: string[]): void {
  const n = (value: number): string => chalk.white(value.toLocaleString('fr-FR'));
  const scope = prefixes.length > 0 ? ` sous ${prefixes.join(', ')}` : '';
  console.log(chalk.cyan(`📋 ${summary.mediaCount.toLocaleString('fr-FR')} médias${scope}`));
  console.log(
    `   Cette passe : ${n(datingRun.exifReadCount)} EXIF lus, ${n(datingRun.exifReusedCount)} EXIF réutilisés ` +
      '(aucune relecture)',
  );

  console.log('\n' + chalk.cyan('🔎 Source de la date retenue :'));
  console.log(`   Nom de fichier      : ${n(summary.bySource.nom_fichier)}`);
  const tags = Object.entries(summary.byExifTag)
    .map(([tag, count]) => `${tag} ${count.toLocaleString('fr-FR')}`)
    .join(', ');
  console.log(`   EXIF                : ${n(summary.bySource.exif)}${tags ? chalk.gray(` (${tags})`) : ''}`);
  console.log(`   Date indéterminée   : ${n(summary.bySource.indeterminee)}`);
  if (summary.undatedKeys.length > 0) {
    console.log(chalk.yellow(`   Non datés (lecture en échec ou interrompue) : ${n(summary.undatedKeys.length)}`));
  }
  console.log(
    `\n${summary.suspects.length > 0 ? chalk.yellow('⚠️ ') : '   '} Dates suspectes (futur, avant 2000, ou EXIF ModifyDate) : ` +
      `${n(summary.suspects.length)}${summary.suspects.length > 0 && !options.suspects ? chalk.gray(' — détail : --suspects') : ''}`,
  );
  if (summary.bySource.indeterminee > 0 && !options.indeterminees) {
    console.log(chalk.gray('   Détail des dates indéterminées : --indeterminees'));
  }

  if (options.suspects) {
    listDatings('Dates suspectes', summary.suspects.map(({ dating, reason }) => ({ dating, note: reason })));
  }
  if (options.indeterminees) {
    listDatings('Dates indéterminées', summary.indeterminate.map((dating) => ({ dating, note: dating.detail })));
  }

  if (datingRun.failures.length > 0) {
    console.log('\n' + chalk.red(`❌ ${datingRun.failures.length} lecture(s) EXIF en échec (rien n'a été enregistré pour ces objets) :`));
    for (const failure of datingRun.failures) {
      getLogger().error(`Lecture EXIF de ${failure.key} en échec : ${failure.reason}`);
      console.log(`   ${failure.key} — ${failure.reason}`);
    }
    if (datingRun.aborted) {
      console.log(chalk.red('   Lectures restantes abandonnées après plusieurs échecs consécutifs (réseau indisponible ?).'));
    }
    console.log(chalk.yellow('   Relancez « gpb inventory dates » : les EXIF déjà lus ne seront pas relus.'));
  }
}

function listDatings(title: string, entries: { dating: ObjectDating; note: string | null }[]): void {
  console.log('\n' + chalk.cyan(`${title} (${entries.length.toLocaleString('fr-FR')}) :`));
  for (const { dating, note } of entries) {
    const labels: Record<DateSource, string> = {
      nom_fichier: ' [nom de fichier]',
      exif: ` [EXIF ${dating.detail}]`,
      indeterminee: '',
    };
    console.log(`   ${dating.takenAt ?? '—'}  ${dating.key}${labels[dating.source]}${note ? chalk.gray(` — ${note}`) : ''}`);
  }
}

function withDisplayOptions(command: Command): Command {
  return command
    .option('--bucket <nom>', 'Bucket inventorié (défaut : bucket de la configuration)')
    .option('--depth <n>', 'Profondeur de regroupement des emplacements', '3')
    .option('--limit <n>', 'Nombre maximal d\'emplacements affichés', '50');
}

function run(command: () => Promise<void>): Promise<void> {
  return runCommand('Erreur lors de l\'inventaire :', command);
}

async function scanCommand(config: AppConfig, options: InventoryOptions): Promise<void> {
  requireValidConfig(config);
  const bucket = options.bucket ?? config.cubbit.bucket;
  const lister = new S3BucketLister(createS3Client(config.cubbit), bucket);

  console.log(chalk.blue.bold(`🔍 Inventaire du bucket « ${bucket} » (lecture seule, sans préfixe)\n`));

  let objects;
  try {
    objects = await scanBucket(lister, (count) => {
      process.stdout.write(`\r   ${count.toLocaleString('fr-FR')} objets listés…`);
    });
  } catch (error) {
    process.stdout.write('\n');
    const reason = describeError(error);
    getLogger().error(`Listing du bucket ${bucket} interrompu : ${reason}`);
    throw new Error(
      `listing interrompu (${reason}). ` +
        'L\'inventaire local n\'a pas été modifié : relancez la commande.',
    );
  }
  process.stdout.write('\n\n');

  const inventoryRun = new InventoryModel().replace(bucket, objects);
  getLogger().info(
    `Inventaire du bucket ${bucket} : ${inventoryRun.objectCount} objets, ${inventoryRun.totalSize} octets`,
  );
  display(config, options, inventoryRun);
}

async function showCommand(config: AppConfig, options: InventoryOptions): Promise<void> {
  const bucket = options.bucket ?? config.cubbit.bucket;
  const inventoryRun = new InventoryModel().findRun(bucket);
  if (!inventoryRun) {
    console.log(chalk.yellow(`Aucun inventaire local pour le bucket « ${bucket} ». Lancez : gpb inventory scan`));
    return;
  }
  display(config, options, inventoryRun);
}

function display(config: AppConfig, { depth, limit }: InventoryOptions, inventoryRun: InventoryRun): void {
  const objects = new InventoryModel().findAll(inventoryRun.bucket);
  const summary = summarizeInventory(objects, config.sync.supportedFormats, depth);

  console.log(chalk.cyan(`📋 Inventaire du bucket « ${inventoryRun.bucket} » du ${inventoryRun.completedAt.toLocaleString('fr-FR')}`));
  console.log(`   Objets : ${chalk.white(summary.objectCount.toLocaleString('fr-FR'))} (${formatBytes(summary.totalSize)})`);
  console.log(
    `   Médias : ${chalk.white(summary.mediaCount.toLocaleString('fr-FR'))} (${formatBytes(summary.mediaSize)})` +
      ` — extensions : ${config.sync.supportedFormats.join(', ')}`,
  );

  console.log('\n' + chalk.cyan(`📂 Emplacements contenant des médias (profondeur ${depth}) :`));
  if (summary.locations.length === 0) {
    console.log('   Aucun média trouvé.');
  }
  for (const location of summary.locations.slice(0, limit)) {
    const count = location.mediaCount.toLocaleString('fr-FR').padStart(8);
    const size = formatBytes(location.mediaSize).padStart(10);
    console.log(`   ${count} médias ${size}  ${location.location}`);
  }
  if (summary.locations.length > limit) {
    console.log(chalk.gray(`   … ${summary.locations.length - limit} autres emplacements (option --limit)`));
  }

  if (summary.unrecognizedExtensions.length > 0) {
    // Toutes les extensions, sans troncature : une photo HEIC isolée ne doit pas disparaître de l'affichage.
    const all = summary.unrecognizedExtensions
      .map(({ extension, count }) => `${extension} (${count.toLocaleString('fr-FR')})`)
      .join(', ');
    console.log('\n' + chalk.gray(`ℹ️  Extensions non comptées comme médias : ${all}`));
  }
}

function parseOptions(raw: RawOptions): InventoryOptions {
  return {
    bucket: raw.bucket,
    depth: parsePositiveInt(raw.depth, '--depth'),
    limit: parsePositiveInt(raw.limit, '--limit'),
  };
}

function parsePositiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} doit être un entier positif (reçu : ${value})`);
  }
  return parsed;
}
