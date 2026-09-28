import * as fs from 'fs';
import * as path from 'path';
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  ACCESS_PROBE_KEY,
  destinationProblem,
  encodeCopySource,
  isCopyRefusedBeforeWrite,
  S3ArchiveWriter,
  sourceKeyProblem,
  WriteRefusedError,
  WriterScope,
} from '../../src/clients/archive-writer';
import {
  createS3Client,
  S3_CONNECTION_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_TIMEOUT_MS,
  S3_SEND_DEADLINE_MS,
} from '../../src/clients/s3-client';
import { FakeS3 } from '../fixtures/fake-s3';

const PREFIXES = ['backup_google_photos/photos/', '2_Personnel/Photos/google_photos/'];
const scope: WriterScope = { sourceBucket: 'marceau', sourcePrefixes: PREFIXES, destinationBucket: 'marceau-photos' };
const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
const SOURCE_KEY = 'backup_google_photos/photos/2016/IMG_0005.JPG';

describe('S3ArchiveWriter : garde de cloisonnement (NFR-1)', () => {
  it.each([
    [{ destinationBucket: '' }, 'aucun bucket dédié'],
    [{ destinationBucket: 'marceau' }, 'bucket source'],
    [{ destinationBucket: 'MARCEAU' }, 'invalide'],
    [{ destinationBucket: ' marceau' }, 'invalide'],
    [{ destinationBucket: 'marceau-photos ' }, 'invalide'],
    [{ destinationBucket: 'ab' }, 'invalide'],
    [{ sourceBucket: 'Marceau' }, 'invalide'],
    [{ sourcePrefixes: [] }, 'aucun préfixe source'],
    [{ sourcePrefixes: ['backup_google_photos/photos'] }, 'préfixe source'],
    [{ sourcePrefixes: ['../marceau-photos/'] }, 'préfixe source'],
  ])('refuse à la construction le périmètre %j', (override, message) => {
    const s3 = new FakeS3();
    expect(() => new S3ArchiveWriter(s3.asClient(), { ...scope, ...override })).toThrow(WriteRefusedError);
    expect(() => new S3ArchiveWriter(s3.asClient(), { ...scope, ...override })).toThrow(message);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it.each([
    ['backups/takeout-20260806-001.zip', 'backups/'],
    ['takeout.zip', 'hors des espaces'],
    ['Photos/2016/a.jpg', 'hors des espaces'],
    ['photos', 'hors des espaces'],
    ['photos/', 'invalide'],
    ['photos/2016/', 'invalide'],
    ['photos//a.jpg', 'invalide'],
    ['photos/../backups/a.zip', 'invalide'],
    ['albums/./mariage/a.jpg', 'invalide'],
    ['/photos/a.jpg', 'hors des espaces'],
  ])('refuse la clé de destination « %s » avant tout appel réseau', async (key, message) => {
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), scope);
    await expect(writer.copyFromSource(SOURCE_KEY, md5, key)).rejects.toThrow(message);
    await expect(writer.headDestination(key)).rejects.toThrow(WriteRefusedError);
    await expect(writer.uploadFile(key, Buffer.from('x'))).rejects.toThrow(message);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it.each([
    ['../marceau-photos/backups/x', 'invalide'],
    ['backup_google_photos/photos/../../marceau-photos/backups/x.zip', 'invalide'],
    ['backup_google_photos/photos//a.jpg', 'invalide'],
    ['backup_google_photos/photos/./a.jpg', 'invalide'],
    ['1_Professionel/contrat.pdf', 'hors des préfixes source'],
    ['2_Personnel/Mariage/a.jpg', 'hors des préfixes source'],
    ['BACKUP_google_photos/photos/a.jpg', 'hors des préfixes source'],
  ])('refuse la clé source « %s » avant tout appel réseau', async (key, message) => {
    const s3 = new FakeS3();
    await expect(new S3ArchiveWriter(s3.asClient(), scope).copyFromSource(key, md5, 'photos/2016/2016-02/a.jpg')).rejects.toThrow(message);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('refuse un bucket étranger, le bucket source (quelle que soit la casse), et autorise les trois espaces', () => {
    expect(destinationProblem('marceau-autre', 'photos/2016/2016-02/a.jpg', scope)).toMatch('différent du bucket dédié');
    expect(destinationProblem('marceau', 'photos/2016/2016-02/a.jpg', scope)).toMatch('bucket source');
    expect(destinationProblem('MARCEAU', 'photos/2016/2016-02/a.jpg', scope)).toMatch('bucket source');
    expect(destinationProblem('marceau-photos', 'backups/x.zip', scope)).toMatch('backups/');
    expect(destinationProblem('marceau-photos', 'photos/2016/2016-02/a.jpg', scope)).toBeNull();
    expect(destinationProblem('marceau-photos', 'albums/mariage/a.jpg', scope)).toBeNull();
    expect(destinationProblem('marceau-photos', 'quarantaine/2_Personnel/Photos/google_photos/x.jpg', scope)).toBeNull();
    expect(destinationProblem('marceau-photos', ACCESS_PROBE_KEY, scope)).toBeNull();
    expect(sourceKeyProblem('2_Personnel/Photos/google_photos/mariage/Été & co.jpg', scope)).toBeNull();
  });
});

describe('S3ArchiveWriter : requêtes', () => {
  it('copie côté serveur, conditionnée à l\'ETag source, vers le seul bucket dédié', async () => {
    const s3 = new FakeS3();
    s3.put('marceau', SOURCE_KEY, { size: 10, etag: md5 });
    await new S3ArchiveWriter(s3.asClient(), scope).copyFromSource(SOURCE_KEY, md5, 'photos/2016/2016-02/IMG_0005.JPG');
    expect(s3.commands).toHaveLength(1);
    expect(s3.commands[0]).toBeInstanceOf(CopyObjectCommand);
    expect((s3.commands[0] as CopyObjectCommand).input).toEqual({
      Bucket: 'marceau-photos',
      Key: 'photos/2016/2016-02/IMG_0005.JPG',
      CopySource: 'marceau/backup_google_photos/photos/2016/IMG_0005.JPG',
      CopySourceIfMatch: `"${md5}"`,
    });
    expect(s3.get('marceau-photos', 'photos/2016/2016-02/IMG_0005.JPG')).toEqual({ size: 10, etag: md5 });
  });

  it('refuse une copie sans ETag source', async () => {
    const s3 = new FakeS3();
    await expect(new S3ArchiveWriter(s3.asClient(), scope).copyFromSource(SOURCE_KEY, ' ', 'photos/a.jpg')).rejects.toThrow('ETag source absent');
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('HEAD : métadonnées sans guillemets, null si absent, erreur relayée sinon', async () => {
    const s3 = new FakeS3();
    s3.put('marceau-photos', 'photos/a.jpg', { size: 3, etag: 'abc-2' });
    const writer = new S3ArchiveWriter(s3.asClient(), scope);
    await expect(writer.headDestination('photos/a.jpg')).resolves.toEqual({ size: 3, etag: 'abc-2' });
    await expect(writer.headDestination('photos/b.jpg')).resolves.toBeNull();
    s3.headError = () => Object.assign(new Error('Forbidden'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
    await expect(writer.headDestination('photos/a.jpg')).rejects.toThrow('Forbidden');
    expect(s3.commands.every((c) => c instanceof HeadObjectCommand)).toBe(true);
  });

  it('contrôle d\'accès : HEAD du bucket dédié puis HEAD de la sonde ; bucket inexistant (404) → échec', async () => {
    const s3 = new FakeS3();
    s3.createBucket('marceau-photos');
    const writer = new S3ArchiveWriter(s3.asClient(), scope);
    await expect(writer.checkAccess()).resolves.toBeUndefined();
    expect(s3.commandNames()).toEqual(['HeadBucketCommand', 'HeadObjectCommand']);
    expect((s3.commands[0] as HeadBucketCommand).input).toEqual({ Bucket: 'marceau-photos' });
    expect((s3.commands[1] as HeadObjectCommand).input).toEqual({ Bucket: 'marceau-photos', Key: ACCESS_PROBE_KEY });

    const missing = new FakeS3();
    await expect(new S3ArchiveWriter(missing.asClient(), scope).checkAccess()).rejects.toThrow('NotFound');
    expect(missing.commandNames()).toEqual(['HeadBucketCommand']);
  });
});

describe('S3ArchiveWriter : uploadFile (story 4.3)', () => {
  it('dépose un petit fichier en une seule requête PutObject', async () => {
    const s3 = new FakeS3();
    const body = Buffer.from('contenu du média');
    await new S3ArchiveWriter(s3.asClient(), scope).uploadFile('photos/2020/2020-05/a.jpg', body);
    expect(s3.commandNames()).toEqual(['PutObjectCommand']);
    const put = s3.commands[0] as PutObjectCommand;
    expect(put.input).toEqual({ Bucket: 'marceau-photos', Key: 'photos/2020/2020-05/a.jpg', Body: body, ContentLength: body.length });
    expect(s3.get('marceau-photos', 'photos/2020/2020-05/a.jpg')?.size).toBe(body.length);
  });

  it('bascule en dépôt multipart au-delà du seuil, en parties de la taille configurée, dans l\'ordre', async () => {
    const s3 = new FakeS3();
    // Seuil et taille de partie réduits pour le test (constructeur, story 4.3) : pas de tampon de test énorme.
    const writer = new S3ArchiveWriter(s3.asClient(), scope, undefined, 10, 4);
    const body = Buffer.from('0123456789ABCDE'); // 15 octets > seuil (10) : 4 parties de 4, 4, 4, 3
    await writer.uploadFile('albums/mariage/video.mp4', body);
    expect(s3.commandNames()).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
    const parts = s3.commands.slice(1, 5) as UploadPartCommand[];
    expect(parts.map((p) => (p.input.Body as Buffer).toString())).toEqual(['0123', '4567', '89AB', 'CDE']);
    expect(parts.map((p) => p.input.PartNumber)).toEqual([1, 2, 3, 4]);
    const create = s3.commands[0] as CreateMultipartUploadCommand;
    expect(create.input).toEqual({ Bucket: 'marceau-photos', Key: 'albums/mariage/video.mp4' });
    const complete = s3.commands[5] as CompleteMultipartUploadCommand;
    expect(complete.input.MultipartUpload?.Parts).toHaveLength(4);
    expect(s3.get('marceau-photos', 'albums/mariage/video.mp4')?.size).toBe(body.length);
  });

  it('un fichier exactement à la taille du seuil reste en une seule requête (borne incluse)', async () => {
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), scope, undefined, 5, 2);
    await writer.uploadFile('photos/2020/2020-05/a.jpg', Buffer.from('12345'));
    expect(s3.commandNames()).toEqual(['PutObjectCommand']);
  });
});

describe('S3ArchiveWriter : listIncompleteMultipartUploads (story 4.3, correction)', () => {
  it('aucun dépôt multipart en cours → liste vide', async () => {
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), scope);
    await expect(writer.listIncompleteMultipartUploads()).resolves.toEqual([]);
  });

  it('signale un dépôt multipart commencé mais jamais terminé (ni abandonné, jamais par ce module)', async () => {
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), scope, undefined, 10, 4);
    // Panne réseau simulée sur la première partie : le dépôt multipart reste ouvert, jamais complété.
    s3.uploadPartError = () => new Error('panne réseau simulée');
    await expect(writer.uploadFile('photos/2020/2020-05/video.mp4', Buffer.from('0123456789ABCDE'))).rejects.toThrow('panne réseau simulée');
    expect(s3.commandNames().includes('AbortMultipartUploadCommand')).toBe(false); // NFC-1 : aucune suppression, jamais par ce module
    const incomplete = await writer.listIncompleteMultipartUploads();
    expect(incomplete).toEqual([{ key: 'photos/2020/2020-05/video.mp4', uploadId: 'upload-1', initiated: expect.any(Date) }]);
  });

  it('un dépôt multipart terminé (CompleteMultipartUpload réussi) n\'apparaît plus dans la liste', async () => {
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), scope, undefined, 10, 4);
    await writer.uploadFile('photos/2020/2020-05/video.mp4', Buffer.from('0123456789ABCDE'));
    await expect(writer.listIncompleteMultipartUploads()).resolves.toEqual([]);
  });

  it('ne lit qu\'un seul bucket, jamais de commande hors lecture', async () => {
    const s3 = new FakeS3();
    const writer = new S3ArchiveWriter(s3.asClient(), scope);
    await writer.listIncompleteMultipartUploads();
    expect(s3.commandNames()).toEqual(['ListMultipartUploadsCommand']);
    const list = s3.commands[0] as ListMultipartUploadsCommand;
    expect(list.input.Bucket).toBe('marceau-photos');
  });
});

