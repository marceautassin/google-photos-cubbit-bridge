import * as fs from 'fs-extra';
import * as path from 'path';
import { getProjectRoot } from '../config';
import { encrypt, decrypt } from '../utils/crypto-utils';
import { getLogger } from '../utils/logger';

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  scope: string[];
}

export class TokenManager {
  private tokenPath: string;

  constructor() {
    this.tokenPath = path.join(getProjectRoot(), 'data', 'tokens.encrypted');
  }

  /**
   * Sauvegarde les tokens de manière chiffrée
   */
  async saveTokens(tokenData: TokenData): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(this.tokenPath));
      const encryptedData = encrypt(JSON.stringify(tokenData));
      await fs.writeFile(this.tokenPath, encryptedData, 'utf8');
      getLogger().info('Tokens sauvegardés avec succès');
    } catch (error) {
      getLogger().error('Erreur lors de la sauvegarde des tokens:', error);
      throw error;
    }
  }

  /**
   * Charge et déchiffre les tokens
   */
  async loadTokens(): Promise<TokenData | null> {
    try {
      if (!(await fs.pathExists(this.tokenPath))) {
        return null;
      }

      const encryptedData = await fs.readFile(this.tokenPath, 'utf8');
      const decryptedData = decrypt(encryptedData);
      return JSON.parse(decryptedData);
    } catch (error) {
      getLogger().error('Erreur lors du chargement des tokens:', error);
      return null;
    }
  }

  /**
   * Vérifie si les tokens sont valides et non expirés
   */
  async areTokensValid(): Promise<boolean> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return false;
    }

    // Vérifier si le token expire dans moins de 5 minutes
    const fiveMinutesFromNow = Date.now() + (5 * 60 * 1000);
    return tokens.expiryDate > fiveMinutesFromNow;
  }

  /**
   * Supprime les tokens stockés
   */
  async clearTokens(): Promise<void> {
    try {
      if (await fs.pathExists(this.tokenPath)) {
        await fs.remove(this.tokenPath);
        getLogger().info('Tokens supprimés');
      }
    } catch (error) {
      getLogger().error('Erreur lors de la suppression des tokens:', error);
      throw error;
    }
  }

  /**
   * Obtient les tokens au format attendu par Google APIs
   */
  async getGoogleTokens(): Promise<any | null> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return null;
    }

    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate,
      scope: tokens.scope.join(' '),
    };
  }

  /**
   * Sauvegarde les tokens au format Google APIs
   */
  async saveGoogleTokens(googleTokens: any): Promise<void> {
    const tokenData: TokenData = {
      accessToken: googleTokens.access_token,
      refreshToken: googleTokens.refresh_token,
      expiryDate: googleTokens.expiry_date,
      scope: typeof googleTokens.scope === 'string' 
        ? googleTokens.scope.split(' ') 
        : googleTokens.scope || [],
    };

    await this.saveTokens(tokenData);
  }
}
