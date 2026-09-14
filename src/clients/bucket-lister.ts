// Lecture seule par construction : ce module n'importe QUE la commande de listing.
// Toute opération d'écriture ou de suppression est hors de sa portée.
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BucketLister, BucketObjectPage } from './types';

/**
 * Liste le contenu d'un bucket S3, page par page, sans aucun filtre de préfixe.
 */
export class S3BucketLister implements BucketLister {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    readonly bucket: string,
  ) {}

  async listPage(continuationToken?: string): Promise<BucketObjectPage> {
    const response = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: continuationToken }),
    );

    // Inventaire exhaustif ou rien : un objet incomplet est une anomalie, pas un objet à ignorer.
    const objects = (response.Contents ?? []).map((object) => {
      if (object.Key === undefined || object.Size === undefined) {
        throw new Error(`Réponse S3 incomplète : objet sans clé ou sans taille (${object.Key ?? 'clé absente'})`);
      }
      return {
        key: object.Key,
        size: object.Size,
        lastModified: object.LastModified ?? null,
        etag: object.ETag ? object.ETag.replace(/^"|"$/g, '') : null,
      };
    });

    // Champ obligatoire du protocole : son absence rendrait la fin du listing indécidable.
    if (response.IsTruncated === undefined) {
      throw new Error('Réponse S3 incomplète : champ IsTruncated absent, impossible de savoir si le listing est terminé');
    }

    return {
      objects,
      isTruncated: response.IsTruncated,
      nextToken: response.NextContinuationToken,
    };
  }
}
