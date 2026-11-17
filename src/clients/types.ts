/**
 * Objet tel que listé dans un bucket (inventaire, story 2.1).
 */
export interface BucketObject {
  key: string;
  size: number;
  lastModified: Date | null;
  etag: string | null; // sans guillemets
}

/**
 * Une page de listing S3.
 */
export interface BucketObjectPage {
  objects: BucketObject[];
  isTruncated: boolean; // d'autres pages suivent
  nextToken?: string;
}

/**
 * Accès en lecture seule au contenu d'un bucket : lister, et rien d'autre.
 */
export interface BucketLister {
  readonly bucket: string;
  listPage(continuationToken?: string): Promise<BucketObjectPage>;
}

/**
 * Accès en lecture seule à une plage d'octets d'un objet (lecture EXIF, story 2.2) : lire, et rien d'autre.
 */
export interface ObjectRangeReader {
  readonly bucket: string;
  /** Lit les octets `start` à `end` inclus (en-tête HTTP `Range`). */
  readRange(key: string, start: number, end: number): Promise<Uint8Array>;
}

/** Contenu entier d'un objet, en flux, avec les métadonnées de la réponse. */
export interface DownloadedObject {
  body: AsyncIterable<Uint8Array>;
  size: number | null; // Content-Length
  etag: string | null; // sans guillemets
}

/**
 * Accès en lecture seule au contenu entier d'un objet (téléchargement des zips Takeout, story 4.2) : lire, et rien d'autre.
 */
export interface ObjectDownloader {
  readonly bucket: string;
  download(key: string): Promise<DownloadedObject>;
}

/**
 * Métadonnées d'un objet du bucket dédié, lues par HEAD (story 3.1).
 */
export interface DestinationObject {
  size: number;
  etag: string | null; // sans guillemets
}

/**
 * Dépôt en plusieurs parties commencé et jamais terminé ni interrompu proprement (story 4.3, correction) : ses
 * parties sont facturées côté Cubbit mais invisibles de l'outil (aucun objet servi avant que le dépôt entier ne soit
 * validé). Lecture seule, jamais nettoyé par ce module (NFR-1) : à purger à la main (Cubbit n'a pas de règle de cycle
 * de vie `AbortIncompleteMultipartUpload`), voir docs/RUNBOOK.md.
 */
export interface IncompleteMultipartUpload {
  key: string;
  uploadId: string;
  initiated: Date | null;
}

/**
 * Seul accès en écriture au stockage (NFR-1, stories 3.1 et 4.3) : copie côté serveur du bucket source vers le bucket
 * dédié, dépôt d'un fichier local dans le bucket dédié, et lecture des métadonnées de destination. Aucune suppression.
 */
export interface ArchiveWriter {
  readonly sourceBucket: string;
  readonly sourcePrefixes: readonly string[]; // seules clés source copiables
  readonly destinationBucket: string;
  /** Vérifie l'existence et l'accès au bucket dédié sans rien écrire ; lève une erreur sinon. */
  checkAccess(): Promise<void>;
  /** Métadonnées de l'objet de destination, `null` s'il n'existe pas. */
  headDestination(key: string): Promise<DestinationObject | null>;
  /** Copie côté serveur, conditionnée à l'ETag source (la source n'a pas changé depuis l'inventaire). */
  copyFromSource(sourceKey: string, sourceEtag: string, destinationKey: string): Promise<void>;
  /**
   * Dépose `body` (contenu entier, déjà lu localement — story 4.3) à `destinationKey` : une seule requête sous un seuil
   * documenté, plusieurs parties au-delà. Ne vérifie ni n'empêche un écrasement : l'appelant doit avoir constaté
   * l'absence de la destination par `headDestination` avant d'appeler cette méthode.
   */
  uploadFile(destinationKey: string, body: Buffer): Promise<void>;
  /**
   * Dépôts multipart inachevés sur le bucket dédié (story 4.3, correction), lecture seule (`ListMultipartUploads`) :
   * signalés à l'appelant pour information (résumé d'`archiver`), jamais abandonnés ici (aucune suppression, NFR-1).
   */
  listIncompleteMultipartUploads(): Promise<IncompleteMultipartUpload[]>;
}
