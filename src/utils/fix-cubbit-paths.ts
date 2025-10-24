#!/usr/bin/env node

/**
 * Script utilitaire pour corriger les chemins cubbit_path en base de données
 * pour refléter la nouvelle organisation par année
 */

import { SyncRecordModel } from '../database/models';
import { initDatabase } from '../database/connection';
import { extractDateFromFilename } from './file-utils';
import { initLogger } from './logger';
import { SyncStatus } from '../clients/types';

async function fixCubbitPathsInDatabase() {
  try {
    // Initialiser le logger
    initLogger({ 
      level: 'info', 
      file: './logs/fix-cubbit-paths.log',
      console: true,
      maxSize: '10m',
      maxFiles: 5
    });
    
    // Initialiser la base de données
    await initDatabase({ path: './data/app.db' });
    
    const syncRecords = new SyncRecordModel();
    
    // Récupérer tous les enregistrements qui ont l'ancien format de chemin
    console.log('🔍 Recherche des enregistrements avec anciens chemins...');
    const allRecords = await syncRecords.findAll(0, 10000);
    
    let correctedCount = 0;
    let skippedCount = 0;
    
    for (const record of allRecords) {
      // Vérifier si le chemin actuel utilise l'ancien format (2025-08 ou 2025)
      if (record.cubbitPath.includes('/2025/') || record.cubbitPath.includes('/2025-08/')) {
        
        // Générer le nouveau chemin basé sur la date corrigée
        const newPath = generateNewCubbitPath(record.filename, record.createdDate, record.cubbitPath);
        
        if (newPath !== record.cubbitPath) {
          console.log(`🔧 Correction du chemin pour ${record.filename}:`);
          console.log(`   Ancien: ${record.cubbitPath}`);
          console.log(`   Nouveau: ${newPath}`);
          
          // Mettre à jour l'enregistrement avec le nouveau chemin
          // et marquer comme PENDING pour qu'il soit retraité
          await syncRecords.update(record.id!, {
            cubbitPath: newPath,
            status: SyncStatus.PENDING,
            syncDate: undefined // Réinitialiser la date de sync
          });
          
          correctedCount++;
        } else {
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    }
    
    console.log(`\n✅ Correction des chemins terminée:`);
    console.log(`   ${correctedCount} enregistrements corrigés`);
    console.log(`   ${skippedCount} enregistrements ignorés`);
    console.log(`   ${allRecords.length} enregistrements traités au total`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la correction des chemins:', error);
    process.exit(1);
  }
}

/**
 * Génère le nouveau chemin Cubbit basé sur la date corrigée
 */
function generateNewCubbitPath(filename: string, createdDate: Date, currentPath: string): string {
  const year = createdDate.getFullYear();
  
  // Déterminer si c'est un album ou une photo normale
  if (currentPath.includes('/albums/')) {
    // Pour les albums, garder la structure albums/[nom_album]/filename
    return currentPath; // Pas de changement pour les albums
  } else {
    // Pour les photos normales, utiliser la nouvelle structure photos/year/filename
    const basePath = `photos/${year}`;
    return `backup_google_photos/${basePath}/${filename}`;
  }
}

// Exécuter le script si appelé directement
if (require.main === module) {
  console.log('🚀 Démarrage de la correction des chemins Cubbit...\n');
  fixCubbitPathsInDatabase();
}

export { fixCubbitPathsInDatabase };
