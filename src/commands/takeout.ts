import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { createS3Client } from '../clients/s3-client';
import { S3BucketLister } from '../clients/bucket-lister';
import { S3ObjectRangeReader } from '../clients/object-range-reader';
import * as fs from 'fs';
import { S3ObjectDownloader } from '../clients/object-downloader';
import { BucketLister, ObjectDownloader, ObjectRangeReader } from '../clients/types';
import { InventoryModel } from '../database/inventory-model';
import { TakeoutAnalysisModel } from '../database/takeout-analysis-model';
import { scanBucket } from '../inventory/inventory';
import { CHRONO_ROOT, QUARANTINE_ROOT } from '../inventory/repair-plan';
import { TAKEOUT_DATE_SOURCES } from '../takeout/media-dating';
import {
  AnalysisContext,
  analysisExport,
  analyzeTakeoutExport,
  AnalyzedMedia,
  ARCHIVE_ROOTS,
  ARCHIVE_STATUSES,
  archivedScope,
  ArchiveStatus,
  summarizeAnalysis,
} from '../takeout/takeout-analysis';
import { analyzeExport, ExportGroup, ExportReport, groupExports, ZipRef } from '../takeout/takeout-validation';
import { localZipSource, readZipDirectory, remoteZipSource } from '../takeout/zip-directory';
import { ensureLocalZip, LocalZip, VERIFICATION_LABELS, ZipProgress } from '../takeout/zip-download';
import { formatBytes, formatNumber } from '../utils/format';
import { checkTimeZone } from '../utils/local-date-time';
import { partSizeLabel } from '../utils/multipart-etag';
import { requireValidConfig } from './inventory';
import { runCommand } from './run-command';
import { register as registerArchiver } from './takeout-archive';
import { register as registerAttester } from './takeout-attest';
import { register as registerPlanifier } from './takeout-plan';

/**
 * `gpb takeout valider` (story 4.1) : valide les exports Takeout avant traitement en lisant la seule table des matières
 * de chaque zip, par lectures partielles. Lecture seule : listing du bucket dédié et GET partiels, rien n'est écrit, ni
 * dans un bucket ni en base.
 *
 * `gpb takeout analyser` (story 4.2) : télécharge localement et vérifie les zips d'un export validé, puis identifie
 * (MD5 du contenu) et date chaque média, détecte les doublons internes et ce qui est déjà archivé d'après l'inventaire
 * local du bucket dédié. Lecture seule côté S3 ; l'analyse est enregistrée en base pour la story 4.3.
 */

/** Fuseau par défaut de conversion de `photoTakenTime` (instant UTC) en heure locale de prise de vue. */
export const DEFAULT_TIME_ZONE = 'Europe/Paris';

/** Emplacement des exports Takeout dans le bucket dédié (exemplaires uniques, jamais écrits). */
export const BACKUPS_PREFIX = 'backups/';

interface ValiderOptions {
  export?: string;
  zip?: string[];
  parties?: string;
}

interface AnalyserOptions {
  export: string;
  parties: string;
  dossier?: string;
  fuseau: string;
  sortie?: string[];
}

/** Accès aux zips, injectable pour les tests. */
export interface TakeoutSources {
  remoteZips(): Promise<{ origin: string; zips: ZipRef[] }>;
  localZip(filePath: string): Promise<ZipRef>;
  downloader(): ObjectDownloader;
}

