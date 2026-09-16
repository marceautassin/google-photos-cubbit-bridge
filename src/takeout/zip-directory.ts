import * as fs from 'fs';
import { ObjectRangeReader } from '../clients/types';

/**
 * Lecture de la table des matières d'un zip (répertoire central) par lectures partielles, sans lire les données
 * compressées (story 4.1). Parseur minimal volontaire : une bibliothèque zip lit entrée par entrée (des milliers de GET
 * partiels sur un zip distant) et ne contrôle pas la cohérence du répertoire. Au plus trois lectures par zip : la queue
 * du fichier, l'éventuel enregistrement zip64 hors de la queue, puis le répertoire central.
 * Référence : APPNOTE.TXT de PKWARE, sections 4.3.12 (répertoire central), 4.3.14 à 4.3.16 (fins zip64 et classique).
 */

/** Zip lisible par plages : taille totale et lecture des octets `start` à `end` inclus. Lecture seule. */
export interface ZipSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  name: string; // chemin dans le zip, décodé en UTF-8, tel quel (sans normalisation)
  size: number; // taille décompressée
  compressedSize: number;
  method: number; // 0 : stockée, 8 : deflate
}

export interface ZipDirectory {
  entries: ZipEntry[];
  zip64: boolean;
}

/** Zip illisible ou incohérent : la partie n'est pas exploitable. */
export class ZipStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipStructureError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LENGTH = 56;
const ENTRY_SIGNATURE = 0x02014b50;
const ENTRY_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const ZIP64_EXTRA_ID = 0x0001;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const SUPPORTED_METHODS = new Set([0, 8]);
/** Plafond du répertoire central lu en une fois (≈ 400 000 entrées de noms moyens). */
const MAX_DIRECTORY_SIZE = 64 * 1024 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function u64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipStructureError('valeur zip64 hors limites');
  return Number(value);
}

