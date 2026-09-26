/**
 * Date de création QuickTime / MP4 (boîte `mvhd`, ISO/IEC 14496-12 §8.2.2), lue en flux (story 4.2) : date des vidéos
 * de Live Photo, qui n'ont pas de métadonnées Takeout propres. Les boîtes de premier niveau sont parcourues sans mémoire
 * (`mdat` sauté octet à octet), seule `moov` est conservée, puis `mvhd` y est cherchée parmi ses enfants directs.
 * Les vidéos Apple écrivent cet instant en UTC.
 */

/** Secondes entre le 1904-01-01 (époque QuickTime) et le 1970-01-01 (époque Unix). */
const QUICKTIME_EPOCH_OFFSET = 2_082_844_800;
/** Plafond de la boîte `moov` gardée en mémoire. */
const MAX_MOOV_SIZE = 64 * 1024 * 1024;

type State =
  | { kind: 'header'; bytes: Buffer } // lecture d'un en-tête de boîte (8 ou 16 octets)
  | { kind: 'skip'; remaining: number } // contenu d'une boîte ignorée
  | { kind: 'moov'; remaining: number; chunks: Buffer[] }
  | { kind: 'done' };

export class Mp4CreationTimeProbe {
  private state: State = { kind: 'header', bytes: Buffer.alloc(0) };
  private creation: number | null = null;

  /** Transmet le morceau suivant du fichier. */
  push(chunk: Uint8Array): void {
    let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (data.length > 0 && this.state.kind !== 'done') {
      const state = this.state;
      if (state.kind === 'skip' || state.kind === 'moov') {
        const take = Math.min(state.remaining, data.length);
        if (state.kind === 'moov') state.chunks.push(data.subarray(0, take));
        state.remaining -= take;
        data = data.subarray(take);
        if (state.remaining === 0) this.endBox(state);
        continue;
      }
      if (state.kind !== 'header') return;
      const bytes = Buffer.concat([state.bytes, data]);
      const needed = bytes.length >= 8 && bytes.readUInt32BE(0) === 1 ? 16 : 8;
      if (bytes.length < needed) {
        this.state = { kind: 'header', bytes };
        return;
      }
      data = bytes.subarray(needed);
      const size32 = bytes.readUInt32BE(0);
      const type = bytes.toString('latin1', 4, 8);
      const size = size32 === 1 ? Number(bytes.readBigUInt64BE(8)) : size32;
      if (size32 === 0) {
        // Boîte jusqu'à la fin du fichier : `moov` ne peut plus suivre.
        this.state = type === 'moov' ? { kind: 'moov', remaining: MAX_MOOV_SIZE, chunks: [] } : { kind: 'done' };
        continue;
      }
      if (size < needed || !Number.isSafeInteger(size)) {
        this.state = { kind: 'done' }; // structure illisible : pas de date
        continue;
      }
      const content = size - needed;
      if (type === 'moov' && content > MAX_MOOV_SIZE) this.state = { kind: 'done' };
      else if (type === 'moov') this.state = { kind: 'moov', remaining: content, chunks: [] };
      else this.state = { kind: 'skip', remaining: content };
      if (content === 0 && this.state.kind !== 'done') this.endBox(this.state);
    }
  }

  private endBox(state: State): void {
    if (state.kind === 'moov') {
      this.creation = findMvhdCreation(Buffer.concat(state.chunks));
      this.state = { kind: 'done' };
    } else {
      this.state = { kind: 'header', bytes: Buffer.alloc(0) };
    }
  }

  /** Instant de création (secondes Unix, UTC), `null` si absent, nul ou illisible. */
  result(): number | null {
    const state = this.state;
    if (state.kind === 'moov' && this.creation === null) this.creation = findMvhdCreation(Buffer.concat(state.chunks));
    return this.creation;
  }
}

/** `mvhd` parmi les enfants directs du contenu de `moov` : version 0 (32 bits) ou 1 (64 bits). */
function findMvhdCreation(moov: Buffer): number | null {
  for (let p = 0; p + 8 <= moov.length; ) {
    const size = moov.readUInt32BE(p);
    const type = moov.toString('latin1', p + 4, p + 8);
    if (type === 'mvhd') {
      const version = moov[p + 8];
      const seconds =
        version === 1 && p + 20 <= moov.length ? Number(moov.readBigUInt64BE(p + 12)) : version === 0 && p + 16 <= moov.length ? moov.readUInt32BE(p + 12) : 0;
      return seconds > 0 ? seconds - QUICKTIME_EPOCH_OFFSET : null;
    }
    if (size < 8) return null;
    p += size;
  }
  return null;
}