export function register(program: Command, config: AppConfig, sources: TakeoutSources = defaultSources(config)): void {
  const takeoutCmd = program.command('takeout').description('Exports Google Takeout');

  takeoutCmd
    .command('valider')
    .description(
      `Valider les exports Takeout avant traitement (zips de ${BACKUPS_PREFIX} du bucket dédié, ou zips locaux) en ne lisant ` +
        'que leur table des matières : parties, médias et volume par dossier, albums, médias sans métadonnées, fichiers ' +
        'non reconnus, verdict. Lecture seule. Code de sortie 1 si un export est non exploitable',
    )
    .option('--export <horodatage>', 'Ne valider que cet export (ex. 20260806T062636Z)')
    .option('--zip <chemins...>', `Zips locaux à valider au lieu de ${BACKUPS_PREFIX}`)
    .option('--parties <n>', 'Nombre de parties annoncé par Google pour l\'export (avec --export) : tout écart rend l\'export non exploitable')
    .action((options: ValiderOptions) =>
      runCommand('Validation Takeout :', () => validerCommand(config.sync.supportedFormats, sources, options)),
    );

  takeoutCmd
    .command('analyser')
    .description(
      `Analyser un export validé : télécharger ses zips de ${BACKUPS_PREFIX} dans un dossier local et vérifier leur intégrité ` +
        '(reprise sans retéléchargement), puis identifier chaque média par son contenu (MD5), le dater (photoTakenTime, nom, ' +
        'EXIF ; Live Photos), détecter les doublons internes et ce qui est déjà archivé d\'après l\'inventaire local du bucket ' +
        'dédié. Lecture seule côté S3 ; analyse enregistrée en base',
    )
    .requiredOption('--export <horodatage>', 'Export à analyser (ex. 20260806T062636Z)')
    .requiredOption('--parties <n>', 'Nombre de parties annoncé par Google : exigé, tout écart refuse l\'analyse')
    .option('--dossier <chemin>', 'Dossier de travail local des zips (défaut : data/takeout/<export>/)')
    .option('--fuseau <iana>', 'Fuseau de conversion de photoTakenTime (instant UTC) en heure de prise de vue', DEFAULT_TIME_ZONE)
    .option('--sortie <fichiers...>', 'Exporter l\'analyse détaillée par média (.csv et/ou .json)')
    .action((options: AnalyserOptions) => runCommand('Analyse Takeout :', () => analyserCommand(config, sources, options)));

  registerPlanifier(takeoutCmd, config, sources);
  registerArchiver(takeoutCmd, config, sources);
  registerAttester(takeoutCmd, config, sources);
}

/** Zips de `backups/` du bucket, taille connue par le listing exhaustif, lus par GET partiels. */
export async function listBackupZips(lister: BucketLister, reader: ObjectRangeReader): Promise<ZipRef[]> {
  const objects = await scanBucket(lister);
  return objects
    .filter((o) => o.key.startsWith(BACKUPS_PREFIX) && o.key.toLowerCase().endsWith('.zip'))
    .map((o) => ({
      name: path.posix.basename(o.key),
      location: `${lister.bucket}/${o.key}`,
      size: o.size,
      key: o.key,
      etag: o.etag,
      open: async () => remoteZipSource(reader, o.key, o.size),
    }));
}

export function defaultSources(config: AppConfig): TakeoutSources {
  return {
    async remoteZips(): Promise<{ origin: string; zips: ZipRef[] }> {
      const bucket = config.repair.destinationBucket;
      if (!bucket) throw new Error('aucun bucket dédié configuré (CUBBIT_DESTINATION_BUCKET ou repair.destinationBucket)');
      requireValidConfig(config);
      const client = createS3Client(config.cubbit);
      const zips = await listBackupZips(new S3BucketLister(client, bucket), new S3ObjectRangeReader(client, bucket));
      return { origin: `${bucket}/${BACKUPS_PREFIX}`, zips };
    },
    async localZip(filePath: string): Promise<ZipRef> {
      const source = await localZipSource(filePath);
      return { name: path.basename(filePath), location: filePath, size: source.size, open: async () => source };
    },
    downloader(): ObjectDownloader {
      requireValidConfig(config);
      return new S3ObjectDownloader(createS3Client(config.cubbit), config.repair.destinationBucket);
    },
  };
}

/** Entier positif de `--parties`. */
export function parsePartCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) throw new Error(`--parties attend un entier positif (reçu « ${value} »)`);
  return count;
}

/** Exports désignés par `--export` (horodatage seul ou identifiant complet), tous si absent ; refus si aucun. */
export function selectGroups(zips: ZipRef[], exportId: string | undefined): ExportGroup[] {
  const all = groupExports(zips);
  const groups = all.filter((g) => !exportId || g.id === exportId || g.id.startsWith(`${exportId}-`));
  if (groups.length === 0) {
    throw new Error(exportId ? `aucun export « ${exportId} » (exports présents : ${all.map((g) => g.id).join(', ') || 'aucun'})` : 'aucun zip à valider');
  }
  return groups;
}

async function validerCommand(supportedFormats: string[], sources: TakeoutSources, options: ValiderOptions): Promise<void> {
  const expectedParts = parsePartCount(options.parties);
  const { origin, zips } = options.zip
    ? { origin: 'zips locaux', zips: await Promise.all(options.zip.map((file) => sources.localZip(file))) }
    : await sources.remoteZips();
  console.log(chalk.blue.bold('📦 Validation des exports Takeout (lecture seule, table des matières uniquement)\n'));
  console.log(`Source : ${origin} — ${formatNumber(zips.length)} zip(s)`);

  const groups = selectGroups(zips, options.export);
  if (expectedParts !== undefined && groups.length > 1) {
    throw new Error(`--parties concerne un seul export : précisez --export (exports présents : ${groups.map((g) => g.id).join(', ')})`);
  }

  let exploitable = true;
  for (const group of groups) {
    const report = await analyzeExport(group, supportedFormats, expectedParts);
    display(report);
    exploitable &&= report.exploitable;
  }
  if (!exploitable) process.exitCode = 1;
}

