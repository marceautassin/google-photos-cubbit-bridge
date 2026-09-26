import * as zlib from 'zlib';
import { ObjectRangeReader } from '../../src/clients/types';

/**
 * Encodeur zip minimal pour les tests (stories 4.1, 4.2) : entrées stockées (méthode 0) ou deflate (méthode 8), CRC-32
 * réel (ou forcé pour simuler une corruption), noms UTF-8 (drapeau 11), zip64 forcé à la demande. Renvoie aussi les
 * positions utiles pour corrompre le zip de façon ciblée.
 */
export interface ZipFileSpec {
  name: string | Uint8Array; // octets bruts pour un nom invalide
  data?: Uint8Array | string;
  deflate?: boolean;
  crc32?: number; // CRC annoncé forcé (corruption)
}

export interface BuiltZip {
  bytes: Uint8Array;
  directoryOffset: number;
  directorySize: number;
  eocdOffset: number;
  entryOffsets: number[]; // position de chaque entrée dans le répertoire central
}

const encoder = new TextEncoder();

export function buildZip(files: ZipFileSpec[], options: { zip64?: boolean; comment?: string } = {}): BuiltZip {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const central: Uint8Array[] = [];

  for (const file of files) {
    const name = typeof file.name === 'string' ? encoder.encode(file.name) : file.name;
    const content = typeof file.data === 'string' ? encoder.encode(file.data) : (file.data ?? new Uint8Array(0));
    const data = file.deflate ? new Uint8Array(zlib.deflateRawSync(content)) : content;
    const method = file.deflate ? 8 : 0;
    const crc = file.crc32 ?? zlib.crc32(content);
    const localOffset = offset;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, content.length, true);
    local.setUint16(26, name.length, true);
    push(new Uint8Array(local.buffer));
    push(name);
    push(data);

    const extra = options.zip64 ? new DataView(new ArrayBuffer(28)) : null;
    if (extra) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 24, true);
      extra.setBigUint64(4, BigInt(content.length), true);
      extra.setBigUint64(12, BigInt(data.length), true);
      extra.setBigUint64(20, BigInt(localOffset), true);
    }
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 45, true);
    entry.setUint16(6, 45, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, method, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, extra ? 0xffffffff : data.length, true);
    entry.setUint32(24, extra ? 0xffffffff : content.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, extra ? 28 : 0, true);
    entry.setUint32(42, extra ? 0xffffffff : localOffset, true);
    central.push(concat([new Uint8Array(entry.buffer), name, extra ? new Uint8Array(extra.buffer) : new Uint8Array(0)]));
  }

  const directoryOffset = offset;
  const entryOffsets: number[] = [];
  for (const entry of central) {
    entryOffsets.push(offset);
    push(entry);
  }
  const directorySize = offset - directoryOffset;

  if (options.zip64) {
    const recordOffset = offset;
    const record = new DataView(new ArrayBuffer(56));
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, 44n, true);
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(24, BigInt(files.length), true);
    record.setBigUint64(32, BigInt(files.length), true);
    record.setBigUint64(40, BigInt(directorySize), true);
    record.setBigUint64(48, BigInt(directoryOffset), true);
    push(new Uint8Array(record.buffer));
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(recordOffset), true);
    locator.setUint32(16, 1, true);
    push(new Uint8Array(locator.buffer));
  }

  const comment = encoder.encode(options.comment ?? '');
  const eocdOffset = offset;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, options.zip64 ? 0xffff : files.length, true);
  eocd.setUint16(10, options.zip64 ? 0xffff : files.length, true);
  eocd.setUint32(12, options.zip64 ? 0xffffffff : directorySize, true);
  eocd.setUint32(16, options.zip64 ? 0xffffffff : directoryOffset, true);
  eocd.setUint16(20, comment.length, true);
  push(new Uint8Array(eocd.buffer));
  push(comment);

  return { bytes: concat(chunks), directoryOffset, directorySize, eocdOffset, entryOffsets };
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let p = 0;
  for (const chunk of chunks) {
    result.set(chunk, p);
    p += chunk.length;
  }
  return result;
}

/** Copie modifiée d'un zip : entier de 16 ou 32 bits réécrit à une position. */
export function patch(bytes: Uint8Array, offset: number, value: number, width: 16 | 32): Uint8Array {
  const copy = bytes.slice();
  const data = new DataView(copy.buffer);
  if (width === 16) data.setUint16(offset, value, true);
  else data.setUint32(offset, value, true);
  return copy;
}

/** Faux lecteur par plages (GET partiel) sur des objets en mémoire : compte les appels et les octets servis. */
export class FakeRangeReader implements ObjectRangeReader {
  readonly calls: { key: string; start: number; end: number }[] = [];
  bytesServed = 0;
  constructor(
    readonly bucket: string,
    readonly objects: Map<string, Uint8Array>,
  ) {}

  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`objet absent : ${key}`);
    this.calls.push({ key, start, end });
    const bytes = object.slice(start, end + 1);
    this.bytesServed += bytes.length;
    return bytes;
  }
}
