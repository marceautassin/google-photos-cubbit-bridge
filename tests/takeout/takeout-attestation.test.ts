import { BucketObject } from '../../src/clients/types';
import { StoredTakeoutAnalysis } from '../../src/database/takeout-analysis-model';
import type { JournalEntry } from '../../src/inventory/plan-execution';
import { MAX_INVENTORY_AGE_HOURS } from '../../src/inventory/repair-report';
import { archivedObjectsFrom, buildArchivePlan, locationKey, TakeoutArchivePlan } from '../../src/takeout/archive-plan';
import { linesToSend } from '../../src/takeout/archive-execution';
import { AnalyzedMedia } from '../../src/takeout/takeout-analysis';
import { AttestationInput, buildAttestation, coveredMediaCsv, gapsCsv } from '../../src/takeout/takeout-attestation';
import { AMBIGUOUS_JSON_REASON, ExportReport, ORPHAN_JSON_REASON } from '../../src/takeout/takeout-validation';

const MD5_A = 'a'.repeat(32);
const MD5_C = 'c'.repeat(32);
const MD5_D = 'd'.repeat(32);
const MULTIPART_E = `${'e'.repeat(32)}-3`;
const DEST = 'marceau-photos';
const PART = 'takeout-20260806T062636Z-1-001.zip';
const ANALYZED_AT = '2026-10-01T08:00:00.000Z';
const EXECUTION_END = new Date('2026-10-01T10:00:00.000Z');
const INVENTORY_AT = new Date('2026-10-01T11:00:00.000Z');
const NOW = new Date('2026-10-01T12:00:00.000Z');

function media(overrides: Partial<AnalyzedMedia> & Pick<AnalyzedMedia, 'path' | 'fileName' | 'md5'>): AnalyzedMedia {
  return {
    part: PART, folder: 'Photos de 2020', folderKind: 'annee', size: 100, takenAt: '2020-05-14T10:00:00', dateSource: 'exif', dateDetail: null,
    instant: null, dateWarning: null, metadata: null, companion: null, duplicateOf: null,
    archive: { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize: false },
    ...overrides,
  };
}

const A = media({ path: 'Takeout/Google Photos/Photos de 2020/A.jpg', fileName: 'A.jpg', md5: MD5_A });
const A_COPY = media({ path: 'Takeout/Google Photos/Album/A_copie.jpg', fileName: 'A_copie.jpg', md5: MD5_A, folder: 'Album', folderKind: 'album', duplicateOf: { part: PART, path: A.path } });
const C = media({ path: 'Takeout/Google Photos/Photos de 2020/C.jpg', fileName: 'C.jpg', md5: MD5_C, takenAt: null, dateSource: 'aucune' as AnalyzedMedia['dateSource'] });
const D = media({
  path: 'Takeout/Google Photos/Photos de 2020/D.jpg', fileName: 'D.jpg', md5: MD5_D,
  archive: { status: 'deja_archive', proof: 'md5', key: 'photos/2019/2019-01/D.jpg', archivedEtag: MD5_D, candidates: ['photos/2019/2019-01/D.jpg'], sameNameAndSize: true },
});
const E = media({
  path: 'Takeout/Google Photos/Photos de 2020/E.jpg', fileName: 'E.jpg', md5: 'f'.repeat(32), size: 5000,
  archive: { status: 'deja_archive', proof: 'etag_multipart', key: 'photos/2019/2019-02/E.jpg', archivedEtag: MULTIPART_E, candidates: ['photos/2019/2019-02/E.jpg'], sameNameAndSize: true },
});
const MEDIA = [A, A_COPY, C, D, E];

const object = (key: string, size: number, etag: string | null): BucketObject => ({ key, size, etag, lastModified: null });
const OCCUPIED_AT_PLAN = [object('photos/2019/2019-01/D.jpg', 100, MD5_D), object('photos/2019/2019-02/E.jpg', 5000, MULTIPART_E)];

