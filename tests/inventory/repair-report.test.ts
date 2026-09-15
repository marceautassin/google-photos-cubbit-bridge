import { BucketObject } from '../../src/clients/types';
import { formatNumber } from '../../src/utils/format';
import { ObjectDating } from '../../src/database/inventory-date-model';
import { ExecutionState, JournalEntry, linesToWrite } from '../../src/inventory/plan-execution';
import { buildRepairPlan, occupiedFrom, PlanInput, RepairPlan, verifyStoredPlan } from '../../src/inventory/repair-plan';
import {
  buildRepairReport,
  deletionKeysCsv,
  deletionLocations,
  MAX_INVENTORY_AGE_HOURS,
  PRD_START_COUNT,
  ReportInput,
  reportExport,
  sourceFreshnessProblems,
  verifyArrival,
} from '../../src/inventory/repair-report';

const SOURCE = 'marceau';
const DEST = 'marceau-photos';
const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);
const obj = (key: string, size: number, etag: string): BucketObject => ({ key, size, etag, lastModified: null });

const PERSO = '2_Personnel/Photos/google_photos/';
const V1 = 'backup_google_photos/photos/';

const sourceObjects: BucketObject[] = [
  obj(`${V1}2016/IMG_0005.JPG`, 100, md5('a')),
  obj(`${V1}2025/2025-08/IMG_0005.JPG`, 100, md5('a')), // doublon
  obj(`${V1}mariage/video.mp4`, 300, `${md5('b')}-2`), // multipart, album conservé
  obj(`${V1}2018/IMG_0100.JPG`, 70, md5('e')), // déjà archivé
  obj(`${PERSO}divers/scan.jpg`, 50, md5('c')), // quarantaine
  obj(`${PERSO}.DS_Store`, 6, md5('d')), // exclusion
  obj('2_Personnel/Documents/impots.pdf', 1000, md5('f')), // hors périmètre, même dossier de premier niveau
];

const datingOf = (o: BucketObject, takenAt: string | null): ObjectDating => ({
  key: o.key,
  size: o.size,
  etag: o.etag,
  source: takenAt ? 'exif' : 'indeterminee',
  takenAt,
  detail: takenAt ? 'DateTimeOriginal' : 'aucune date',
  exifRead: true,
});

const PLAN_DEST_STAMP = { completedAt: '2026-09-15T08:05:00.000Z', objectCount: 1 };
const archived = obj('photos/2018/2018-05/IMG_0100.JPG', 70, md5('e'));

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    sourceBucket: SOURCE,
    destinationBucket: DEST,
    sourcePrefixes: [PERSO, V1],
    supportedFormats: ['jpg', 'mp4'],
    keptAlbums: ['mariage'],
    ignoredFileNames: ['.DS_Store'],
    ignoredExtensions: [],
    objects: sourceObjects,
    datings: [
      datingOf(sourceObjects[0]!, '2016-02-20T10:00:00'),
      datingOf(sourceObjects[1]!, '2016-02-20T10:00:00'),
      datingOf(sourceObjects[2]!, '2019-06-01T12:00:00'),
      datingOf(sourceObjects[3]!, '2018-05-01T12:00:00'),
      datingOf(sourceObjects[4]!, null),
    ],
    index: {
      sourceInventory: { completedAt: '2026-09-15T08:00:00.000Z', objectCount: sourceObjects.length },
      destinationInventory: PLAN_DEST_STAMP,
      datings: { count: 5, lastDatedAt: '2026-09-15T09:00:00.000Z' },
    },
    occupied: occupiedFrom([archived]),
    ...overrides,
  };
}

const plan: RepairPlan = buildRepairPlan(input());
const END = new Date('2026-09-16T10:00:00Z');
const AFTER = new Date('2026-09-16T11:00:00Z');
const NOW = new Date('2026-09-16T12:00:00Z');

/** Journal où toutes les lignes à écrire sont dans l'état donné (sauf `overrides`). */
function statesOf(state: ExecutionState = 'copie', overrides: Record<string, ExecutionState> = {}): Map<string, JournalEntry> {
  return new Map(
    linesToWrite(plan).map((l) => {
      const s = overrides[l.sourceKey] ?? state;
      return [l.sourceKey, { destination: l.destination, state: s, copyAttempted: s !== 'a_faire', message: s === 'echec' ? 'copie en échec : réseau' : null }];
    }),
  );
}