const percent = (part: number, total: number): string =>
  `${(total > 0 ? (100 * part) / total : 0).toLocaleString('fr-FR', { maximumFractionDigits: 3 })} %`;

function display(report: ExportReport): void {
  const verdict = report.exploitable ? chalk.green('✅ exploitable') : chalk.red('❌ non exploitable');
  console.log('\n' + chalk.cyan.bold(`═══ Export ${report.id} : `) + verdict);

  console.log(chalk.cyan('\nParties :'));
  for (const part of report.parts) {
    const content =
      part.error === null
        ? `${formatNumber(part.entryCount ?? 0)} entrée(s)${part.zip64 ? ', zip64' : ''}`
        : chalk.red(`illisible : ${part.error}`);
    console.log(
      `   ${String(part.number).padStart(3, '0')}  ${part.name}  ${formatBytes(part.size)}  ${content}  ` +
        chalk.gray(`(lus : ${formatBytes(part.bytesRead)}, ${percent(part.bytesRead, part.size)})`),
    );
  }

  const mediaCount = report.media.length;
  const mediaSize = report.media.reduce((sum, m) => sum + m.size, 0);
  const without = report.folders.flatMap((f) => f.withoutMetadata.map((name) => `${f.name}/${name}`));
  console.log(chalk.cyan('\nDossiers :'));
  for (const folder of report.folders) {
    const kind = folder.kind === 'annee' ? 'année' : 'album';
    const details = [
      `${formatNumber(folder.mediaCount)} média(s)`,
      formatBytes(folder.mediaSize),
      `${formatNumber(folder.withoutMetadata.length)} sans métadonnées`,
      ...(folder.albumMetadata ? ['métadonnées d\'album'] : []),
    ];
    console.log(`   ${folder.name.padEnd(28)} ${kind.padEnd(6)} ${details.join(' · ')}`);
  }
  const albums = report.folders.filter((f) => f.kind === 'album').map((f) => f.name);
  console.log(`\nAlbums détectés : ${albums.length > 0 ? albums.join(', ') : 'aucun'}`);
  console.log(`Total : ${formatNumber(mediaCount)} média(s), ${formatBytes(mediaSize)}`);

  console.log(chalk.cyan(`\nMédias sans métadonnées (${formatNumber(without.length)}) :`));
  for (const name of without) console.log(`   ${name}`);
  const livePhotos = report.folders.flatMap((f) => f.livePhotoVideos.map((l) => `${f.name}/${l.video} → ${l.image}`));
  console.log(chalk.cyan(`\nVidéos de Live Photo (${formatNumber(livePhotos.length)}) :`) + chalk.gray(' sans métadonnées propres, datées par « gpb takeout analyser »'));
  for (const line of livePhotos) console.log(`   ${line}`);
  console.log(chalk.cyan(`\nFichiers non reconnus (${formatNumber(report.unrecognized.length)}) :`));
  for (const item of report.unrecognized) console.log(`   ${item.path} ${chalk.gray(`(${item.part} : ${item.reason})`)}`);

  if (report.warnings.length > 0) console.log(chalk.yellow('\nAvertissements :'));
  for (const warning of report.warnings) console.log(chalk.yellow(`   • ${warning}`));

  const parts = report.partCountConfirmed
    ? `nombre de parties confirmé (${report.parts.length})`
    : 'nombre de parties non confirmé (--parties)';
  if (report.exploitable) {
    console.log(chalk.green(`\nVerdict : exploitable, ${parts}.`) + ' Rien n\'a été écrit.');
  } else {
    console.log(chalk.red(`\nVerdict : non exploitable, ${parts}.`));
    for (const problem of report.problems) console.log(chalk.red(`   • ${problem}`));
  }
}

// --- gpb takeout analyser (story 4.2) ----------------------------------------------------------------------------------

