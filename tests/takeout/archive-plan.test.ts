import {
  archivedObjectsFrom,
  archivePlanFingerprint,
  ArchivedObjectSnapshot,
  ArchivePlanRefusedError,
  assessArchivePlanFreshness,
  buildArchivePlan,
  checkArchivePlanInvariants,
  locationKey,
  storedArchivePlanProblems,
  TakeoutArchivePlan,
  TakeoutPlanInput,
  verifyStoredArchivePlan,
} from '../../src/takeout/archive-plan';
import { AnalyzedMedia } from '../../src/takeout/takeout-analysis';

const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);
const MD5_C = 'c'.repeat(32);
const MULTIPART_A = `${'d'.repeat(32)}-3`;

/** Fabrique un `AnalyzedMedia` minimal, avec des valeurs par défaut raisonnables. */
function media(overrides: Partial<AnalyzedMedia> & Pick<AnalyzedMedia, 'part' | 'path' | 'fileName' | 'md5'>): AnalyzedMedia {
  return {
    folder: 'Photos de 2020',
    folderKind: 'annee',
    size: 100,
    takenAt: '2020-05-14T10:00:00',
    dateSource: 'exif',
    dateDetail: null,
    instant: null,
    dateWarning: null,
    metadata: null,
    companion: null,
    duplicateOf: null,
    archive: { status: 'nouveau', proof: null, key: null, archivedEtag: null, candidates: [], sameNameAndSize: false },
    ...overrides,
  };
}

/** Instantané occupé pour l'invariant 6 : objet réellement présent, avec sa taille. */
function occupiedObject(folder: string, name: string, etag: string | null, size: number): ArchivedObjectSnapshot {
  return { folder, name, etag, size };
}

const KEPT_ALBUMS = ['Baptême Raphaëlle', 'tenerife 2026'];

