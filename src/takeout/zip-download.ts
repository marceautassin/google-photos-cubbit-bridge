import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { ObjectDownloader } from '../clients/types';
import { etagKind, normalizeEtag } from '../inventory/duplicates';
import { describeError } from '../utils/format';
import { MultipartEtagHasher, multipartPartCount, partSizeLabel } from '../utils/multipart-etag';
import { localZipSource, readZipDirectory, ZipEntry } from './zip-directory';
import { readZipEntry } from './zip-entry-stream';

/**
 * Téléchargement local des zips Takeout de `backups/` (story 4.2), en lecture seule côté S3, avec vérification
 * d'intégrité avant tout usage :
 * - taille reçue égale à la taille listée, ETag de la réponse égal à l'ETag listé ;
 * - ETag MD5 simple : MD5 recalculé égal, sinon refus ;
 * - ETag multipart `<md5>-N` : recalculé pour les tailles de partie plausibles (`utils/multipart-etag.ts`). S3 ne
 *   conserve pas la taille des parties : si aucune ne correspond, ce n'est pas une preuve de corruption, et le zip est
 *   vérifié par repli : son répertoire central doit être identique, entrée par entrée, à celui du zip distant (lu par
 *   plages), puis chaque entrée doit passer son CRC-32 et sa taille ;
 * - espace disque suffisant exigé avant téléchargement (taille × 1,1) ; fichier partiel supprimé en cas d'échec ;
 * - écriture dans `<zip>.partiel`, synchronisation disque du fichier puis du dossier, renommage atomique, marqueur
 *   `<zip>.verification.json`.
 * Reprise : un zip dont le marqueur correspond (nom, taille, ETag, date de modification) est réutilisé tel quel ; un zip
 * complet sans marqueur valide est revérifié sans téléchargement ; un fichier partiel ou non conforme est remplacé.
 * Après un téléchargement, la vérification MD5 / ETag multipart utilise l'empreinte calculée à la volée sur le flux
 * reçu (`EtagHasher`, mis à jour pendant l'écriture de `<zip>.partiel`), jamais une relecture du fichier renommé ; seul
 * le repli `crc_entrees` relit le fichier local (répertoire central puis CRC de chaque entrée), car aucune empreinte
 * n'a alors pu être établie contre l'objet distant. Le marqueur `<zip>.verification.json` inclut la date de
 * modification (`mtime_ms`) du fichier local : tout changement de `mtime` (édition, remplacement hors de l'outil)
 * invalide le marqueur et force une revérification complète avant réutilisation.
 */

/** Zip de `backups/` tel que listé. */
export interface RemoteZip {
  name: string;
  key: string;
  size: number;
  etag: string | null;
}

/** Méthode par laquelle un zip local a été vérifié. */
export type ZipVerification = 'md5' | 'etag_multipart' | 'crc_entrees';

export const VERIFICATION_LABELS: Record<ZipVerification, string> = {
  md5: 'MD5 égal à l\'ETag',
  etag_multipart: 'ETag multipart recalculé',
  crc_entrees: 'ETag non recalculable : répertoire central identique au zip distant, CRC-32 et taille de toutes les entrées vérifiés',
};

export interface LocalZip extends RemoteZip {
  path: string;
  verification: ZipVerification;
  origin: 'reutilise' | 'reverifie' | 'telecharge';
  partSize: number | null; // taille de partie retrouvée (etag_multipart)
  detail: string | null; // précision sur la vérification (tailles de partie essayées sans succès)
  note: string | null; // exemplaire local précédent remplacé, et pourquoi
}

export interface ZipProgress {
  zip: string;
  phase: 'telechargement' | 'verification';
  done: number;
  total: number;
}

export interface EnsureOptions {
  onProgress?: (progress: ZipProgress) => void;
  /** Répertoire central du zip distant (lu par plages) : exigé pour le repli quand l'ETag ne se recalcule pas. */
  remoteEntries: () => Promise<ZipEntry[]>;
  /** Octets libres dans le dossier (injectable pour les tests). */
  freeSpace?: (directory: string) => Promise<number>;
}

/** Marge d'espace disque exigée avant un téléchargement. */
export const FREE_SPACE_MARGIN = 1.1;

/** Résultat de la comparaison à l'ETag : vérifié, repli nécessaire (`verification` nul), ou refus (`mismatch`). */
export interface EtagCheck {
  verification: 'md5' | 'etag_multipart' | null;
  partSize: number | null;
  mismatch: string | null;
  detail: string | null;
}

/** Calcule, en une passe, ce qu'il faut pour comparer un contenu à son ETag S3. */
export class EtagHasher {
  private readonly md5: crypto.Hash | null;
  private readonly multipart: MultipartEtagHasher | null;
  private readonly expected: string | null;
  constructor(etag: string | null, size: number) {
    this.expected = normalizeEtag(etag);
    this.md5 = etagKind(this.expected) === 'md5' ? crypto.createHash('md5') : null;
    this.multipart = multipartPartCount(this.expected) === null ? null : new MultipartEtagHasher(this.expected!, size);
  }

