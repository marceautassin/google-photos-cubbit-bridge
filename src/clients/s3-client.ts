import { S3Client } from '@aws-sdk/client-s3';
import { AppConfig } from '../config/types';

/**
 * Construit un client S3 pour Cubbit à partir de la configuration (identifiants issus du `.env`).
 */
export function createS3Client(config: AppConfig['cubbit']): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle ?? true, // Nécessaire pour la plupart des implémentations S3 compatibles
  });
}

/**
 * Configuration du client utilisé pour écrire dans le bucket dédié (story 3.1) : paire dédiée
 * `CUBBIT_DESTINATION_ACCESS_KEY_ID` / `CUBBIT_DESTINATION_SECRET_ACCESS_KEY` si les deux sont définies, sinon paire
 * principale. Refus si une seule des deux est définie ou si l'endpoint ou la paire retenue manquent. Les messages ne
 * citent que des noms de variables, jamais de valeur.
 */
export function destinationClientConfig(config: AppConfig['cubbit']): { config: AppConfig['cubbit']; dedicated: boolean } {
  const id = config.destinationAccessKeyId ?? '';
  const secret = config.destinationSecretAccessKey ?? '';
  if ((id === '') !== (secret === '')) {
    throw new Error(
      'identifiants du bucket dédié incomplets : définissez CUBBIT_DESTINATION_ACCESS_KEY_ID et ' +
        'CUBBIT_DESTINATION_SECRET_ACCESS_KEY ensemble, ou aucune des deux',
    );
  }
  const dedicated = id !== '';
  const effective = dedicated ? { ...config, accessKeyId: id, secretAccessKey: secret } : config;
  const missing = [
    effective.endpoint ? null : 'CUBBIT_ENDPOINT',
    effective.accessKeyId ? null : dedicated ? 'CUBBIT_DESTINATION_ACCESS_KEY_ID' : 'CUBBIT_ACCESS_KEY_ID',
    effective.secretAccessKey ? null : dedicated ? 'CUBBIT_DESTINATION_SECRET_ACCESS_KEY' : 'CUBBIT_SECRET_ACCESS_KEY',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) throw new Error(`configuration incomplète (${missing.join(', ')}). Renseignez le fichier .env.`);
  return { config: effective, dedicated };
}