/** Bucket dédié après une exécution complète : chaque destination présente, telle que la source (multipart : ETag changé par la copie). */
function arrivedObjects(): BucketObject[] {
  return [
    obj('backups/takeout-001.zip', 9, md5('t')),
    ...plan.lines
      .filter((l) => l.destination !== null && l.action !== 'ignorer_doublon')
      .map((l) => obj(l.destination!, l.size, l.etag!.includes('-') ? md5('z') : l.etag!)),
  ];
}

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    plan,
    states: statesOf(),
    executionEnd: END,
    lockHeld: false,
    journaledPlanIds: [plan.id],
    sourceObjects,
    sourceProblems: sourceFreshnessProblems(plan, input(), null, END),
    sourceInventoryCompletedAt: AFTER,
    verificationRequested: true,
    destinationInventory: { completedAt: AFTER, objects: arrivedObjects() },
    now: NOW,
    ...overrides,
  };
}

const destOf = (suffix: string): string => plan.lines.find((l) => l.sourceKey.endsWith(suffix))!.destination!;

describe('plan de l\'essai', () => {
  it('couvre copie, doublon, album multipart, déjà archivé, quarantaine et exclusion', () => {
    expect(plan.executable).toBe(true);
    expect(plan.lines.map((l) => l.action).sort()).toEqual(['copier', 'copier', 'ignorer_deja_archive', 'ignorer_doublon', 'quarantaine']);
    expect(plan.exclusions).toHaveLength(1);
  });
});

describe('buildRepairReport — exécution complète et vérifiée conforme', () => {
  const report = buildRepairReport(reportInput());

  it('attestation accordée, aucune anomalie', () => {
    expect(report.attestation).toEqual({ granted: true, reasons: [] });
    expect(report.anomalies).toEqual([]);
    expect(report.journal.status).toBe('complete');
  });

  it('comptes : copiés, doublons (espace économisé), quarantaine, déjà archivés', () => {
    expect(report.journal.copied).toEqual({ count: 3, size: 450 });
    expect(report.journal.expectedCopies.count).toBe(2);
    expect(report.journal.expectedQuarantine).toEqual({ count: 1, size: 50 });
    expect(report.journal.duplicates).toEqual({ count: 1, size: 100 });
    expect(report.journal.alreadyArchived).toEqual({ count: 1, size: 70 });
    expect(report.quarantine).toEqual([{ sourceKey: `${PERSO}divers/scan.jpg`, destination: `quarantaine/${PERSO}divers/scan.jpg`, size: 50 }]);
    expect(report.exclusions.map((e) => e.sourceKey)).toEqual([`${PERSO}.DS_Store`]);
  });

  it('conservation : arrivées vérifiées + doublons = médias ; + exclusions = périmètre', () => {
    const m = report.counterMetrics;
    expect(m.arrivalsFrom).toBe('verification');
    expect(m.arrivals).toBe(4);
    expect(m.arrivals + m.duplicates).toBe(m.mediaCount);
    expect(m.mediaCount + m.exclusions + m.unrecognized).toBe(m.scopeCount);
    expect(m.scopeCount).toBe(6);
    expect(m.deletedByTool).toBe(0);
    expect(m.deletionGuarantee).toMatch('garanti par construction');
    expect(report.warnings.join()).toMatch(`contre ${formatNumber(PRD_START_COUNT)} au relevé du PRD`);
  });

  it('emplacements à supprimer : bucket source, préfixes exacts, comptes, dossier parent hors périmètre', () => {
    expect(report.locations).toEqual([
      { bucket: SOURCE, prefix: PERSO, count: 2, size: 56, topFolder: '2_Personnel/', otherCount: 1, otherSize: 1000, exclusions: [expect.objectContaining({ sourceKey: `${PERSO}.DS_Store` })] },
      { bucket: SOURCE, prefix: V1, count: 4, size: 570, topFolder: 'backup_google_photos/', otherCount: 0, otherSize: 0, exclusions: [] },
    ]);
  });
});

