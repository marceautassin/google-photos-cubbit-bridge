import * as fs from 'fs';
import * as path from 'path';
import { CopyObjectCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

/** Seuls modules du SDK autorisés, et identifiants importés par fichier (inventaire figé). */
const ALLOWED_IMPORTS: Record<string, string[]> = {
  [WRITER_FILE]: ['CopyObjectCommand', 'HeadBucketCommand', 'HeadObjectCommand', 'S3Client'],
  'clients/bucket-lister.ts': ['ListObjectsV2Command', 'S3Client'],
  // Story 4.2 : téléchargement entier des zips Takeout de backups/, en lecture seule (GET complet, rien d'autre).
  'clients/object-downloader.ts': ['GetObjectCommand', 'S3Client'],
  'clients/object-range-reader.ts': ['GetObjectCommand', 'S3Client'],
  'clients/s3-client.ts': ['S3Client'],
};
const ALLOWED_MODULE = '@aws-sdk/client-s3';
const WRITER_COMMANDS = new Set(['CopyObjectCommand', 'HeadBucketCommand', 'HeadObjectCommand']);
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
      if (extra.length > 0) violations.push(`${file} : commandes hors copie et HEAD : ${extra.join(', ')}`);
      if (/Delete|Put[A-Z]|Upload|GetObject|lib-storage/.test(text)) violations.push(`${file} : mention de suppression, dépôt ou lecture d'objet`);
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
    const tampered = writer.text.replace('HeadBucketCommand, HeadObjectCommand', 'HeadBucketCommand, HeadObjectCommand, GetObjectCommand');
    expect(tampered).not.toBe(writer.text);
    expect(analyzeSources([{ file: WRITER_FILE, text: tampered }])).not.toEqual([]);
  });
});
