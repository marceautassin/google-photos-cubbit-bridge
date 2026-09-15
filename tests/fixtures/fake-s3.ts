import { CopyObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Faux S3 en mémoire pour la story 3.1 : aucun réseau. Ne connaît que HeadBucket, HeadObject et CopyObject ; toute autre commande
 * fait échouer le test. Chaque commande envoyée est enregistrée pour les assertions.
 */
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
  /** Erreur levée par HEAD sur une clé donnée. */
  headError: ((bucket: string, key: string) => Error | null) | null = null;
  /** Erreur levée par une copie vers une clé donnée, AVANT toute écriture. */
  copyError: ((key: string) => Error | null) | null = null;
  /** Destinations écrasées par une copie (clé déjà présente) : doit rester vide. */
  readonly overwrites: string[] = [];

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
    throw new Error(`commande inattendue dans le faux S3 : ${(command as object).constructor.name}`);
  });
}