describe('délais des requêtes S3 (story 3.2)', () => {
  it('le client S3 porte des délais explicites de connexion et d\'inactivité, et le nombre de tentatives', async () => {
    const client = createS3Client({ endpoint: 'https://essai.invalid', accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'marceau' } as never);
    expect(await client.config.maxAttempts()).toBe(S3_MAX_ATTEMPTS);
    // Configuration résolue du gestionnaire HTTP (champ interne du SDK, lu en test seulement).
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<{ requestTimeout?: number; connectionTimeout?: number }> };
    await expect(handler.configProvider).resolves.toMatchObject({ requestTimeout: S3_REQUEST_TIMEOUT_MS, connectionTimeout: S3_CONNECTION_TIMEOUT_MS });
    expect(S3_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(S3_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    client.destroy();
  });

  it('chaque envoi du point d\'accès porte un signal d\'abandon à l\'échéance (HEAD bucket, HEAD, copie)', async () => {
    const s3 = new FakeS3();
    s3.createBucket('marceau-photos');
    s3.put('marceau', SOURCE_KEY, { size: 10, etag: md5 });
    const writer = new S3ArchiveWriter(s3.asClient(), scope);
    await writer.checkAccess();
    await writer.copyFromSource(SOURCE_KEY, md5, 'photos/2016/2016-02/IMG_0005.JPG');
    expect(s3.options).toHaveLength(3);
    for (const options of s3.options) {
      expect((options as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
      expect((options as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(false);
    }
    expect(S3_SEND_DEADLINE_MS).toBe(970_000);
  });

  it('une requête bloquée (TCP mort après veille) est abandonnée à l\'échéance', async () => {
    const hanging = {
      send: (_command: unknown, options?: { abortSignal?: AbortSignal }): Promise<never> =>
        new Promise((_resolve, reject) =>
          options?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))),
        ),
    };
    const writer = new S3ArchiveWriter(hanging as never, scope, 5);
    await expect(writer.copyFromSource(SOURCE_KEY, md5, 'photos/a.jpg')).rejects.toThrow('Request aborted');
  });
});

describe('isCopyRefusedBeforeWrite : la copie n\'a certainement rien écrit', () => {
  const err = (name: string, status?: number, attempts?: number): Error =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status, attempts } });
  it.each([
    ['refus du garde', true, new WriteRefusedError('clé hors des espaces')],
    ['412 à la première tentative', true, err('PreconditionFailed', 412, 1)],
    ['403 AccessDenied', true, err('AccessDenied', 403, 1)],
    ['403 sans nom', true, err('Forbidden', 403, 1)],
    ['404 NoSuchKey', true, err('NoSuchKey', 404, 1)],
    ['404 NoSuchBucket', true, err('NoSuchBucket', 404, 1)],
    ['412 après retentatives du SDK (une tentative a pu écrire)', false, err('PreconditionFailed', 412, 2)],
    ['403 sans nombre de tentatives connu', false, err('AccessDenied', 403)],
    ['500', false, err('InternalError', 500, 1)],
    ['503 SlowDown', false, err('SlowDown', 503, 3)],
    ['coupure réseau', false, Object.assign(new Error('socket hang up'), { name: 'TimeoutError', code: 'ECONNRESET' })],
    ['abandon à l\'échéance', false, Object.assign(new Error('Request aborted'), { name: 'AbortError' })],
    ['404 générique', false, err('NotFound', 404, 1)],
  ])('%s → rien écrit : %s', (_label, expected, error) => {
    expect(isCopyRefusedBeforeWrite(error)).toBe(expected);
  });
});

