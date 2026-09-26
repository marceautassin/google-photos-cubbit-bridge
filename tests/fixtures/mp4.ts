/**
 * Vidéo MP4 minimale construite en mémoire (story 4.2) : `ftyp`, `mdat`, `moov` contenant `mvhd`, dans l'ordre voulu.
 */
const QUICKTIME_EPOCH_OFFSET = 2_082_844_800;

function box(type: string, content: Buffer, largeSize = false): Buffer {
  if (largeSize) {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write(type, 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + content.length), 8);
    return Buffer.concat([header, content]);
  }
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

export interface Mp4Options {
  creationUnix?: number | null; // null : champ à 0
  version?: 0 | 1;
  moovFirst?: boolean;
  mdatBytes?: number;
  withoutMvhd?: boolean;
  largeMdat?: boolean;
}

export function buildMp4(options: Mp4Options = {}): Buffer {
  const version = options.version ?? 0;
  const seconds = options.creationUnix === null || options.creationUnix === undefined ? 0 : options.creationUnix + QUICKTIME_EPOCH_OFFSET;
  const mvhd = Buffer.alloc(version === 1 ? 112 : 100);
  mvhd[0] = version;
  if (version === 1) mvhd.writeBigUInt64BE(BigInt(seconds), 4);
  else mvhd.writeUInt32BE(seconds, 4);
  const moov = box('moov', Buffer.concat([box('udta', Buffer.alloc(12)), ...(options.withoutMvhd ? [] : [box('mvhd', mvhd)]), box('trak', Buffer.alloc(40))]));
  const ftyp = box('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(options.mdatBytes ?? 5000, 7), options.largeMdat);
  return Buffer.concat(options.moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}