function input(overrides: Partial<TakeoutPlanInput> = {}): TakeoutPlanInput {
  return {
    exportId: '20260806T062636Z',
    destinationBucket: 'marceau-photos',
    keptAlbums: KEPT_ALBUMS,
    analysisAnalyzedAt: '2026-09-16T10:00:00.000Z',
    media: [],
    occupied: [],
    destinationInventoryCompletedAt: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

describe('buildArchivePlan : cas nominaux', () => {
  it('un média nouveau est envoyé vers photos/AAAA/AAAA-MM/<nom>', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(plan.executable).toBe(true);
    expect(plan.lines).toEqual([
      expect.objectContaining({ part: '001', path: 'a.jpg', action: 'envoyer', destination: 'photos/2020/2020-05/a.jpg' }),
    ]);
  });

  it('un contenu déjà archivé (photos/) est ignoré, destination = clé archivée existante', () => {
    const m = media({
      part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A,
      archive: { status: 'deja_archive', proof: 'md5', key: 'photos/2020/2020-05/a.jpg', archivedEtag: MD5_A, candidates: ['photos/2020/2020-05/a.jpg'], sameNameAndSize: true },
    });
    const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2020/2020-05/', 'a.jpg', MD5_A, 100)];
    const plan = buildArchivePlan(input({ media: [m], occupied }));
    expect(plan.executable).toBe(true);
    expect(plan.lines[0]).toMatchObject({ action: 'ignorer_deja_archive', destination: 'photos/2020/2020-05/a.jpg' });
  });

  it('un album conservé va sous albums/<nom>/, un album non désigné est classé par date', () => {
    const kept = media({
      part: '001', path: 'kept.jpg', fileName: 'kept.jpg', md5: MD5_A, folder: 'Baptême Raphaëlle', folderKind: 'album',
    });
    const notKept = media({
      part: '001', path: 'notkept.jpg', fileName: 'notkept.jpg', md5: MD5_B, folder: '2019 à imprimer', folderKind: 'album',
      takenAt: '2019-03-01T10:00:00',
    });
    const plan = buildArchivePlan(input({ media: [kept, notKept] }));
    expect(plan.executable).toBe(true);
    expect(plan.lines.find((l) => l.path === 'kept.jpg')?.destination).toBe('albums/Baptême Raphaëlle/kept.jpg');
    expect(plan.lines.find((l) => l.path === 'notkept.jpg')?.destination).toBe('photos/2019/2019-03/notkept.jpg');
  });

  it('décision explicite : contenu déjà archivé sous photos/ et présent dans un album conservé → ignoré, jamais dupliqué dans albums/', () => {
    // Représentant choisi par la 4.2 dans l'album conservé (duplicateOf === null), mais son contenu est déjà archivé
    // sous photos/ : la revue de 4.2 exige qu'il ne soit pas recopié dans albums/.
    const m = media({
      part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A, folder: 'Baptême Raphaëlle', folderKind: 'album',
      archive: { status: 'deja_archive', proof: 'md5', key: 'photos/2018/2018-06/a.jpg', archivedEtag: MD5_A, candidates: ['photos/2018/2018-06/a.jpg'], sameNameAndSize: false },
    });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(plan.lines[0]).toMatchObject({ action: 'ignorer_deja_archive', destination: 'photos/2018/2018-06/a.jpg' });
  });

  it('homonyme différent envoyé sous un nom suffixé par le MD5 (règle Q1)', () => {
    const a = media({ part: '001', path: 'a.jpg', fileName: 'img.jpg', md5: MD5_A, archive: { status: 'homonyme_different', proof: null, key: null, archivedEtag: null, candidates: ['photos/2020/2020-05/img.jpg'], sameNameAndSize: true } });
    const b = media({ part: '001', path: 'b.jpg', fileName: 'img.jpg', md5: MD5_B, archive: { status: 'homonyme_different', proof: null, key: null, archivedEtag: null, candidates: ['photos/2020/2020-05/img.jpg'], sameNameAndSize: true } });
    const plan = buildArchivePlan(input({ media: [a, b] }));
    expect(plan.executable).toBe(true);
    const destA = plan.lines.find((l) => l.path === 'a.jpg')!.destination!;
    const destB = plan.lines.find((l) => l.path === 'b.jpg')!.destination!;
    expect(destA).toBe(`photos/2020/2020-05/img_${MD5_A.slice(0, 8)}.jpg`);
    expect(destB).toBe(`photos/2020/2020-05/img_${MD5_B.slice(0, 8)}.jpg`);
  });

  it('non_confirmable est traité comme un homonyme différent (envoyé)', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A, archive: { status: 'non_confirmable', proof: null, key: null, archivedEtag: null, candidates: ['photos/2020/2020-05/a.jpg'], sameNameAndSize: true } });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(plan.lines[0]?.action).toBe('envoyer');
  });

  it('doublon interne : une seule ligne envoyer/reclasser_quarantaine par contenu, l\'autre ignorer_doublon_interne', () => {
    const kept = media({ part: '001', path: 'kept.jpg', fileName: 'kept.jpg', md5: MD5_A });
    const dup = media({ part: '001', path: 'dup.jpg', fileName: 'dup.jpg', md5: MD5_A, duplicateOf: { part: '001', path: 'kept.jpg' } });
    const plan = buildArchivePlan(input({ media: [kept, dup] }));
    expect(plan.executable).toBe(true);
    expect(plan.lines.find((l) => l.path === 'kept.jpg')).toMatchObject({ action: 'envoyer' });
    expect(plan.lines.find((l) => l.path === 'dup.jpg')).toMatchObject({ action: 'ignorer_doublon_interne', destination: null, keptOf: { part: '001', path: 'kept.jpg' } });
  });

  it('reclassement des médias archivés uniquement en quarantaine : action reclasser_quarantaine, destination datée', () => {
    const m = media({
      part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A, takenAt: '2021-08-09T10:00:00',
      archive: { status: 'deja_archive', proof: 'md5', key: 'quarantaine/x/a.jpg', archivedEtag: MD5_A, candidates: ['quarantaine/x/a.jpg'], sameNameAndSize: false },
    });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(plan.executable).toBe(true);
    expect(plan.lines[0]).toMatchObject({ action: 'reclasser_quarantaine', destination: 'photos/2021/2021-08/a.jpg' });
  });

  it('quarantaine-seule sans date connue : laissé en l\'état (reclassement impossible)', () => {
    const m = media({
      part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A, takenAt: null, dateSource: 'indeterminee',
      archive: { status: 'deja_archive', proof: 'md5', key: 'quarantaine/x/a.jpg', archivedEtag: MD5_A, candidates: ['quarantaine/x/a.jpg'], sameNameAndSize: false },
    });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(plan.lines[0]).toMatchObject({ action: 'ignorer_deja_archive', destination: 'quarantaine/x/a.jpg' });
  });

  it('date indéterminée (nouveau contenu) : action quarantaine, destination sous quarantaine/', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A, folder: 'Divers', takenAt: null, dateSource: 'indeterminee' });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(plan.lines[0]).toMatchObject({ action: 'quarantaine', destination: 'quarantaine/Divers/a.jpg' });
  });

  it('contenu nouveau détecté déjà présent dans le bucket dédié au moment du plan (inventaire plus récent que l\'analyse)', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2020/2020-05/', 'a.jpg', MD5_A, 100)];
    const plan = buildArchivePlan(input({ media: [m], occupied }));
    expect(plan.lines[0]).toMatchObject({ action: 'ignorer_deja_archive', destination: 'photos/2020/2020-05/a.jpg', archivedEtag: MD5_A });
  });

  it('un contenu déjà archivé confirmé uniquement par ETag multipart (aucune preuve MD5) est ignoré, sans violation (régression 2026-09-26)', () => {
    // L'export réel du 6 août compte 112 médias confirmés uniquement par recalcul d'ETag multipart
    // (archive_proof = 'etag_multipart'), jamais par MD5. Avant correction, l'invariant comparait `l.md5` à l'ETag de
    // l'objet archivé et rejetait ces 112 lignes (« aucun objet présent de même MD5 ») alors que l'objet est bien
    // présent, avec la bonne preuve (ETag multipart), inchangée depuis l'analyse.
    const m = media({
      part: '001', path: 'a.mp4', fileName: 'a.mp4', md5: MD5_A, size: 5_000_000,
      archive: { status: 'deja_archive', proof: 'etag_multipart', key: 'photos/2021/2021-04/a.mp4', archivedEtag: MULTIPART_A, candidates: ['photos/2021/2021-04/a.mp4'], sameNameAndSize: true },
    });
    const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2021/2021-04/', 'a.mp4', MULTIPART_A, 5_000_000)];
    const plan = buildArchivePlan(input({ media: [m], occupied }));
    expect(plan.lines[0]).toMatchObject({ action: 'ignorer_deja_archive', destination: 'photos/2021/2021-04/a.mp4', archivedEtag: MULTIPART_A });
    expect(plan.violations).toEqual([]);
    expect(plan.executable).toBe(true);
  });

  it('refuse de construire un plan sans aucun média', () => {
    expect(() => buildArchivePlan(input({ media: [] }))).toThrow(ArchivePlanRefusedError);
  });

  it('deux plans identiques ont la même empreinte, un plan différent une empreinte différente', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const plan1 = buildArchivePlan(input({ media: [m] }));
    const plan2 = buildArchivePlan(input({ media: [m] }));
    expect(plan1.id).toBe(plan2.id);
    const other = media({ part: '001', path: 'b.jpg', fileName: 'b.jpg', md5: MD5_B });
    const plan3 = buildArchivePlan(input({ media: [other] }));
    expect(plan3.id).not.toBe(plan1.id);
  });
});

