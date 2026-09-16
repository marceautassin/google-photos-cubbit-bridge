import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { AppConfig } from '../config/types';
import { createS3Client } from '../clients/s3-client';
import { S3BucketLister } from '../clients/bucket-lister';
import { S3ObjectRangeReader } from '../clients/object-range-reader';
import { BucketLister, ObjectRangeReader } from '../clients/types';
import { scanBucket } from '../inventory/inventory';
import { analyzeExport, ExportReport, groupExports, ZipRef } from '../takeout/takeout-validation';
import { localZipSource, remoteZipSource } from '../takeout/zip-directory';
import { formatBytes, formatNumber } from '../utils/format';
import { registerDisabledCommand } from './disabled-command';
import { requireValidConfig } from './inventory';
import { runCommand } from './run-command';

/**
 * `gpb takeout valider` (story 4.1) : valide les exports Takeout avant traitement en lisant la seule table des matières
 * de chaque zip, par lectures partielles. Lecture seule : listing du bucket dédié et GET partiels, rien n'est écrit, ni
 * dans un bucket ni en base. Les anciennes sous-commandes (ancien format Takeout extrait localement) sont désactivées.
 */

/** Emplacement des exports Takeout dans le bucket dédié (exemplaires uniques, jamais écrits). */
export const BACKUPS_PREFIX = 'backups/';

export const LEGACY_MESSAGE =
  'désactivée : elle lisait un ancien format Takeout que Google ne produit plus. Validez un export avec ' +
  '« gpb takeout valider » ; l\'archivage sera reconstruit sur le point d\'accès en écriture (epic 4). Rien n\'a été lu ni envoyé.';

interface ValiderOptions {
  export?: string;
  zip?: string[];
  parties?: string;
}

/** Accès aux zips, injectable pour les tests. */
export interface TakeoutSources {
  remoteZips(): Promise<{ origin: string; zips: ZipRef[] }>;
  localZip(filePath: string): Promise<ZipRef>;
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

  for (const [name, description] of [
    ['import', 'Importer un export Takeout extrait (ancien format)'],
    ['list', 'Lister un export Takeout extrait (ancien format)'],
    ['validate', 'Valider un export Takeout extrait (ancien format), remplacée par « valider »'],
  ] as const) {
    registerDisabledCommand(takeoutCmd, name, description, LEGACY_MESSAGE);
  }
  registerDisabledCommand(program, 'archive', 'Extraire des archives Takeout localement (ancien format)', LEGACY_MESSAGE);
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
      open: async () => remoteZipSource(reader, o.key, o.size),
    }));
}

function defaultSources(config: AppConfig): TakeoutSources {
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
  };
}

async function validerCommand(supportedFormats: string[], sources: TakeoutSources, options: ValiderOptions): Promise<void> {
  const expectedParts = options.parties === undefined ? undefined : Number(options.parties);
  if (expectedParts !== undefined && (!Number.isInteger(expectedParts) || expectedParts < 1)) {
    throw new Error(`--parties attend un entier positif (reçu « ${options.parties} »)`);
  }
  const { origin, zips } = options.zip
    ? { origin: 'zips locaux', zips: await Promise.all(options.zip.map((file) => sources.localZip(file))) }
    : await sources.remoteZips();
  console.log(chalk.blue.bold('📦 Validation des exports Takeout (lecture seule, table des matières uniquement)\n'));
  console.log(`Source : ${origin} — ${formatNumber(zips.length)} zip(s)`);

  const groups = groupExports(zips).filter((g) => !options.export || g.id === options.export || g.id.startsWith(`${options.export}-`));
  if (groups.length === 0) {
    const available = groupExports(zips).map((g) => g.id);
    throw new Error(
      options.export
        ? `aucun export « ${options.export} » (exports présents : ${available.join(', ') || 'aucun'})`
        : 'aucun zip à valider',
    );
  }

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
  console.log(chalk.cyan(`\nVidéos de Live Photo (${formatNumber(livePhotos.length)}) :`) + chalk.gray(' sans métadonnées propres, date à décider en 4.2'));
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
