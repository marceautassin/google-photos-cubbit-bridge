import { google } from 'googleapis';
import * as http from 'http';
import * as url from 'url';
// import * as open from 'open'; // TODO: ajouter cette dépendance
import { AppConfig } from '../config/types';
import { TokenManager } from './token-manager';
import { getLogger } from '../utils/logger';

export class GoogleAuth {
  private oauth2Client: any;
  private tokenManager: TokenManager;
  private config: AppConfig['googlePhotos'];

  constructor(config: AppConfig['googlePhotos']) {
    this.config = config;
    this.tokenManager = new TokenManager();
    
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
  }

  /**
   * Vérifie si l'utilisateur est authentifié
   */
  async isAuthenticated(): Promise<boolean> {
    return await this.tokenManager.areTokensValid();
  }

  /**
   * Obtient le client OAuth2 authentifié
   */
  async getAuthenticatedClient(): Promise<any> {
    const tokens = await this.tokenManager.getGoogleTokens();
    if (!tokens) {
      throw new Error('Aucun token d\'authentification trouvé. Veuillez vous authentifier d\'abord.');
    }

    this.oauth2Client.setCredentials(tokens);
    return this.oauth2Client;
  }

  /**
   * Lance le processus d'authentification OAuth2
   */
  async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const authUrl = this.oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: this.config.scopes,
        prompt: 'consent', // Force la réautorisation pour obtenir le refresh token
      });

      getLogger().info('Démarrage du processus d\'authentification Google...');
      console.log('\\nOuverture de votre navigateur pour l\'authentification Google...');
      console.log('Si le navigateur ne s\'ouvre pas automatiquement, visitez cette URL:');
      console.log(authUrl);

      // Créer un serveur local pour recevoir le callback
      const server = http.createServer(async (req, res) => {
        try {
          const parsedUrl = url.parse(req.url!, true);
          
          if (parsedUrl.pathname === '/auth/callback') {
            const code = parsedUrl.query.code as string;
            const error = parsedUrl.query.error as string;

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<h1>Erreur d'authentification</h1><p>${error}</p>`);
              server.close();
              reject(new Error(`Erreur d'authentification: ${error}`));
              return;
            }

            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Erreur</h1><p>Code d\'autorisation manquant</p>');
              server.close();
              reject(new Error('Code d\'autorisation manquant'));
              return;
            }

            try {
              // Échanger le code d'autorisation contre des tokens
              const { tokens } = await this.oauth2Client.getToken(code);
              await this.tokenManager.saveGoogleTokens(tokens);

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <h1>Authentification réussie!</h1>
                <p>Vous pouvez fermer cette fenêtre et retourner au terminal.</p>
                <script>window.close();</script>
              `);

              server.close();
              getLogger().info('Authentification Google réussie');
              console.log('\\n✅ Authentification Google réussie!');
              resolve();
            } catch (tokenError) {
              res.writeHead(500, { 'Content-Type': 'text/html' });
              res.end('<h1>Erreur</h1><p>Impossible d\'obtenir les tokens</p>');
              server.close();
              getLogger().error('Erreur lors de l\'obtention des tokens:', tokenError);
              reject(tokenError);
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>Page non trouvée</h1>');
          }
        } catch (serverError) {
          getLogger().error('Erreur du serveur d\'authentification:', serverError);
          server.close();
          reject(serverError);
        }
      });

      // Démarrer le serveur sur le port extrait de l'URL de redirection
      const redirectUrl = new URL(this.config.redirectUri);
      const port = parseInt(redirectUrl.port) || 3000;
      
      server.listen(port, () => {
        getLogger().info(`Serveur d'authentification démarré sur le port ${port}`);
        
        // Ouvrir le navigateur
        try {
          const open = require('open');
          open(authUrl).catch((browserError: any) => {
            getLogger().warn('Impossible d\'ouvrir le navigateur automatiquement:', browserError);
          });
        } catch {
          getLogger().info('Module open non disponible, copiez l\'URL manuellement');
        }
      });

      // Timeout après 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Timeout: authentification non terminée dans les 5 minutes'));
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Se déconnecte en supprimant les tokens
   */
  async logout(): Promise<void> {
    try {
      // Révoquer les tokens côté Google
      const tokens = await this.tokenManager.getGoogleTokens();
      if (tokens && tokens.access_token) {
        await this.oauth2Client.revokeToken(tokens.access_token);
      }
    } catch (error) {
      getLogger().warn('Erreur lors de la révocation des tokens:', error);
    }

    // Supprimer les tokens locaux
    await this.tokenManager.clearTokens();
    getLogger().info('Déconnexion Google réussie');
  }

  /**
   * Rafraîchit les tokens si nécessaire
   */
  async refreshTokensIfNeeded(): Promise<void> {
    const tokens = await this.tokenManager.getGoogleTokens();
    if (!tokens) {
      throw new Error('Aucun token trouvé');
    }

    // Si le token expire dans moins de 5 minutes, le rafraîchir
    const fiveMinutesFromNow = Date.now() + (5 * 60 * 1000);
    if (tokens.expiry_date <= fiveMinutesFromNow) {
      getLogger().info('Rafraîchissement des tokens Google...');
      
      this.oauth2Client.setCredentials(tokens);
      
      try {
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        await this.tokenManager.saveGoogleTokens(credentials);
        getLogger().info('Tokens Google rafraîchis avec succès');
      } catch (error) {
        getLogger().error('Erreur lors du rafraîchissement des tokens:', error);
        throw new Error('Impossible de rafraîchir les tokens. Veuillez vous réauthentifier.');
      }
    }
  }

  /**
   * Obtient les informations sur l'utilisateur connecté
   */
  async getUserInfo(): Promise<any> {
    const client = await this.getAuthenticatedClient();
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    
    try {
      const { data } = await oauth2.userinfo.get();
      return data;
    } catch (error) {
      getLogger().error('Erreur lors de la récupération des informations utilisateur:', error);
      throw error;
    }
  }
}
