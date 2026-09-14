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
