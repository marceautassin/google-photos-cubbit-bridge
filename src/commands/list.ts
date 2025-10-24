import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { GooglePhotosClient } from '../clients/google-photos';

export function register(program: Command, config: AppConfig): void {
  const listCmd = program
    .command('list')
    .description('Lister les contenus Google Photos');

  listCmd
    .command('albums')
    .description('Lister tous les albums')
    .option('--limit <number>', 'Nombre maximum d\'albums à afficher', '50')
    .action(async (options) => {
      try {
        await listAlbumsCommand(config, options);
      } catch (error) {
        console.error(chalk.red('Erreur lors du listing des albums:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  listCmd
    .command('photos')
    .description('Lister les photos')
    .option('--album <name>', 'Nom de l\'album à lister')
    .option('--album-id <id>', 'ID de l\'album à lister')
    .option('--from <date>', 'Date de début (YYYY-MM-DD)')
    .option('--to <date>', 'Date de fin (YYYY-MM-DD)')
    .option('--type <type>', 'Type de média (photo, video, all)', 'all')
    .option('--limit <number>', 'Nombre maximum de photos à afficher', '100')
    .action(async (options) => {
      try {
        await listPhotosCommand(config, options);
      } catch (error) {
        console.error(chalk.red('Erreur lors du listing des photos:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

async function listAlbumsCommand(config: AppConfig, options: any): Promise<void> {
  const googlePhotos = new GooglePhotosClient(config.googlePhotos);

  // Vérifier l'authentification
  if (!(await googlePhotos.isAuthenticated())) {
    console.log(chalk.red('❌ Non authentifié sur Google Photos.'));
    console.log(chalk.yellow('Utilisez ' + chalk.cyan('gpb auth login') + ' pour vous connecter.'));
    return;
  }

  console.log(chalk.blue('📚 Récupération des albums...\\n'));

  try {
    const albums = await googlePhotos.getAlbums();
    
    if (albums.length === 0) {
      console.log(chalk.yellow('Aucun album trouvé.'));
      return;
    }

    const limit = parseInt(options.limit) || 50;
    const displayAlbums = albums.slice(0, limit);

    console.log(chalk.green(`📋 ${displayAlbums.length} albums trouvés${albums.length > limit ? ` (${albums.length - limit} albums supplémentaires masqués)` : ''}:\\n`));

    // En-tête du tableau
    console.log(
      chalk.bold('ID'.padEnd(25)) +
      chalk.bold('Titre'.padEnd(40)) +
      chalk.bold('Nombre de fichiers')
    );
    console.log('-'.repeat(80));

    // Afficher chaque album
    for (const album of displayAlbums) {
      const id = album.id.length > 22 ? album.id.substring(0, 19) + '...' : album.id;
      const title = album.title.length > 37 ? album.title.substring(0, 34) + '...' : album.title;
      
      console.log(
        chalk.cyan(id.padEnd(25)) +
        chalk.white(title.padEnd(40)) +
        chalk.yellow(album.mediaItemsCount.padEnd(15))
      );
    }

    console.log('\n' + chalk.blue('💡 Utilisez ' + chalk.cyan('gpb list photos --album "Nom Album"') + ' pour voir les photos d\'un album.'));
    console.log(chalk.blue('💡 Ou utilisez ' + chalk.cyan('gpb sync --album "Nom Album"') + ' pour synchroniser un album.'));

  } catch (error) {
    console.error(chalk.red('Erreur lors de la récupération des albums:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

async function listPhotosCommand(config: AppConfig, options: any): Promise<void> {
  const googlePhotos = new GooglePhotosClient(config.googlePhotos);

  // Vérifier l'authentification
  if (!(await googlePhotos.isAuthenticated())) {
    console.log(chalk.red('❌ Non authentifié sur Google Photos.'));
    console.log(chalk.yellow('Utilisez ' + chalk.cyan('gpb auth login') + ' pour vous connecter.'));
    return;
  }

  let searchTitle = 'toutes les photos';
  let albumId: string | undefined;

  // Si un nom d'album est spécifié, le chercher
  if (options.album) {
    console.log(chalk.blue(`🔍 Recherche de l'album \"${options.album}\"...`));
    
    const albums = await googlePhotos.getAlbums();
    const album = albums.find(a => 
      a.title.toLowerCase().includes(options.album.toLowerCase())
    );
    
    if (!album) {
      console.log(chalk.red(`❌ Album \"${options.album}\" non trouvé.`));
      console.log(chalk.yellow('Utilisez ' + chalk.cyan('gpb list albums') + ' pour voir les albums disponibles.'));
      return;
    }
    
    albumId = album.id;
    searchTitle = `l'album \"${album.title}\"`;
  } else if (options.albumId) {
    albumId = options.albumId;
    searchTitle = `l'album ID ${albumId}`;
  }

  // Construire les filtres
  const filters: any = {};
  
  if (albumId) {
    filters.albumId = albumId;
  }
  
  if (options.from || options.to) {
    filters.dateRange = {};
    if (options.from) filters.dateRange.startDate = options.from;
    if (options.to) filters.dateRange.endDate = options.to;
    
    searchTitle += ` (du ${options.from || 'début'} au ${options.to || 'fin'})`;
  }
  
  if (options.type !== 'all') {
    filters.mediaTypes = options.type === 'photo' ? ['PHOTO'] : ['VIDEO'];
    searchTitle += ` (${options.type}s seulement)`;
  }

  console.log(chalk.blue(`📸 Récupération des photos de ${searchTitle}...\\n`));

  try {
    const mediaItems = albumId 
      ? await googlePhotos.getAlbumMediaItems(albumId)
      : await googlePhotos.searchMediaItems(filters);
    
    if (mediaItems.length === 0) {
      console.log(chalk.yellow('Aucune photo trouvée avec ces critères.'));
      return;
    }

    const limit = parseInt(options.limit) || 100;
    const displayItems = mediaItems.slice(0, limit);

    console.log(chalk.green(`📋 ${displayItems.length} photos trouvées${mediaItems.length > limit ? ` (${mediaItems.length - limit} photos supplémentaires masquées)` : ''}:\\n`));

    // En-tête du tableau
    console.log(
      chalk.bold('Nom du fichier'.padEnd(40)) +
      chalk.bold('Type'.padEnd(15)) +
      chalk.bold('Taille'.padEnd(15)) +
      chalk.bold('Date de création')
    );
    console.log('-'.repeat(90));

    // Afficher chaque photo
    for (const item of displayItems) {
      const filename = item.filename.length > 37 ? item.filename.substring(0, 34) + '...' : item.filename;
      const type = item.mimeType.startsWith('image/') ? '📷 Image' : '🎬 Vidéo';
      const dimensions = item.width && item.height ? `${item.width}x${item.height}` : 'N/A';
      const date = item.creationTime.toLocaleDateString('fr-FR');
      
      console.log(
        chalk.cyan(filename.padEnd(40)) +
        chalk.white(type.padEnd(15)) +
        chalk.yellow(dimensions.padEnd(15)) +
        chalk.blue(date)
      );
    }

    // Statistiques
    const imageCount = displayItems.filter(item => item.mimeType.startsWith('image/')).length;
    const videoCount = displayItems.filter(item => item.mimeType.startsWith('video/')).length;
    
    console.log('\\n' + chalk.blue('📊 Statistiques:'));
    console.log(chalk.white(`   Images: ${imageCount}`));
    console.log(chalk.white(`   Vidéos: ${videoCount}`));
    console.log(chalk.white(`   Total: ${displayItems.length}`));

    console.log('\\n' + chalk.blue('💡 Utilisez ' + chalk.cyan('gpb sync') + ' avec les mêmes options pour synchroniser ces photos.'));

  } catch (error) {
    console.error(chalk.red('Erreur lors de la récupération des photos:'), error instanceof Error ? error.message : error);
    throw error;
  }
}
