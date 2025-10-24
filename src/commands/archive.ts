import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs-extra';
import { TakeoutExtractor, ExtractionProgress } from '../utils/takeout-extractor';
import { scanTakeout } from '../utils/takeout-scanner';
import { getLogger } from '../utils/logger';
import { formatBytes, formatDuration } from '../utils/format';

/**
 * Crée la commande archive pour gérer les archives ZIP Takeout
 */
export function createArchiveCommand(): Command {
  const archiveCmd = new Command('archive');
  archiveCmd.description('Gestion des archives ZIP Google Takeout');

  // Commande pour lister les archives trouvées
  archiveCmd
    .command('list [directory]')
    .description('Liste les archives Google Takeout dans un répertoire')
    .option('--detailed', 'Affichage détaillé avec analyse des archives')
    .action(async (directory: string | undefined, options?: { detailed?: boolean }) => {
      try {
        const searchPath = directory || process.cwd();
        
        console.log(`🔍 Recherche d'archives Takeout dans: ${searchPath}`);
        console.log();

        const archives = await TakeoutExtractor.findTakeoutArchives(searchPath);
        
        if (archives.length === 0) {
          console.log('❌ Aucune archive Google Takeout trouvée.');
          console.log('\n💡 Conseil: Les archives doivent contenir "takeout" ou "google" dans leur nom et être au format ZIP.');
          return;
        }

        console.log(`✅ ${archives.length} archive(s) Takeout trouvée(s):\n`);

        for (let i = 0; i < archives.length; i++) {
          const archive = archives[i];
          if (!archive) continue;
          
          const fileName = path.basename(archive.archivePath);
          const stats = await fs.stat(archive.archivePath);
          
          if (archive.isMultiPart && archive.parts) {
            // Archive multi-parties
            const baseName = fileName.replace(/-\d+-\d+\.zip$/i, '');
            console.log(`${i + 1}. 📂 ${baseName} (${archive.parts.length} parties)`);
            console.log(`   📍 ${path.dirname(archive.archivePath)}`);
            console.log(`   📦 ${formatBytes(archive.totalSize || 0)} total`);
            console.log(`   🔢 Parties: ${archive.parts.map(p => path.basename(p)).join(', ')}`);
            console.log(`   📅 ${stats.mtime.toLocaleDateString()} ${stats.mtime.toLocaleTimeString()}`);
          } else {
            // Archive simple
            console.log(`${i + 1}. ${fileName}`);
            console.log(`   📍 ${archive.archivePath}`);
            console.log(`   📦 ${formatBytes(stats.size)} (${stats.size.toLocaleString()} bytes)`);
            console.log(`   📅 ${stats.mtime.toLocaleDateString()} ${stats.mtime.toLocaleTimeString()}`);
          }

          if (options?.detailed && !archive.isMultiPart) {
            try {
              console.log('   🔍 Analyse en cours...');
              const analysis = await TakeoutExtractor.analyzeArchive(archive.archivePath);
              console.log(`   📊 ${analysis.fileCount?.toLocaleString()} fichiers, ${formatBytes(analysis.totalSize || 0)} décompressé`);
            } catch (error) {
              console.log(`   ⚠️  Erreur d'analyse: ${(error as Error).message}`);
            }
          } else if (options?.detailed && archive.isMultiPart) {
            console.log('   💡 Assemblage requis avant analyse détaillée');
          }

          console.log();
        }
      } catch (error) {
        console.error(`❌ Erreur: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // Commande pour analyser une archive sans l'extraire
  archiveCmd
    .command('analyze <archive>')
    .description('Analyse une archive Google Takeout sans l\'extraire')
    .action(async (archivePath: string) => {
      try {
        const fullPath = path.resolve(archivePath);
        
        console.log(`🔍 Analyse de l'archive: ${path.basename(fullPath)}`);
        console.log(`📍 Chemin: ${fullPath}`);
        console.log();

        // Vérifications de base
        if (!await fs.pathExists(fullPath)) {
          throw new Error('Archive introuvable');
        }

        const stats = await fs.stat(fullPath);
        console.log(`📦 Taille de l'archive: ${formatBytes(stats.size)}`);
        console.log(`📅 Date de modification: ${stats.mtime.toLocaleDateString()} ${stats.mtime.toLocaleTimeString()}`);
        console.log();

        // Analyse détaillée
        console.log('🔍 Analyse du contenu...');
        const analysis = await TakeoutExtractor.analyzeArchive(fullPath);

        console.log(`✅ Archive Google Takeout valide`);
        console.log(`📊 Nombre de fichiers: ${analysis.fileCount?.toLocaleString()}`);
        console.log(`📏 Taille décompressée: ${formatBytes(analysis.totalSize || 0)}`);
        console.log(`📈 Ratio de compression: ${((1 - stats.size / (analysis.totalSize || 1)) * 100).toFixed(1)}%`);

      } catch (error) {
        console.error(`❌ Erreur: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // Commande pour extraire une archive
  archiveCmd
    .command('extract <archive>')
    .description('Extrait une archive Google Takeout')
    .option('-o, --output <directory>', 'Répertoire de destination (défaut: à côté de l\'archive)')
    .option('--overwrite', 'Remplacer le répertoire de destination s\'il existe')
    .option('--no-subfolder', 'Ne pas créer de sous-dossier pour l\'extraction')
    .option('--no-progress', 'Désactiver l\'affichage de la progression')
    .action(async (archivePath: string, options?: { 
      output?: string; 
      overwrite?: boolean; 
      subfolder?: boolean;
      progress?: boolean;
    }) => {
      try {
        const fullPath = path.resolve(archivePath);
        const fileName = path.basename(fullPath, path.extname(fullPath));
        
        console.log(`📦 Extraction de: ${path.basename(fullPath)}`);
        console.log();

        // Analyser d'abord l'archive
        const analysis = await TakeoutExtractor.analyzeArchive(fullPath);
        console.log(`📊 ${analysis.fileCount?.toLocaleString()} fichiers à extraire (${formatBytes(analysis.totalSize || 0)})`);
        console.log();

        const startTime = Date.now();
        let lastProgressUpdate = 0;

        // Callback de progression
        const onProgress = options?.progress !== false ? (progress: ExtractionProgress) => {
          const now = Date.now();
          // Limiter les updates de progression (max une par 200ms)
          if (now - lastProgressUpdate < 200 && progress.percentage < 100) {
            return;
          }
          lastProgressUpdate = now;

          const speed = progress.extractedBytes / ((now - startTime) / 1000);
          const eta = (progress.totalBytes - progress.extractedBytes) / speed;

          process.stdout.write(`\r🚀 ${progress.percentage}% - ${progress.extractedFiles}/${progress.totalFiles} fichiers ` +
            `(${formatBytes(speed)}/s, ETA: ${formatDuration(eta)})`);

          if (progress.percentage === 100) {
            process.stdout.write('\n');
          }
        } : undefined;

        // Extraire l'archive
        const extractPath = await TakeoutExtractor.extractArchive(fullPath, {
          extractTo: options?.output,
          overwrite: options?.overwrite,
          createSubfolder: options?.subfolder,
          preserveTimestamps: true
        }, onProgress);

        const duration = Date.now() - startTime;

        console.log(`✅ Extraction terminée en ${formatDuration(duration / 1000)}`);
        console.log(`📁 Fichiers extraits vers: ${extractPath}`);
        console.log();

        // Scanner rapidement le contenu extrait
        console.log('🔍 Scan rapide du contenu extrait...');
        try {
          const scanResult = await scanTakeout(extractPath);
          console.log(`📷 ${scanResult.supportedFiles} fichiers médias supportés trouvés`);
          if (scanResult.albums.length > 0) {
            console.log(`📁 ${scanResult.albums.length} albums détectés: ${scanResult.albums.slice(0, 5).join(', ')}${scanResult.albums.length > 5 ? '...' : ''}`);
          }
          if (scanResult.errors.length > 0) {
            console.log(`⚠️  ${scanResult.errors.length} erreurs détectées lors du scan`);
          }
        } catch (scanError) {
          console.log(`⚠️  Impossible de scanner le contenu: ${(scanError as Error).message}`);
        }

        console.log();
        console.log('💡 Prochaines étapes recommandées:');
        console.log(`   • gpb takeout import "${extractPath}" --dry-run`);
        console.log(`   • gpb takeout list "${extractPath}"`);

      } catch (error) {
        console.error(`❌ Erreur: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // Commande pour assembler des archives multi-parties
  archiveCmd
    .command('assemble <first-part>')
    .description('Assemble une série d\'archives multi-parties en une seule archive')
    .option('-o, --output <archive>', 'Nom de l\'archive assemblée')
    .option('--overwrite', 'Remplacer l\'archive de destination si elle existe')
    .action(async (firstPart: string, options?: { output?: string; overwrite?: boolean }) => {
      try {
        const fullPath = path.resolve(firstPart);
        
        console.log(`🔗 Assemblage de l'archive multi-parties: ${path.basename(fullPath)}`);
        console.log();

        // Vérifier que le fichier existe
        if (!await fs.pathExists(fullPath)) {
          throw new Error('Première partie introuvable');
        }

        // Détecter toutes les parties de la série
        const directory = path.dirname(fullPath);
        const filename = path.basename(fullPath);
        const multiPartMatch = filename.match(/^(.+?)(-\d+-)(\d+)\.zip$/i);
        
        if (!multiPartMatch) {
          throw new Error('Ce fichier ne semble pas être une archive multi-parties');
        }
        
        const [, baseName, separator] = multiPartMatch;
        const pattern = `${baseName}${separator}`;
        
        // Trouver toutes les parties
        const entries = await fs.readdir(directory);
        const parts: string[] = [];
        
        for (const entry of entries) {
          if (entry.startsWith(pattern) && entry.endsWith('.zip')) {
            parts.push(path.join(directory, entry));
          }
        }
        
        parts.sort();
        
        if (parts.length === 0) {
          throw new Error('Aucune partie d\'archive trouvée');
        }
        
        console.log(`🗋 ${parts.length} parties détectées:`);
        let totalSize = 0;
        for (let i = 0; i < parts.length; i++) {
          const partPath = parts[i];
          if (partPath) {
            const stats = await fs.stat(partPath);
            totalSize += stats.size;
            console.log(`  ${i + 1}. ${path.basename(partPath)} (${formatBytes(stats.size)})`);
          }
        }
        console.log(`  Total: ${formatBytes(totalSize)}`);
        console.log();
        
        // Déterminer le chemin de sortie
        const outputPath = options?.output || path.join(directory, `${baseName}-assembled.zip`);
        
        // Vérifier si le fichier de sortie existe déjà
        if (await fs.pathExists(outputPath) && !options?.overwrite) {
          throw new Error(`Le fichier de destination existe déjà: ${outputPath}. Utilisez --overwrite pour le remplacer.`);
        }
        
        console.log(`🎯 Assemblage vers: ${outputPath}`);
        console.log();
        
        const startTime = Date.now();
        
        // Assembler les parties
        const assembledPath = await TakeoutExtractor.assembleMultiPartArchive(parts, outputPath);
        
        const duration = Date.now() - startTime;
        const assembledStats = await fs.stat(assembledPath);
        
        console.log(`✅ Assemblage terminé en ${formatDuration(duration / 1000)}`);
        console.log(`📎 Archive assemblée: ${assembledPath}`);
        console.log(`📦 Taille finale: ${formatBytes(assembledStats.size)}`);
        console.log();
        
        // Valider l'archive assemblée
        console.log('🔍 Validation de l\'archive assemblée...');
        try {
          const analysis = await TakeoutExtractor.analyzeArchive(assembledPath);
          console.log(`✅ Archive valide: ${analysis.fileCount?.toLocaleString()} fichiers, ${formatBytes(analysis.totalSize || 0)} décompressé`);
        } catch (error) {
          console.log(`⚠️  Attention: ${(error as Error).message}`);
        }
        
        console.log();
        console.log('💡 Prochaines étapes recommandées:');
        console.log(`   • gpb archive extract "${assembledPath}"`);
        console.log(`   • gpb archive analyze "${assembledPath}"`);

      } catch (error) {
        console.error(`❌ Erreur: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // Commande pour nettoyer les extractions
  archiveCmd
    .command('cleanup [directory]')
    .description('Nettoie les répertoires d\'extraction temporaires')
    .option('--dry-run', 'Afficher ce qui serait supprimé sans le faire')
    .option('--force', 'Force la suppression même des répertoires qui ne semblent pas être des extractions')
    .action(async (directory?: string, options?: { dryRun?: boolean; force?: boolean }) => {
      try {
        const searchPath = directory || process.cwd();
        
        console.log(`🧹 Recherche de répertoires d'extraction dans: ${searchPath}`);
        console.log();

        const entries = await fs.readdir(searchPath, { withFileTypes: true });
        const extractionDirs = entries.filter(entry => 
          entry.isDirectory() && 
          (entry.name.includes('extracted') || entry.name.includes('takeout'))
        );

        if (extractionDirs.length === 0) {
          console.log('✨ Aucun répertoire d\'extraction trouvé.');
          return;
        }

        console.log(`🗑️  ${extractionDirs.length} répertoire(s) d'extraction trouvé(s):\n`);

        let totalSize = 0;

        for (const dir of extractionDirs) {
          const fullPath = path.join(searchPath, dir.name);
          
          try {
            const stats = await fs.stat(fullPath);
            // Calculer la taille approximative du répertoire
            const dirSize = await getDirSize(fullPath);
            totalSize += dirSize;

            console.log(`📁 ${dir.name}`);
            console.log(`   📍 ${fullPath}`);
            console.log(`   📏 ~${formatBytes(dirSize)}`);
            console.log(`   📅 ${stats.mtime.toLocaleDateString()}`);
            console.log();

            if (!options?.dryRun) {
              await TakeoutExtractor.cleanupExtraction(fullPath, options?.force);
              console.log(`   ✅ Supprimé\n`);
            }
          } catch (error) {
            console.log(`   ❌ Erreur: ${(error as Error).message}\n`);
          }
        }

        if (options?.dryRun) {
          console.log(`💾 Espace total qui serait libéré: ${formatBytes(totalSize)}`);
          console.log('\n💡 Utilisez --dry-run=false pour effectuer la suppression');
        } else {
          console.log(`✨ Nettoyage terminé - ${formatBytes(totalSize)} libérés`);
        }

      } catch (error) {
        console.error(`❌ Erreur: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return archiveCmd;
}

/**
 * Calcule approximativement la taille d'un répertoire
 */
async function getDirSize(dirPath: string, maxDepth: number = 3): Promise<number> {
  if (maxDepth <= 0) return 0;
  
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let size = 0;

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isFile()) {
        const stats = await fs.stat(fullPath);
        size += stats.size;
      } else if (entry.isDirectory() && maxDepth > 1) {
        size += await getDirSize(fullPath, maxDepth - 1);
      }
    }

    return size;
  } catch (error) {
    return 0;
  }
}
