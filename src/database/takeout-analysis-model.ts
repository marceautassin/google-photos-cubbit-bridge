import { DatabaseSync } from 'node:sqlite';
import { normalizeEtag } from '../inventory/duplicates';
import { AnalyzedMedia, ArchiveProof, ArchiveStatus } from '../takeout/takeout-analysis';
import { comparableName } from '../inventory/duplicates';
import { TakeoutDateSource } from '../takeout/media-dating';
import { getDatabase, inTransaction } from './connection';

/** Zip sur lequel porte une analyse : l'analyse ne vaut que pour ces octets (nom, taille, ETag). */
export interface AnalyzedZip {
  name: string;
  size: number;
  etag: string | null;
  verification: string;
}

export interface StoredTakeoutAnalysis {
  exportId: string;
  zips: AnalyzedZip[];
  timeZone: string;
  keptAlbums: string[];
  destinationBucket: string;
  inventoryCompletedAt: string | null;
  analyzedAt: string;
  media: AnalyzedMedia[];
}

interface AnalysisRow {
  export_id: string;
  zips: string;
  time_zone: string;
  destination_bucket: string;
  inventory_completed_at: string | null;
  kept_albums: string;
  analyzed_at: string;
}

interface MediaRow {
  part: string;
  path: string;
  folder: string;
  folder_kind: 'annee' | 'album';
  file_name: string;
  size: number;
  md5: string;
  taken_at: string | null;
  date_source: TakeoutDateSource;
  date_detail: string | null;
  instant: number | null;
  date_warning: string | null;
  metadata_part: string | null;
  metadata_path: string | null;
  companion: string | null;
  duplicate_of_part: string | null;
  duplicate_of_path: string | null;
  archive_status: ArchiveStatus;
  archive_proof: ArchiveProof | null;
  archived_key: string | null;
  archive_candidates: string;
  same_name_and_size: number;
}

/** Albums conservés sous forme comparable (NFC, sans casse), triés : l'ordre et la casse de la configuration ne comptent pas. */
export const normalizedAlbums = (albums: string[]): string[] => [...new Set(albums.map(comparableName))].sort();

const location = (part: string | null, path: string | null): { part: string; path: string } | null =>
  part === null || path === null ? null : { part, path };

/**
 * Analyses d'exports Takeout persistées (story 4.2), une par export, remplacées d'un bloc : jamais d'état intermédiaire.
 */
export class TakeoutAnalysisModel {
  private db: DatabaseSync;

  constructor() {
    this.db = getDatabase();
  }

  replace(analysis: StoredTakeoutAnalysis): void {
    inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM takeout_analyses WHERE export_id = ?').run(analysis.exportId);
      this.db
        .prepare(
          'INSERT INTO takeout_analyses (export_id, zips, time_zone, destination_bucket, inventory_completed_at, kept_albums, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          analysis.exportId, JSON.stringify(analysis.zips), analysis.timeZone, analysis.destinationBucket, analysis.inventoryCompletedAt,
          JSON.stringify(normalizedAlbums(analysis.keptAlbums)), analysis.analyzedAt,
        );
      const insert = this.db.prepare(
        `INSERT INTO takeout_media (export_id, part, path, folder, folder_kind, file_name, size, md5, taken_at, date_source, date_detail,
           instant, date_warning, metadata_part, metadata_path, companion, duplicate_of_part, duplicate_of_path, archive_status,
           archive_proof, archived_key, archive_candidates, same_name_and_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of analysis.media) {
        insert.run(
          analysis.exportId, m.part, m.path, m.folder, m.folderKind, m.fileName, m.size, m.md5, m.takenAt, m.dateSource, m.dateDetail,
          m.instant, m.dateWarning, m.metadata?.part ?? null, m.metadata?.path ?? null, m.companion, m.duplicateOf?.part ?? null,
          m.duplicateOf?.path ?? null, m.archive.status, m.archive.proof, m.archive.key, JSON.stringify(m.archive.candidates), m.archive.sameNameAndSize ? 1 : 0,
        );
      }
    });
  }

  find(exportId: string): StoredTakeoutAnalysis | null {
    const row = this.db.prepare('SELECT * FROM takeout_analyses WHERE export_id = ?').get(exportId) as unknown as AnalysisRow | undefined;
    if (!row) return null;
    const rows = this.db.prepare('SELECT * FROM takeout_media WHERE export_id = ? ORDER BY part, path').all(exportId) as unknown as MediaRow[];
    return {
      exportId: row.export_id,
      zips: JSON.parse(row.zips) as AnalyzedZip[],
      timeZone: row.time_zone,
      keptAlbums: JSON.parse(row.kept_albums) as string[],
      destinationBucket: row.destination_bucket,
      inventoryCompletedAt: row.inventory_completed_at,
      analyzedAt: row.analyzed_at,
      media: rows.map((r) => ({
        part: r.part, path: r.path, folder: r.folder, folderKind: r.folder_kind, fileName: r.file_name, size: r.size, md5: r.md5,
        takenAt: r.taken_at, dateSource: r.date_source, dateDetail: r.date_detail, instant: r.instant, dateWarning: r.date_warning,
        metadata: location(r.metadata_part, r.metadata_path), companion: r.companion, duplicateOf: location(r.duplicate_of_part, r.duplicate_of_path),
        archive: {
          status: r.archive_status, proof: r.archive_proof, key: r.archived_key, candidates: JSON.parse(r.archive_candidates) as string[], sameNameAndSize: r.same_name_and_size === 1,
        },
      })),
    };
  }

  /**
   * Analyse de l'export seulement si elle vaut encore : mêmes zips (nom, taille, ETag), même inventaire du bucket dédié
   * (date de fin), mêmes albums conservés (comparés normalisés) ; `null` sinon (story 4.3).
   */
  findValid(
    exportId: string,
    current: { zips: { name: string; size: number; etag: string | null }[]; inventoryCompletedAt: string | null; keptAlbums: string[] },
  ): StoredTakeoutAnalysis | null {
    const analysis = this.find(exportId);
    const stamp = (list: { name: string; size: number; etag: string | null }[]): string =>
      JSON.stringify([...list].map((z) => [z.name, z.size, normalizeEtag(z.etag)]).sort());
    if (analysis === null) return null;
    const same =
      stamp(analysis.zips) === stamp(current.zips) &&
      analysis.inventoryCompletedAt === current.inventoryCompletedAt &&
      JSON.stringify(analysis.keptAlbums) === JSON.stringify(normalizedAlbums(current.keptAlbums));
    return same ? analysis : null;
  }
}