describe('checkArchivePlanInvariants : chaque invariant cassé individuellement', () => {
  const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
  const okPlan = (): TakeoutArchivePlan => buildArchivePlan(input({ media: [m] }));

  it('plan sain : aucune violation', () => {
    expect(okPlan().violations).toEqual([]);
  });

  it('1. total des lignes ≠ médias de l\'export', () => {
    const plan = okPlan();
    const scope = [{ part: '001', path: 'a.jpg' }, { part: '002', path: 'b.jpg' }];
    expect(checkArchivePlanInvariants(plan, scope, [])).toEqual(
      expect.arrayContaining([expect.stringContaining('total des lignes')]),
    );
  });

  it('2. un média présent deux fois', () => {
    const plan = okPlan();
    const tampered = { lines: [...plan.lines, plan.lines[0]!] };
    expect(checkArchivePlanInvariants(tampered, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
      expect.arrayContaining([expect.stringContaining('présent 2 fois')]),
    );
  });

  it('3. somme des actions ≠ total (action inconnue)', () => {
    const plan = okPlan();
    const tampered = { lines: [{ ...plan.lines[0]!, action: 'inconnue' as never }] };
    expect(checkArchivePlanInvariants(tampered, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
      expect.arrayContaining([expect.stringContaining('somme des actions')]),
    );
  });

  it('4. destination attribuée deux fois (casse/NFC normalisées)', () => {
    const m2 = media({ part: '001', path: 'b.jpg', fileName: 'b.jpg', md5: MD5_B, takenAt: '2020-05-14T10:00:00' });
    const plan = buildArchivePlan(input({ media: [m, m2] }));
    const tampered = { lines: plan.lines.map((l) => ({ ...l, destination: l.destination ? 'photos/2020/2020-05/A.JPG' : l.destination })) };
    expect(checkArchivePlanInvariants(tampered, [{ part: '001', path: 'a.jpg' }, { part: '001', path: 'b.jpg' }], [])).toEqual(
      expect.arrayContaining([expect.stringContaining('attribuée deux fois')]),
    );
  });

  it('5. destination hors des racines attendues', () => {
    const plan = okPlan();
    const tampered = { lines: [{ ...plan.lines[0]!, destination: 'ailleurs/a.jpg' }] };
    expect(checkArchivePlanInvariants(tampered, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
      expect.arrayContaining([expect.stringContaining('hors de')]),
    );
  });

  describe('6. ligne ignorer_deja_archive : preuve MD5 ou ETag multipart revérifiée contre l\'inventaire actuel', () => {
    const archivedMd5 = media({
      part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A, size: 100,
      archive: { status: 'deja_archive', proof: 'md5', key: 'photos/2020/2020-05/a.jpg', archivedEtag: MD5_A, candidates: ['photos/2020/2020-05/a.jpg'], sameNameAndSize: true },
    });
    const archivedMultipart = media({
      part: '001', path: 'a.mp4', fileName: 'a.mp4', md5: MD5_A, size: 5_000_000,
      archive: { status: 'deja_archive', proof: 'etag_multipart', key: 'photos/2021/2021-04/a.mp4', archivedEtag: MULTIPART_A, candidates: ['photos/2021/2021-04/a.mp4'], sameNameAndSize: true },
    });

    it('preuve MD5, objet inchangé → OK', () => {
      const plan = buildArchivePlan(input({ media: [archivedMd5] }));
      const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2020/2020-05/', 'a.jpg', MD5_A, 100)];
      expect(checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.jpg' }], occupied)).toEqual([]);
    });

    it('preuve ETag multipart, objet inchangé (même ETag, même taille) → OK', () => {
      const plan = buildArchivePlan(input({ media: [archivedMultipart] }));
      const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2021/2021-04/', 'a.mp4', MULTIPART_A, 5_000_000)];
      expect(checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.mp4' }], occupied)).toEqual([]);
    });

    it('preuve MD5 mais objet présent de MD5 différent → échec, sans jamais confondre avec une preuve multipart', () => {
      const plan = buildArchivePlan(input({ media: [archivedMd5] }));
      const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2020/2020-05/', 'a.jpg', MD5_C, 100)];
      expect(checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.jpg' }], occupied)).toEqual(
        expect.arrayContaining([expect.stringContaining('preuve MD5 ou ETag multipart')]),
      );
    });

    it('ETag multipart changé depuis l\'analyse → échec explicite', () => {
      const plan = buildArchivePlan(input({ media: [archivedMultipart] }));
      const changed = `${'e'.repeat(32)}-4`;
      const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2021/2021-04/', 'a.mp4', changed, 5_000_000)];
      expect(checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.mp4' }], occupied)).toEqual(
        expect.arrayContaining([expect.stringContaining('a changé depuis l\'analyse')]),
      );
    });

    it('taille changée depuis l\'analyse (même ETag) → échec explicite', () => {
      const plan = buildArchivePlan(input({ media: [archivedMultipart] }));
      const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2021/2021-04/', 'a.mp4', MULTIPART_A, 5_000_001)];
      expect(checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.mp4' }], occupied)).toEqual(
        expect.arrayContaining([expect.stringContaining('a changé depuis l\'analyse')]),
      );
    });

    it('aucune preuve enregistrée (archivedEtag null) → échec explicite', () => {
      const plan = buildArchivePlan(input({ media: [archivedMd5] }));
      const tampered = { lines: [{ ...plan.lines[0]!, archivedEtag: null }] };
      expect(checkArchivePlanInvariants(tampered, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
        expect.arrayContaining([expect.stringContaining('aucune preuve (MD5 ou ETag multipart)')]),
      );
    });

    it('doublon interne dont le représentant est déjà archivé (par ETag multipart) : accepté, pas de violation', () => {
      const representative = archivedMultipart;
      const duplicate = media({
        part: '001', path: 'copie.mp4', fileName: 'copie.mp4', md5: MD5_A, size: 5_000_000,
        duplicateOf: { part: representative.part, path: representative.path },
      });
      const occupied: ArchivedObjectSnapshot[] = [occupiedObject('photos/2021/2021-04/', 'a.mp4', MULTIPART_A, 5_000_000)];
      const plan = buildArchivePlan(input({ media: [representative, duplicate], occupied }));
      expect(plan.lines.find((l) => l.path === 'copie.mp4')).toMatchObject({ action: 'ignorer_doublon_interne' });
      expect(plan.violations).toEqual([]);
    });

    it('objet déclaré déjà archivé absent de l\'inventaire courant (supprimé du bucket dédié) → violation, jamais silencieux (BLOQUANT, revue)', () => {
      const plan = buildArchivePlan(input({ media: [archivedMd5] }));
      // Inventaire courant restreint aux racines archivées, sans l'objet déclaré déjà archivé : il a disparu du
      // bucket dédié depuis l'analyse (supprimé, ou déplacé hors de photos/albums/quarantaine).
      expect(checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
        expect.arrayContaining([expect.stringContaining('introuvable dans l\'inventaire courant')]),
      );
    });

    it('doublon interne dont le représentant ignorer_deja_archive a un objet disparu de l\'inventaire courant → violation (via le représentant)', () => {
      const representative = archivedMd5;
      const duplicate = media({
        part: '001', path: 'copie.jpg', fileName: 'copie.jpg', md5: MD5_A, size: 100,
        duplicateOf: { part: representative.part, path: representative.path },
      });
      const plan = buildArchivePlan(input({ media: [representative, duplicate] }));
      expect(plan.lines.find((l) => l.path === 'copie.jpg')).toMatchObject({ action: 'ignorer_doublon_interne' });
      // Inventaire courant vide : l'objet du représentant a disparu. La violation doit apparaître même si la ligne
      // examinée est le doublon interne (son représentant est vérifié à son propre tour dans la même passe).
      expect(
        checkArchivePlanInvariants(plan, [{ part: '001', path: 'a.jpg' }, { part: '001', path: 'copie.jpg' }], []),
      ).toEqual(expect.arrayContaining([expect.stringContaining('introuvable dans l\'inventaire courant')]));
    });
  });

  it('7. destination de plus de 1024 octets', () => {
    const plan = okPlan();
    const tampered = { lines: [{ ...plan.lines[0]!, destination: `photos/2020/2020-05/${'a'.repeat(1100)}.jpg` }] };
    expect(checkArchivePlanInvariants(tampered, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
      expect.arrayContaining([expect.stringContaining('1024 octets')]),
    );
  });
});

describe('fraîcheur et vérification avant exécution', () => {
  it('assessArchivePlanFreshness : analyse, inventaire ou albums conservés différents → périmé', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const plan = buildArchivePlan(input({ media: [m] }));
    expect(assessArchivePlanFreshness(plan, { analysisAnalyzedAt: plan.analysisAnalyzedAt, destinationInventoryCompletedAt: plan.destinationInventoryCompletedAt, keptAlbums: KEPT_ALBUMS }, null)).toEqual([]);
    expect(assessArchivePlanFreshness(plan, { analysisAnalyzedAt: '2026-09-17T00:00:00.000Z', destinationInventoryCompletedAt: plan.destinationInventoryCompletedAt, keptAlbums: KEPT_ALBUMS }, null)[0]).toMatch('analyse source a changé');
    expect(assessArchivePlanFreshness(plan, { analysisAnalyzedAt: plan.analysisAnalyzedAt, destinationInventoryCompletedAt: '2026-09-17T00:00:00.000Z', keptAlbums: KEPT_ALBUMS }, null)[0]).toMatch('inventaire du bucket dédié');
    expect(assessArchivePlanFreshness(plan, { analysisAnalyzedAt: plan.analysisAnalyzedAt, destinationInventoryCompletedAt: plan.destinationInventoryCompletedAt, keptAlbums: [] }, null)[0]).toMatch('albums conservés');
    expect(assessArchivePlanFreshness(plan, { analysisAnalyzedAt: plan.analysisAnalyzedAt, destinationInventoryCompletedAt: plan.destinationInventoryCompletedAt, keptAlbums: KEPT_ALBUMS }, { refusedAt: new Date(), reason: 'x' })[0]).toMatch('refusée');
  });

  it('verifyStoredArchivePlan : plan intact et à jour → aucun problème', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const theInput = input({ media: [m] });
    const plan = buildArchivePlan(theInput);
    expect(verifyStoredArchivePlan(plan, theInput, null)).toEqual([]);
  });

  it('verifyStoredArchivePlan : contenu stocké incohérent avec son empreinte', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const theInput = input({ media: [m] });
    const plan = buildArchivePlan(theInput);
    const tampered: TakeoutArchivePlan = { ...plan, lines: [{ ...plan.lines[0]!, size: 999 }] };
    expect(verifyStoredArchivePlan(tampered, theInput, null)).toEqual(
      expect.arrayContaining([expect.stringContaining('incohérent avec son empreinte')]),
    );
  });

  it('storedArchivePlanProblems : plan marqué non exécutable', () => {
    const m = media({ part: '001', path: 'a.jpg', fileName: 'a.jpg', md5: MD5_A });
    const plan = buildArchivePlan(input({ media: [m] }));
    const tampered: TakeoutArchivePlan = { ...plan, executable: false, violations: ['x'] };
    // Recalculer l'empreinte pour isoler la vérification « marqué non exécutable » de celle de l'empreinte.
    const fixedId = archivePlanFingerprint(tampered);
    expect(storedArchivePlanProblems({ ...tampered, id: fixedId }, [{ part: '001', path: 'a.jpg' }], [])).toEqual(
      expect.arrayContaining([expect.stringContaining('non exécutable')]),
    );
  });
});

describe('locationKey', () => {
  it('combine part et path de façon unique', () => {
    expect(locationKey({ part: '001', path: 'a.jpg' })).not.toBe(locationKey({ part: '00', path: '1a.jpg' }));
  });
});

describe('archivedObjectsFrom', () => {
  it('découpe la clé en dossier + nom, en conservant la taille (nécessaire à l\'invariant 6)', () => {
    expect(archivedObjectsFrom([{ key: 'photos/2021/2021-04/a.mp4', size: 5_000_000, etag: MULTIPART_A }])).toEqual([
      { folder: 'photos/2021/2021-04/', name: 'a.mp4', etag: MULTIPART_A, size: 5_000_000 },
    ]);
  });
});
