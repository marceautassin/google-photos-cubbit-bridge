import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import * as zlib from 'zlib';
import { ZipEntry, ZipStructureError } from './zip-directory';

/**
 * Lecture en flux du contenu d'une entrée d'un zip local (story 4.2), sans extraction sur disque : en-tête local
 * contrôlé, données compressées bornées, décompression deflate en flux, CRC-32 et taille décompressée vérifiés à la fin.
 * Référence : APPNOTE.TXT de PKWARE, section 4.3.7 (en-tête local).
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_LENGTH = 30;

/**
 * Lit l'entrée `entry` du zip `filePath` et passe chaque morceau décompressé à `onChunk`, dans l'ordre. Lève une
 * `ZipStructureError` si l'en-tête local est invalide, si la décompression échoue, ou si la taille décompressée ou le
 * CRC-32 diffèrent de ceux du répertoire central : dans ce cas, les morceaux déjà transmis ne sont pas fiables.
 */
export async function readZipEntry(
  filePath: string,
  entry: ZipEntry,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r');
  let dataStart: number;
  let fileSize: number;
  try {
    fileSize = (await handle.stat()).size;
    const header = Buffer.alloc(LOCAL_HEADER_LENGTH);
    const { bytesRead } = await handle.read(header, 0, LOCAL_HEADER_LENGTH, entry.localOffset);
    if (bytesRead !== LOCAL_HEADER_LENGTH || header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipStructureError(`${entry.name} : en-tête local introuvable à la position ${entry.localOffset}`);
    }
    const nameLength = header.readUInt16LE(26);
    const nameBytes = Buffer.alloc(nameLength);
    await handle.read(nameBytes, 0, nameLength, entry.localOffset + LOCAL_HEADER_LENGTH);
    // L'en-tête local doit décrire la même entrée que le répertoire central : même nom, même méthode.
    if (nameBytes.toString('utf8') !== entry.name) {
      throw new ZipStructureError(`${entry.name} : l'en-tête local porte un autre nom (${JSON.stringify(nameBytes.toString('utf8'))}) : zip corrompu`);
    }
    if (header.readUInt16LE(8) !== entry.method) {
      throw new ZipStructureError(`${entry.name} : méthode ${header.readUInt16LE(8)} dans l'en-tête local, ${entry.method} dans le répertoire central : zip corrompu`);
    }
    dataStart = entry.localOffset + LOCAL_HEADER_LENGTH + nameLength + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (dataStart + entry.compressedSize > fileSize) {
    throw new ZipStructureError(`${entry.name} : données compressées au-delà de la fin du fichier`);
  }

  let size = 0;
  let crc = 0;
  let overflow: ZipStructureError | null = null; // le pipeline peut masquer l'erreur levée par la dernière étape
  const consume = async (source: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > entry.size) {
        overflow = new ZipStructureError(`${entry.name} : contenu plus long que la taille annoncée (${entry.size} octets)`);
        throw overflow;
      }
      crc = zlib.crc32(chunk, crc);
      onChunk(chunk);
    }
  };
  const raw =
    entry.compressedSize === 0
      ? [] // createReadStream refuse une plage vide
      : fs.createReadStream(filePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  try {
    if (entry.method === 8) await pipeline(raw, zlib.createInflateRaw(), consume);
    else if (entry.method === 0) await pipeline(raw, consume);
    else throw new ZipStructureError(`${entry.name} : méthode de compression ${entry.method} non prise en charge`);
  } catch (error) {
    if (overflow !== null) throw overflow;
    if (error instanceof ZipStructureError) throw error;
    throw new ZipStructureError(`${entry.name} : décompression impossible (${error instanceof Error ? error.message : String(error)})`);
  }
  if (size !== entry.size) {
    throw new ZipStructureError(`${entry.name} : taille décompressée ${size} octets, ${entry.size} annoncés`);
  }
  if (crc >>> 0 !== entry.crc32 >>> 0) {
    throw new ZipStructureError(
      `${entry.name} : CRC-32 invalide (calculé ${(crc >>> 0).toString(16)}, annoncé ${(entry.crc32 >>> 0).toString(16)}) : zip corrompu`,
    );
  }
}

/** Contenu entier d'une petite entrée (métadonnées JSON), vérifié ; refus au-delà de `maxSize` octets. */
export async function readSmallZipEntry(filePath: string, entry: ZipEntry, maxSize: number): Promise<Buffer> {
  if (entry.size > maxSize) throw new ZipStructureError(`${entry.name} : ${entry.size} octets, au-delà de ${maxSize} octets attendus`);
  return readWholeZipEntry(filePath, entry);
}

/**
 * Contenu entier d'une entrée, quelle que soit sa taille (story 4.3 : lecture d'un média avant envoi, jamais réextrait
 * sur disque), vérifié (CRC-32 et taille décompressée). Mis en mémoire en une fois : acceptable pour des médias d'un
 * export Google Photos (quelques centaines de Mio au plus), à revoir si de bien plus gros fichiers apparaissaient.
 */
export async function readWholeZipEntry(filePath: string, entry: ZipEntry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readZipEntry(filePath, entry, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}