describe('buildRepairReport — exécution non terminée', () => {
  const key = `${V1}2016/IMG_0005.JPG`;

  it.each<[ExecutionState, string, string]>([
    ['a_faire', 'incomplete', 'exécution incomplète : 1 à faire'],
    ['copie_en_cours', 'incomplete', '1 copie(s) en cours'],
    ['echec', 'bloquee', 'exécution bloquée'],
  ])('ligne %s : statut %s, pas d\'attestation', (state, status, reason) => {
    const report = buildRepairReport(reportInput({ states: statesOf('copie', { [key]: state }) }));
    expect(report.journal.status).toBe(status);
    expect(report.attestation.granted).toBe(false);
    expect(report.attestation.reasons.join('\n')).toMatch(reason);
  });

  it('ligne en échec listée avec son message', () => {
    const report = buildRepairReport(reportInput({ states: statesOf('copie', { [key]: 'echec' }) }));
    expect(report.journal.failures).toEqual([{ sourceKey: key, destination: destOf('2016/IMG_0005.JPG'), reason: 'copie en échec : réseau' }]);
  });

  it('journal incomplet sans vérification : conservation en écart, anomalie', () => {
    const report = buildRepairReport(reportInput({ states: statesOf('copie', { [key]: 'a_faire' }), verificationRequested: false, destinationInventory: null }));
    expect(report.counterMetrics.arrivalsFrom).toBe('journal');
    expect(report.anomalies.join()).toMatch('conservation des comptes : 3 objet(s) à l\'arrivée (d\'après le journal) + 1 doublon(s) écarté(s) = 4 ≠ 5');
  });

  it('aucun journal pour le plan courant : dit explicitement, cite l\'autre plan', () => {
    const report = buildRepairReport(reportInput({ states: new Map(), executionEnd: null, journaledPlanIds: ['b'.repeat(64)] }));
    expect(report.journal.status).toBe('non_executee');
    expect(report.attestation.reasons.join()).toMatch(`aucune exécution journalisée pour le plan courant ${plan.id.slice(0, 12)} (journal d'un autre plan : bbbbbbbbbbbb)`);
  });

  it('verrou présent : pas d\'attestation', () => {
    expect(buildRepairReport(reportInput({ lockHeld: true })).attestation.reasons.join()).toMatch('verrou d\'exécution est présent');
  });

  it('journal vers une autre destination : anomalie', () => {
    const states = statesOf();
    states.set(key, { ...states.get(key)!, destination: 'photos/ailleurs.jpg' });
    expect(buildRepairReport(reportInput({ states })).anomalies.join()).toMatch('journalisé vers photos/ailleurs.jpg');
  });
});

describe('verifyArrival et vérification de l\'arrivée', () => {
  const replaceObject = (destination: string, changes: Partial<BucketObject>): BucketObject[] =>
    arrivedObjects().map((o) => (o.key === destination ? { ...o, ...changes } : o));

  it('manquant, taille différente, ETag MD5 différent → non conformes ; multipart : taille seule', () => {
    const photo = destOf('2016/IMG_0005.JPG');
    const video = destOf('video.mp4');
    const quarantine = destOf('scan.jpg');
    const objects = replaceObject(photo, { etag: md5('x') })
      .filter((o) => o.key !== destOf('IMG_0100.JPG'))
      .map((o) => (o.key === quarantine ? { ...o, size: 49 } : o));
    const checks = verifyArrival(plan, objects, statesOf());
    const byDest = new Map(checks.map((c) => [c.destination, c]));
    expect(byDest.get(photo)).toMatchObject({ status: 'non_conforme', detail: `ETag ${md5('x')} au lieu de ${md5('a')} (MD5 source)` });
    expect(byDest.get(quarantine)).toMatchObject({ status: 'non_conforme', detail: 'taille 49 octets au lieu de 50' });
    expect(byDest.get(destOf('IMG_0100.JPG'))).toMatchObject({ status: 'manquant' });
    expect(byDest.get(video)).toMatchObject({ status: 'conforme' }); // ETag différent, même taille

    const report = buildRepairReport(reportInput({ destinationInventory: { completedAt: AFTER, objects } }));
    expect(report.attestation.granted).toBe(false);
    expect(report.verification!.missing).toHaveLength(1);
    expect(report.verification!.nonConforming).toHaveLength(2);
    expect(report.attestation.reasons.join('\n')).toMatch('1 objet(s) manquant(s)');
    expect(report.anomalies.join()).toMatch('conservation des comptes : 1 objet(s) à l\'arrivée (vérifiés)');
  });

  it('multipart de taille différente → non conforme', () => {
    const video = destOf('video.mp4');
    const checks = verifyArrival(plan, replaceObject(video, { size: 299 }), statesOf());
    expect(checks.find((c) => c.destination === video)!.status).toBe('non_conforme');
  });

  it('clé exacte : une destination en autre forme Unicode ou casse est manquante', () => {
    const photo = destOf('2016/IMG_0005.JPG');
    const checks = verifyArrival(plan, replaceObject(photo, { key: photo.toLowerCase() }), statesOf());
    expect(checks.find((c) => c.destination === photo)!.status).toBe('manquant');
  });

  it('inventaire du bucket dédié antérieur (ou égal) à la fin de l\'exécution → pas d\'attestation', () => {
    for (const completedAt of [new Date('2026-09-16T09:00:00Z'), END]) {
      const report = buildRepairReport(reportInput({ destinationInventory: { completedAt, objects: arrivedObjects() } }));
      expect(report.verification!.afterExecution).toBe(false);
      expect(report.attestation.reasons.join()).toMatch('antérieur à la fin de l\'exécution');
      expect(report.counterMetrics.arrivalsFrom).toBe('journal');
    }
  });

  it('vérification non demandée, ou sans inventaire du bucket dédié → pas d\'attestation', () => {
    expect(buildRepairReport(reportInput({ verificationRequested: false })).attestation.reasons).toEqual(['vérification de l\'arrivée non faite (option --verifier)']);
    expect(buildRepairReport(reportInput({ destinationInventory: null })).attestation.reasons.join()).toMatch(
      `aucun inventaire du bucket dédié « ${DEST} » : lancez « gpb inventory scan --bucket ${DEST} »`,
    );
  });
});

