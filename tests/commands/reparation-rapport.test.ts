import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/utils/logger', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { S3ArchiveWriter } from '../../src/clients/archive-writer';
import { BucketObject } from '../../src/clients/types';
import { readPlanInput } from '../../src/commands/plan';
import { executeCommand, ExecuteDeps } from '../../src/commands/reparation';
import { reportCommand } from '../../src/commands/reparation-rapport';
import { AppConfig } from '../../src/config/types';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/connection';
import { InventoryDateModel, ObjectDating } from '../../src/database/inventory-date-model';
import { InventoryModel } from '../../src/database/inventory-model';
import { RepairExecutionModel } from '../../src/database/repair-execution-model';
import { RepairPlanModel } from '../../src/database/repair-plan-model';
import { formatNumber } from '../../src/utils/format';
import { buildRepairPlan, RepairPlan } from '../../src/inventory/repair-plan';
import { FakeS3 } from '../fixtures/fake-s3';

const SOURCE = 'marceau';
const DEST = 'marceau-photos';
const PERSO = '2_Personnel/Photos/google_photos/';
const V1 = 'backup_google_photos/photos/';
const md5 = (seed: string): string => seed.repeat(32).slice(0, 32);

// Configuration écrite à la main : `src/config` n'est pas importé (il chargerait le fichier .env).
const config = {
  cubbit: { endpoint: 'https://essai.invalid', accessKeyId: 'id', secretAccessKey: 'secret', bucket: SOURCE },
  sync: { supportedFormats: ['jpg', 'mp4'] },
  repair: { sourcePrefixes: [PERSO, V1], destinationBucket: DEST, keptAlbums: ['mariage'], ignoredFileNames: ['.DS_Store'], ignoredExtensions: [] },
} as unknown as AppConfig;

const obj = (key: string, size: number, etag: string): BucketObject => ({ key, size, etag, lastModified: null });
const objects: BucketObject[] = [
  obj(`${V1}2016/IMG_0005.JPG`, 100, md5('a')),
  obj(`${V1}2025/2025-08/IMG_0005.JPG`, 100, md5('a')),
  obj(`${V1}mariage/video.mp4`, 300, `${md5('b')}-2`),
  obj(`${PERSO}divers/scan.jpg`, 50, md5('c')),
  obj(`${PERSO}.DS_Store`, 6, md5('d')),
  obj('2_Personnel/Documents/impots.pdf', 1000, md5('f')),
];
const dating = (o: BucketObject, takenAt: string | null): ObjectDating => ({
  key: o.key,
  size: o.size,
  etag: o.etag,
  source: takenAt ? 'exif' : 'indeterminee',
  takenAt,
  detail: takenAt ? 'DateTimeOriginal' : 'aucune date',
  exifRead: true,
});