/** Affiche une progression par paliers de 10 %, sans inonder la console. */
export function progressPrinter(): (label: string, done: number, total: number) => void {
  const printed = new Map<string, number>();
  return (label, done, total) => {
    const step = total > 0 ? Math.floor((10 * done) / total) : 10;
    if ((printed.get(label) ?? -1) >= step) return;
    printed.set(label, step);
    console.log(chalk.gray(`   ${label} : ${step * 10} % (${formatBytes(done)} / ${formatBytes(total)})`));
  };
}

export const PHASE_LABELS: Record<ZipProgress['phase'], string> = { telechargement: 'téléchargement', verification: 'vérification' };
export const ORIGIN_LABELS: Record<LocalZip['origin'], string> = {
  reutilise: 'déjà présent et vérifié, réutilisé',
  reverifie: 'déjà présent, revérifié sans téléchargement',
  telecharge: 'téléchargé',
};

/** Dossier de travail local des zips d'un export (défaut : `data/takeout/<export>/`). */
export const localZipsDirectory = (config: AppConfig, exportId: string, dossier?: string): string =>
  path.resolve(dossier ?? path.join(path.dirname(config.database.path), 'takeout', exportId));

/** Télécharge (ou réutilise après revérification, sans retéléchargement) et vérifie les zips locaux d'un export. */
export async function ensureLocalZips(config: AppConfig, sources: TakeoutSources, group: ExportGroup, dossier?: string): Promise<LocalZip[]> {
  const directory = localZipsDirectory(config, group.id, dossier);
  console.log(chalk.cyan(`\nZips locaux (${directory}) :`));
  const downloader = sources.downloader();
  const progress = progressPrinter();
  const localZips: LocalZip[] = [];
  for (const { zip } of group.parts) {
    if (zip.key === undefined) throw new Error(`${zip.name} : clé du zip dans le bucket inconnue`);
    const local = await ensureLocalZip(downloader, { name: zip.name, key: zip.key, size: zip.size, etag: zip.etag ?? null }, directory, {
      onProgress: (p) => progress(`${p.zip} — ${PHASE_LABELS[p.phase]}`, p.done, p.total),
      remoteEntries: async () => (await readZipDirectory(await zip.open())).entries,
    });
    localZips.push(local);
    const part = local.partSize === null ? '' : ` (parties de ${partSizeLabel(local.partSize)})`;
    console.log(`   ${local.name}  ${formatBytes(local.size)}  ${ORIGIN_LABELS[local.origin]} — ${VERIFICATION_LABELS[local.verification]}${part}`);
    if (local.detail) console.log(chalk.yellow(`      ${local.detail}`));
    if (local.note) console.log(chalk.yellow(`      ${local.note}`));
  }
  return localZips;
}

/** Même export, lu sur les zips locaux vérifiés : ce sont leurs octets qui sont analysés, archivés puis attestés. */
export function localExportGroup(group: ExportGroup, localZips: LocalZip[]): ExportGroup {
  return {
    id: group.id,
    parts: group.parts.map((p, i) => {
      const local = localZips[i]!;
      return { number: p.number, zip: { name: local.name, location: local.path, size: local.size, open: () => localZipSource(local.path) } };
    }),
  };
}