describe('sourceFreshnessProblems : fraîcheur côté source, pas côté bucket dédié', () => {
  it('plan à jour : aucun problème', () => {
    expect(sourceFreshnessProblems(plan, input(), null, END)).toEqual([]);
  });

  it('bucket dédié rescanné après exécution (nouvel inventaire, destinations occupées) : pas périmé', () => {
    const rescanned = input({
      index: { ...input().index, destinationInventory: { completedAt: '2026-09-16T11:00:00.000Z', objectCount: 5 } },
      occupied: occupiedFrom(arrivedObjects()),
    });
    expect(sourceFreshnessProblems(plan, rescanned, null, END)).toEqual([]);
    // Témoin : la vérification avant exécution, elle, le déclarerait périmé.
    expect(verifyStoredPlan(plan, rescanned, null).join()).toMatch('bucket dédié');
  });

  it('inventaire source, datations ou configuration modifiés, dernier refus, contenu altéré : périmé', () => {
    const newSource = input({ index: { ...input().index, sourceInventory: { completedAt: '2026-09-16T09:00:00.000Z', objectCount: 7 } } });
    expect(sourceFreshnessProblems(plan, newSource, null, END).join()).toMatch('bucket source');
    const newDatings = input({ index: { ...input().index, datings: { count: 6, lastDatedAt: '2026-09-16T12:00:00.000Z' } } });
    expect(sourceFreshnessProblems(plan, newDatings, null, END).join()).toMatch('datations');
    expect(sourceFreshnessProblems(plan, input({ keptAlbums: [] }), null, END).join()).toMatch('configuration a changé : keptAlbums');
    expect(sourceFreshnessProblems(plan, input(), { refusedAt: END, reason: 'non daté' }, END).join()).toMatch('dernière génération a été refusée');
    const altered = { ...plan, lines: plan.lines.map((l) => (l.action === 'copier' ? { ...l, destination: 'photos/autre.jpg' } : l)) };
    expect(sourceFreshnessProblems(altered, input(), null, END).join()).toMatch('incohérent avec son empreinte');
  });

  it('objet ajouté sous un préfixe source : invariant en échec', () => {
    const objects = [...sourceObjects, obj(`${V1}2020/new.jpg`, 1, md5('n'))];
    expect(sourceFreshnessProblems(plan, input({ objects }), null, END).join()).toMatch('objet source absent du plan');
  });

  it('problème de fraîcheur source → pas d\'attestation', () => {
    const report = buildRepairReport(reportInput({ sourceProblems: ['plan périmé : essai'] }));
    expect(report.attestation.reasons).toEqual(['plan exécuté non vérifiable contre l\'index source : plan périmé : essai']);
  });

  it('inventaire source avec un objet de plus sous un préfixe : anomalie de conservation', () => {
    const report = buildRepairReport(reportInput({ sourceObjects: [...sourceObjects, obj(`${V1}x.jpg`, 1, md5('n'))] }));
    expect(report.anomalies.join()).toMatch('5 médias + 1 exclusion(s) + 0 non reconnu(s) ≠ 7 objets');
    expect(report.attestation.granted).toBe(false);
  });
});