function buildPlan(): TakeoutArchivePlan {
  return buildArchivePlan({
    exportId: '20260806T062636Z-1', destinationBucket: DEST, keptAlbums: [], analysisAnalyzedAt: ANALYZED_AT, media: MEDIA,
    occupied: archivedObjectsFrom(OCCUPIED_AT_PLAN), destinationInventoryCompletedAt: '2026-10-01T07:00:00.000Z',
  });
}

const ZIP = { name: PART, key: `backups/${PART}`, size: 123456, etag: 'abc-12' };

function validationReport(overrides: Partial<ExportReport> = {}): ExportReport {
  return {
    id: '20260806T062636Z-1',
    parts: [],
    folders: [],
    media: MEDIA.map((m) => ({
      part: m.part, path: m.path, folder: m.folder, fileName: m.fileName, size: m.size,
      metadata: { part: m.part, path: `${m.path}.json`, quality: 'exact' as never }, companion: null,
    })),
    unrecognized: [], problems: [], warnings: [], partCountConfirmed: true, exploitable: true,
    ...overrides,
  };
}

function journalOf(plan: TakeoutArchivePlan): Map<string, JournalEntry> {
  return new Map(linesToSend(plan).map((l) => [locationKey(l), { destination: l.destination, state: 'copie', copyAttempted: true, message: null }]));
}

/** Entrée complète d'une attestation accordée ; chaque test en dégrade un point. */
function input(overrides: Partial<AttestationInput> = {}): AttestationInput {
  const plan = buildPlan();
  const destinationOf = (m: AnalyzedMedia): string => plan.lines.find((l) => l.path === m.path)!.destination!;
  const analysis: StoredTakeoutAnalysis = {
    exportId: '20260806T062636Z-1', zips: [{ ...ZIP, verification: 'md5' }], timeZone: 'Europe/Paris', keptAlbums: [], destinationBucket: DEST,
    inventoryCompletedAt: '2026-10-01T07:00:00.000Z', analyzedAt: ANALYZED_AT, media: MEDIA,
  };
  return {
    exportId: analysis.exportId, expectedParts: 1, analysis, plan, states: journalOf(plan), executionEnd: EXECUTION_END, lockHeld: false,
    remoteZips: [ZIP], validation: validationReport(),
    inventory: {
      completedAt: INVENTORY_AT,
      objects: [
        object(destinationOf(A), 100, MD5_A),
        object(destinationOf(C), 100, MD5_C),
        ...OCCUPIED_AT_PLAN,
      ],
    },
    now: NOW,
    ...overrides,
  };
}

const reasonsOf = (i: AttestationInput): string => buildAttestation(i).attestation.reasons.join('\n');
const withObjects = (objects: BucketObject[]): AttestationInput => ({ ...input(), inventory: { completedAt: INVENTORY_AT, objects } });

