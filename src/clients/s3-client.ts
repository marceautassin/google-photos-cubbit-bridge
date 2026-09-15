import { S3Client } from '@aws-sdk/client-s3';
import { AppConfig } from '../config/types';

/**
 * Délais des requêtes S3 (story 3.2). Sans eux, le gestionnaire HTTP du SDK n'a aucun délai (0 = infini) : une connexion
 * TCP morte après une mise en veille bloquerait une requête indéfiniment, sans que l'exécution rafraîchisse l'activité
 * de son verrou.
 */
/** Établissement de la connexion (TCP + TLS). */
export const S3_CONNECTION_TIMEOUT_MS = 10_000;
/**
 * Inactivité du socket (aucun octet reçu ni envoyé). Généreux : une copie côté serveur ne renvoie sa réponse qu'une fois
 * la copie faite ; le plus gros objet (687 Mo) tient dans ce délai dès 2,3 Mo/s de débit interne au serveur.
 */
export const S3_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Tentatives par requête, retentatives du SDK comprises (valeur par défaut du SDK, rendue explicite). */
export const S3_MAX_ATTEMPTS = 3;
/** Attente maximale entre deux tentatives dans le SDK (`MAXIMUM_RETRY_DELAY` de `@smithy/util-retry`). */
export const SDK_MAX_RETRY_DELAY_MS = 20_000;
/**
 * Durée maximale d'un envoi, retentatives comprises : chaque tentative épuise au plus ses deux délais, et le SDK attend
 * au plus `SDK_MAX_RETRY_DELAY_MS` entre deux. Le délai d'inactivité ne bornant pas une réponse qui arriverait au
 * compte-gouttes, le point d'accès en écriture impose en plus cette échéance à chaque envoi (signal d'abandon).
 */
export const S3_SEND_DEADLINE_MS =
  S3_MAX_ATTEMPTS * (S3_CONNECTION_TIMEOUT_MS + S3_REQUEST_TIMEOUT_MS) + (S3_MAX_ATTEMPTS - 1) * SDK_MAX_RETRY_DELAY_MS;
/**
 * Durée maximale d'un envoi une fois l'échéance atteinte : si elle tombe pendant une attente de retentative, l'abandon
 * n'est constaté qu'à la tentative suivante.
 */
export const S3_SEND_MAX_DURATION_MS = S3_SEND_DEADLINE_MS + SDK_MAX_RETRY_DELAY_MS;

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
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS, requestTimeout: S3_REQUEST_TIMEOUT_MS },
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
