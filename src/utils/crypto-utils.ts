import * as CryptoJS from 'crypto-js';
import * as os from 'os';

/**
 * Génère une clé de chiffrement basée sur l'identifiant machine
 */
function getEncryptionKey(): string {
  const machineId = os.hostname() + os.platform() + os.arch();
  return CryptoJS.SHA256(machineId).toString();
}

/**
 * Chiffre une chaîne de caractères
 */
export function encrypt(text: string): string {
  const key = getEncryptionKey();
  const encrypted = CryptoJS.AES.encrypt(text, key).toString();
  return encrypted;
}

/**
 * Déchiffre une chaîne de caractères
 */
export function decrypt(encryptedText: string): string {
  try {
    const key = getEncryptionKey();
    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    
    if (!decrypted) {
      throw new Error('Échec du déchiffrement');
    }
    
    return decrypted;
  } catch (error) {
    throw new Error(`Erreur de déchiffrement: ${error}`);
  }
}

/**
 * Génère un hash SHA256 d'une chaîne
 */
export function sha256(text: string): string {
  return CryptoJS.SHA256(text).toString();
}

/**
 * Génère un ID unique
 */
export function generateId(): string {
  const timestamp = Date.now().toString();
  const random = Math.random().toString(36).substring(2);
  return sha256(timestamp + random).substring(0, 16);
}
