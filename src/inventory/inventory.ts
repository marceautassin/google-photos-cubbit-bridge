import * as path from 'path';
import { BucketLister, BucketObject } from '../clients/types';
import { isSupportedFormat } from '../utils/file-utils';

/** Libellé des objets situés à la racine du bucket. */
export const ROOT_LOCATION = '(racine)';

export interface MediaLocation {
  location: string;
  mediaCount: number;
  mediaSize: number;
}

export interface InventorySummary {
  objectCount: number;
  totalSize: number;
  mediaCount: number;
  mediaSize: number;
  locations: MediaLocation[]; // triés par volume décroissant
  unrecognizedExtensions: { extension: string; count: number }[]; // triés par nombre décroissant
}

/**
 * Liste l'intégralité du bucket, page par page, sans aucun préfixe.
 * Rien n'est persisté ici : en cas d'interruption, l'erreur remonte et aucun état partiel n'existe.
 */
export async function scanBucket(
  lister: BucketLister,
  onProgress?: (listedCount: number) => void,
): Promise<BucketObject[]> {
  const objects: BucketObject[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;
  for (;;) {
    const page = await lister.listPage(token);
    for (const object of page.objects) objects.push(object);
    onProgress?.(objects.length);

    if (!page.isTruncated) return objects;
    // Garde-fous : un listing qui ne peut pas aboutir proprement ne doit jamais passer pour complet.
    if (!page.nextToken) {
      throw new Error('Listing incohérent : page tronquée sans jeton de continuation');
    }
    if (seenTokens.has(page.nextToken)) {
      throw new Error('Listing incohérent : jeton de continuation déjà reçu (boucle)');
    }
    seenTokens.add(page.nextToken);
    token = page.nextToken;
  }
}

/**
 * Emplacement d'un objet : son dossier, tronqué aux `depth` premiers segments.
 */
export function locationOf(key: string, depth: number): string {
  const segments = key.split('/').slice(0, -1);
  return segments.length === 0 ? ROOT_LOCATION : `${segments.slice(0, depth).join('/')}/`;
}

/**
 * Regroupe les médias par emplacement, quel que soit le préfixe, et signale les extensions non reconnues.
 */
export function summarizeInventory(
  objects: BucketObject[],
  supportedFormats: string[],
  depth: number,
): InventorySummary {
  const locations = new Map<string, MediaLocation>();
  const unrecognized = new Map<string, number>();
  let totalSize = 0;
  let mediaCount = 0;
  let mediaSize = 0;

  for (const object of objects) {
    totalSize += object.size;

    if (!isSupportedFormat(object.key, supportedFormats)) {
      const extension = path.extname(object.key).toLowerCase();
      if (extension) unrecognized.set(extension, (unrecognized.get(extension) ?? 0) + 1);
      continue;
    }

    mediaCount++;
    mediaSize += object.size;
    const location = locationOf(object.key, depth);
    const entry = locations.get(location) ?? { location, mediaCount: 0, mediaSize: 0 };
    entry.mediaCount++;
    entry.mediaSize += object.size;
    locations.set(location, entry);
  }

  return {
    objectCount: objects.length,
    totalSize,
    mediaCount,
    mediaSize,
    locations: [...locations.values()].sort((a, b) => b.mediaSize - a.mediaSize),
    unrecognizedExtensions: [...unrecognized.entries()]
      .map(([extension, count]) => ({ extension, count }))
      .sort((a, b) => b.count - a.count),
  };
}
