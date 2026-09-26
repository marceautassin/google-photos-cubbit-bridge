/**
 * Construit en mémoire un JPEG minimal portant un segment EXIF (APP1), pour tester la lecture EXIF
 * sans fichier binaire versionné ni accès réseau.
 */
export interface ExifDates {
  DateTimeOriginal?: string; // format EXIF « AAAA:MM:JJ HH:MM:SS »
  CreateDate?: string;
  ModifyDate?: string;
  OffsetTimeOriginal?: string; // « +01:00 »
}

const ASCII = 2;
const LONG = 4;

interface Entry {
  tag: number;
  type: number;
  value: string | number;
}

/** Écrit un IFD (petit-boutiste) à `offset` ; les chaînes sont stockées juste après l'IFD. */
function writeIfd(tiff: Buffer, offset: number, entries: Entry[]): number {
  tiff.writeUInt16LE(entries.length, offset);
  let dataOffset = offset + 2 + entries.length * 12 + 4;
  entries.forEach((entry, index) => {
    const at = offset + 2 + index * 12;
    tiff.writeUInt16LE(entry.tag, at);
    tiff.writeUInt16LE(entry.type, at + 2);
    if (typeof entry.value === 'string') {
      const bytes = Buffer.from(`${entry.value}\0`, 'ascii');
      tiff.writeUInt32LE(bytes.length, at + 4);
      tiff.writeUInt32LE(dataOffset, at + 8);
      bytes.copy(tiff, dataOffset);
      dataOffset += bytes.length;
    } else {
      tiff.writeUInt32LE(1, at + 4);
      tiff.writeUInt32LE(entry.value, at + 8);
    }
  });
  tiff.writeUInt32LE(0, offset + 2 + entries.length * 12); // pas d'IFD suivant
  return dataOffset;
}

function tiffBlock(dates: ExifDates, exifIfdOffset?: number): Buffer {
  const tiff = Buffer.alloc(Math.max(512, (exifIfdOffset ?? 0) + 512));
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);

  const ifd0: Entry[] = [];
  if (dates.ModifyDate) ifd0.push({ tag: 0x0132, type: ASCII, value: dates.ModifyDate });
  const exif: Entry[] = [];
  if (dates.DateTimeOriginal) exif.push({ tag: 0x9003, type: ASCII, value: dates.DateTimeOriginal });
  if (dates.CreateDate) exif.push({ tag: 0x9004, type: ASCII, value: dates.CreateDate });
  if (dates.OffsetTimeOriginal) exif.push({ tag: 0x9011, type: ASCII, value: dates.OffsetTimeOriginal });

  // Taille de l'IFD0 connue d'avance : pointeur vers le sous-IFD Exif placé après ses données.
  const ifd0Entries: Entry[] = [...ifd0, { tag: 0x8769, type: LONG, value: 0 }];
  const ifd0DataEnd = 8 + 2 + ifd0Entries.length * 12 + 4 + (dates.ModifyDate ? dates.ModifyDate.length + 1 : 0);
  const exifOffset = exifIfdOffset ?? ifd0DataEnd;
  ifd0Entries[ifd0Entries.length - 1] = { tag: 0x8769, type: LONG, value: exifOffset };
  writeIfd(tiff, 8, ifd0Entries);
  const end = writeIfd(tiff, exifOffset, exif);
  return tiff.subarray(0, end);
}

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * JPEG : SOI, `paddingBytes` octets de segments APP2 de remplissage (pour repousser l'EXIF), APP1 Exif, EOI.
 * Sans `dates`, aucun segment EXIF n'est écrit.
 */
export function buildJpeg(dates?: ExifDates, paddingBytes = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let remaining = paddingBytes;
  while (remaining > 0) {
    const size = Math.min(remaining, 60000);
    parts.push(segment(0xffe2, Buffer.alloc(size, 0x20)));
    remaining -= size;
  }
  if (dates) parts.push(segment(0xffe1, Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiffBlock(dates)])));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/**
 * Fichier TIFF brut : `ModifyDate` en tête (IFD0), sous-IFD Exif (`DateTimeOriginal`, `CreateDate`) placé à
 * `exifIfdOffset` octets — pour simuler un champ prioritaire situé au-delà de la première plage lue.
 */
export function buildTiff(dates: ExifDates, exifIfdOffset: number): Buffer {
  return tiffBlock(dates, exifIfdOffset);
}