describe('encodeCopySource', () => {
  it('encode espaces, &, #, +, ?, accents, et conserve les /', () => {
    expect(encodeCopySource('marceau', '2_Personnel/Photos/google_photos/Été 2019 & co #1+2?.jpg')).toBe(
      'marceau/2_Personnel/Photos/google_photos/%C3%89t%C3%A9%202019%20%26%20co%20%231%2B2%3F.jpg',
    );
  });

  it('ne normalise jamais une clé NFD', () => {
    const nfd = 'photos/Été.jpg'.normalize('NFD');
    expect(encodeCopySource('marceau', nfd)).toBe('marceau/photos/E%CC%81te%CC%81.jpg');
    expect(encodeCopySource('marceau', nfd)).not.toBe(encodeCopySource('marceau', nfd.normalize('NFC')));
    expect(decodeURIComponent(encodeCopySource('marceau', nfd).slice('marceau/'.length))).toBe(nfd);
  });
});

// --- Analyse statique des sources -------------------------------------------------------------------------------------

interface Source {
  file: string;
  text: string;
}

const WRITER_FILE = 'clients/archive-writer.ts';

/**
 * Seuls modules du SDK autorisés, et identifiants importés par fichier (inventaire figé).
 * Story 4.3 : le point d'accès gagne la capacité de dépôt d'un fichier local (`PutObjectCommand` en une requête,
 * `CreateMultipartUploadCommand`/`UploadPartCommand`/`CompleteMultipartUploadCommand` au-delà d'un seuil documenté),
 * et la lecture seule des dépôts multipart inachevés (`ListMultipartUploadsCommand`, correction de revue : ces
 * parties sont facturées et invisibles autrement, signalées à `archiver` pour purge côté Cubbit).
 * Volontairement absente : `AbortMultipartUploadCommand` — ce serait la seule commande de suppression du point d'accès,
 * contraire à sa garantie « aucune suppression » ; une partie orpheline d'un dépôt multipart inachevé n'est jamais
 * servie (elle n'existe qu'après `CompleteMultipartUpload`) et n'écrase donc jamais rien.
 */
