import * as crypto from 'crypto';
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

/**
 * Faux S3 en mémoire pour les stories 3.1 et 4.3 : aucun réseau. Ne connaît que HeadBucket, HeadObject, CopyObject,
 * PutObject et le dépôt multipart (CreateMultipartUpload/UploadPart/CompleteMultipartUpload) ; toute autre commande
 * fait échouer le test. Chaque commande envoyée est enregistrée pour les assertions.
 */
const md5Hex = (data: Uint8Array): string => crypto.createHash('md5').update(data).digest('hex');
export interface FakeObject {
  size: number;
  etag: string; // sans guillemets
}

/** Erreur de service telle que le SDK la lève : réponse du serveur à la première tentative. */
const s3Error = (name: string, status: number): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status, attempts: 1 } });

export class FakeS3 {
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  readonly commands: unknown[] = [];
  /** ETag attribué à la copie (défaut : celui de la source). */
  copyEtag: (source: FakeObject, key: string) => string = (source) => source.etag;
  /** Altère la copie après écriture (vérification en échec). */
  afterCopy: ((bucket: string, key: string) => void) | null = null;
  /** Altère le dépôt (PutObject ou dépôt multipart complété) après écriture (vérification en échec). */
  afterUpload: ((bucket: string, key: string) => void) | null = null;
  /** Erreur levée par HEAD sur une clé donnée. */
  headError: ((bucket: string, key: string) => Error | null) | null = null;
  /** Erreur levée par une copie vers une clé donnée, AVANT toute écriture. */
  copyError: ((key: string) => Error | null) | null = null;
  /** Erreur levée par le dépôt d'une partie d'un envoi multipart (panne réseau simulée : le dépôt reste inachevé). */
  uploadPartError: ((partNumber: number) => Error | null) | null = null;
  /** Destinations écrasées par une copie (clé déjà présente) : doit rester vide. */
  readonly overwrites: string[] = [];
  /** Parties reçues par un dépôt multipart, indexées par `UploadId`. */
  private readonly multipartParts = new Map<string, Buffer[]>();
  /** Dépôts multipart commencés et pas encore terminés (`CompleteMultipartUpload`), pour `ListMultipartUploads`. */
  private readonly multipartUploads = new Map<string, { bucket: string; key: string; initiated: Date }>();

  createBucket(bucket: string): void {
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, new Map());
  }

  put(bucket: string, key: string, object: FakeObject): void {
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, new Map());
    this.buckets.get(bucket)!.set(key, { ...object });
  }

  get(bucket: string, key: string): FakeObject | undefined {
    return this.buckets.get(bucket)?.get(key);
  }

  keys(bucket: string): string[] {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].sort();
  }

  asClient(): Pick<S3Client, 'send'> {
    return this as unknown as Pick<S3Client, 'send'>;
  }

  commandNames(): string[] {
    return this.commands.map((c) => (c as object).constructor.name);
  }

  /** Options de chaque envoi (signal d'abandon à l'échéance). */
  readonly options: unknown[] = [];

  send = jest.fn(async (command: unknown, options?: unknown): Promise<unknown> => {
    this.commands.push(command);
    this.options.push(options);
    if (command instanceof HeadBucketCommand) {
      if (!this.buckets.has(command.input.Bucket!)) throw s3Error('NotFound', 404);
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const { Bucket, Key } = command.input;
      const error = this.headError?.(Bucket!, Key!);
      if (error) throw error;
      const object = this.get(Bucket!, Key!);
      if (!object) throw s3Error('NotFound', 404);
      return { ContentLength: object.size, ETag: `"${object.etag}"` };
    }
    if (command instanceof CopyObjectCommand) {
      const { Bucket, Key, CopySource, CopySourceIfMatch } = command.input;
      const separator = CopySource!.indexOf('/');
      const sourceBucket = CopySource!.slice(0, separator);
      const sourceKey = CopySource!.slice(separator + 1).split('/').map(decodeURIComponent).join('/');
      const source = this.get(sourceBucket, sourceKey);
      if (!source) throw s3Error('NoSuchKey', 404);
      if (CopySourceIfMatch !== `"${source.etag}"`) throw s3Error('PreconditionFailed', 412);
      const error = this.copyError?.(Key!);
      if (error) throw error;
      if (this.get(Bucket!, Key!)) this.overwrites.push(Key!);
      this.put(Bucket!, Key!, { size: source.size, etag: this.copyEtag(source, Key!) });
      this.afterCopy?.(Bucket!, Key!);
      return { CopyObjectResult: {} };
    }
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body } = command.input;
      const body = Buffer.from(Body as Uint8Array);
      this.put(Bucket!, Key!, { size: body.length, etag: md5Hex(body) });
      this.afterUpload?.(Bucket!, Key!);
      return { ETag: `"${md5Hex(body)}"` };
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const { Bucket, Key } = command.input;
      const uploadId = `upload-${this.multipartParts.size + 1}`;
      this.multipartParts.set(uploadId, []);
      this.multipartUploads.set(uploadId, { bucket: Bucket!, key: Key!, initiated: new Date() });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const { UploadId, PartNumber, Body } = command.input;
      const error = this.uploadPartError?.(PartNumber!);
      if (error) throw error;
      const parts = this.multipartParts.get(UploadId!);
      if (!parts) throw s3Error('NoSuchUpload', 404);
      parts[PartNumber! - 1] = Buffer.from(Body as Uint8Array);
      return { ETag: `"${md5Hex(parts[PartNumber! - 1]!)}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const { Bucket, Key, UploadId, MultipartUpload } = command.input;
      const parts = this.multipartParts.get(UploadId!);
      if (!parts) throw s3Error('NoSuchUpload', 404);
      this.multipartParts.delete(UploadId!);
      this.multipartUploads.delete(UploadId!);
      const size = parts.reduce((total, part) => total + part.length, 0);
      // ETag S3 réel pour un dépôt multipart : md5 de la concaténation des md5 (binaires) de chaque partie, suivi de leur nombre.
      const partsMd5 = Buffer.concat(parts.map((part) => crypto.createHash('md5').update(part).digest()));
      const etag = `${md5Hex(partsMd5)}-${MultipartUpload!.Parts!.length}`;
      this.put(Bucket!, Key!, { size, etag });
      this.afterUpload?.(Bucket!, Key!);
      return { ETag: `"${etag}"` };
    }
    if (command instanceof ListMultipartUploadsCommand) {
      const { Bucket } = command.input;
      const uploads = [...this.multipartUploads.entries()]
        .filter(([, u]) => u.bucket === Bucket)
        .map(([uploadId, u]) => ({ UploadId: uploadId, Key: u.key, Initiated: u.initiated }));
      return { Uploads: uploads, IsTruncated: false };
    }
    throw new Error(`commande inattendue dans le faux S3 : ${(command as object).constructor.name}`);
  });
}