describe('gpb reparation rapport', () => {
  let dir: string;
  let s3: FakeS3;
  let deps: ExecuteDeps;
  let output: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpb-rapport-'));
    await initDatabase({ path: path.join(dir, 'app.db') });
    s3 = new FakeS3();
    for (const o of objects) s3.put(SOURCE, o.key, { size: o.size, etag: o.etag! });
    s3.put(DEST, 'backups/takeout-001.zip', { size: 9, etag: md5('t') });
    // Cubbit attribue un ETag MD5 à la copie d'un multipart : vérifié par la taille seule.
    s3.copyEtag = (source) => (source.etag.includes('-') ? md5('z') : source.etag);
    deps = { createWriter: (_config, scope) => new S3ArchiveWriter(s3.asClient(), scope) };
    output = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    closeDatabase();
    await fs.remove(dir);
  });

  const text = (): string => output.join('\n');

  function seedPlan(): RepairPlan {
    new InventoryModel().replace(SOURCE, objects, new Date('2026-09-15T08:00:00Z'));
    new InventoryModel().replace(DEST, [obj('backups/takeout-001.zip', 9, md5('t'))], new Date('2026-09-15T08:05:00Z'));
    new InventoryDateModel().save(
      SOURCE,
      [dating(objects[0]!, '2016-02-20T10:00:00'), dating(objects[1]!, '2016-02-20T10:00:00'), dating(objects[2]!, '2019-06-01T12:00:00'), dating(objects[3]!, null)],
      new Date('2026-09-15T09:00:00Z'),
    );
    const plan = buildRepairPlan(readPlanInput(config, { destination: DEST }));
    expect(plan.executable).toBe(true);
    new RepairPlanModel().save(plan);
    return plan;
  }

  /** `gpb inventory scan --bucket marceau-photos` simulé : listing du faux S3, terminé à `completedAt`. */
  function scanDestination(completedAt: Date): void {
    const listed = s3.keys(DEST).map((key) => ({ key, ...s3.get(DEST, key)!, lastModified: null }));
    new InventoryModel().replace(DEST, listed, completedAt);
  }

  const later = (): Date => new Date(Date.now() + 60_000);
  /** Heure du rapport : après les inventaires simulés. */
  const clock = (): Date => new Date(Date.now() + 5 * 60_000);

  /** `gpb inventory scan --bucket marceau` simulé après l'exécution. */
  function scanSource(completedAt: Date, extra: BucketObject[] = []): void {
    const listed = s3.keys(SOURCE).map((key) => ({ key, ...s3.get(SOURCE, key)!, lastModified: null }));
    new InventoryModel().replace(SOURCE, [...listed, ...extra], completedAt);
  }

  it('sans plan : message, code 1', async () => {
    expect(await reportCommand(config, {})).toBe(1);
    expect(text()).toMatch('Aucun plan de réparation enregistré');
  });

  it('plan non exécuté : ne supprimez rien, commande d\'exécution', async () => {
    const plan = seedPlan();
    expect(await reportCommand(config, { verifier: true })).toBe(1);
    expect(text()).toMatch('aucune exécution journalisée pour ce plan');
    expect(text()).toMatch(`Pour exécuter : gpb reparation executer --confirmer ${plan.id.slice(0, 12)}`);
    expect(text()).toMatch('NE SUPPRIMEZ RIEN');
    expect(text()).not.toMatch('Emplacements à supprimer');
  });

  it('exécution complète, inventaire du bucket dédié postérieur : attestation, emplacements exacts, code 0, rien écrit', async () => {
    const plan = seedPlan();
    expect(await executeCommand(config, { confirmer: plan.id }, deps)).toBe(0);
    scanDestination(later());
    scanSource(later());
    const commandsBefore = s3.commands.length;
    const planCountBefore = getDatabase().prepare('SELECT COUNT(*) AS n FROM repair_plans').get();

    const suppression = path.join(dir, 'suppression.csv');
    expect(await reportCommand(config, { verifier: true, exportSuppression: suppression }, clock)).toBe(0);
    expect(s3.commands.length).toBe(commandsBefore);
    const keys = (await fs.readFile(suppression, 'utf8')).slice(1).trimEnd().split('\n');
    expect(keys.map((row) => row.split(';').slice(0, 4).join(';'))).toEqual([
      'bucket;cle;taille_octets;etag',
      ...objects.filter((o) => !o.key.startsWith('2_Personnel/Documents/')).map((o) => `${SOURCE};${o.key};${o.size};${o.etag}`).sort(),
    ]);
    expect(text()).toMatch('dont 1 exclusion(s) non archivée(s) qui seront supprimées (elles figurent dans le fichier des clés)');
    expect(text()).toMatch('Supprimez sans attendre');
    expect(text()).toMatch('Méthode de suppression : UNIQUEMENT les clés exactes du fichier exporté par --export-suppression.');
    expect(text()).toMatch(
      'Ne supprimez pas les dossiers entiers depuis la console : tout objet ajouté depuis l\'inventaire serait perdu. ' +
        'Supprimez uniquement les clés du fichier exporté, juste après ce rapport.',
    );
    expect(text()).toMatch('un objet écrasé en place sous une clé existante');
    expect(text()).toMatch('Activez le versioning sur le bucket source si Cubbit le propose');
    expect(text()).toMatch(`Fichier des clés à supprimer (${formatNumber(keys.length - 1)} clés) : ${suppression}`);
    expect(text()).toMatch('1 copie(s) multipart vérifiée(s) sur la taille seule : Cubbit recalcule l\'ETag d\'une copie');
    expect(text()).toMatch('Pour information, emplacements concernés (ne pas les supprimer en bloc)');
    expect(keys[1]).toMatch(new RegExp(`;${plan.id};[0-9T:.Z-]+;[0-9T:.Z-]+$`));

    // Fichier existant : jamais écrasé.
    const before = await fs.readFile(suppression, 'utf8');
    output.length = 0;
    expect(await reportCommand(config, { verifier: true, exportSuppression: suppression }, clock)).toBe(1);
    expect(text()).toMatch('existe déjà');
    expect(await fs.readFile(suppression, 'utf8')).toBe(before);
    // L'écran ne désigne jamais un fichier non produit : pas de chemin « à utiliser », refus explicite à la place.
    expect(text()).not.toMatch('Fichier des clés à supprimer (');
    expect(text()).toMatch('Fichier des clés NON produit');
    expect(text()).toMatch("N'utilisez aucun ancien fichier");

    // --export et --export-suppression sur le même fichier : refus avant tout calcul, rien n'est écrit.
    output.length = 0;
    const same = path.join(path.dirname(suppression), 'meme-fichier.csv');
    expect(await reportCommand(config, { verifier: true, export: same, exportSuppression: same }, clock)).toBe(1);
    expect(text()).toMatch('désignent le même fichier');
    expect(await fs.pathExists(same)).toBe(false);

    // Attestation sans --export-suppression : commande exacte pour produire le fichier.
    output.length = 0;
    expect(await reportCommand(config, { verifier: true, bucket: SOURCE }, clock)).toBe(0);
    expect(text()).toMatch(`Pour produire ce fichier : gpb reparation rapport --bucket ${SOURCE} --verifier --export-suppression suppression.csv`);
    expect(text()).toMatch(/Inventaire source du .* \(il y a -?0\.\d h\)/);
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM repair_plans').get()).toEqual(planCountBefore);
    expect(text()).toMatch('Niveau 1 — Rapport du journal');
    expect(text()).toMatch('Niveau 2 — Vérification de l\'arrivée');
    expect(text()).toMatch(/Conformes : 3 — manquants : 0 — non conformes : 0/);
    expect(text()).toMatch('espace économisé 100 octets');
    expect(text()).toMatch(`${PERSO}divers/scan.jpg → quarantaine/${PERSO}divers/scan.jpg`);
    expect(text()).toMatch(`${PERSO}.DS_Store`);
    expect(text()).toMatch('Objets supprimés par l\'outil dans « marceau » : 0 — garanti par construction');
    expect(text()).toMatch('La suppression des anciens emplacements vous appartient');
    expect(text()).toMatch(`• marceau/${PERSO} — 2 objets (56 octets)`);
    expect(text()).toMatch(`• marceau/${V1} — 3 objets (500 octets)`);
    expect(text()).toMatch('Ne supprimez PAS « 2_Personnel/ » en entier : il contient 1 autre(s) objet(s) hors périmètre');
    expect(text()).not.toMatch('NE SUPPRIMEZ RIEN');
    expect(s3.keys(SOURCE)).toEqual(objects.map((o) => o.key).sort());
  });

  it('sans --verifier : rapport du journal seul, ne supprimez rien, code 1', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    scanDestination(later());
    output.length = 0;
    expect(await reportCommand(config, {})).toBe(1);
    expect(text()).toMatch('Exécution : complète');
    expect(text()).toMatch('Non faite.');
    expect(text()).toMatch('vérification de l\'arrivée non faite (option --verifier)');
    expect(text()).not.toMatch('vous appartient');
  });

  it('inventaire du bucket dédié antérieur à l\'exécution : ne supprimez rien, consigne de scan', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    output.length = 0;
    expect(await reportCommand(config, { verifier: true })).toBe(1);
    expect(text()).toMatch('Antérieur à la fin de l\'exécution');
    expect(text()).toMatch(`gpb inventory scan --bucket ${DEST}`);
    expect(text()).toMatch('NE SUPPRIMEZ RIEN');
  });

  it('exécution interrompue : incomplète, commande de relance, ne supprimez rien', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    const [first] = new RepairExecutionModel().findStates(plan.id).keys();
    new RepairExecutionModel().record(plan.id, first!, 'copie_en_cours', null, true);
    scanDestination(later());
    output.length = 0;
    expect(await reportCommand(config, { verifier: true, bucket: SOURCE })).toBe(1);
    expect(text()).toMatch('Exécution : incomplète');
    expect(text()).toMatch(`Pour reprendre : gpb reparation executer --bucket ${SOURCE} --confirmer ${plan.id.slice(0, 12)}`);
    expect(text()).toMatch('NE SUPPRIMEZ RIEN');
  });

  it('objet disparu du bucket dédié après l\'exécution : manquant listé, anomalie de conservation, export', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    scanDestination(later());
    const inventory = new InventoryModel();
    const run = inventory.findRun(DEST)!;
    inventory.replace(DEST, inventory.findAll(DEST).filter((o) => !o.key.startsWith('albums/')), run.completedAt);
    output.length = 0;
    const exported = path.join(dir, 'export', 'rapport.json');
    expect(await reportCommand(config, { verifier: true, export: exported })).toBe(1);
    expect(text()).toMatch('Manquants :');
    expect(text()).toMatch('ANOMALIE : conservation des comptes');
    const json = await fs.readJson(exported);
    expect(json.attestation.accordee).toBe(false);
    expect(json.verification_arrivee.manquants).toHaveLength(1);
    expect(json.anomalies.join()).toMatch('conservation des comptes');
    expect(json.emplacements_a_supprimer_par_marceau).toBeNull();
  });

  it('objet ajouté au bucket source après le plan : ajout listé, pas d\'attestation, liste de suppression refusée', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    scanSource(later(), [obj(`${V1}2020/new.jpg`, 1, md5('n'))]);
    scanDestination(later());
    output.length = 0;
    const suppression = path.join(dir, 'suppression.csv');
    expect(await reportCommand(config, { verifier: true, exportSuppression: suppression }, clock)).toBe(1);
    expect(text()).toMatch('Ajoutés au bucket source depuis le plan (non archivés) :');
    expect(text()).toMatch(`${V1}2020/new.jpg (1 octets`);
    expect(text()).toMatch('NE SUPPRIMEZ RIEN');
    expect(text()).toMatch('Liste de suppression refusée, rien n\'a été écrit');
    expect(await fs.pathExists(suppression)).toBe(false);
  });

  it('inventaire source non refait après l\'exécution : refus, consigne de scan du bucket source', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    scanDestination(later());
    output.length = 0;
    expect(await reportCommand(config, { verifier: true }, clock)).toBe(1);
    expect(text()).toMatch(`lancez « gpb inventory scan --bucket ${SOURCE} »`);
  });

  it('inventaires de plus de 24 h au moment du rapport : refus', async () => {
    const plan = seedPlan();
    await executeCommand(config, { confirmer: plan.id }, deps);
    scanDestination(later());
    scanSource(later());
    output.length = 0;
    expect(await reportCommand(config, { verifier: true }, () => new Date(Date.now() + 25 * 3_600_000))).toBe(1);
    expect(text()).toMatch('inventaire du bucket source vieux de 25');
    expect(text()).toMatch('inventaire du bucket dédié vieux de 25');
  });

  it('le module de la commande ne crée aucun client S3', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../src/commands/reparation-rapport.ts'), 'utf8');
    expect(source).not.toMatch(/s3-client|archive-writer|@aws-sdk/);
  });
});
