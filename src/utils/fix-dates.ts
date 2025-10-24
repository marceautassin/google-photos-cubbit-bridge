#!/usr/bin/env node

/**
 * Script utilitaire pour corriger les dates de création des photos en base de données
 * en extrayant la date du nom de fichier quand c'est possible
 */

import { SyncRecordModel } from '../database/models';
import { initDatabase } from '../database/connection';
import { extractDateFromFilename } from './file-utils';
import { initLogger } from './logger';

async function fixDatesInDatabase() {
  try {
    // Initialiser le logger
    initLogger({ 
      level: 'info', 
      file: './logs/fix-dates.log',
      console: true,
      maxSize: '10m',
      maxFiles: 5
    });
    
    // Initialiser la base de données
    await initDatabase({ path: './data/app.db' });
    
    const syncRecords = new SyncRecordModel();
    
    // Récupérer tous les enregistrements
    console.log('🔍 Recherche des enregistrements à corriger...');
    const allRecords = await syncRecords.findAll(0, 10000); // Ajuster si vous avez plus de 10k photos
    
    let correctedCount = 0;
    let skippedCount = 0;
    
    for (const record of allRecords) {
      // Vérifier si la date actuelle semble incorrecte (2025)
      const currentYear = record.createdDate.getFullYear();
      
      if (currentYear >= 2025) {
        // Essayer d'extraire la date du nom de fichier
        const extractedDate = extractDateFromFilename(record.filename);
        
        if (extractedDate && extractedDate.getFullYear() !== currentYear) {
          console.log(`📅 Correction de ${record.filename}:`);
          console.log(`   Avant: ${record.createdDate.toISOString()} (${currentYear})`);
          console.log(`   Après: ${extractedDate.toISOString()} (${extractedDate.getFullYear()})`);
          
          // Mettre à jour l'enregistrement
          await syncRecords.update(record.id!, {
            createdDate: extractedDate
          });
          
          correctedCount++;
        } else {
          console.log(`⚠️  Impossible d'extraire la date pour: ${record.filename}`);
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    }
    
    console.log(`\n✅ Correction terminée:`);
    console.log(`   ${correctedCount} enregistrements corrigés`);
    console.log(`   ${skippedCount} enregistrements ignorés`);
    console.log(`   ${allRecords.length} enregistrements traités au total`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la correction des dates:', error);
    process.exit(1);
  }
}

// Exécuter le script si appelé directement
if (require.main === module) {
  console.log('🚀 Démarrage de la correction des dates...\n');
  fixDatesInDatabase();
}

export { fixDatesInDatabase };