describe('attestation d\'un export Takeout (story 4.5)', () => {
  it('accordée quand tout est conforme : décomptes, zips supprimables, une ligne par média', () => {
    const report = buildAttestation(input());
    expect(report.attestation).toEqual({ granted: true, reasons: [] });
    expect(report.gaps).toEqual([]);
    expect(report.counts).toEqual({ covered: 5, deposited: 2, alreadyArchived: 2, internalDuplicates: 1, quarantine: 1 });
    expect(report.zips).toEqual([ZIP]);
    expect(report.rows).toHaveLength(MEDIA.length);
  });

  it('un doublon interne est couvert par la destination de son représentant', () => {
    const report = buildAttestation(input());
    const copy = report.rows.find((r) => r.media.path === A_COPY.path)!;
    expect(copy.coverage).toBe('doublon_interne');
    expect(copy.expectedKey).toBe(report.rows.find((r) => r.media.path === A.path)!.expectedKey);
    // Représentant manquant : le doublon n'est pas couvert non plus (écart sur chacun des deux).
    const without = buildAttestation({ ...input(), inventory: { completedAt: INVENTORY_AT, objects: input().inventory!.objects.filter((o) => !o.key.endsWith('/A.jpg')) } });
    expect(without.gaps.filter((g) => g.type === 'manquant').map((g) => g.path).sort()).toEqual([A.path, A_COPY.path].sort());
    expect(without.attestation.granted).toBe(false);
  });

  it('un média en quarantaine conforme est couvert et signalé', () => {
    const report = buildAttestation(input());
    const row = report.rows.find((r) => r.media.path === C.path)!;
    expect(row.quarantine).toBe(true);
    expect(row.gap).toBeNull();
  });

  describe('écarts de rapprochement, chacun typé avec l\'action à mener', () => {
    const keyOfA = (): string => input().inventory!.objects[0]!.key;
    const others = (): BucketObject[] => input().inventory!.objects.slice(1);

    it('manquant : clé absente de l\'inventaire', () => {
      const report = buildAttestation(withObjects(others()));
      const gap = report.gaps.find((g) => g.path === A.path)!;
      expect(gap).toMatchObject({ type: 'manquant', part: PART, expectedKey: keyOfA() });
      expect(gap.action).toContain('gpb inventory scan');
      expect(report.attestation.granted).toBe(false);
    });

    it('taille_differente : même clé, autre taille', () => {
      const report = buildAttestation(withObjects([object(keyOfA(), 99, MD5_A), ...others()]));
      expect(report.gaps.find((g) => g.path === A.path)).toMatchObject({ type: 'taille_differente', expected: `100 octets, MD5 ${MD5_A}`, found: `99 octets, ETag ${MD5_A}` });
    });

    it('contenu_different : MD5 simple différent à taille égale', () => {
      const report = buildAttestation(withObjects([object(keyOfA(), 100, 'b'.repeat(32)), ...others()]));
      expect(report.gaps.find((g) => g.path === A.path)?.type).toBe('contenu_different');
    });

    it('non_confirmable : ETag multipart sans preuve enregistrée, ou ETag absent', () => {
      for (const etag of [`${'b'.repeat(32)}-2`, null]) {
        const report = buildAttestation(withObjects([object(keyOfA(), 100, etag), ...others()]));
        expect(report.gaps.find((g) => g.path === A.path)?.type).toBe('non_confirmable');
      }
    });

    it('sans_destination : ligne du plan sans destination', () => {
      const i = input();
      i.plan = { ...i.plan, lines: i.plan.lines.map((l) => (l.path === A.path ? { ...l, destination: null } : l)) };
      const report = buildAttestation(i);
      expect(report.gaps.filter((g) => g.type === 'sans_destination').map((g) => g.path).sort()).toEqual([A.path, A_COPY.path].sort());
      expect(report.attestation.granted).toBe(false);
    });

    it('ETag multipart d\'un déjà archivé : preuve enregistrée égale → conforme, différente → contenu_different', () => {
      expect(buildAttestation(input()).rows.find((r) => r.media.path === E.path)!.gap).toBeNull();
      const changed = withObjects(input().inventory!.objects.map((o) => (o.key.endsWith('E.jpg') ? object(o.key, 5000, `${'9'.repeat(32)}-3`) : o)));
      expect(buildAttestation(changed).gaps.find((g) => g.path === E.path)?.type).toBe('contenu_different');
    });
  });

  describe('raisons de refus (toutes listées)', () => {
    it('zips distants différents de ceux de l\'analyse (ETag, taille, absent, en trop)', () => {
      expect(reasonsOf(input({ remoteZips: [{ ...ZIP, etag: 'autre-1' }] }))).toContain('différent de celui analysé');
      expect(reasonsOf(input({ remoteZips: [{ ...ZIP, size: ZIP.size + 1 }] }))).toContain('différent de celui analysé');
      expect(reasonsOf(input({ remoteZips: [{ ...ZIP, name: 'takeout-20260806T062636Z-1-002.zip' }] }))).toContain('absent de backups/');
      expect(reasonsOf(input({ remoteZips: [ZIP, { ...ZIP, name: 'takeout-20260806T062636Z-1-002.zip' }] }))).toContain('2 zip(s) distant(s)');
    });

    it('zip sans ETag (analysé et distant) : jamais comparé sur le seul nom et la taille', () => {
      const base = input();
      const analysis = { ...base.analysis, zips: [{ ...ZIP, etag: null, verification: 'crc_entrees' }] };
      expect(reasonsOf({ ...base, analysis, remoteZips: [{ ...ZIP, etag: null }] })).toContain('sans ETag');
      expect(buildAttestation({ ...base, analysis, remoteZips: [{ ...ZIP, etag: null }] }).attestation.granted).toBe(false);
      expect(reasonsOf(input({ remoteZips: [{ ...ZIP, etag: null }] }))).toContain('sans ETag');
    });

    it('nombre de parties : écart avec --parties, ou non confirmé par la validation', () => {
      expect(reasonsOf(input({ expectedParts: 2 }))).toContain('2 attendu(s) (--parties)');
      expect(reasonsOf(input({ validation: validationReport({ partCountConfirmed: false }) }))).toContain('nombre de parties non confirmé');
    });

    it('export non exploitable, fichier non reconnu, JSON orphelin, JSON ambigu : chacun avec son chemin', () => {
      const i = input({
        validation: validationReport({
          problems: ['partie takeout-x-002.zip illisible : zip tronqué'],
          unrecognized: [
            { part: PART, path: 'Takeout/inconnu.txt', reason: 'extension non prise en charge' },
            { part: PART, path: 'Takeout/orphelin.json', reason: ORPHAN_JSON_REASON },
            { part: PART, path: 'Takeout/ambigu.json', reason: AMBIGUOUS_JSON_REASON },
          ],
        }),
      });
      const reasons = reasonsOf(i);
      expect(reasons).toContain('export non exploitable : partie takeout-x-002.zip illisible');
      expect(reasons).toContain(`fichier non reconnu (extension non prise en charge) : ${PART}:Takeout/inconnu.txt`);
      expect(reasons).toContain(`JSON orphelin (sans média correspondant) : ${PART}:Takeout/orphelin.json`);
      expect(reasons).toContain(`JSON ambigu : ${PART}:Takeout/ambigu.json`);
    });

    it('média sans métadonnées refusé, sauf vidéo de Live Photo avec image compagnon', () => {
      const bare = (m: AnalyzedMedia, companion: string | null) => ({ ...validationReport().media.find((v) => v.path === m.path)!, metadata: null, companion });
      const sans = validationReport();
      sans.media = sans.media.map((v) => (v.path === A.path ? bare(A, null) : v));
      expect(reasonsOf(input({ validation: sans }))).toContain(`média sans métadonnées (ni image compagnon de Live Photo) : ${PART}:${A.path}`);
      const live = validationReport();
      live.media = live.media.map((v) => (v.path === A.path ? bare(A, 'A.jpg') : v));
      expect(buildAttestation(input({ validation: live })).attestation.granted).toBe(true);
    });

    it('ensemble de médias rejoué différent de celui de l\'analyse (absent, en trop, taille)', () => {
      const v = validationReport();
      v.media = [...v.media.filter((m) => m.path !== C.path).map((m) => (m.path === A.path ? { ...m, size: 7 } : m)), { ...v.media[0]!, path: 'Takeout/nouveau.jpg' }];
      const reasons = reasonsOf(input({ validation: v }));
      expect(reasons).toContain('1 média(s) de l\'analyse absent(s) des zips locaux');
      expect(reasons).toContain('1 média(s) des zips locaux inconnu(s) de l\'analyse');
      expect(reasons).toContain('1 média(s) de taille différente de l\'analyse');
    });

    it('plan périmé par rapport à l\'analyse, ou altéré (empreinte)', () => {
      const i = input();
      expect(reasonsOf({ ...i, analysis: { ...i.analysis, analyzedAt: '2026-10-01T09:00:00.000Z' } })).toContain('plan périmé');
      expect(reasonsOf({ ...i, plan: { ...i.plan, lines: i.plan.lines.map((l) => ({ ...l, reason: 'altéré' })) } })).toContain('incohérent avec son empreinte');
    });

    it('exécution incomplète : nombre restant et commande de reprise ; verrou posé', () => {
      const i = input();
      const states = i.states;
      states.delete([...states.keys()][0]!);
      const reasons = reasonsOf({ ...i, states, lockHeld: true });
      expect(reasons).toContain('1 ligne(s) à déposer restante(s) sur 2');
      expect(reasons).toContain('gpb takeout archiver --export 20260806T062636Z-1 --confirmer');
      expect(reasons).toContain('verrou d\'exécution');
    });

    it('inventaire du bucket dédié : absent, antérieur à la dernière écriture, trop vieux, dans le futur', () => {
      expect(reasonsOf(input({ inventory: null }))).toContain('aucun inventaire local du bucket dédié');
      const objects = input().inventory!.objects;
      expect(reasonsOf(input({ inventory: { completedAt: new Date(EXECUTION_END.getTime() - 1000), objects } }))).toContain('non postérieur à la dernière écriture du journal');
      expect(reasonsOf(input({ inventory: { completedAt: EXECUTION_END, objects } }))).toContain('non postérieur');
      const old = new Date(NOW.getTime() - (MAX_INVENTORY_AGE_HOURS + 1) * 3_600_000);
      expect(reasonsOf(input({ executionEnd: new Date(old.getTime() - 1000), inventory: { completedAt: old, objects } }))).toContain(`plus de ${MAX_INVENTORY_AGE_HOURS} h`);
      expect(reasonsOf(input({ inventory: { completedAt: new Date(NOW.getTime() + 3_600_000), objects } }))).toContain('daté dans le futur');
    });

    it('rien à déposer et aucun journal : l\'inventaire doit être au moins celui du plan', () => {
      const i = input();
      const analysis = { ...i.analysis, media: [D, E] };
      const plan = buildArchivePlan({
        exportId: analysis.exportId, destinationBucket: DEST, keptAlbums: [], analysisAnalyzedAt: ANALYZED_AT, media: [D, E],
        occupied: archivedObjectsFrom(OCCUPIED_AT_PLAN), destinationInventoryCompletedAt: '2026-10-01T07:00:00.000Z',
      });
      const validation = validationReport({ media: validationReport().media.filter((m) => m.path === D.path || m.path === E.path) });
      const base = { ...i, plan, analysis, validation, states: new Map<string, JournalEntry>(), executionEnd: null };
      expect(buildAttestation({ ...base, inventory: { completedAt: INVENTORY_AT, objects: OCCUPIED_AT_PLAN } }).attestation).toEqual({ granted: true, reasons: [] });
      const stale = buildAttestation({ ...base, inventory: { completedAt: new Date('2026-10-01T06:00:00.000Z'), objects: OCCUPIED_AT_PLAN } });
      expect(stale.attestation.reasons.join('\n')).toContain('non postérieur à l\'inventaire du plan');
    });
  });

  it('CSV des médias couverts : une ligne par média, colonnes demandées, album vide pour une année', () => {
    const lines = coveredMediaCsv(buildAttestation(input())).replace(/^﻿/, '').trimEnd().split('\n');
    expect(lines[0]).toBe('nom;date_prise_de_vue;source_date;album;dossier_takeout;cle_archive;taille;md5');
    expect(lines).toHaveLength(1 + MEDIA.length);
    expect(lines).toContain(`A.jpg;2020-05-14T10:00:00;exif;;Photos de 2020;photos/2020/2020-05/A.jpg;100;${MD5_A}`);
    expect(lines.find((l) => l.startsWith('A_copie.jpg'))).toContain(';Album;Album;photos/2020/2020-05/A.jpg;');
  });

  it('CSV des écarts : une ligne par écart avec l\'action', () => {
    const report = buildAttestation(withObjects(input().inventory!.objects.slice(1)));
    const lines = gapsCsv(report).replace(/^﻿/, '').trimEnd().split('\n');
    expect(lines[0]).toBe('type;partie;chemin;cle_attendue;attendu;trouve;action');
    expect(lines).toHaveLength(1 + report.gaps.length);
    expect(lines[1]).toContain('manquant');
  });
});
