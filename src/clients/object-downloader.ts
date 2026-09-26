// Lecture seule par construction : ce module n'importe QUE la commande de lecture d'objet.
// Toute opération d'écriture ou de suppression est hors de sa portée.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DownloadedObject, ObjectDownloader } from './types';

/**
 * Télécharge le contenu entier d'un objet S3 en flux (zips Takeout de `backups/`, story 4.2), sans le garder en mémoire.
 */
export class S3ObjectDownloader implements ObjectDownloader {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    readonly bucket: string,
  ) {}

  async download(key: string): Promise<DownloadedObject> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const status = response.$metadata?.httpStatusCode;
    if (!response.Body || status !== 200) {
      (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new Error(`Réponse S3 inattendue pour ${key} (statut ${status ?? 'inconnu'}${response.Body ? '' : ', corps absent'}) : téléchargement abandonné`);
    }
    return {
      body: response.Body as unknown as AsyncIterable<Uint8Array>,
      size: response.ContentLength ?? null,
      etag: response.ETag?.replace(/"/g, '') ?? null,
    };
  }
}
