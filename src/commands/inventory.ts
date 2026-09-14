import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { validateConfig } from '../config';
import { createS3Client } from '../clients/s3-client';
import { S3BucketLister } from '../clients/bucket-lister';
import { InventoryModel, InventoryRun } from '../database/inventory-model';
import { scanBucket, summarizeInventory } from '../inventory/inventory';
import { formatBytes } from '../utils/file-utils';
import { getLogger } from '../utils/logger';

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
}

function withDisplayOptions(command: Command): Command {
  return command
    .option('--bucket <nom>', 'Bucket inventorié (défaut : bucket de la configuration)')
    .option('--depth <n>', 'Profondeur de regroupement des emplacements', '3')
    .option('--limit <n>', 'Nombre maximal d\'emplacements affichés', '50');
}

async function run(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    console.error(chalk.red('Erreur lors de l\'inventaire :'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function scanCommand(config: AppConfig, options: InventoryOptions): Promise<void> {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`configuration incomplète (${errors.join(', ')}). Renseignez le fichier .env.`);
  }

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
    // Seul le message est journalisé : l'objet d'erreur du SDK peut embarquer l'identifiant de clé.
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