const ALLOWED_IMPORTS: Record<string, string[]> = {
  [WRITER_FILE]: [
    'CompleteMultipartUploadCommand',
    'CopyObjectCommand',
    'CreateMultipartUploadCommand',
    'HeadBucketCommand',
    'HeadObjectCommand',
    'ListMultipartUploadsCommand',
    'PutObjectCommand',
    'S3Client',
    'UploadPartCommand',
  ],
  'clients/bucket-lister.ts': ['ListObjectsV2Command', 'S3Client'],
  // Story 4.2 : téléchargement entier des zips Takeout de backups/, en lecture seule (GET complet, rien d'autre).
  'clients/object-downloader.ts': ['GetObjectCommand', 'S3Client'],
  'clients/object-range-reader.ts': ['GetObjectCommand', 'S3Client'],
  'clients/s3-client.ts': ['S3Client'],
};
const ALLOWED_MODULE = '@aws-sdk/client-s3';
const WRITER_COMMANDS = new Set([
  'CompleteMultipartUploadCommand',
  'CopyObjectCommand',
  'CreateMultipartUploadCommand',
  'HeadBucketCommand',
  'HeadObjectCommand',
  'ListMultipartUploadsCommand',
  'PutObjectCommand',
  'UploadPartCommand',
]);
const READ_COMMANDS = new Set(['ListObjectsV2Command', 'GetObjectCommand', 'HeadObjectCommand', 'HeadBucketCommand']);