export async function readZipDirectory(source: ZipSource): Promise<ZipDirectory> {
  const read = async (start: number, length: number): Promise<Uint8Array> => {
    const bytes = await source.read(start, start + length - 1);
    if (bytes.length !== length) {
      throw new ZipStructureError(`lecture incomplète : ${bytes.length} octet(s) reçu(s) sur ${length} à la position ${start}`);
    }
    return bytes;
  };
  const { size } = source;
  if (size < EOCD_LENGTH) throw new ZipStructureError('fichier trop court pour être un zip');

  // Queue : la fin du répertoire central (EOCD) est suivie d'un commentaire d'au plus 65 535 octets.
  const tailStart = Math.max(0, size - (EOCD_LENGTH + MAX_COMMENT_LENGTH));
  const tail = await read(tailStart, size - tailStart);
  const tailView = view(tail);
  /** Octets à une position absolue : pris dans la queue s'ils y sont, lus sinon. */
  const bytesAt = async (offset: number, length: number): Promise<Uint8Array> =>
    length === 0 ? new Uint8Array(0) : offset >= tailStart ? tail.subarray(offset - tailStart, offset - tailStart + length) : read(offset, length);
  let eocd = -1;
  for (let p = tail.length - EOCD_LENGTH; p >= 0; p--) {
    if (tailView.getUint32(p, true) === EOCD_SIGNATURE && p + EOCD_LENGTH + tailView.getUint16(p + 20, true) === tail.length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new ZipStructureError('fin du répertoire central (EOCD) introuvable : zip tronqué ou corrompu');

  const eocdOffset = tailStart + eocd;
  let disk = tailView.getUint16(eocd + 4, true);
  let directoryDisk = tailView.getUint16(eocd + 6, true);
  let entriesOnDisk = tailView.getUint16(eocd + 8, true);
  let entryCount = tailView.getUint16(eocd + 10, true);
  let directorySize = tailView.getUint32(eocd + 12, true);
  let directoryOffset = tailView.getUint32(eocd + 16, true);
  let directoryLimit = eocdOffset; // le répertoire central s'arrête avant les enregistrements de fin

  const saturated = [disk, directoryDisk, entriesOnDisk, entryCount].includes(MAX16) || [directorySize, directoryOffset].includes(MAX32);
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_LENGTH;
  const locator = locatorOffset >= 0 ? view(await bytesAt(locatorOffset, ZIP64_LOCATOR_LENGTH)) : null;
  const zip64 = locator !== null && locator.getUint32(0, true) === ZIP64_LOCATOR_SIGNATURE;
  if (saturated && !zip64) throw new ZipStructureError('valeurs zip64 annoncées mais localisateur zip64 absent');
  if (locator !== null && zip64) {
    if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1) {
      throw new ZipStructureError('zip multi-volume (découpé) non pris en charge');
    }
    const recordOffset = u64(locator, 8);
    if (recordOffset + ZIP64_EOCD_LENGTH > locatorOffset) {
      throw new ZipStructureError('enregistrement de fin zip64 hors des bornes du fichier');
    }
    const record = view(await bytesAt(recordOffset, ZIP64_EOCD_LENGTH));
    if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipStructureError('enregistrement de fin zip64 introuvable à la position annoncée');
    }
    disk = record.getUint32(16, true);
    directoryDisk = record.getUint32(20, true);
    entriesOnDisk = u64(record, 24);
    entryCount = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
    directoryLimit = recordOffset;
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipStructureError('zip multi-volume (découpé) non pris en charge');
  }
  // Le répertoire central se termine exactement là où commencent les enregistrements de fin : écarte aussi une fin de
  // répertoire factice (signature présente dans un commentaire).
  if (directoryOffset + directorySize !== directoryLimit) {
    throw new ZipStructureError(
      `répertoire central non contigu à sa fin (position ${directoryOffset}, ${directorySize} octets, fin attendue ${directoryLimit})`,
    );
  }
  // Taille plausible avant toute lecture : chaque entrée occupe entre 46 octets et 46 + 3 × 65 535 octets.
  if (directorySize < entryCount * ENTRY_LENGTH || directorySize > entryCount * (ENTRY_LENGTH + 3 * MAX16) || directorySize > MAX_DIRECTORY_SIZE) {
    throw new ZipStructureError(
      `répertoire central incohérent : ${directorySize} octets pour ${entryCount} entrée(s) annoncée(s) (plafond ${MAX_DIRECTORY_SIZE} octets)`,
    );
  }

  const directory = await bytesAt(directoryOffset, directorySize);
  const entries = parseEntries(directory, entryCount, directoryOffset);
  return { entries, zip64 };
}