describe('deletionLocations', () => {
  it('préfixe de premier niveau : pas de dossier parent', () => {
    const top = { ...plan, config: { ...plan.config, sourcePrefixes: ['backup_google_photos/'] } };
    expect(deletionLocations(top, sourceObjects)).toEqual([
      { bucket: SOURCE, prefix: 'backup_google_photos/', count: 4, size: 570, topFolder: null, otherCount: 0, otherSize: 0, exclusions: [] },
    ]);
  });
});

describe('exports', () => {
  const at = new Date('2026-09-16T12:00:00Z');

  it('JSON : attestation, emplacements, contre-métriques, quarantaine, lignes', () => {
    const json = JSON.parse(reportExport(buildRepairReport(reportInput()), 'rapport.json', at));
    expect(json.attestation).toEqual({ accordee: true, raisons_de_refus: [] });
    expect(json.emplacements_a_supprimer_par_marceau.map((l: { prefixe: string }) => l.prefixe)).toEqual([PERSO, V1]);
    expect(json.emplacements_a_supprimer_par_marceau[0].autres_objets_du_dossier_parent_a_ne_pas_supprimer).toBe(1);
    expect(json.contre_metriques).toMatchObject({ objets_supprimes_par_l_outil: 0, arrivees: 4, doublons_ecartes: 1, objets_perimetre_source: 6 });
    expect(json.journal.espace_economise_octets).toBe(100);
    expect(json.quarantaine).toHaveLength(1);
    expect(json.lignes).toHaveLength(6);
  });

  it('JSON refusé : anomalies et raisons, aucun emplacement à supprimer', () => {
    const report = buildRepairReport(reportInput({ destinationInventory: { completedAt: AFTER, objects: [] } }));
    const json = JSON.parse(reportExport(report, 'rapport.json', at));
    expect(json.attestation.accordee).toBe(false);
    expect(json.emplacements_a_supprimer_par_marceau).toBeNull();
    expect(json.anomalies.length).toBeGreaterThan(0);
    expect(json.verification_arrivee.manquants).toHaveLength(4);
  });

  it('CSV : BOM, en-tête, une ligne par objet du périmètre, puis anomalies et refus', () => {
    const report = buildRepairReport(reportInput({ destinationInventory: { completedAt: AFTER, objects: [] } }));
    const csv = reportExport(report, 'rapport.CSV', at);
    const rows = csv.slice(1).trimEnd().split('\n');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(rows[0]).toBe('type;cle_source;action;taille_octets;destination;etat_journal;verification_arrivee;detail');
    expect(rows.filter((r) => r.startsWith('objet;'))).toHaveLength(6);
    expect(rows.some((r) => r.startsWith('anomalie;') && r.includes('conservation'))).toBe(true);
    expect(rows.some((r) => r.startsWith('refus_attestation;'))).toBe(true);
    expect(rows.find((r) => r.includes('.DS_Store'))).toMatch(/;exclu;6;;;;/);
  });

  it('extension inconnue : erreur', () => {
    expect(() => reportExport(buildRepairReport(reportInput()), 'rapport.txt', at)).toThrow('extension .csv ou .json attendue');
  });
});

