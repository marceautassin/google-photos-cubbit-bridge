import { classifyEntry, comparableName, folderKind, GOOGLE_PHOTOS_ROOT, livePhotoCompanion, pairMetadata, PairingQuality } from './takeout-layout';
import { countingSource, readZipDirectory, ZipSource } from './zip-directory';

/**
 * Validation d'un export Takeout avant traitement (story 4.1) : regroupement des parties, lecture de leur table des
 * matières, reconnaissance des médias et de leurs métadonnées, verdict. Rien n'est écrit nulle part.
 */

/** Nom d'une partie d'export : `takeout-<horodatage>-<n>-<nnn>.zip`. */
const PART_NAME = /^takeout-(\d{8}T\d{6}Z-\d+)-(\d{3})\.zip$/i;

/** Zip à valider : nom de fichier, emplacement affiché, taille, et accès par plages. */
export interface ZipRef {
  name: string;
  location: string;
  size: number;
  open(): Promise<ZipSource>;
}

export interface ExportGroup {
  id: string; // `<horodatage>-<n>`, ou nom du zip s'il ne suit pas la convention de Google
  parts: { number: number; zip: ZipRef }[]; // triées par numéro
}

/** Regroupe les zips par export. Un zip au nom non conforme forme un export à lui seul (partie 1). */
export function groupExports(zips: ZipRef[]): ExportGroup[] {
  const groups = new Map<string, ExportGroup>();
  for (const zip of zips) {
    const match = PART_NAME.exec(zip.name);
    const id = match ? match[1]! : zip.name;
    const group = groups.get(id) ?? { id, parts: [] };
    group.parts.push({ number: match ? Number(match[2]) : 1, zip });
    groups.set(id, group);
  }
  for (const group of groups.values()) group.parts.sort((a, b) => a.number - b.number || a.zip.location.localeCompare(b.zip.location));
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface PartReport {
  number: number;
  name: string;
  location: string;
  size: number;
  entryCount: number | null; // null si illisible
  mediaCount: number;
  bytesRead: number;
  zip64: boolean;
  error: string | null;
}

/** Emplacement d'un fichier dans l'export : partie et chemin exact dans le zip. */
export interface ZipLocation {
  part: string;
  path: string;
}

export interface MediaReport extends ZipLocation {
  folder: string; // forme comparable
  fileName: string; // forme comparable
  size: number; // décompressée
  metadata: (ZipLocation & { quality: PairingQuality }) | null;
  /** Vidéo de Live Photo sans métadonnées : nom de l'image compagnon (sa date relève de la story 4.2). */
  companion: string | null;
}

export interface FolderReport {
  name: string;
  kind: 'annee' | 'album';
  year: number | null;
  mediaCount: number;
  mediaSize: number;
  albumMetadata: boolean;
  withoutMetadata: string[]; // vrais orphelins : ni métadonnées, ni image compagnon
  livePhotoVideos: { video: string; image: string }[];
}

export interface ExportReport {
  id: string;
  parts: PartReport[];
  folders: FolderReport[]; // années croissantes, puis albums par nom
  media: MediaReport[];
  unrecognized: (ZipLocation & { reason: string })[];
  problems: string[]; // raisons rendant l'export non exploitable
  warnings: string[]; // signaux à vérifier, sans bloquer
  /** Nombre de parties confirmé par `--parties` ; `false` : non confirmé (exigé par l'attestation, story 4.5). */
  partCountConfirmed: boolean;
  exploitable: boolean;
}

interface FolderContent {
  media: Map<string, MediaReport>;
  json: Map<string, ZipLocation>;
  files: string[]; // tous les fichiers du dossier, y compris non reconnus
  albumMetadata: boolean;
}

/** Une dernière partie au moins à ce ratio de la plus grosse est « de taille pleine » : une suivante peut manquer. */
const FULL_PART_RATIO = 0.9;

const partLabel = (n: number): string => String(n).padStart(3, '0');

export async function analyzeExport(group: ExportGroup, supportedFormats: string[], expectedParts?: number): Promise<ExportReport> {
  const parts: PartReport[] = [];
  const folders = new Map<string, FolderContent>();
  const unrecognized: ExportReport['unrecognized'] = [];
  const seenPaths = new Map<string, number>();
  const folderOf = (name: string): FolderContent => {
    const folder = folders.get(name) ?? { media: new Map(), json: new Map(), files: [], albumMetadata: false };
    folders.set(name, folder);
    return folder;
  };

  for (const { number, zip } of group.parts) {
    const report: PartReport = {
      number, name: zip.name, location: zip.location, size: zip.size, entryCount: null, mediaCount: 0, bytesRead: 0, zip64: false, error: null,
    };
    parts.push(report);
    let counter: ReturnType<typeof countingSource> | null = null;
    try {
      counter = countingSource(await zip.open());
      const directory = await readZipDirectory(counter.source);
      Object.assign(report, { entryCount: directory.entries.length, zip64: directory.zip64 });
      for (const entry of directory.entries) {
        const location = { part: zip.name, path: entry.name };
        const entryClass = classifyEntry(entry.name, supportedFormats);
        if (entryClass.kind === 'repertoire') continue;
        const comparable = comparableName(entry.name);
        seenPaths.set(comparable, (seenPaths.get(comparable) ?? 0) + 1);
        if (entryClass.kind === 'non_reconnu') {
          unrecognized.push({ ...location, reason: entryClass.reason });
          if (entryClass.folder !== undefined && entryClass.fileName !== undefined) folderOf(entryClass.folder).files.push(entryClass.fileName);
          continue;
        }
        const folder = folderOf(entryClass.folder);
        if (entryClass.kind === 'metadonnees_album') {
          folder.albumMetadata = true;
          continue;
        }
        folder.files.push(entryClass.fileName);
        if (entryClass.kind === 'media') {
          report.mediaCount++;
          folder.media.set(entryClass.fileName, {
            ...location, folder: entryClass.folder, fileName: entryClass.fileName, size: entry.size, metadata: null, companion: null,
          });
        } else folder.json.set(entryClass.fileName, location);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      report.error = counter === null ? `ouverture impossible : ${reason}` : reason;
    }
    report.bytesRead = counter?.bytesRead() ?? 0;
  }

  const media: MediaReport[] = [];
  const folderReports: FolderReport[] = [];
  const ambiguous: string[] = [];
  let orphanJsonCount = 0;
  for (const [name, content] of folders) {
    const { pairs, unpairedJson, ambiguousJson } = pairMetadata([...content.media.keys()], [...content.json.keys()], content.files);
    for (const json of unpairedJson) unrecognized.push({ ...content.json.get(json)!, reason: 'métadonnées sans média correspondant' });
    for (const json of ambiguousJson) {
      unrecognized.push({ ...content.json.get(json)!, reason: 'JSON ambigu : plusieurs fichiers portent ce nom' });
      ambiguous.push(`${name}/${json}`);
    }
    orphanJsonCount += unpairedJson.length;
    const paired = new Set(pairs.keys());
    const folderMedia = [...content.media.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
    for (const item of folderMedia) {
      const pair = pairs.get(item.fileName);
      item.metadata = pair === undefined ? null : { ...content.json.get(pair.json)!, quality: pair.quality };
      item.companion = pair === undefined ? livePhotoCompanion(item.fileName, content.files, paired) : null;
      media.push(item);
    }
    if (folderMedia.length === 0 && !content.albumMetadata) continue; // dossier sans média : ses fichiers sont déjà listés
    const kind = folderKind(name);
    folderReports.push({
      name,
      kind: kind.kind,
      year: kind.kind === 'annee' ? kind.year : null,
      mediaCount: folderMedia.length,
      mediaSize: folderMedia.reduce((sum, item) => sum + item.size, 0),
      albumMetadata: content.albumMetadata,
      withoutMetadata: folderMedia.filter((item) => item.metadata === null && item.companion === null).map((item) => item.fileName),
      livePhotoVideos: folderMedia.filter((item) => item.companion !== null).map((item) => ({ video: item.fileName, image: item.companion! })),
    });
  }
  folderReports.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.name.localeCompare(b.name, 'fr'));
  unrecognized.sort((a, b) => a.part.localeCompare(b.part) || a.path.localeCompare(b.path));

  const problems = [
    ...parts.filter((p) => p.error !== null).map((p) => `partie ${p.name} illisible : ${p.error}`),
    ...parts.filter((p) => p.entryCount === 0).map((p) => `partie ${p.name} sans aucune entrée`),
    ...parts.filter((p) => p.entryCount !== null && p.entryCount > 0 && p.mediaCount === 0).map((p) => `partie ${p.name} sans aucun média`),
    ...missingParts(group),
    ...(expectedParts !== undefined && expectedParts !== group.parts.length
      ? [`${group.parts.length} partie(s) présente(s), ${expectedParts} attendue(s) (--parties)`]
      : []),
    ...[...seenPaths].filter(([, count]) => count > 1).map(([path, count]) => `chemin présent ${count} fois dans l'export : ${path}`),
    ...ambiguous.map((json) => `JSON ambigu (plusieurs fichiers portent ce nom) : ${json}`),
  ];
  if (media.length === 0) problems.push(`aucun média reconnu sous ${GOOGLE_PHOTOS_ROOT}`);

  const warnings: string[] = [];
  if (orphanJsonCount > 0) {
    warnings.push(`${orphanJsonCount} JSON sans média correspondant : partie possiblement manquante (son média serait dans une autre partie)`);
  }
  const largest = Math.max(...group.parts.map((p) => p.zip.size));
  const last = group.parts[group.parts.length - 1]!;
  if (group.parts.length > 1 && last.zip.size >= FULL_PART_RATIO * largest) {
    warnings.push(`la dernière partie (${partLabel(last.number)}) est de taille pleine : une partie suivante peut manquer`);
  }
  return {
    id: group.id, parts, folders: folderReports, media, unrecognized, problems, warnings,
    partCountConfirmed: expectedParts !== undefined && expectedParts === group.parts.length,
    exploitable: problems.length === 0,
  };
}

/** Numéros de parties absents entre 1 et le plus grand numéro présent. Une dernière partie absente est indétectable ici. */
function missingParts(group: ExportGroup): string[] {
  const numbers = new Set(group.parts.map((p) => p.number));
  const max = Math.max(...numbers);
  const missing = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !numbers.has(n));
  const duplicated = group.parts.filter((p, i) => group.parts.findIndex((q) => q.number === p.number) !== i);
  return [
    ...(missing.length > 0 ? [`partie(s) manquante(s) : ${missing.map(partLabel).join(', ')}`] : []),
    ...duplicated.map((p) => `partie ${partLabel(p.number)} présente plusieurs fois (${p.zip.location})`),
  ];
}