function parseEntries(directory: Uint8Array, entryCount: number, dataLimit: number): ZipEntry[] {
  const data = view(directory);
  const entries: ZipEntry[] = [];
  const extents: { name: string; start: number; minimalEnd: number }[] = [];
  let p = 0;
  while (entries.length < entryCount) {
    const index = entries.length + 1;
    const truncated = `répertoire central tronqué : ${entries.length} entrée(s) lue(s) sur ${entryCount} annoncée(s)`;
    if (p + ENTRY_LENGTH > directory.length) throw new ZipStructureError(truncated);
    if (data.getUint32(p, true) !== ENTRY_SIGNATURE) {
      throw new ZipStructureError(`répertoire central incohérent : signature invalide à l'entrée ${index} sur ${entryCount}`);
    }
    const flags = data.getUint16(p + 8, true);
    const method = data.getUint16(p + 10, true);
    let compressedSize = data.getUint32(p + 20, true);
    let size = data.getUint32(p + 24, true);
    const nameLength = data.getUint16(p + 28, true);
    const extraLength = data.getUint16(p + 30, true);
    const commentLength = data.getUint16(p + 32, true);
    let startDisk = data.getUint16(p + 34, true);
    let localOffset = data.getUint32(p + 42, true);
    const nameStart = p + ENTRY_LENGTH;
    const end = nameStart + nameLength + extraLength + commentLength;
    if (end > directory.length) throw new ZipStructureError(truncated);

    let name: string;
    try {
      name = utf8.decode(directory.subarray(nameStart, nameStart + nameLength));
    } catch {
      throw new ZipStructureError(`nom de l'entrée ${index} illisible : ce n'est pas de l'UTF-8 valide`);
    }

    // Champs saturés : valeurs réelles dans le champ supplémentaire zip64, dans cet ordre.
    if (size === MAX32 || compressedSize === MAX32 || localOffset === MAX32 || startDisk === MAX16) {
      const extra = findZip64Extra(directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength));
      if (!extra) throw new ZipStructureError(`${name} : champ zip64 absent alors que des tailles sont saturées`);
      const extraView = view(extra);
      let q = 0;
      const next64 = (): number => {
        if (q + 8 > extra.length) throw new ZipStructureError(`${name} : champ zip64 trop court`);
        const value = u64(extraView, q);
        q += 8;
        return value;
      };
      if (size === MAX32) size = next64();
      if (compressedSize === MAX32) compressedSize = next64();
      if (localOffset === MAX32) localOffset = next64();
      if (startDisk === MAX16) {
        if (q + 4 > extra.length) throw new ZipStructureError(`${name} : champ zip64 trop court`);
        startDisk = extraView.getUint32(q, true);
      }
    }

    if (flags & 1) throw new ZipStructureError(`${name} : entrée chiffrée, non prise en charge`);
    if (!SUPPORTED_METHODS.has(method)) throw new ZipStructureError(`${name} : méthode de compression ${method} non prise en charge`);
    if (method === 0 && compressedSize !== size) throw new ZipStructureError(`${name} : entrée stockée dont les tailles diffèrent`);
    if (startDisk !== 0) throw new ZipStructureError(`${name} : entrée sur un autre volume (zip découpé)`);
    if (localOffset + LOCAL_HEADER_LENGTH + nameLength + compressedSize > dataLimit) {
      throw new ZipStructureError(`${name} : données hors des bornes (au-delà du début du répertoire central)`);
    }
    entries.push({ name, size, compressedSize, method });
    extents.push({ name, start: localOffset, minimalEnd: localOffset + LOCAL_HEADER_LENGTH + nameLength + compressedSize });
    p = end;
  }
  if (p !== directory.length) {
    throw new ZipStructureError(
      `répertoire central incohérent : ${directory.length} octets annoncés, ${p} occupés par les ${entryCount} entrée(s) annoncée(s)`,
    );
  }
  // Aucune entrée ne chevauche la suivante. Borne minimale : en-tête local de 30 octets, nom (supposé de même longueur
  // que dans le répertoire central) et données compressées ; l'extra local, qui peut différer, n'est pas lu.
  extents.sort((a, b) => a.start - b.start);
  for (let i = 1; i < extents.length; i++) {
    if (extents[i - 1]!.minimalEnd > extents[i]!.start) {
      throw new ZipStructureError(`${extents[i - 1]!.name} : données chevauchant l'entrée ${extents[i]!.name}`);
    }
  }
  return entries;
}

function findZip64Extra(extra: Uint8Array): Uint8Array | null {
  const data = view(extra);
  for (let p = 0; p + 4 <= extra.length; ) {
    const id = data.getUint16(p, true);
    const length = data.getUint16(p + 2, true);
    if (p + 4 + length > extra.length) return null;
    if (id === ZIP64_EXTRA_ID) return extra.subarray(p + 4, p + 4 + length);
    p += 4 + length;
  }
  return null;
}

/** Source qui compte les octets lus, y compris quand la lecture de la table des matières échoue. */
export function countingSource(source: ZipSource): { source: ZipSource; bytesRead: () => number } {
  let bytesRead = 0;
  return {
    source: {
      size: source.size,
      read: async (start, end): Promise<Uint8Array> => {
        const bytes = await source.read(start, end);
        bytesRead += bytes.length;
        return bytes;
      },
    },
    bytesRead: () => bytesRead,
  };
}

/** Zip local, lu par plages (descripteur ouvert en lecture seule à chaque lecture). */
export async function localZipSource(filePath: string): Promise<ZipSource> {
  const { size } = await fs.promises.stat(filePath);
  return {
    size,
    async read(start: number, end: number): Promise<Uint8Array> {
      const handle = await fs.promises.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(Math.max(0, Math.min(end, size - 1) - start + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

/** Zip distant, lu par GET partiels (taille connue par le listing). */
export function remoteZipSource(reader: ObjectRangeReader, key: string, size: number): ZipSource {
  return { size, read: (start, end) => reader.readRange(key, start, end) };
}