  update(chunk: Uint8Array): void {
    this.md5?.update(chunk);
    this.multipart?.update(chunk);
  }

  check(): EtagCheck {
    if (this.md5) {
      const actual = this.md5.digest('hex');
      return actual === this.expected
        ? { verification: 'md5', partSize: null, mismatch: null, detail: null }
        : { verification: null, partSize: null, mismatch: `MD5 du contenu ${actual} différent de l'ETag ${this.expected}`, detail: null };
    }
    const partSize = this.multipart?.matchingPartSize() ?? null;
    if (partSize !== null) return { verification: 'etag_multipart', partSize, mismatch: null, detail: null };
    const tried = this.multipart?.partSizes ?? [];
    const detail =
      this.expected === null
        ? 'ETag absent'
        : tried.length === 0
          ? `aucune taille de partie plausible pour l'ETag ${this.expected}`
          : `ETag ${this.expected} non retrouvé avec les tailles de partie donnant le bon nombre de parties (${tried.map(partSizeLabel).join(', ')})`;
    return { verification: null, partSize: null, mismatch: null, detail };
  }
}

/** Écarts entre deux répertoires centraux (nom, tailles, CRC-32, position, méthode), entrée par entrée ; vide si identiques. */
export function directoryDifferences(local: ZipEntry[], remote: ZipEntry[]): string[] {
  if (local.length !== remote.length) return [`${local.length} entrée(s) en local, ${remote.length} dans le zip distant`];
  const fields = ['name', 'size', 'compressedSize', 'crc32', 'localOffset', 'method'] as const;
  return local.flatMap((entry, i) => {
    const other = remote[i]!;
    const differing = fields.filter((field) => entry[field] !== other[field]);
    return differing.length === 0 ? [] : [`entrée ${i + 1} (${other.name}) : ${differing.join(', ')} différent(s)`];
  });
}

/** Lit toutes les entrées d'un zip local en contrôlant CRC-32 et taille ; lève une erreur au premier défaut. */
export async function verifyAllEntries(filePath: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const { entries } = await readZipDirectory(await localZipSource(filePath));
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  let done = 0;
  for (const entry of entries) {
    await readZipEntry(filePath, entry, (chunk) => {
      done += chunk.length;
      onProgress?.(done, total);
    });
  }
}

interface Marker {
  nom: string;
  cle: string;
  taille: number;
  etag: string | null;
  mtime_ms: number;
  verification: ZipVerification;
  taille_partie: number | null;
  detail: string | null;
  verifie_le: string;
}

type Verified = Pick<LocalZip, 'verification' | 'partSize' | 'detail'>;

const markerPath = (file: string): string => `${file}.verification.json`;

async function readMarker(file: string): Promise<Marker | null> {
  try {
    return JSON.parse(await fs.promises.readFile(markerPath(file), 'utf8')) as Marker;
  } catch {
    return null;
  }
}

