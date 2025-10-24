const { loadConfig } = require('./dist/config');
const { TokenManager } = require('./dist/auth/token-manager');
const axios = require('axios');

async function debugScopes() {
  console.log('=== DEBUG SCOPES ET PERMISSIONS ===\n');

  try {
    const tokenManager = new TokenManager();
    const tokens = await tokenManager.getGoogleTokens();
    
    if (!tokens) {
      console.log('❌ Aucun token trouvé.');
      return;
    }

    console.log('1. Vérification des tokens et scopes...');
    console.log('✅ Access token présent:', !!tokens.access_token);
    console.log('✅ Refresh token présent:', !!tokens.refresh_token);
  console.log('📋 Scopes actuels:', tokens.scope);
  
  // Vérifier si c'est le bon scope
  if (tokens.scope.includes('photoslibrary.readonly')) {
    console.log('⚠️  ATTENTION: Ancien scope déprécié détecté!');
  }
  if (tokens.scope.includes('https://www.googleapis.com/auth/photoslibrary')) {
    console.log('✅ Nouveau scope valide détecté');
  }

    // Vérifier le token avec Google
    console.log('\n2. Vérification du token avec Google...');
    try {
      const tokenInfo = await axios.get(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${tokens.access_token}`);
      console.log('✅ Token valide selon Google');
      console.log('📋 Scopes reconnus par Google:', tokenInfo.data.scope);
      console.log('🎯 Audience (Client ID):', tokenInfo.data.audience);
      console.log('⏰ Expire dans:', Math.floor((tokenInfo.data.expires_in || 0) / 60), 'minutes');
    } catch (error) {
      console.log('❌ Token invalide selon Google:', error.response?.data);
      return;
    }

    // Test spécifique Photos Library
    console.log('\n3. Test spécifique API Photos Library...');
    try {
      const response = await axios.get('https://photoslibrary.googleapis.com/v1/albums', {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        params: {
          pageSize: 1,
        },
      });
      
      console.log('🎉 API Photos Library fonctionne !');
      console.log('Albums trouvés:', response.data.albums ? response.data.albums.length : 0);
      
    } catch (error) {
      console.log('❌ Erreur API Photos Library:');
      console.log('Code:', error.response?.status);
      console.log('Message:', error.response?.data?.error?.message);
      console.log('Status:', error.response?.data?.error?.status);
      
      if (error.response?.status === 403) {
        console.log('\n🔍 DIAGNOSTIC ERREUR 403:');
        const errorMsg = error.response?.data?.error?.message || '';
        
        if (errorMsg.includes('insufficient authentication scopes')) {
          console.log('➤ Le scope photoslibrary.readonly n\'est pas reconnu ou autorisé');
          console.log('➤ Vérifiez que le scope est ajouté dans OAuth consent screen');
        }
        
        if (errorMsg.includes('access_denied') || errorMsg.includes('unauthorized')) {
          console.log('➤ L\'application n\'est pas autorisée pour cet utilisateur');
          console.log('➤ Ajoutez votre email aux test users si l\'app est en mode Testing');
        }
        
        if (errorMsg.includes('project')) {
          console.log('➤ Problème de configuration du projet Google Cloud');
          console.log('➤ Vérifiez que l\'API Photos Library est bien activée');
        }
        
        console.log('\n📋 Actions recommandées:');
        console.log('1. OAuth consent screen → ADD OR REMOVE SCOPES → Photos Library API');
        console.log('2. OAuth consent screen → Test users → Ajouter votre email');
        console.log('3. APIs & Services → Photos Library API → Vérifier activation');
      }
    }

  } catch (error) {
    console.error('Erreur générale:', error.message);
  }
}

debugScopes().catch(console.error);