describe('story 3.3, revue : nouvel inventaire source, âge des inventaires, liste de suppression', () => {
  const rescannedAt = '2026-09-16T11:00:00.000Z';
  /** Nouvel inventaire source terminé après l'exécution, avec ses objets. */
  const rescan = (objects: BucketObject[]): Partial<ReportInput> => {
    const current = input({ objects, index: { ...input().index, sourceInventory: { completedAt: rescannedAt, objectCount: objects.length } } });
    return { sourceObjects: objects, sourceInventoryCompletedAt: new Date(rescannedAt), sourceProblems: sourceFreshnessProblems(plan, current, null, END) };
  };

  it('nouveau scan source identique après exécution : tampon neutralisé, attestation accordée', () => {
    const report = buildRepairReport(reportInput(rescan(sourceObjects)));
    expect(report.sourceProblems).toEqual([]);
    expect(report.sourceAfterExecution).toBe(true);
    expect(report.sourceDiff).toEqual({ added: [], removed: [], modified: [] });
    expect(report.attestation).toEqual({ granted: true, reasons: [] });
  });

  it('tampon source non neutralisé si l\'inventaire source est antérieur à la fin d\'exécution', () => {
    const current = input({ index: { ...input().index, sourceInventory: { completedAt: '2026-09-16T09:00:00.000Z', objectCount: 6 } } });
    expect(sourceFreshnessProblems(plan, current, null, END).join()).toMatch('bucket source');
  });

  it('objet ajouté sous un préfixe : refus, ajout listé', () => {
    const extra = obj(`${V1}2021/nouveau.jpg`, 12, md5('g'));
    const report = buildRepairReport(reportInput(rescan([...sourceObjects, extra])));
    expect(report.sourceDiff.added).toEqual([{ key: extra.key, size: 12, etag: md5('g') }]);
    expect(report.attestation.granted).toBe(false);
    expect(report.attestation.reasons.join('\n')).toMatch('1 ajouté(s), 0 retiré(s), 0 modifié(s)');
  });

  it('doublon modifié (ETag changé, même taille, même multipart) : refus, modification listée', () => {
    const duplicate = `${V1}2025/2025-08/IMG_0005.JPG`;
    const objects = sourceObjects.map((o) => (o.key === duplicate ? { ...o, etag: md5('h') } : o));
    const report = buildRepairReport(reportInput(rescan(objects)));
    expect(report.sourceDiff.modified).toEqual([{ key: duplicate, before: { key: duplicate, size: 100, etag: md5('a') }, after: { key: duplicate, size: 100, etag: md5('h') } }]);
    expect(report.attestation.granted).toBe(false);
    const video = `${V1}mariage/video.mp4`;
    const multipart = sourceObjects.map((o) => (o.key === video ? { ...o, etag: `${md5('b')}-3` } : o));
    expect(buildRepairReport(reportInput(rescan(multipart))).sourceDiff.modified.map((d) => d.key)).toEqual([video]);
  });

  it('objet retiré : refus, retrait listé', () => {
    const objects = sourceObjects.filter((o) => !o.key.endsWith('.DS_Store'));
    const report = buildRepairReport(reportInput(rescan(objects)));
    expect(report.sourceDiff.removed.map((o) => o.key)).toEqual([`${PERSO}.DS_Store`]);
    expect(report.attestation.granted).toBe(false);
  });

  it('inventaire source antérieur (ou égal) à la fin d\'exécution, ou absent : refus', () => {
    for (const at of [new Date('2026-09-16T09:00:00Z'), END, null]) {
      const report = buildRepairReport(reportInput({ sourceInventoryCompletedAt: at }));
      expect(report.attestation.reasons.join()).toMatch(`non postérieur à la fin de l'exécution (${END.toISOString()}) : lancez « gpb inventory scan --bucket ${SOURCE} »`);
    }
  });

  it('inventaire source ou dédié de plus de 24 h, ou daté dans le futur : refus', () => {
    const hours = (h: number): Date => new Date(AFTER.getTime() + h * 3_600_000);
    expect(buildRepairReport(reportInput({ now: hours(24) })).attestation.granted).toBe(true);
    const old = buildRepairReport(reportInput({ now: hours(24.5) }));
    expect(old.inventoryAgesHours).toEqual({ source: 24.5, destination: 24.5 });
    expect(old.attestation.reasons).toEqual([
      `inventaire du bucket source vieux de 24.5 h (plus de ${MAX_INVENTORY_AGE_HOURS} h) : relancez « gpb inventory scan --bucket ${SOURCE} »`,
      `inventaire du bucket dédié vieux de 24.5 h (plus de ${MAX_INVENTORY_AGE_HOURS} h) : relancez « gpb inventory scan --bucket ${DEST} »`,
    ]);
    const destOnly = buildRepairReport(reportInput({ now: hours(25), sourceInventoryCompletedAt: hours(2) }));
    expect(destOnly.attestation.reasons).toHaveLength(1);
    expect(destOnly.attestation.reasons[0]).toMatch('bucket dédié vieux de 25.0 h');
    expect(buildRepairReport(reportInput({ now: hours(-1) })).attestation.reasons.join()).toMatch('daté dans le futur');
  });

  it('liste exacte des clés à supprimer : seulement si attesté, avec empreinte du plan et dates', () => {
    const csv = deletionKeysCsv(buildRepairReport(reportInput()), NOW);
    const rows = csv.slice(1).trimEnd().split('\n');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(rows[0]).toBe('bucket;cle;taille_octets;etag;empreinte_plan;inventaire_source_du;genere_le');
    expect(rows.slice(1)).toEqual(
      sourceObjects
        .filter((o) => o.key.startsWith(PERSO) || o.key.startsWith(V1))
        .map((o) => `${SOURCE};${o.key};${o.size};${o.etag};${plan.id};${AFTER.toISOString()};${NOW.toISOString()}`),
    );
    expect(csv).not.toMatch('impots.pdf');
    expect(() => deletionKeysCsv(buildRepairReport(reportInput({ verificationRequested: false })), NOW)).toThrow('pas attestée');
  });

  it('copies multipart vérifiées sur la taille seule : comptées (lignes copie seulement)', () => {
    expect(buildRepairReport(reportInput()).verification!.sizeOnlyCopies).toBe(1);
    const video = `${V1}mariage/video.mp4`;
    const same = arrivedObjects().map((o) => (o.key === destOf('video.mp4') ? { ...o, etag: `${md5('b')}-2` } : o));
    const report = buildRepairReport(reportInput({ states: statesOf('copie', { [video]: 'deja_present' }), destinationInventory: { completedAt: AFTER, objects: same } }));
    expect(report.verification!.sizeOnlyCopies).toBe(0);
  });

  it('exclusions non archivées rattachées à leur emplacement', () => {
    const [perso, v1] = buildRepairReport(reportInput()).locations;
    expect(perso!.exclusions).toEqual([{ sourceKey: `${PERSO}.DS_Store`, reason: expect.stringMatching('fichier technique ignoré') }]);
    expect(v1!.exclusions).toEqual([]);
  });

  it('objets non prévus sous photos/, albums/, quarantaine/ : avertissement non bloquant', () => {
    const objects = [...arrivedObjects(), obj('photos/2020/2020-01/intrus.jpg', 1, md5('i')), obj('backups/autre.zip', 1, md5('j'))];
    const report = buildRepairReport(reportInput({ destinationInventory: { completedAt: AFTER, objects } }));
    expect(report.verification!.unexpected).toEqual(['photos/2020/2020-01/intrus.jpg']);
    expect(report.warnings.join()).toMatch('1 objet(s) du bucket dédié sous photos/, albums/ ou quarantaine/ non prévu(s)');
    expect(report.attestation.granted).toBe(true);
  });
});

