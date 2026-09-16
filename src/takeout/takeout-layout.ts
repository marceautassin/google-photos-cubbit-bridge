import { isSupportedFormat } from '../utils/file-utils';

/**
 * Reconnaissance du format réel des exports Google Takeout (story 4.1) : où sont les médias, leurs métadonnées et les
 * métadonnées d'album, dans le chemin d'une entrée de zip. Fonctions pures. Format décrit dans docs/TAKEOUT_STRUCTURE.md.
 */

/** Racine des photos dans un export, sous forme comparable. */
export const GOOGLE_PHOTOS_ROOT = 'Takeout/Google Photos/';

/**
 * Forme comparable d'un nom : NFC, et espaces Unicode (insécable U+00A0, fine U+202F, tabulaire U+2007) ramenées à
 * l'espace normal. Google écrit `Google\u00a0Photos` et `Photos de\u00a02020`. Sert aussi à l'affichage.
 */
export const comparableName = (name: string): string => name.normalize('NFC').replace(/[\u00a0\u2007\u202f]/g, ' ');

/** Dossier d'année (`Photos de 2020`, `Photos from 2020`), sinon dossier d'album. */
const YEAR_FOLDER = /^Photos (?:de|from) (\d{4})$/;
/** Métadonnées d'un dossier d'album (export français, anglais). */
const ALBUM_METADATA_NAMES = new Set(['métadonnées.json', 'metadata.json']);

export type FolderKind = { kind: 'annee'; year: number } | { kind: 'album' };

export function folderKind(folder: string): FolderKind {
  const year = YEAR_FOLDER.exec(comparableName(folder));
  return year ? { kind: 'annee', year: Number(year[1]) } : { kind: 'album' };
}

export type EntryClass =
  | { kind: 'repertoire' }
  | { kind: 'media'; folder: string; fileName: string }
  | { kind: 'json'; folder: string; fileName: string } // métadonnées de média présumées, à apparier
  | { kind: 'metadonnees_album'; folder: string }
  | { kind: 'non_reconnu'; reason: string; folder?: string; fileName?: string }; // dossier connu si le fichier y est

/** Classe une entrée de zip d'après son chemin. `folder` et `fileName` sont sous forme comparable. */
export function classifyEntry(path: string, supportedFormats: string[]): EntryClass {
  const comparable = comparableName(path);
  if (comparable.endsWith('/')) return { kind: 'repertoire' };
  if (!comparable.startsWith(GOOGLE_PHOTOS_ROOT)) return { kind: 'non_reconnu', reason: `hors de ${GOOGLE_PHOTOS_ROOT}` };
  const segments = comparable.slice(GOOGLE_PHOTOS_ROOT.length).split('/');
  if (segments.length === 1) return { kind: 'non_reconnu', reason: `fichier à la racine de ${GOOGLE_PHOTOS_ROOT}` };
  if (segments.length > 2) return { kind: 'non_reconnu', reason: 'sous-dossier inattendu dans un dossier d\'année ou d\'album' };
  const [folder, fileName] = segments as [string, string];
  if (ALBUM_METADATA_NAMES.has(fileName.toLowerCase())) return { kind: 'metadonnees_album', folder };
  if (isSupportedFormat(fileName, supportedFormats)) return { kind: 'media', folder, fileName };
  if (fileName.toLowerCase().endsWith('.json')) return { kind: 'json', folder, fileName };
  return { kind: 'non_reconnu', reason: 'extension non prise en charge (sync.supportedFormats)', folder, fileName };
}

/** Suffixe ajouté par Google au nom du média pour nommer ses métadonnées, avant `.json`. */
const METADATA_SUFFIX = '.supplemental-metadata';
/** Suffixe de doublon avant l'extension : `IMG_1234(1).jpg`. Non observé sur les exports réels, pris en compte par précaution. */
const NAME_DUPLICATE = /^(.*)\((\d+)\)(\.[^.]*)?$/;
/** Suffixe de doublon en fin de radical de JSON : `IMG_1234.jpg.supplemental-metadata(1)`. Non observé, par précaution. */
const JSON_DUPLICATE = /^(.*)\((\d+)\)$/;
/** Vidéos d'une Live Photo : `X.MP4` accompagnant `X.JPG`. */
const LIVE_PHOTO_VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);
/** Seuls ces formats d'image produisent des Live Photos (Apple, Google Motion Photos exportées). */
const LIVE_PHOTO_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'heic', 'heif']);

interface NameKey {
  base: string;
  index: number; // numéro de doublon, 0 sans suffixe
}

/** Clés d'un nom : tel quel, et sans son suffixe de doublon s'il en a un. */
function nameKeys(name: string): NameKey[] {
  const duplicate = NAME_DUPLICATE.exec(name);
  const keys = [{ base: name, index: 0 }];
  if (duplicate) keys.push({ base: `${duplicate[1]}${duplicate[3] ?? ''}`, index: Number(duplicate[2]) });
  return keys;
}

/** Clé d'un JSON : radical sans `.json`, suffixe de doublon final extrait ; `null` si ce n'est pas un `.json`. */
function jsonKey(name: string): NameKey | null {
  if (!name.toLowerCase().endsWith('.json')) return null;
  const stem = name.slice(0, -'.json'.length);
  const duplicate = JSON_DUPLICATE.exec(stem);
  return duplicate ? { base: duplicate[1]!, index: Number(duplicate[2]) } : { base: stem, index: 0 };
}