/** Synchronise un fichier ou un dossier sur disque (le dossier : pour qu'un renommage survive à une coupure). */
async function syncPath(target: string): Promise<void> {
  const handle = await fs.promises.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeMarker(file: string, zip: RemoteZip, verified: Verified): Promise<void> {
  const { mtimeMs } = await fs.promises.stat(file);
  const marker: Marker = {
    nom: zip.name, cle: zip.key, taille: zip.size, etag: normalizeEtag(zip.etag), mtime_ms: mtimeMs,
    verification: verified.verification, taille_partie: verified.partSize, detail: verified.detail, verifie_le: new Date().toISOString(),
  };
  const temporary = `${markerPath(file)}.partiel`;
  await fs.promises.writeFile(temporary, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  await fs.promises.rename(temporary, markerPath(file));
  await syncPath(path.dirname(file));
}

const removeQuietly = (file: string): Promise<void> => fs.promises.rm(file, { force: true });

async function defaultFreeSpace(directory: string): Promise<number> {
  const stats = await fs.promises.statfs(directory);
  return stats.bavail * stats.bsize;
}

/**
 * Vérifie un fichier complet : ETag, sinon repli (répertoire central identique au zip distant, puis CRC-32 et taille de
 * toutes les entrées). Lève une erreur décrivant le défaut. `hashed` : résultat déjà calculé pendant le téléchargement.
 */
async function verifyFile(file: string, zip: RemoteZip, hashed: EtagCheck | null, options: EnsureOptions): Promise<Verified> {
  let check = hashed;
  if (check === null) {
    const hasher = new EtagHasher(zip.etag, zip.size);
    let done = 0;
    for await (const chunk of fs.createReadStream(file)) {
      hasher.update(chunk as Buffer);
      done += (chunk as Buffer).length;
      options.onProgress?.({ zip: zip.name, phase: 'verification', done, total: zip.size });
    }
    check = hasher.check();
  }
  if (check.mismatch) throw new Error(check.mismatch);
  if (check.verification) return { verification: check.verification, partSize: check.partSize, detail: null };

  // Sans ETag recalculé, rien ne relie encore ces octets à l'objet S3 : le répertoire central local doit être
  // identique, entrée par entrée, à celui du zip distant, puis chaque entrée doit passer son CRC-32.
  const local = (await readZipDirectory(await localZipSource(file))).entries;
  const differences = directoryDifferences(local, await options.remoteEntries());
  if (differences.length > 0) {
    throw new Error(`répertoire central différent de celui du zip distant (${differences.slice(0, 3).join(' ; ')}${differences.length > 3 ? ' ; …' : ''})`);
  }
  await verifyAllEntries(file, (done, total) => options.onProgress?.({ zip: zip.name, phase: 'verification', done, total }));
  return { verification: 'crc_entrees', partSize: null, detail: check.detail };
}

/** Garantit un exemplaire local vérifié du zip dans `directory`, en ne le téléchargeant que si nécessaire. */
export async function ensureLocalZip(downloader: ObjectDownloader, zip: RemoteZip, directory: string, options: EnsureOptions): Promise<LocalZip> {
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, zip.name);
  const stat = await fs.promises.stat(file).catch(() => null);
  let note: string | null = stat === null ? null : `taille locale ${stat.size} octets ≠ ${zip.size} listés, remplacé`;

  if (stat?.isFile() && stat.size === zip.size) {
    const marker = await readMarker(file);
    if (
      marker !== null && marker.nom === zip.name && marker.cle === zip.key && marker.taille === zip.size &&
      marker.etag === normalizeEtag(zip.etag) && marker.mtime_ms === stat.mtimeMs && Object.hasOwn(VERIFICATION_LABELS, marker.verification)
    ) {
      return {
        ...zip, path: file, verification: marker.verification, origin: 'reutilise', partSize: marker.taille_partie, detail: marker.detail ?? null, note: null,
      };
    }
    try {
      const verified = await verifyFile(file, zip, null, options);
      await writeMarker(file, zip, verified);
      return { ...zip, path: file, ...verified, origin: 'reverifie', note: null };
    } catch (error) {
      note = `exemplaire local complet mais non conforme remplacé (${describeError(error)})`;
    }
  }
  await removeQuietly(markerPath(file));
  await removeQuietly(file);
  return { ...(await download(downloader, zip, file, options)), note };
}

async function download(downloader: ObjectDownloader, zip: RemoteZip, file: string, options: EnsureOptions): Promise<Omit<LocalZip, 'note'>> {
  const partial = `${file}.partiel`;
  const refuse = async (reason: string): Promise<never> => {
    await removeQuietly(partial);
    await removeQuietly(file);
    throw new Error(`${zip.name} : ${reason} — zip refusé, il ne sera pas utilisé`);
  };

  await removeQuietly(partial);
  const free = await (options.freeSpace ?? defaultFreeSpace)(path.dirname(file));
  if (free < zip.size * FREE_SPACE_MARGIN) {
    throw new Error(`${zip.name} : espace disque insuffisant dans ${path.dirname(file)} (${free} octets libres, ${Math.ceil(zip.size * FREE_SPACE_MARGIN)} requis) — rien n'a été téléchargé`);
  }

  let check: EtagCheck;
  try {
    const object = await downloader.download(zip.key);
    if (object.size !== null && object.size !== zip.size) {
      return await refuse(`taille annoncée ${object.size} octets, ${zip.size} listés (objet modifié depuis le listing ?)`);
    }
    if (normalizeEtag(object.etag) !== normalizeEtag(zip.etag)) {
      return await refuse(`ETag de la réponse ${object.etag ?? 'absent'} différent de l'ETag listé ${zip.etag ?? 'absent'}`);
    }
    const hasher = new EtagHasher(zip.etag, zip.size);
    let done = 0;
    try {
      await pipeline(
        object.body,
        async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          for await (const chunk of source) {
            done += chunk.length;
            if (done > zip.size) throw new Error(`plus de ${zip.size} octets reçus`);
            hasher.update(chunk);
            options.onProgress?.({ zip: zip.name, phase: 'telechargement', done, total: zip.size });
            yield chunk;
          }
        },
        fs.createWriteStream(partial),
      );
    } catch (error) {
      return await refuse(`téléchargement interrompu (${describeError(error)})`);
    }
    if (done !== zip.size) return await refuse(`${done} octets reçus sur ${zip.size}`);
    await syncPath(partial);
    check = hasher.check();
    if (check.mismatch) return await refuse(check.mismatch);
    await fs.promises.rename(partial, file);
    await syncPath(path.dirname(file));
  } catch (error) {
    // Toute autre erreur (réseau à l'ouverture, disque) : aucun fichier partiel ne reste.
    await removeQuietly(partial);
    throw error;
  }

  let verified: Verified;
  try {
    verified = await verifyFile(file, zip, check, options);
  } catch (error) {
    return refuse(`vérification en échec (${describeError(error)})`);
  }
  await writeMarker(file, zip, verified);
  return { ...zip, path: file, ...verified, origin: 'telecharge' };
}