describe('story 3.3, revue : règle de conformité selon l\'origine de l\'objet', () => {
  const video = `${V1}mariage/video.mp4`;
  const videoDest = (): string => destOf('video.mp4');
  const archivedKey = `${V1}2018/IMG_0100.JPG`;

  it('multipart journalisé copie : ETag différent de même taille accepté (copie de l\'outil)', () => {
    const check = verifyArrival(plan, arrivedObjects(), statesOf('copie')).find((c) => c.sourceKey === video)!;
    expect(check.status).toBe('conforme');
  });

  it('multipart journalisé deja_present : taille ET ETag exigés', () => {
    const check = verifyArrival(plan, arrivedObjects(), statesOf('copie', { [video]: 'deja_present' })).find((c) => c.sourceKey === video)!;
    expect(check).toMatchObject({ status: 'non_conforme', detail: expect.stringMatching('objet non copié par l\'outil : taille et ETag exigés') });
    const same = arrivedObjects().map((o) => (o.key === videoDest() ? { ...o, etag: `${md5('b')}-2` } : o));
    expect(verifyArrival(plan, same, statesOf('copie', { [video]: 'deja_present' })).find((c) => c.sourceKey === video)!.status).toBe('conforme');
  });

  it('déjà archivé : taille ET ETag exigés, même si l\'état du journal était copie', () => {
    const objects = arrivedObjects().map((o) => (o.key === destOf('IMG_0100.JPG') ? { ...o, etag: md5('y') } : o));
    const states = statesOf();
    states.set(archivedKey, { destination: destOf('IMG_0100.JPG'), state: 'copie', copyAttempted: true, message: null });
    expect(verifyArrival(plan, objects, states).find((c) => c.sourceKey === archivedKey)!.status).toBe('non_conforme');
  });
});