async function analyserCommand(config: AppConfig, sources: TakeoutSources, options: AnalyserOptions): Promise<void> {
  const expectedParts = parsePartCount(options.parties)!;
  checkTimeZone(options.fuseau);
  const bucket = config.repair.destinationBucket;
  if (!bucket) throw new Error('aucun bucket dédié configuré (CUBBIT_DESTINATION_BUCKET ou repair.destinationBucket)');
  const inventory = new InventoryModel();
  const inventoryRun = inventory.findRun(bucket);
  if (!inventoryRun) {
    throw new Error(`aucun inventaire local du bucket dédié « ${bucket} » : impossible de savoir ce qui est déjà archivé. Lancez : gpb inventory scan --bucket ${bucket}`);
  }

  console.log(chalk.blue.bold('🔎 Analyse d\'un export Takeout (lecture seule côté S3)\n'));
  const { origin, zips } = await sources.remoteZips();
  const groups = selectGroups(zips, options.export);
  if (groups.length > 1) throw new Error(`« ${options.export} » désigne plusieurs exports (${groups.map((g) => g.id).join(', ')}) : précisez l'identifiant complet`);
  const group = groups[0]!;
  console.log(`Source : ${origin} — export ${group.id}, ${formatNumber(group.parts.length)} partie(s)`);

  const remoteReport = await analyzeExport(group, config.sync.supportedFormats, expectedParts);
  if (!remoteReport.exploitable) {
    throw new Error(`export ${group.id} non exploitable (gpb takeout valider --export ${options.export} --parties ${expectedParts}) : ${remoteReport.problems.join(' ; ')}`);
  }

  const localZips = await ensureLocalZips(config, sources, group, options.dossier);
  const localGroup = localExportGroup(group, localZips);
  const report = await analyzeExport(localGroup, config.sync.supportedFormats, expectedParts);
  if (!report.exploitable || report.media.length !== remoteReport.media.length) {
    throw new Error(`zips locaux incohérents avec la validation distante (${report.media.length} médias contre ${remoteReport.media.length}) : ${report.problems.join(' ; ')}`);
  }

  console.log(chalk.cyan(`\nLecture des médias (${formatNumber(report.media.length)}) :`));
  const progress = progressPrinter();
  const media = await analyzeTakeoutExport({
    report,
    zipPaths: new Map(localZips.map((z) => [z.name, z.path])),
    timeZone: options.fuseau,
    keptAlbums: config.takeout.keptAlbums,
    archived: archivedScope(inventory.findAll(bucket)),
    onProgress: (done, total) => progress('décompression et empreintes', done, total),
  });

  const context: AnalysisContext = {
    exportId: group.id,
    timeZone: options.fuseau,
    keptAlbums: config.takeout.keptAlbums,
    destinationBucket: bucket,
    inventoryCompletedAt: inventoryRun.completedAt.toISOString(),
    analyzedAt: new Date().toISOString(),
    zips: localZips.map((z) => ({ name: z.name, size: z.size, etag: z.etag, verification: z.verification })),
  };
  new TakeoutAnalysisModel().replace({ ...context, media });
  displayAnalysis(media, context);

  for (const file of options.sortie ?? []) {
    const content = analysisExport(media, context, file);
    await fs.promises.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await fs.promises.writeFile(file, content, 'utf8');
    console.log(chalk.green(`📄 Analyse détaillée exportée (${formatNumber(media.length)} médias) : ${path.resolve(file)}`));
  }
}

const STATUS_LABELS: Record<ArchiveStatus, string> = {
  deja_archive: 'déjà archivés (confirmés par MD5 ou ETag multipart recalculé)',
  non_confirmable: 'non confirmables (homonyme de même taille à ETag multipart non retrouvé ou absent)',
  homonyme_different: 'homonymes de contenu différent',
  nouveau: 'nouveaux',
};

const describeMedia = (m: AnalyzedMedia): string => `${m.folder}/${m.fileName} ${chalk.gray(`(${m.part})`)}`;