/** Toute référence à un module du SDK, quels que soient les guillemets. */
const SDK_REFERENCE = /(['"`])(@aws-sdk\/[^'"`]*)\1/g;
/** `import … from` / `export … from` d'un module du SDK : clause d'import et module. */
const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;]*?)\s*\bfrom\s*(['"`])(@aws-sdk\/[^'"`]*)\2/g;
/** Noms de commandes ou d'outils d'écriture. */
const WRITE_NAME =
  /\b(?:Put|Delete|Copy|Create|Restore|Upload|CompleteMultipart|UploadPart|AbortMultipart)[A-Za-z0-9]*\b|\b[A-Za-z0-9]*(?:Acl|Policy|Lifecycle|Versioning)[A-Za-z0-9]*Command\b/g;
/**
 * Mots qui ressemblent à un nom d'écriture sans en être, admis dans les seuls fichiers qui en ont besoin : la balise EXIF
 * `CreateDate`, lue par la datation (story 2.2) et citée par le rang de fiabilité des dates (story 2.3).
 */
const NOT_WRITE_NAMES: Record<string, ReadonlySet<string>> = {
  'inventory/dating.ts': new Set(['CreateDate']),
  'inventory/duplicates.ts': new Set(['CreateDate']),
};
const COMMAND_NAME = /\b[A-Z][A-Za-z0-9]*Command\b/g;
const KEYWORDS = new Set(['as', 'type', 'from', 'import', 'export', 'default']);

/** Violations des règles d'accès au SDK, vide si tout est conforme. Pure, pour être éprouvée sur des sources piégées. */
function analyzeSources(sources: Source[]): string[] {
  const violations: string[] = [];
  const unique = (values: string[]): string[] => [...new Set(values)].sort();
  for (const { file, text } of sources) {
    const references = [...text.matchAll(SDK_REFERENCE)].map((m) => m[2]!);
    const statements = [...text.matchAll(STATIC_IMPORT)];
    for (const module of references) {
      if (module !== ALLOWED_MODULE) violations.push(`${file} : module du SDK non autorisé « ${module} »`);
    }
    if (references.length !== statements.length) {
      violations.push(`${file} : référence au SDK hors d'un import statique analysable (require, import(), import à effet de bord)`);
    }
    const imported = unique(statements.flatMap((m) => (m[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => !KEYWORDS.has(n))));
    const allowed = ALLOWED_IMPORTS[file] ?? [];
    if (imported.length > 0 && JSON.stringify(imported) !== JSON.stringify(allowed)) {
      violations.push(`${file} : imports du SDK ${imported.join(', ')} ≠ inventaire figé [${allowed.join(', ')}]`);
    }
    const commands = unique(text.match(COMMAND_NAME) ?? []);
    if (file === WRITER_FILE) {
      const extra = commands.filter((c) => !WRITER_COMMANDS.has(c));
      if (extra.length > 0) violations.push(`${file} : commandes hors copie, dépôt et HEAD : ${extra.join(', ')}`);
      // Story 4.3 : PutObject/CreateMultipartUpload/UploadPart/CompleteMultipartUpload sont désormais légitimes ici
      // (couverts et bornés par WRITER_COMMANDS ci-dessus) ; seuls la suppression, la lecture d'objet et
      // `AbortMultipartUpload` (qui serait la seule suppression du point d'accès) restent interdits.
      if (/Delete|AbortMultipart|GetObject|lib-storage/.test(text)) violations.push(`${file} : mention de suppression ou de lecture d'objet`);
    } else {
      const writes = unique(text.match(WRITE_NAME) ?? []).filter((name) => !NOT_WRITE_NAMES[file]?.has(name));
      if (writes.length > 0) violations.push(`${file} : nom d'écriture hors du point d'accès : ${writes.join(', ')}`);
      const extra = commands.filter((c) => !READ_COMMANDS.has(c));
      if (extra.length > 0) violations.push(`${file} : commandes S3 hors de la liste de lecture : ${extra.join(', ')}`);
    }
  }
  return violations;
}

describe('analyse statique des sources : aucune suppression, une seule écriture', () => {
  const srcRoot = path.join(__dirname, '../../src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : /\.(ts|js|mjs|cjs)$/.test(full) ? [full] : [];
    });
  const sources: Source[] = files(srcRoot).map((file) => ({
    file: path.relative(srcRoot, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }));

  it('les sources de src/ respectent les règles d\'accès au SDK', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.file)).toContain(WRITER_FILE);
    expect(analyzeSources(sources)).toEqual([]);
  });

  it('l\'inventaire figé est exactement celui des sources (aucun lecteur disparu ou ajouté en silence)', () => {
    const importers = sources.filter(({ text }) => (text.match(SDK_REFERENCE) ?? []).length > 0).map((s) => s.file).sort();
    expect(importers).toEqual(Object.keys(ALLOWED_IMPORTS).sort());
  });

  it.each([
    ['guillemets doubles et alias', 'import { PutObjectCommand as P } from "@aws-sdk/client-s3";'],
    ['backticks', 'import { DeleteObjectCommand } from `@aws-sdk/client-s3`;'],
    ['sous-chemin dist', "import { S3Client } from '@aws-sdk/client-s3/dist-cjs/index.js';"],
    ['require', "const { S3Client } = require('@aws-sdk/client-s3');"],
    ['import dynamique', "const sdk = await import('@aws-sdk/client-s3');"],
    ['réexport', "export { CopyObjectCommand } from '@aws-sdk/client-s3';"],
    ['import * as', "import * as s3 from '@aws-sdk/client-s3'; new s3.S3Client({});"],
    ['autre module', "import { Upload } from '@aws-sdk/lib-storage';"],
    ['import multi-lignes', "import {\n  S3Client,\n  PutBucketPolicyCommand,\n} from '@aws-sdk/client-s3';"],
    ['nom d\'écriture sans import', 'const c = new client.DeleteObjectsCommand(input);'],
    ['commande de configuration', 'const c = new PutBucketVersioningCommand(input);'],
    ['nom d\'écriture en commentaire', '// on pourrait appeler CopyObject ici'],
  ])('détecte une source piégée : %s', (_label, text) => {
    expect(analyzeSources([{ file: 'commands/evil.ts', text }])).not.toEqual([]);
  });

  it('exception CreateDate : admise dans les fichiers de datation, signalée partout ailleurs', () => {
    const text = "const TAG = 'CreateDate';";
    expect(analyzeSources([{ file: 'inventory/dating.ts', text }])).toEqual([]);
    expect(analyzeSources([{ file: 'inventory/duplicates.ts', text }])).toEqual([]);
    for (const file of ['commands/evil.ts', 'inventory/plan-execution.ts', 'clients/bucket-lister.ts']) {
      expect(analyzeSources([{ file, text }])).toEqual([`${file} : nom d'écriture hors du point d'accès : CreateDate`]);
    }
  });

  it('détecte une commande en trop dans le point d\'accès lui-même', () => {
    const writer = sources.find((s) => s.file === WRITER_FILE)!;
    const tampered = writer.text.replace('HeadObjectCommand,', 'HeadObjectCommand,\n  GetObjectCommand,');
    expect(tampered).not.toBe(writer.text);
    expect(analyzeSources([{ file: WRITER_FILE, text: tampered }])).not.toEqual([]);
  });
});
