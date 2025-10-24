import * as path from 'path';
import * as fs from 'fs-extra';
import * as yauzl from 'yauzl';
import { getLogger } from './logger';

export interface TakeoutArchive {
  archivePath: string;
  extractedPath?: string;
  isExtracted: boolean;
  totalSize?: number;
  fileCount?: number;
  isMultiPart?: boolean;
  parts?: string[];
  assembledPath?: string;
}

export interface ExtractionOptions {
  extractTo?: string;
  overwrite?: boolean;
  createSubfolder?: boolean;
  preserveTimestamps?: boolean;
}

export interface ExtractionProgress {
  currentFile: string;
  extractedFiles: number;
  totalFiles: number;
  extractedBytes: number;
  totalBytes: number;
  percentage: number;
}

export type ProgressCallback = (progress: ExtractionProgress) => void;

/**
 * Utilitaire pour extraire les archives Google Takeout
 */
export class TakeoutExtractor {
  
  /**
   * Vérifie si un fichier est une archive ZIP valide
   */
  static async isValidZipArchive(archivePath: string): Promise<boolean> {
    try {
      if (!await fs.pathExists(archivePath)) {
        return false;
      }

      const stats = await fs.stat(archivePath);
      if (!stats.isFile()) {
        return false;
      }

      // Vérifier les premiers bytes pour la signature ZIP
      const buffer = Buffer.alloc(4);
      const fd = await fs.open(archivePath, 'r');
      
      try {
        await fs.read(fd, buffer, 0, 4, 0);
        // Signature ZIP: PK\003\004
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B && 
                      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && 
                      (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);
        return isZip;
      } finally {
        await fs.close(fd);
      }
    } catch (error) {
      getLogger().debug(`Erreur lors de la vérification ZIP de ${archivePath}: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Analyse une archive ZIP sans l'extraire
   */
  static async analyzeArchive(archivePath: string): Promise<TakeoutArchive> {
    if (!await this.isValidZipArchive(archivePath)) {
      throw new Error(`Fichier non valide ou non accessible: ${archivePath}`);
    }

    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(new Error(`Impossible d'ouvrir l'archive: ${err.message}`));
          return;
        }

        if (!zipfile) {
          reject(new Error('Archive ZIP invalide'));
          return;
        }

        let totalSize = 0;
        let fileCount = 0;
        let hasGooglePhotos = false;

        zipfile.readEntry();
        
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (!/\/$/.test(entry.fileName)) {
            // C'est un fichier, pas un dossier
            fileCount++;
            totalSize += entry.uncompressedSize;
          }

          // Vérifier si c'est un export Google Photos
          if (entry.fileName.includes('Google Photos')) {
            hasGooglePhotos = true;
          }

          zipfile.readEntry();
        });

        zipfile.on('end', () => {
          if (!hasGooglePhotos) {
            reject(new Error('Cette archive ne semble pas contenir d\'export Google Photos'));
            return;
          }

          const result: TakeoutArchive = {
            archivePath,
            isExtracted: false,
            totalSize,
            fileCount
          };

          resolve(result);
        });

        zipfile.on('error', (error) => {
          reject(new Error(`Erreur lors de l'analyse de l'archive: ${error.message}`));
        });
      });
    });
  }

  /**
   * Extrait une archive Google Takeout
   */
  static async extractArchive(
    archivePath: string, 
    options: ExtractionOptions = {},
    onProgress?: ProgressCallback
  ): Promise<string> {
    
    const archive = await this.analyzeArchive(archivePath);
    
    // Déterminer le répertoire de destination
    const archiveName = path.basename(archivePath, path.extname(archivePath));
    const baseExtractPath = options.extractTo || path.dirname(archivePath);
    
    let extractPath: string;
    if (options.createSubfolder !== false) {
      extractPath = path.join(baseExtractPath, `${archiveName}-extracted`);
    } else {
      extractPath = baseExtractPath;
    }

    // Vérifier si le répertoire existe déjà
    if (await fs.pathExists(extractPath) && !options.overwrite) {
      throw new Error(`Le répertoire de destination existe déjà: ${extractPath}. Utilisez l'option overwrite pour le remplacer.`);
    }

    // Créer le répertoire de destination
    await fs.ensureDir(extractPath);

    getLogger().info(`Extraction de l'archive vers: ${extractPath}`);

    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(new Error(`Impossible d'ouvrir l'archive: ${err.message}`));
          return;
        }

        if (!zipfile) {
          reject(new Error('Archive ZIP invalide'));
          return;
        }

        let extractedFiles = 0;
        let extractedBytes = 0;
        const totalFiles = archive.fileCount || 0;
        const totalBytes = archive.totalSize || 0;

        zipfile.readEntry();

        zipfile.on('entry', (entry: yauzl.Entry) => {
          const entryPath = path.join(extractPath, entry.fileName);
          
          if (/\/$/.test(entry.fileName)) {
            // C'est un dossier
            fs.ensureDir(entryPath).then(() => {
              zipfile.readEntry();
            }).catch(reject);
            return;
          }

          // C'est un fichier
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) {
              reject(new Error(`Impossible de lire l'entrée ${entry.fileName}: ${err.message}`));
              return;
            }

            if (!readStream) {
              reject(new Error(`Stream invalide pour ${entry.fileName}`));
              return;
            }

            // Créer le répertoire parent si nécessaire
            const parentDir = path.dirname(entryPath);
            fs.ensureDir(parentDir).then(() => {
              const writeStream = fs.createWriteStream(entryPath);

              readStream.on('end', () => {
                extractedFiles++;
                extractedBytes += entry.uncompressedSize;

                // Préserver les timestamps si demandé
                if (options.preserveTimestamps !== false) {
                  const mtime = entry.getLastModDate();
                  fs.utimes(entryPath, mtime, mtime).catch(() => {
                    // Ignorer les erreurs de timestamps
                  });
                }

                // Rapport de progression
                if (onProgress) {
                  const progress: ExtractionProgress = {
                    currentFile: entry.fileName,
                    extractedFiles,
                    totalFiles,
                    extractedBytes,
                    totalBytes,
                    percentage: totalFiles > 0 ? Math.round((extractedFiles / totalFiles) * 100) : 0
                  };
                  onProgress(progress);
                }

                zipfile.readEntry();
              });

              readStream.on('error', (error) => {
                reject(new Error(`Erreur lors de la lecture de ${entry.fileName}: ${error.message}`));
              });

              writeStream.on('error', (error) => {
                reject(new Error(`Erreur lors de l'écriture de ${entryPath}: ${error.message}`));
              });

              readStream.pipe(writeStream);
            }).catch(reject);
          });
        });

        zipfile.on('end', () => {
          getLogger().info(`Extraction terminée: ${extractedFiles} fichiers extraits vers ${extractPath}`);
          resolve(extractPath);
        });

        zipfile.on('error', (error) => {
          reject(new Error(`Erreur lors de l'extraction: ${error.message}`));
        });
      });
    });
  }

  /**
   * Nettoie un répertoire d'extraction (supprime les fichiers extraits)
   */
  static async cleanupExtraction(extractedPath: string, force: boolean = false): Promise<void> {
    if (!await fs.pathExists(extractedPath)) {
      return;
    }

    const stats = await fs.stat(extractedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Le chemin spécifié n'est pas un répertoire: ${extractedPath}`);
    }

    // Vérification de sécurité : s'assurer que c'est bien un dossier d'extraction
    const folderName = path.basename(extractedPath);
    if (!force && !folderName.includes('extracted') && !folderName.includes('takeout')) {
      throw new Error(`Refus de supprimer le répertoire pour des raisons de sécurité: ${extractedPath}. Utilisez l'option force si vous êtes sûr.`);
    }

    await fs.remove(extractedPath);
    getLogger().info(`Répertoire d'extraction supprimé: ${extractedPath}`);
  }

  /**
   * Détecte les séries d'archives multi-parties
   */
  static detectMultiPartArchives(archivePaths: string[]): Map<string, string[]> {
    const series = new Map<string, string[]>();
    
    for (const archivePath of archivePaths) {
      const filename = path.basename(archivePath);
      
      // Pattern pour détecter les archives multi-parties : nom-XXX-001.zip
      const multiPartMatch = filename.match(/^(.+?)(-\d+-)(\d+)\.zip$/i);
      
      if (multiPartMatch) {
        const [, baseName, separator, partNumber] = multiPartMatch;
        if (!baseName || !separator) continue;
        const seriesKey = baseName + separator;
        
        if (!series.has(seriesKey)) {
          series.set(seriesKey, []);
        }
        series.get(seriesKey)!.push(archivePath);
      }
    }
    
    // Trier les parties de chaque série
    for (const parts of series.values()) {
      parts.sort();
    }
    
    return series;
  }

  /**
   * Assemble des archives multi-parties en une seule archive
   */
  static async assembleMultiPartArchive(parts: string[], outputPath?: string): Promise<string> {
    if (parts.length === 0) {
      throw new Error('Aucune partie d\'archive fournie');
    }
    
    // Trier les parties
    const sortedParts = [...parts].sort();
    
    // Déterminer le chemin de sortie
    const firstPart = sortedParts[0];
    if (!firstPart) {
      throw new Error('Aucune partie valide trouvée');
    }
    
    const baseName = path.basename(firstPart).replace(/-\d+-\d+\.zip$/i, '');
    const outputDir = path.dirname(firstPart);
    const assembledPath = outputPath || path.join(outputDir, `${baseName}-assembled.zip`);
    
    getLogger().info(`Assemblage de ${parts.length} parties vers: ${assembledPath}`);
    
    // Concaténer les fichiers
    const writeStream = fs.createWriteStream(assembledPath);
    
    try {
      for (let i = 0; i < sortedParts.length; i++) {
        const partPath = sortedParts[i];
        if (!partPath) continue;
        
        getLogger().debug(`Ajout de la partie ${i + 1}/${sortedParts.length}: ${path.basename(partPath)}`);
        
        const readStream = fs.createReadStream(partPath);
        
        await new Promise<void>((resolve, reject) => {
          readStream.on('end', resolve);
          readStream.on('error', reject);
          writeStream.on('error', reject);
          
          readStream.pipe(writeStream, { end: false });
        });
      }
      
      writeStream.end();
      
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      
      getLogger().info(`Archive assemblée avec succès: ${assembledPath}`);
      return assembledPath;
      
    } catch (error) {
      // Nettoyer en cas d'erreur
      if (await fs.pathExists(assembledPath)) {
        await fs.remove(assembledPath);
      }
      throw new Error(`Erreur lors de l'assemblage: ${(error as Error).message}`);
    }
  }

  /**
   * Trouve les archives Google Takeout dans un répertoire (avec support multi-parties)
   */
  static async findTakeoutArchives(searchPath: string): Promise<TakeoutArchive[]> {
    const results: TakeoutArchive[] = [];
    
    if (!await fs.pathExists(searchPath)) {
      return results;
    }

    const entries = await fs.readdir(searchPath, { withFileTypes: true });
    const allArchivePaths: string[] = [];
    
    // Première passe : trouver tous les fichiers ZIP potentiels
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        const fullPath = path.join(searchPath, entry.name);
        
        // Vérifier si c'est potentiellement une archive Takeout
        if (entry.name.toLowerCase().includes('takeout') || 
            entry.name.toLowerCase().includes('google')) {
          
          if (await this.isValidZipArchive(fullPath)) {
            allArchivePaths.push(fullPath);
          }
        }
      }
    }
    
    // Deuxième passe : détecter les séries multi-parties
    const multiPartSeries = this.detectMultiPartArchives(allArchivePaths);
    const processedPaths = new Set<string>();
    
    // Traiter les séries multi-parties
    for (const [seriesKey, parts] of multiPartSeries) {
      if (parts.length > 1) {
        try {
          // C'est une série multi-parties, analyser la première partie
          const firstPart = parts[0];
          if (!firstPart) continue;
          
          // Calculer la taille totale de toutes les parties
          let totalSize = 0;
          for (const part of parts) {
            const stats = await fs.stat(part);
            totalSize += stats.size;
          }
          
          const result: TakeoutArchive = {
            archivePath: firstPart,
            isExtracted: false,
            totalSize,
            fileCount: 0, // Impossible à déterminer sans assembler
            isMultiPart: true,
            parts: parts
          };
          
          results.push(result);
          
          // Marquer toutes les parties comme traitées
          parts.forEach(part => processedPaths.add(part));
          
        } catch (error) {
          getLogger().debug(`Série multi-parties ignorée: ${seriesKey}`);
        }
      }
    }
    
    // Traiter les archives simples restantes
    for (const archivePath of allArchivePaths) {
      if (!processedPaths.has(archivePath)) {
        try {
          const archive = await this.analyzeArchive(archivePath);
          results.push(archive);
        } catch (error) {
          getLogger().debug(`Archive ignorée (pas un Takeout valide): ${archivePath}`);
        }
      }
    }

    return results.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  }
}

/**
 * Fonction utilitaire pour extraire rapidement une archive Takeout
 */
export async function extractTakeout(
  archivePath: string, 
  extractTo?: string, 
  onProgress?: ProgressCallback
): Promise<string> {
  return TakeoutExtractor.extractArchive(archivePath, {
    extractTo,
    overwrite: true,
    createSubfolder: true,
    preserveTimestamps: true
  }, onProgress);
}