function displayAnalysis(media: AnalyzedMedia[], context: AnalysisContext): void {
  const summary = summarizeAnalysis(media, { timeZone: context.timeZone, keptAlbums: context.keptAlbums });
  const count = (n: number, size?: number): string => `${formatNumber(n)}${size === undefined ? '' : ` (${formatBytes(size)})`}`;
  console.log('\n' + chalk.cyan.bold(`═══ Analyse de l'export ${context.exportId}`));
  console.log(`Médias : ${count(summary.media.count, summary.media.size)} — contenus distincts : ${count(summary.distinct.count, summary.distinct.size)}`);

  console.log(chalk.cyan(`\nDates par source (fuseau ${context.timeZone} pour les instants sans date locale) :`));
  for (const source of TAKEOUT_DATE_SOURCES) console.log(`   ${source.padEnd(22)} ${formatNumber(summary.bySource[source])}`);
  console.log(chalk.cyan(`\nDates suspectes (${formatNumber(summary.suspects.length)}) :`));
  for (const s of summary.suspects) console.log(`   ${describeMedia(s.media)} ${s.media.takenAt} [${s.media.dateSource}] : ${s.reason}`);
  console.log(chalk.cyan(`\nDates indéterminées (${formatNumber(summary.indeterminate.length)}) :`));
  for (const m of summary.indeterminate) console.log(`   ${describeMedia(m)} : ${m.dateDetail}`);
  console.log(chalk.cyan(`\nAlertes de date (${formatNumber(summary.dateWarnings.length)}, dont ${formatNumber(summary.jsonDiscordances)} discordance(s) JSON) :`));
  for (const m of summary.dateWarnings) console.log(`   ${describeMedia(m)} ${m.takenAt} [${m.dateSource}] : ${m.dateWarning}`);
  console.log(chalk.cyan(`\nVidéos de Live Photo (${formatNumber(summary.livePhotos.length)}) :`));
  for (const m of summary.livePhotos) {
    console.log(`   ${describeMedia(m)} → ${m.companion} : ${m.takenAt ?? 'indéterminée'} [${m.dateSource}]${m.dateWarning ? chalk.yellow(` ⚠ ${m.dateWarning}`) : ''}`);
  }

  console.log(chalk.cyan(`\nDoublons internes : ${formatNumber(summary.duplicateGroups.length)} contenu(s) en plusieurs exemplaires, ${count(summary.duplicateCopies.count, summary.duplicateCopies.size)} copie(s) en trop`));
  console.log(chalk.gray(`   représentant : album conservé (${context.keptAlbums.join(', ') || 'aucun'}) sinon première occurrence`));
  for (const group of summary.duplicateGroups) console.log(`   ${group.map((m) => `${m.folder}/${m.fileName}`).join('  =  ')}`);
  console.log(
    chalk.yellow(
      `   Règle des albums à trancher en 4.3 : ${formatNumber(summary.albumRule.archivedInPhotosAndKeptAlbum)} contenu(s) déjà archivé(s) sous ${CHRONO_ROOT} ` +
        `et présent(s) dans un album conservé ; ${formatNumber(summary.albumRule.newInYearAndKeptAlbum)} contenu(s) à envoyer présent(s) dans une année et un album conservé`,
    ),
  );

  console.log(
    chalk.cyan(
      `\nDéjà archivé (inventaire local de ${context.destinationBucket} du ${new Date(context.inventoryCompletedAt!).toLocaleString('fr-FR')}, espaces ${ARCHIVE_ROOTS.join(', ')}) :`,
    ),
  );
  for (const status of ARCHIVE_STATUSES) console.log(`   ${STATUS_LABELS[status].padEnd(84)} ${count(summary.byStatus[status].count, summary.byStatus[status].size)}`);
  console.log(`      dont confirmés par MD5 : ${formatNumber(summary.byProof.md5)} ; par ETag multipart recalculé : ${formatNumber(summary.byProof.etag_multipart)}`);
  const same = summary.sameNameAndSize;
  console.log(
    `   Médias ayant un objet de même nom et même taille : ${formatNumber(same.total)}, dont ${formatNumber(same.deja_archive)} confirmés, ` +
      `${formatNumber(same.non_confirmable)} non confirmables, ${formatNumber(same.homonyme_different + same.nouveau)} de contenu différent`,
  );
  console.log(chalk.bold(`   À envoyer (contenus distincts nouveaux ou homonymes différents) : ${count(summary.toSend.count, summary.toSend.size)}`));
  console.log(chalk.cyan(`\nDéjà archivés uniquement en ${QUARANTINE_ROOT} (${formatNumber(summary.quarantineOnly.length)}) :`) + chalk.gray(' à reclasser en 4.3, jamais laissés en quarantaine'));
  for (const m of summary.quarantineOnly) console.log(`   ${describeMedia(m)} ↔ ${m.archive.key} : date retenue : ${m.takenAt ?? 'indéterminée'} [${m.dateSource}]`);
  for (const status of ['non_confirmable', 'homonyme_different'] as const) {
    const listed = media.filter((m) => m.archive.status === status);
    console.log(chalk.cyan(`\n${STATUS_LABELS[status][0]!.toUpperCase()}${STATUS_LABELS[status].slice(1)} (${formatNumber(listed.length)}) :`));
    for (const m of listed) console.log(`   ${describeMedia(m)} ↔ ${m.archive.candidates.join(', ')}`);
  }

  console.log(chalk.cyan('\nConcordance de mois avec le dossier de l\'objet archivé (médias confirmés), par source de la date retenue :'));
  for (const c of summary.monthConcordance) {
    const json = c.jsonInTimeZone === null ? '' : ` ; avec photoTakenTime : ${formatNumber(c.jsonInTimeZone)} en ${context.timeZone}, ${formatNumber(c.jsonUtc!)} en UTC`;
    console.log(`   ${c.source.padEnd(22)} ${formatNumber(c.concordant)} concordant(s), ${formatNumber(c.discordant)} discordant(s), ${formatNumber(c.notComparable)} non comparable(s)${json}`);
  }
  const names = summary.nameConcordance;
  console.log(
    `   mois du nom de fichier / photoTakenTime : ${formatNumber(names.inTimeZone)} concordant(s) sur ${formatNumber(names.compared)} en ${context.timeZone} (en UTC : ${formatNumber(names.utc)})`,
  );

  console.log(chalk.green(`\nAnalyse enregistrée en base (${formatNumber(media.length)} médias). Rien n'a été écrit dans aucun bucket.`));
}