const withoutExtension = (name: string): string => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);
const extensionOf = (name: string): string => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/**
 * Le JSON désigne-t-il ce média par son nom complet ? Radical égal au nom du média (ancien format `<média>.json`), ou
 * commençant par `<média>.` et début de `<média>.supplemental-metadata` (forme complète ; troncature du seul suffixe
 * tolérée). Même numéro de doublon. La troncature du nom du média lui-même n'est pas gérée (non observée : noms jusqu'à
 * 131 caractères sur les exports réels, et source de faux appariements).
 */
export function metadataMatch(jsonName: string, mediaName: string): boolean {
  const json = jsonKey(jsonName);
  if (json === null) return false;
  return nameKeys(mediaName).some(
    (media) =>
      media.index === json.index &&
      (json.base === media.base || (json.base.startsWith(`${media.base}.`) && `${media.base}${METADATA_SUFFIX}`.startsWith(json.base))),
  );
}

/**
 * Radical d'un JSON sans extension de média (`<radical>.supplemental-metadata.json`, observé pour des noms UUID) : forme
 * complète exigée ; `null` sinon.
 */
function extensionlessTarget(jsonName: string): NameKey | null {
  const json = jsonKey(jsonName);
  if (json === null || !json.base.endsWith(METADATA_SUFFIX)) return null;
  const base = json.base.slice(0, -METADATA_SUFFIX.length);
  return base === '' ? null : { base, index: json.index };
}

/** Le fichier porte-t-il ce radical (nom sans extension, doublon pris en compte) ? */
const hasRadical = (fileName: string, target: NameKey): boolean =>
  nameKeys(fileName).some((key) => key.index === target.index && withoutExtension(key.base) === target.base);

export type PairingQuality = 'complet' | 'sans_extension';

export interface MetadataPairing {
  pairs: Map<string, { json: string; quality: PairingQuality }>; // nom du média → JSON apparié
  unpairedJson: string[]; // JSON qui ne désignent aucun média
  ambiguousJson: string[]; // JSON qui désignent plusieurs fichiers : jamais appariés
}

/**
 * Apparie un pour un les médias et les JSON d'un même dossier, toutes parties confondues. `allFileNames` : tous les
 * fichiers du dossier (médias, JSON, non reconnus), pour l'unicité du dernier recours.
 * 1. Nom complet du média (`metadataMatch`) ; les JSON les plus longs d'abord : si deux JSON visent le même média, le
 *    second reste seul. Un JSON qui désigne plusieurs médias est ambigu.
 * 2. Dernier recours, JSON sans extension de média : le radical doit être porté par exactement un fichier du dossier,
 *    tous fichiers comptés, et ce fichier doit être un média encore sans métadonnées ; sinon le JSON est ambigu.
 */
export function pairMetadata(mediaNames: string[], jsonNames: string[], allFileNames: string[]): MetadataPairing {
  const pairs: MetadataPairing['pairs'] = new Map();
  const unpairedJson: string[] = [];
  const ambiguousJson: string[] = [];
  const remaining: string[] = [];
  for (const json of [...jsonNames].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    const matches = mediaNames.filter((media) => metadataMatch(json, media));
    if (matches.length > 1) ambiguousJson.push(json);
    else if (matches.length === 1 && !pairs.has(matches[0]!)) pairs.set(matches[0]!, { json, quality: 'complet' });
    else if (matches.length === 1) unpairedJson.push(json);
    else remaining.push(json);
  }
  const mediaSet = new Set(mediaNames);
  for (const json of remaining) {
    const target = extensionlessTarget(json);
    const holders = target === null ? [] : allFileNames.filter((name) => hasRadical(name, target));
    if (holders.length === 0) unpairedJson.push(json);
    else if (holders.length === 1 && mediaSet.has(holders[0]!) && !pairs.has(holders[0]!)) {
      pairs.set(holders[0]!, { json, quality: 'sans_extension' });
    } else ambiguousJson.push(json);
  }
  return { pairs, unpairedJson: unpairedJson.sort(), ambiguousJson: ambiguousJson.sort() };
}

/**
 * Vidéo d'une Live Photo : une vidéo (`.mp4`, `.mov`) sans métadonnées dont le radical (nom sans extension) est porté par
 * exactement un autre fichier du dossier, tous fichiers comptés, et ce fichier est une image appariée (jpg, jpeg, heic, heif). Renvoie le nom de
 * l'image compagnon, `null` sinon. La vidéo n'est pas appariée au JSON de l'image : la décision de date revient à 4.2.
 */
export function livePhotoCompanion(videoName: string, allFileNames: string[], pairedMedia: ReadonlySet<string>): string | null {
  if (!LIVE_PHOTO_VIDEO_EXTENSIONS.has(extensionOf(videoName)) || pairedMedia.has(videoName)) return null;
  const radical = withoutExtension(videoName);
  const others = allFileNames.filter((name) => name !== videoName && withoutExtension(name) === radical);
  const image = others.length === 1 ? others[0]! : null;
  return image !== null && pairedMedia.has(image) && LIVE_PHOTO_IMAGE_EXTENSIONS.has(extensionOf(image)) ? image : null;
}
