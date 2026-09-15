// Lecture seule par construction : ce module n'importe QUE la commande de lecture d'objet.
// Toute opération d'écriture ou de suppression est hors de sa portée.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ObjectRangeReader } from './types';

/**
 * Lit une plage d'octets d'un objet S3 par GET partiel, sans télécharger l'objet entier.
 */
export class S3ObjectRangeReader implements ObjectRangeReader {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    readonly bucket: string,
  ) {}

  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    if (!response.Body) {
      throw new Error(`Réponse S3 incomplète : corps absent pour ${key}`);
    }
    return response.Body.transformToByteArray();
  }
}
