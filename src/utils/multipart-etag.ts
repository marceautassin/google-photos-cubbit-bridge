import * as crypto from 'crypto';

/**
 * Recalcul local d'un ETag S3 multipart (`<md5 des md5 des parties>-N`), en une passe sur le contenu (story 4.2) : sert à
 * vérifier un zip téléchargé et à confirmer qu'un média est identique à un objet archivé déposé en plusieurs parties.
 * S3 ne conserve pas la taille des parties : on essaie les tailles plausibles qui donnent exactement N parties, les
 * tailles usuelles des outils d'envoi d'abord, puis les parties égales, puis les autres multiples entiers de Mio et de Mo.
 */

export const MIB = 1024 * 1024;
export const MB = 1000 * 1000;
/** Tailles de partie usuelles (en Mio ou en Mo), essayées en premier. */
const USUAL_PART_SIZES = [5, 8, 10, 15, 16, 32, 50, 64, 100];
/** Au plus ce nombre de tailles essayées (coût : un MD5 du contenu par taille). */
export const MAX_PART_SIZE_CANDIDATES = 8;

/** Nombre de parties d'un ETag multipart normalisé (`<32 hex>-N`), `null` sinon. */
export function multipartPartCount(etag: string | null): number | null {
  const match = /^[0-9a-f]{32}-(\d+)$/.exec(etag ?? '');
  return match ? Number(match[1]) : null;
}

/** Tailles de partie plausibles donnant exactement `parts` parties pour `size` octets, par ordre de préférence. */
export function multipartPartSizes(size: number, parts: number): number[] {
  if (!Number.isInteger(parts) || parts < 1 || size <= 0) return [];
  if (parts === 1) return [size];
  const fits = (partSize: number): boolean => partSize > 0 && Math.ceil(size / partSize) === parts;
  const ordered = [
    ...USUAL_PART_SIZES.flatMap((value) => [value * MIB, value * MB]),
    Math.ceil(size / parts),
  ];
  const candidates = [...new Set(ordered.filter(fits))];
  for (const unit of [MIB, MB]) {
    for (let k = Math.max(1, Math.ceil(size / parts / unit)); k * unit * (parts - 1) < size && candidates.length < MAX_PART_SIZE_CANDIDATES; k++) {
      if (fits(k * unit) && !candidates.includes(k * unit)) candidates.push(k * unit);
    }
  }
  return candidates.slice(0, MAX_PART_SIZE_CANDIDATES);
}

/** MD5 par parties de taille fixe. */
class PartHasher {
  private current = crypto.createHash('md5');
  private filled = 0;
  private readonly digests: Buffer[] = [];
  private result: string | null = null;
  constructor(readonly partSize: number) {}

  update(chunk: Uint8Array): void {
    for (let offset = 0; offset < chunk.length; ) {
      const take = Math.min(this.partSize - this.filled, chunk.length - offset);
      this.current.update(chunk.subarray(offset, offset + take));
      this.filled += take;
      offset += take;
      if (this.filled === this.partSize) {
        this.digests.push(this.current.digest());
        this.current = crypto.createHash('md5');
        this.filled = 0;
      }
    }
  }

  etag(): string {
    if (this.result === null) {
      const digests = this.filled > 0 ? [...this.digests, this.current.digest()] : this.digests;
      this.result = `${crypto.createHash('md5').update(Buffer.concat(digests)).digest('hex')}-${digests.length}`;
    }
    return this.result;
  }
}

/**
 * ETag multipart réellement produit pour `body` déposé en une passe, en parties de `partSize` octets **connue**
 * (jamais devinée) — story 4.3, correction : sert à vérifier notre propre dépôt (`archive-execution.ts`), dont la
 * taille de partie est celle que nous avons choisie (`UPLOAD_PART_SIZE_BYTES` par défaut). À ne pas confondre avec
 * `MultipartEtagHasher`, qui essaie plusieurs tailles plausibles quand la taille de partie d'un objet tiers (déposé
 * par un autre outil) est inconnue.
 */
export function computeMultipartEtag(body: Uint8Array, partSize: number): string {
  const hasher = new PartHasher(partSize);
  hasher.update(body);
  return hasher.etag();
}

/** Recalcule un ETag multipart attendu pour chaque taille de partie plausible. */
export class MultipartEtagHasher {
  private readonly hashers: PartHasher[];
  /** @param expected ETag multipart normalisé ; @param size taille du contenu */
  constructor(
    readonly expected: string,
    size: number,
  ) {
    const parts = multipartPartCount(expected);
    this.hashers = parts === null ? [] : multipartPartSizes(size, parts).map((p) => new PartHasher(p));
  }

  /** Tailles de partie essayées. */
  get partSizes(): number[] {
    return this.hashers.map((h) => h.partSize);
  }

  update(chunk: Uint8Array): void {
    for (const hasher of this.hashers) hasher.update(chunk);
  }

  /** Taille de partie dont l'ETag recalculé égale l'ETag attendu, `null` si aucune. À appeler après le dernier morceau. */
  matchingPartSize(): number | null {
    return this.hashers.find((h) => h.etag() === this.expected)?.partSize ?? null;
  }
}

/** Libellé lisible d'une taille de partie (`5 Mio`, `5 Mo`, ou en octets). */
export function partSizeLabel(partSize: number): string {
  if (partSize % MIB === 0) return `${partSize / MIB} Mio`;
  if (partSize % MB === 0) return `${partSize / MB} Mo`;
  return `${partSize} octets`;
}
