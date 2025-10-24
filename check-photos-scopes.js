const axios = require('axios');

async function checkPhotosApiScopes() {
  console.log('=== VÉRIFICATION DES SCOPES PHOTOS LIBRARY API ===\n');
  
  console.log('🔍 Scopes historiques Photos Library:');
  console.log('- https://www.googleapis.com/auth/photoslibrary.readonly (DÉPRÉCIÉ)');
  console.log('- https://www.googleapis.com/auth/photoslibrary (Accès complet)');
  console.log('- https://www.googleapis.com/auth/photoslibrary.appendonly (Ajout seulement)');
  console.log('- https://www.googleapis.com/auth/photoslibrary.sharing (Partage)');
  
  console.log('\n📅 État actuel selon Gemini:');
  console.log('❌ photoslibrary.readonly - DÉPRÉCIÉ (mars 2023)');
  console.log('✅ photoslibrary - Toujours actif (mais accès en écriture aussi)');
  
  console.log('\n🎯 SOLUTION RECOMMANDÉE:');
  console.log('Remplacer par: https://www.googleapis.com/auth/photoslibrary');
  console.log('⚠️  Note: Ce scope donne aussi accès en écriture aux photos');
  
  console.log('\n📝 Alternative pour les nouvelles applications:');
  console.log('Google recommande maintenant d\'utiliser des scopes plus spécifiques');
  console.log('ou de migrer vers d\'autres APIs selon le cas d\'usage.');
  
  console.log('\n🔧 Actions à faire:');
  console.log('1. Modifier le scope dans la configuration');
  console.log('2. Reconfigurer OAuth consent screen avec le nouveau scope');
  console.log('3. Se réauthentifier');
}

checkPhotosApiScopes();
