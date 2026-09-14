import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs-extra';
import { AppConfig } from '../config/types';
import { TakeoutParser } from '../takeout/takeout-parser';
import { SyncRecordModel } from '../database/models';
import { SyncStatus } from '../clients/types';
import { formatBytes } from '../utils/file-utils';

export function register(program: Command, config: AppConfig): void {
  const takeoutCmd = program
    .command('takeout')
    .description('Commandes pour traiter les exports Google Takeout');

  takeoutCmd
    .command('import <takeout-path>')
    .description('Importer un export Google Takeout')
    .option('--dry-run', 'Simuler l\'import sans modifier la base de données')
    .option('--force', 'Forcer l\'import même si des éléments existent déjà')
    .action(async (takeoutPath, options) => {
      try {
        await importCommand(takeoutPath, options, config);
      } catch (error) {
        console.error(chalk.red('Erreur lors de l\'import:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  takeoutCmd
    .command('list <takeout-path>')
    .description('Lister le contenu d\'un export Takeout')
    .option('--albums', 'Afficher seulement les albums')
    .option('--stats', 'Afficher les statistiques')
    .action(async (takeoutPath, options) => {
      try {
        await listCommand(takeoutPath, options, config);
      } catch (error) {
        console.error(chalk.red('Erreur lors du listing:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  takeoutCmd
    .command('validate <takeout-path>')
    .description('Valider un export Takeout')
    .action(async (takeoutPath) => {
      try {
        await validateCommand(takeoutPath);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la validation:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

async function importCommand(takeoutPath: string, options: any, config: AppConfig): Promise<void> {
  console.log(chalk.blue(`📦 Import de l'export Takeout depuis: ${takeoutPath}\n`));

  // Vérifier que le chemin existe
  if (!(await fs.pathExists(takeoutPath))) {
    throw new Error(`Le chemin ${takeoutPath} n'existe pas`);
  }

  // Parser l'export Takeout
  const parser = new TakeoutParser();
  const mediaItems = await parser.parseTakeoutDirectory(takeoutPath);

  if (mediaItems.length === 0) {
    console.log(chalk.yellow('Aucun élément média trouvé dans l\'export Takeout.'));
    return;
  }

  console.log(chalk.green(`${mediaItems.length} éléments média trouvés`));

  // Statistiques
  const stats = {
    photos: mediaItems.filter(item => item.mimeType.startsWith('image/')).length,
    videos: mediaItems.filter(item => item.mimeType.startsWith('video/')).length,
    albums: new Set(mediaItems.filter(item => item.album).map(item => item.album)).size,
    totalSize: mediaItems.reduce((sum, item) => sum + item.fileSize, 0),
  };

  console.log(chalk.cyan('\n📊 Statistiques:'));
  console.log(`   Photos: ${chalk.white(stats.photos)}`);
  console.log(`   Vidéos: ${chalk.white(stats.videos)}`);
  console.log(`   Albums: ${chalk.white(stats.albums)}`);
  console.log(`   Taille totale: ${chalk.white(formatBytes(stats.totalSize))}`);

  if (options.dryRun) {
    console.log(chalk.yellow('\n[DRY RUN] Import simulé - aucune modification en base'));
    return;
  }

  // Importer en base de données
  const syncRecords = new SyncRecordModel();
  let importedCount = 0;
  let skippedCount = 0;

  console.log(chalk.blue('\n📥 Import en cours...'));

  for (const item of mediaItems) {
    // Générer un ID unique basé sur le chemin du fichier complet + nom de fichier
    const uniqueId = Buffer.from(item.filepath + '|' + item.filename + '|' + item.fileSize).toString('base64');

    // Vérifier si l'élément existe déjà
    const existingRecord = await syncRecords.findByGooglePhotoId(uniqueId);
    if (existingRecord && !options.force) {
      skippedCount++;
      continue;
    }

    // Générer le chemin de stockage Cubbit
    const storagePath = generateTakeoutStoragePath(item, config);

    // Créer l'enregistrement de synchronisation
    const recordData = {
      googlePhotoId: uniqueId,
      filename: item.filename,
      googleUrl: item.filepath, // Utiliser le chemin local au lieu d'une URL Google
      cubbitPath: storagePath,
      fileSize: item.fileSize,
      mimeType: item.mimeType,
      createdDate: item.creationDate,
      status: SyncStatus.PENDING,
      // Un réimport repart d'un état propre : pas d'ancienne erreur ni de date d'envoi
      errorMessage: undefined,
      syncDate: undefined,
      metadata: {
        ...item.metadata,
        albumTitle: item.album,
        source: 'takeout',
        originalPath: item.filepath,
      },
    };

    if (existingRecord) {
      await syncRecords.update(existingRecord.id!, recordData);
    } else {
      await syncRecords.create(recordData);
    }

    importedCount++;

    // Afficher la progression
    if (importedCount % 100 === 0) {
      console.log(chalk.gray(`   ${importedCount}/${mediaItems.length} éléments importés...`));
    }
  }

  console.log(chalk.green(`\n✅ Import terminé!`));
  console.log(`   Importés: ${chalk.green(importedCount)}`);
  console.log(`   Ignorés: ${chalk.yellow(skippedCount)}`);
  console.log('\n' + chalk.blue('Vous pouvez maintenant lancer la synchronisation avec:'));
  console.log(chalk.cyan('   gpb sync'));
}

async function listCommand(takeoutPath: string, options: any, config: AppConfig): Promise<void> {
  console.log(chalk.blue(`📋 Contenu de l'export Takeout: ${takeoutPath}\n`));

  // Vérifier que le chemin existe
  if (!(await fs.pathExists(takeoutPath))) {
    throw new Error(`Le chemin ${takeoutPath} n'existe pas`);
  }

  // Parser l'export Takeout
  const parser = new TakeoutParser();
  const mediaItems = await parser.parseTakeoutDirectory(takeoutPath);

  if (mediaItems.length === 0) {
    console.log(chalk.yellow('Aucun élément média trouvé.'));
    return;
  }

  if (options.albums) {
    // Afficher seulement les albums
    const albums = new Map<string, number>();
    mediaItems.filter(item => item.album).forEach(item => {
      const count = albums.get(item.album!) || 0;
      albums.set(item.album!, count + 1);
    });

    console.log(chalk.cyan('📚 Albums trouvés:'));
    for (const [albumName, count] of albums) {
      console.log(`   ${chalk.white(albumName)}: ${chalk.gray(count + ' éléments')}`);
    }

  } else if (options.stats) {
    // Afficher les statistiques détaillées
    const stats = {
      photos: mediaItems.filter(item => item.mimeType.startsWith('image/')).length,
      videos: mediaItems.filter(item => item.mimeType.startsWith('video/')).length,
      albums: new Set(mediaItems.filter(item => item.album).map(item => item.album)).size,
      totalSize: mediaItems.reduce((sum, item) => sum + item.fileSize, 0),
      dateRange: {
        earliest: new Date(Math.min(...mediaItems.map(item => item.creationDate.getTime()))),
        latest: new Date(Math.max(...mediaItems.map(item => item.creationDate.getTime()))),
      },
    };

    console.log(chalk.cyan('📊 Statistiques détaillées:'));
    console.log(`   Photos: ${chalk.white(stats.photos)}`);
    console.log(`   Vidéos: ${chalk.white(stats.videos)}`);
    console.log(`   Albums: ${chalk.white(stats.albums)}`);
    console.log(`   Taille totale: ${chalk.white(formatBytes(stats.totalSize))}`);
    console.log(`   Plus ancienne: ${chalk.white(stats.dateRange.earliest.toLocaleDateString('fr-FR'))}`);
    console.log(`   Plus récente: ${chalk.white(stats.dateRange.latest.toLocaleDateString('fr-FR'))}`);

  } else {
    // Afficher la liste des éléments
    console.log(chalk.cyan('📷 Éléments média:'));
    console.log(
      chalk.bold('Nom'.padEnd(40)) +
      chalk.bold('Type'.padEnd(15)) +
      chalk.bold('Taille'.padEnd(12)) +
      chalk.bold('Date'.padEnd(12)) +
      chalk.bold('Album')
    );
    console.log('-'.repeat(90));

    for (const item of mediaItems.slice(0, 50)) { // Limiter à 50 pour la lisibilité
      const name = item.filename.padEnd(40);
      const type = (item.mimeType.startsWith('image/') ? '📷 Photo' : '🎥 Vidéo').padEnd(15);
      const size = formatBytes(item.fileSize).padEnd(12);
      const date = item.creationDate.toLocaleDateString('fr-FR').padEnd(12);
      const album = item.album || '';

      console.log(
        chalk.white(name) +
        chalk.blue(type) +
        chalk.yellow(size) +
        chalk.gray(date) +
        chalk.green(album)
      );
    }

    if (mediaItems.length > 50) {
      console.log(chalk.gray(`\n... et ${mediaItems.length - 50} autres éléments`));
    }
  }
}

async function validateCommand(takeoutPath: string): Promise<void> {
  console.log(chalk.blue(`🔍 Validation de l'export Takeout: ${takeoutPath}\n`));

  // Vérifications de base
  if (!(await fs.pathExists(takeoutPath))) {
    console.log(chalk.red('❌ Le chemin spécifié n\'existe pas'));
    return;
  }

  const googlePhotosPath = path.join(takeoutPath, 'Google Photos');
  if (!(await fs.pathExists(googlePhotosPath))) {
    console.log(chalk.red('❌ Dossier \"Google Photos\" non trouvé'));
    console.log(chalk.yellow('   Assurez-vous d\'avoir extrait l\'archive Takeout'));
    return;
  }

  console.log(chalk.green('✅ Structure Takeout valide'));

  try {
    const parser = new TakeoutParser();
    const mediaItems = await parser.parseTakeoutDirectory(takeoutPath);

    console.log(chalk.green(`✅ ${mediaItems.length} éléments média détectés`));

    // Vérifications des métadonnées
    const withMetadata = mediaItems.filter(item => item.metadata.title);
    const withoutMetadata = mediaItems.length - withMetadata.length;

    console.log(chalk.green(`✅ ${withMetadata.length} éléments avec métadonnées`));
    if (withoutMetadata > 0) {
      console.log(chalk.yellow(`⚠️  ${withoutMetadata} éléments sans métadonnées JSON`));
    }

    console.log(chalk.green('\n🎉 Export Takeout prêt pour l\'import !'));

  } catch (error) {
    console.log(chalk.red('❌ Erreur lors de la validation:'), error);
  }
}

/**
 * Génère un chemin de stockage Cubbit pour un élément Takeout
 */
function generateTakeoutStoragePath(item: any, config: AppConfig): string {
  const year = item.creationDate.getFullYear();
  const month = String(item.creationDate.getMonth() + 1).padStart(2, '0');
  
  let basePath = `photos/${year}/${year}-${month}`;
  
  if (item.album) {
    // Nettoyer le nom de l'album
    const cleanAlbumName = item.album
      .replace(/[<>:\"/\\\\|?*]/g, '_')
      .replace(/\\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    
    basePath = `albums/${cleanAlbumName}`;
  }
  
  return `backup_google_photos/${basePath}/${item.filename}`;
}
