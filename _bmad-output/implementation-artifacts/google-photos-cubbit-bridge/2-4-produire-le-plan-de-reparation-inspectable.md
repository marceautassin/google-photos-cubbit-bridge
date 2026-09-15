---
baseline_commit: 3b08319
---

# Story 2.4 : Produire le plan de réparation inspectable

Status: done

## Story

En tant que Marceau,
je veux lire le plan complet avant qu'un seul octet ne bouge,
afin de contester ce qui me paraît faux tant que rien n'est irréversible.

**Exigences :** FR-3, FR-6 (prépare FR-1b, FR-5 exécutés en 3.1, FR-7 en 3.2, FR-8 en 3.3) — décisions **D1, D2, D3, D4**,
règle **Q1** (2.3) — **NFR :** NFR-2 (lecture seule), NFR-3 (simulation inspectable), NFR-5 (idempotence), NFR-7
(traçabilité), NFR-8 (volumétrie), NFR-10 (français), NFR-11 (qualité) — **contre-métrique principale** : nombre d'objets à
l'arrivée contre nombre inventorié, moins les doublons connus.

## Acceptance Criteria

1. **Plan sans écriture.** **Étant donné** l'inventaire daté du bucket source, **quand** je lance `gpb plan generer`,
   **alors** un plan listant chaque média du périmètre, sa destination et la raison de cette destination est produit
   **depuis l'index local uniquement** : aucun client S3 créé, aucun appel réseau, aucune écriture sur aucun bucket.
2. **Refus plutôt que plan partiel.** Pas d'inventaire local du bucket source, préfixes source vides, bucket dédié non
   configuré ou identique au bucket source, aucun média dans le périmètre, **ou** au moins un média non daté / à datation
   périmée (clé, taille ou ETag différents) → aucun plan n'est produit ni remplacé ; message clair en français (pour les
   datations : nombre, exemples de clés, « lancez `gpb inventory dates` »), code de sortie 1.
3. **Périmètre source (D4).** Les préfixes retenus viennent de la configuration `repair.sourcePrefixes`, valeurs par défaut
   documentées `backup_google_photos/photos/` et `2_Personnel/Photos/google_photos/`. Aucun objet hors périmètre (ex.
   `2_Personnel/Mariage/`, `1_Professionel/`) n'apparaît dans le plan. Seules les extensions `sync.supportedFormats` comptent.
4. **Destination (D2, D3).** Bucket dédié paramétrable (`repair.destinationBucket`, variable `CUBBIT_DESTINATION_BUCKET`,
   option `--destination`). Chemins **sans préfixe racine** : `photos/AAAA/AAAA-MM/<nom>` (chronologique),
   `albums/<album>/<chemin relatif dans l'album>` (albums conservés), `quarantaine/<clé source complète>` (date indéterminée).
5. **Quarantaine (FR-3).** Un média à date indéterminée, hors album conservé, reçoit l'action `quarantaine` vers
   `quarantaine/…`, distinct de l'arborescence par date ; raison « date indéterminée : <détail> ».
6. **Albums (D1).** La liste des albums conservés vient de `repair.keptAlbums` (défaut `["mariage"]`). Un média appartient à
   l'album `<a>` si le **premier segment de sa clé après le préfixe source** (le plus long qui correspond) vaut exactement
   `<a>` et qu'il est suivi d'au moins un segment. Il va dans `albums/<a>/…`, jamais dans `photos/` : ni éclaté par date, ni
   dupliqué. Raison « album conservé : <a> ».
7. **Doublons (FR-4, 2.3).** Contenus = nom comparable + taille + ETag identique non nul (règle 2.3, inchangée). Dans un
   contenu : chaque album conservé qui en contient une copie en garde **une** ; s'il existe au moins une copie en album,
   toutes les copies chronologiques sont `ignorer_doublon` (doublon de l'exemplaire du premier album par ordre de nom) ;
   sinon un exemplaire chronologique (`chooseKept`) est gardé. Raison « doublon de <clé conservée> ».
8. **Désambiguïsation stricte (Q1).** La règle 2.3 (`resolveNames`) s'applique à **chaque** dossier de destination
   (`photos/…`, `albums/…`, `quarantaine/…`), avec les destinations occupées. Toute anomalie de nommage rend le plan **non
   exécutable**, avec la liste complète des anomalies ; la ligne concernée reste dans le plan, sans destination.
9. **Déjà archivé.** Si le bucket dédié a été inventorié (`gpb inventory scan --bucket <dédié>`), ses objets sont les
   destinations occupées : un exemplaire au contenu déjà présent (même dossier, nom ou variante suffixée, même ETag) reçoit
   `ignorer_deja_archive` (destination = objet existant). Non inventorié : destinations occupées vides, signalé dans le résumé,
   non bloquant.
10. **Ligne de plan.** Clé source, bucket source, taille, ETag, action (`copier` / `ignorer_doublon` / `quarantaine` /
    `ignorer_deja_archive`), destination (nulle pour `ignorer_doublon`), raison (source de la date + champ EXIF et date ; ou
    album ; ou doublon ; ou date indéterminée ; mention « nom suffixé » en cas de collision).
11. **Invariants de comptes (vérifiés par le code).** Total des lignes = médias du périmètre ; chaque objet source exactement
    une fois ; somme des actions = total ; aucune destination attribuée deux fois (comparaison sans casse, NFC) ; aucune
    copie vers une destination occupée ; toute copie/quarantaine a une destination du bon espace (`photos/` ou `albums/`,
    `quarantaine/`) ; tout `ignorer_doublon` renvoie à une ligne conservée qui a une destination. Un invariant en échec ou
    une anomalie → plan non exécutable, violations listées.
12. **Rejouabilité.** Même entrée (quel que soit l'ordre) → mêmes lignes dans le même ordre (tri par clé source) et même
    empreinte (SHA-256 du contenu canonique, sans horodatage). Persisté localement (migration 6) : régénérer un plan
    identique ne crée rien ; un plan différent remplace l'ancien de façon atomique (transaction).
13. **Inspection.** `gpb plan generer` et `gpb plan afficher` affichent : empreinte, buckets, comptes et volumes par action,
    volume économisé, quarantaine, albums, noms suffixés, bucket dédié inventorié ou non, invariants OK/KO, exécutable
    oui/non, anomalies complètes. `--export <fichier.csv|fichier.json>` écrit le plan complet (en-têtes français).

## Tasks / Subtasks

- [x] T1 — Configuration (AC 3, 4, 6) : section `repair` (`sourcePrefixes`, `destinationBucket`, `keptAlbums`) dans
      `AppConfig`, défauts + fusion dans `loadConfig`, `config/config.example.json` et `config/.env.example` documentés
- [x] T2 — Refactor DRY `duplicates.ts` : extraire `attachDatings` et `groupContents` utilisés par `analyzeDuplicates` et le
      plan ; corriger l'affichage « (anomalie) » d'un exemplaire déjà archivé (consigne 2.3)
- [x] T3 — Module pur `src/inventory/repair-plan.ts` (AC 1–12) : `buildRepairPlan`, `albumOf`, `checkPlanInvariants`,
      `planFingerprint`, `summarizePlan`, `planToCsv`, `planToJson`, `PlanRefusedError`
- [x] T4 — Persistance (AC 12) : migration 6 `repair_plans` + `repair_plan_lines`, `RepairPlanModel.save` (inchangé /
      remplacé) et `findCurrent`
- [x] T5 — CLI `src/commands/plan.ts` : `gpb plan generer [--bucket] [--destination] [--export]`,
      `gpb plan afficher [--export]` (AC 13) ; enregistrement dans `src/index.ts`
- [x] T6 — Tests : `tests/inventory/repair-plan.test.ts` (pur), `tests/database/repair-plan-model.test.ts` (base temporaire),
      mise à jour du nombre de migrations dans `connection.test.ts`
- [x] T7 — Vérifications : tsc, test, clean + build, aide CLI, contre-épreuves ; suppression `data/` `logs/`
- [x] T8 — Corrections de revue `pr-reviewer` (décisions arrêtées par l'orchestrateur)
  - [x] [AI-Review][BLOQUANT] Périmètre = tous les objets sous les préfixes : ligne du plan, exclusion déclarée
        (`repair.ignoredFileNames`, marqueur de dossier vide) ou objet non reconnu (plan non exécutable, liste par extension) ;
        formats par défaut élargis (`heic`, `heif`, `dng`, `m4v`, `3gp`, `webm`, `mts`), `dng` lu par EXIF ; invariant
        lignes + exclusions + non reconnus = objets sous les préfixes
  - [x] [AI-Review][IMPORTANT] Invariant doublon : ETag normalisé non nul et taille égaux à ceux de l'exemplaire conservé
  - [x] [AI-Review][IMPORTANT] Invariant déjà archivé : ETag égal à celui de l'objet présent, espace `photos/`, `albums/` ou `quarantaine/`
  - [x] [AI-Review][IMPORTANT] Q1 : dossier normalisé (casse, NFC) dans la clé de conflit ; commentaire de quarantaine corrigé
  - [x] [AI-Review][IMPORTANT] Plan périmé : état de l'index (inventaires source et dédié, datations) dans le plan et l'empreinte ;
        refus enregistré sans écraser le plan ; `assessPlanFreshness` ; `plan afficher` avertit ; consignes pour la 3.1
  - [x] [AI-Review][SUGGESTION] Invariant longueur de destination ≤ 1024 octets UTF-8
  - [x] [AI-Review][SUGGESTION] Préfixes source imbriqués ou répétés refusés
  - [x] [AI-Review][SUGGESTION] Rapport 2.3 : mention explicite de la priorité à l'album dans le plan
- [x] T9 — Seconde revue `pr-reviewer` (décisions arrêtées par l'orchestrateur)
  - [x] [AI-Review][IMPORTANT] Instantané normalisé de la configuration effective (buckets, préfixes, formats, albums, noms et
        extensions ignorés) dans le plan et l'empreinte ; `assessPlanFreshness` le compare ; `verifyStoredPlan` pour la 3.1
  - [x] [AI-Review][IMPORTANT] Invariant de légitimité des exclusions (marqueur de dossier vide, nom ou extension ignorés)
  - [x] [AI-Review][IMPORTANT] `repair.ignoredExtensions` (vide par défaut, refus d'une extension de média)
  - [x] [AI-Review][SUGGESTION] `ignorer_deja_archive` : clé exacte de l'objet présent (`resolveNames` rend la clé complète)
  - [x] [AI-Review][SUGGESTION] Note sur `SyncManager` et la liste en dur de `takeout import`
- [x] T10 — Troisième revue `pr-reviewer` (décisions arrêtées par l'orchestrateur)
  - [x] [AI-Review][IMPORTANT] Aucun média exclu : refus d'un nom de `ignoredFileNames` à extension de média ; invariant
        indépendant de `exclusionReason` (aucune exclusion à extension de `supportedFormats`)
  - [x] [AI-Review][SUGGESTION] `save` : « inchangé » seulement si le plan en base est intact (empreinte recalculée,
        booléen `executable`), sinon réécriture
  - [x] [AI-Review][SUGGESTION] `verifyStoredPlan` refuse aussi un plan stocké `executable = false` ou avec violations
  - [x] [AI-Review][SUGGESTION] `plan afficher` : consigne de repasser les mêmes `--bucket` / `--destination` (`bucketMismatchHint`)

## Dev Notes

### État actuel (lu avant modification)

- `InventoryModel.findAll/findRun(bucket)` ; `InventoryDateModel.findAll(bucket)` ; `isSameObject(row, object)` ;
  `selectMedia(objects, formats, prefixes)` — préfixes vides = tout l'inventaire (**à refuser pour le plan** : le bucket
  `marceau` contient 7 667 objets perso/pro).
- `duplicates.ts` : `analyzeDuplicates` (groupement nom comparable + taille + ETag, `chooseKept`, `resolveNames` tolérant
  sur les seuls exemplaires datés), `disambiguateNames` strict, `destinationFolder`, `comparableName`, `normalizeEtag`,
  `OccupiedDestination`, `NamingAnomaly`. Le groupement est interne à `analyzeDuplicates` : il est extrait (T2) pour que le
  plan ne le duplique pas ; comportement de `analyzeDuplicates` inchangé (24 tests existants).
- `connection.ts` : 5 migrations, `inTransaction` ; `connection.test.ts` fige `version = 5` (→ 6).
- `config/index.ts` : `defaultConfig` + fusion par section ; `AppConfig` sans section réparation.
- Commandes : `src/commands/inventory.ts` (`run()` : message + exit 1), enregistrées dans `src/index.ts`.

### Décisions

- **Pas de préfixe racine dans le bucket dédié.** Le PRD final (D2 révisée par D3) fixe `photos/AAAA/AAAA-MM/` et
  `albums/<nom>/` ; l'ancienne mention `backup_google_photos/photos/…` du journal date d'avant D3 : `backup_google_photos/`
  servait à cloisonner l'archive dans un bucket mixte, le cloisonnement est désormais porté par le bucket (NFR-1).
- **Quarantaine `quarantaine/<clé source complète>`.** Les clés source sont uniques dans le bucket source : aucune collision
  possible par construction, même entre les deux emplacements (un chemin relatif au préfixe pourrait faire se rencontrer
  `2019/IMG.jpg` des deux côtés) ; l'origine reste lisible pour décider à la main. La règle Q1 est tout de même appliquée
  (collisions sans casse, destinations occupées).
- **Albums.** Membre = premier segment après le préfixe (le plus long) égal exactement à un nom configuré, suivi d'un
  segment. Chemin relatif conservé dans l'album (« tels quels ») ; `mariage/` étant à plat, c'est `albums/mariage/<nom>`. Un
  média d'album à date indéterminée reste dans l'album (sa destination ne dépend pas de la date).
- **Doublon album / chronologique.** L'album gagne : D1 interdit la duplication dans l'arborescence chronologique, et la
  copie d'album porte le regroupement voulu. Rien n'est perdu (le contenu est copié dans l'album, la ligne chronologique
  cite la clé conservée), rien n'est dupliqué. Deux albums conservés partageant un contenu gardent chacun leur copie (un
  album est conservé en entier).
- **Refus si non daté.** Même les médias d'album : un plan à moitié calculé ne doit pas passer pour complet.
- **Empreinte.** SHA-256 du JSON canonique `{bucket source, bucket destination, lignes triées, anomalies/violations}` ;
  aucun horodatage. Identifiant du plan = empreinte.
- **Persistance (KISS).** Un seul plan courant : `repair_plans` (id = empreinte, buckets, généré le, exécutable, problèmes
  JSON, bucket dédié inventorié) + `repair_plan_lines` (plan_id, position, clé, taille, ETag, action, destination, raison ;
  PK plan_id + clé). Même empreinte → rien n'est écrit ; sinon suppression de l'ancien et insertion du nouveau en une
  transaction. Les comptes/volumes sont recalculés depuis les lignes (pas de doublon d'état). La 3.1/3.2 stockera son
  avancement en référence à l'empreinte.
- **Export.** CSV `;` (tableur français), UTF-8 avec BOM, champs échappés ; JSON indenté avec clés françaises. Format déduit
  de l'extension, refus sinon.

### Hors périmètre

- Toute écriture S3, exécution, confirmation (3.1), reprise (3.2), rapport (3.3), état de l'archive (2.5).
- Résidu `2_Personnel/Photos/` hors `google_photos/` (addendum) : hors périmètre par configuration.

### Tests

- Jest, logger mocké ; pur en mémoire ; modèle sur base `os.tmpdir()` ; aucun réseau, aucun `.env`.
- Jeu : deux emplacements + objet hors périmètre + non-média ; doublon inter-emplacements ; `IMG_0044` 2016 / 2025 ×2 et
  2025 homonyme même mois (collision suffixée) ; album `mariage/` avec doublon chronologique ; indéterminé → quarantaine ;
  indéterminé en album ; refus (non daté, datation périmée, préfixes vides, destination absente/égale) ; invariants ;
  stabilité (entrée inversée) ; anomalie de nommage (ETag absent en collision) → non exécutable ; déjà archivé ; export CSV
  et JSON ; persistance inchangé / remplacé.

### Apprentissages des stories précédentes

- `rtk proxy` + redirection + `echo $?` ; `clean` + `build` ; supprimer `data/` et `logs/`.
- Vérifier chaque fichier modifié (`file`, fin de fichier) : troncature en 2.2, octets NUL en 2.3 (écrire `\u0000` avec
  précaution).
- Toute anomalie visible en entier, jamais filtrée (revues 2.1, 2.3).
- Consigne 2.3 : exiger `namingAnomalies.length === 0` avant d'émettre un plan exécutable ; corriger l'affichage
  « (anomalie) » pour un déjà archivé.
- Pas de commit : proposer seulement.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 2.4, #Story 3.1, #Story 3.3]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#4, #FR-3, #FR-6, #6, #8, #9 D1–D4]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/addendum.md#Résidu à vérifier avant la migration]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-3-identifier-les-doublons-et-les-collisions-de-noms.md#Revue de clôture]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-2-reconstruire-la-date-de-prise-de-vue-par-cascade-tracee.md]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 10 suites, 146/146 (dont `tests/inventory/repair-plan.test.ts` 24 cas, `tests/database/repair-plan-model.test.ts` 4 cas ; `duplicates.test.ts` 24/24 inchangé après refactor).
- `npx eslint` sur les fichiers touchés : seule erreur `validateConfig` importé et inutilisé dans `src/index.ts`, **préexistante** (présente dans `HEAD`), non corrigée (hors périmètre).
- `npm run clean` puis `npm run build` : code 0. `node dist/index.js --help`, `plan --help`, `plan generer --help`, `plan afficher --help` : code 0 (migration 6 appliquée sur base neuve).
- Bout en bout sur base locale remplie par script (bucket fictif `essai-plan`, aucun réseau) : sans datations → code 1, « plan refusé … 7 média(s) … Lancez « gpb inventory dates » » ; avec datations → code 0, 7 lignes (4 copier, 2 doublons, 1 quarantaine), hors périmètre absents, invariants OK, exécutable ; regénération → même empreinte, « identique … rien n'a été réécrit » ; `afficher --export plan.json` code 0 ; `--destination` égale à la source → code 1, refus. CSV : UTF-8 avec BOM. `data/` et `logs/` supprimés.
- Contre-épreuves (fichier restauré, `cmp` identique) : (1) contrôle « destination attribuée deux fois » neutralisé → 1 test en échec ; (2) désambiguïsation désactivée (nom d'origine) → 6 tests en échec ; (3) appartenance aux albums neutralisée → 5 tests en échec ; (4) contrôle du total et des objets absents neutralisé → 1 test en échec.
- Incident : l'outil d'écriture a de nouveau converti l'échappement `\u0000` en octet NUL, cette fois dans le fichier de story (texte des apprentissages) ; remplacé par l'échappement littéral, fichier contrôlé (`file` : texte UTF-8). Aucun octet NUL dans les sources (vérifié fichier par fichier) ; le code évite l'échappement (BOM écrit par `String.fromCharCode(0xfeff)`).

- Après revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 10 suites, 160/160 (`repair-plan.test.ts` 36 cas, `repair-plan-model.test.ts` 5, `dating.test.ts` + 1 cas formats) ; `npx eslint` des fichiers touchés (hors `src/index.ts`, erreur préexistante) code 0 ; `npm run clean` + `npm run build` code 0 ; `plan --help` code 0.
- Bout en bout après revue (base fictive, aucun réseau) : plan généré (code 0) ; ajout d'un objet à l'inventaire → `plan afficher` code 1, « plan périmé : l'index a changé depuis sa génération — bucket source (… 9 objets → … 10 objets) », « Plan exécutable : non en l'état » ; `generer` refusé (HEIC non daté, code 1) → `afficher` signale en plus « la dernière génération a été refusée le … ». `data/` et `logs/` supprimés.
- Contre-épreuves après revue (fichiers restaurés, `cmp` identique) : (1e) exclusions retirées du décompte → 8 tests en échec ; (2) contrôle taille/ETag du doublon neutralisé → 1 ; (3) contrôle d'ETag du déjà archivé neutralisé → 1 ; (4) dossier non normalisé dans `conflictKey` → 2. Tests 2.3 (`duplicates.test.ts`) verts avec le changement de `conflictKey`.
- Aucun octet NUL dans les fichiers modifiés (contrôle octet par octet), fins de fichier vérifiées. Le shell refuse une commande contenant l'échappement NUL : les contre-épreuves l'évitent.
- Seconde revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 10 suites, 170/170 (`repair-plan.test.ts` 46 cas, `repair-plan-model.test.ts` 5) ; `npx eslint` des fichiers touchés code 0 ; `npm run clean` + `npm run build` code 0 ; `plan --help` code 0 ; `plan afficher` sans plan code 0 (« Aucun plan de réparation local »).
- Bout en bout (base fictive) : `generer --bucket essai-plan --destination photos-essai` code 0 ; `afficher` avec les mêmes options code 0, « Plan exécutable : oui » ; `afficher --destination photos-autre` code 1, « plan périmé : la configuration a changé : destinationBucket » et « l'empreinte du plan recalculé … diffère » ; `afficher` avec les options par défaut (bucket non inventorié) code 1, « vérification impossible ». `data/` et `logs/` supprimés.
- Troisième revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 10 suites, 175/175 ; `npx eslint` des fichiers touchés code 0 ; `npm run clean` + `npm run build` code 0 ; `plan --help` code 0. Bout en bout (base fictive) : `afficher --bucket essai-plan --destination photos-essai` code 0, « Plan exécutable : oui » ; `afficher` sans options code 1, « vérification impossible » suivi de « les buckets vérifiés (source « marceau », dédié «  ») diffèrent de ceux du plan : repassez les mêmes options qu'à la génération (--bucket essai-plan --destination photos-essai) ». Contre-épreuve : règle 1b (exclusion à extension de média) neutralisée seule → 1 test en échec ; restaurée, `cmp` identique. `data/` et `logs/` supprimés ; aucun octet NUL, fins de fichier vérifiées.
- Contre-épreuves seconde revue (restaurées, `cmp` identique) : (1b) configuration non comparée → 2 tests en échec (les autres cas restent couverts par l'empreinte recalculée) ; (2) légitimité des exclusions non vérifiée → 1 ; (3a) extension ignorée sans effet → 1 ; (3b) extension de média excluable → 1.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Commandes : `gpb plan generer [--bucket <source>] [--destination <dédié>] [--export <fichier.csv|.json>]` (calcule, enregistre, affiche le résumé ; code 1 si refus ou plan non exécutable) et `gpb plan afficher [--export <fichier>]` (plan enregistré, sans recalcul). Aucun client S3 créé.
- Configuration `repair` : `sourcePrefixes` (défaut `backup_google_photos/photos/`, `2_Personnel/Photos/google_photos/`), `destinationBucket` (`CUBBIT_DESTINATION_BUCKET`), `keptAlbums` (défaut `mariage`) ; documentée dans `config/config.example.json` et `config/.env.example`. Préfixes vides ou sans `/` final refusés.
- `src/inventory/repair-plan.ts` (pur) : `buildRepairPlan`, `albumOf`, `occupiedFrom`, `checkPlanInvariants`, `planFingerprint`, `summarizePlan`, `planToCsv`, `planToJson`, `planExport`, `PlanRefusedError`. Réutilise `selectMedia`, `attachDatings`, `groupSameNameAndSize`, `splitContents`, `chooseKept`, `destinationFolder`, `resolveNames` (tolérant, puis exigence zéro anomalie pour l'exécutabilité).
- Refactor DRY `duplicates.ts` : `attachDatings`, `groupSameNameAndSize`, `splitContents`, `nameOf` extraits et exportés, utilisés par `analyzeDuplicates` et le plan. `runCommand` extrait (`src/commands/run-command.ts`), utilisé par `inventory` et `plan`. Consigne 2.3 appliquée : l'affichage des collisions montre « déjà archivé » au lieu de « (anomalie) ».
- Ligne de plan : clé source, bucket source, taille, ETag, action, destination, clé conservée (doublons), raison. Actions `copier`, `ignorer_doublon`, `quarantaine`, `ignorer_deja_archive`.
- Persistance : migration 6 (`repair_plans`, `repair_plan_lines`), `RepairPlanModel.save` → `cree` / `inchange` (rien écrit) / `remplace` (transaction), `findCurrent`.
- Points à signaler : (1) un plan refusé laisse l'ancien plan enregistré intact : la 3.1 doit recalculer l'empreinte depuis l'index avant d'exécuter, pour ne pas exécuter un plan périmé ; (2) appartenance aux albums sensible à la casse (`mariage` ≠ `Mariage`) ; (3) deux albums conservés partageant un contenu gardent chacun leur copie, la copie chronologique renvoie au premier album par ordre de nom ; (4) un média d'album à date indéterminée va dans l'album, pas en quarantaine ; (5) scanner le bucket dédié (même vide) change l'empreinte (le fait « inventorié » en fait partie) ; (6) erreur eslint préexistante dans `src/index.ts`.
- Revue `pr-reviewer` : 1 BLOQUANT, 4 IMPORTANT, 3 SUGGESTION traités (T8), chacun testé.
  - Périmètre : `classifyScope` répartit tous les objets sous les préfixes. Exclusion déclarée = nom de fichier dans
    `repair.ignoredFileNames` (sans casse ; défauts `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.picasa.ini`, `Picasa.ini`,
    `Icon` + retour chariot) ou marqueur de dossier (clé finissant par `/`, 0 octet — objet créé par les consoles S3, sans
    contenu). Tout le reste non reconnu (dont un marqueur non vide) bloque le plan, listé par extension avec la consigne.
    Les non reconnus sont comptés dans l'invariant des comptes (ils sont déclarés, pas perdus) et bloquent l'exécutabilité à part.
    Exportés en CSV (`exclu`, `non_reconnu`) et en JSON ; dans l'empreinte.
  - Formats : `sync.supportedFormats` par défaut + `heic`, `heif`, `dng`, `m4v`, `3gp`, `webm`, `mts`. `dng` ajouté aux formats
    EXIF (structure TIFF, testé) ; vidéos datées par le nom ou indéterminées sans requête (testé). `takeout import` non
    affecté : `TakeoutParser` a sa propre liste d'extensions en dur (sans HEIC) et n'utilise pas la configuration — à
    reprendre en epic 4 ; `sync` filtre avec la configuration mais ne reçoit que des éléments produits par ce parseur.
  - `conflictKey` et l'index « déjà archivé » de `resolveNames` comparent le dossier sans casse ni forme Unicode : Q1 suffixe
    au lieu de bloquer. Effet sur la 2.3 : nul pour `photos/AAAA/AAAA-MM/` (dossiers générés identiques).
  - Fraîcheur : `RepairPlan.index` (inventaire source et dédié : `completedAt`, `objectCount` ; datations : nombre et
    `MAX(dated_at)` via `InventoryDateModel.stamp`) et `sourcePrefixes` stockés et dans l'empreinte. Table
    `repair_plan_refusals` (une ligne) ; `save` l'efface. `assessPlanFreshness(plan, indexActuel, dernierRefus)` pure. Relancer
    `gpb inventory dates` sans changement modifie `MAX(dated_at)` : le plan devient périmé et doit être régénéré (prudent).
    Migration 6 modifiée en place (story non livrée, aucune base existante à migrer).
  - Rapport 2.3 : mention ajoutée plutôt qu'alignement. Appliquer la priorité à l'album dans `analyzeDuplicates` y ferait
    entrer la configuration des préfixes et des albums et recopierait la logique du plan (destinations `albums/`) dans un
    rapport qui n'en a pas besoin (KISS, DRY) ; le plan reste la seule source de vérité des destinations.
- Seconde revue `pr-reviewer` : 3 IMPORTANT et 2 SUGGESTION traités (T9), chacun testé.
  - `PlanSettings` / `PlanConfig` : `RepairPlan.config` remplace `sourceBucket`, `destinationBucket`, `sourcePrefixes` ;
    `normalizePlanConfig` (listes triées sans doublon, formats et extensions sans point ni casse, noms comparables). Le
    classement utilise les formats normalisés. Colonne `config` (JSON) dans `repair_plans` (migration 6 modifiée en place).
  - `verifyStoredPlan(plan, entréeActuelle, dernierRefus)` : fraîcheur (index, configuration, refus), empreinte recalculée
    sur le contenu stocké, objets non reconnus et anomalies stockés, invariants rejoués sur les lignes relues avec le
    périmètre et les destinations occupées actuels, recalcul `buildRepairPlan` depuis l'entrée actuelle et comparaison
    d'empreinte (ou refus du recalcul). `plan afficher` l'utilise (options `--bucket`, `--destination` comme la génération).
  - `exclusionReason` partagée par le classement et l'invariant de légitimité ; `checkPlanInvariants` reçoit les noms et
    extensions ignorés. Exclusions résumées par raison (nombre, volume) à l'écran, listées en entier si 50 au plus, toujours
    en entier dans l'export.
  - `resolveNames.alreadyArchived` rend la clé complète exacte de l'objet présent ; `DuplicateReport.alreadyArchived`
    idem (tests 2.3 ajustés sur la valeur, comportement inchangé).
  - **Formats élargis, portée** : `sync.supportedFormats` sert aussi à `SyncManager` (`src/sync/sync-manager.ts:224`, code
    hérité de la synchronisation Takeout) : il acceptera désormais heic, heif, dng, m4v, 3gp, webm, mts. `takeout import`
    (`TakeoutParser`) garde une liste d'extensions en dur, sans HEIC ni les autres ajouts, et n'est donc pas affecté : à
    unifier en epic 4 (stories 4.1–4.3), sans quoi un Takeout contenant des HEIC les ignorerait.
  - **Marche à suivre si l'inventaire réel révèle des sidecars** (`.json` Takeout, `.xmp`, `.aae`) : `gpb plan generer`
    les liste comme non reconnus, par extension, et refuse l'exécution. Décider pour chaque extension : fichier à ne pas
    archiver → l'ajouter à `repair.ignoredExtensions` dans `config/config.json` (ex. `["json", "xmp", "aae"]`) ; fichier à
    archiver → l'ajouter à `sync.supportedFormats` (il sera daté et classé comme un média). Régénérer le plan, relire la
    section « Exclusions déclarées » et l'export (`exclu`) avant d'exécuter. Une extension de média ne peut pas être
    ignorée (refus de génération).
- Troisième revue `pr-reviewer` : 1 IMPORTANT et 3 SUGGESTION traités (T10), chacun testé. Le scénario
  `ignoredFileNames: ['A.JPG']` excluait `…/2020/a.jpg` en silence avec un plan exécutable : désormais refusé à la
  génération, et `checkPlanInvariants` (qui reçoit `supportedFormats`) signale toute exclusion à extension de média,
  quelle que soit la raison, pour attraper aussi un plan stocké à configuration contournée ou un bug futur du classement.
  `RepairPlanModel` importe `planFingerprint` à l'exécution (aucun cycle : `repair-plan.ts` n'importe que des types de
  `database/`). La consigne de buckets n'est ajoutée qu'en présence d'un problème et si les buckets vérifiés diffèrent.
- Écart au cycle red-green : tests écrits juste après le code dans la même passe, validés par contre-épreuves.

### File List

- src/inventory/repair-plan.ts (nouveau)
- src/database/repair-plan-model.ts (nouveau)
- src/commands/plan.ts (nouveau)
- src/commands/run-command.ts (nouveau)
- src/inventory/duplicates.ts (modifié : helpers de groupement extraits, dossier normalisé dans la clé de conflit)
- src/inventory/dating.ts (modifié : `dng` dans les formats EXIF)
- src/database/inventory-date-model.ts (modifié : `stamp`)
- tests/inventory/dating.test.ts (modifié : formats ajoutés)
- tests/inventory/duplicates.test.ts (modifié : clé complète des « déjà archivés »)
- src/commands/inventory.ts (modifié : `runCommand`, affichage « déjà archivé », mention de la priorité à l'album)
- src/database/connection.ts (modifié : migration 6)
- src/config/types.ts (modifié : section `repair`)
- src/config/index.ts (modifié : défauts et fusion `repair`)
- src/index.ts (modifié : commande `plan`)
- config/config.example.json (modifié)
- config/.env.example (modifié)
- tests/inventory/repair-plan.test.ts (nouveau)
- tests/database/repair-plan-model.test.ts (nouveau)
- tests/database/connection.test.ts (modifié : 6 migrations)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-4-produire-le-plan-de-reparation-inspectable.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-15 : plan de réparation inspectable — `gpb plan generer|afficher`, destinations `photos/`, `albums/`, `quarantaine/` dans le bucket dédié, doublons et règle Q1 appliqués à chaque dossier, invariants de comptes vérifiés, empreinte, persistance (migration 6), export CSV/JSON (FR-3, FR-6).
- 2026-09-15 : corrections de revue — périmètre complet sous les préfixes (exclusions déclarées, objets non reconnus bloquants), formats élargis, invariants doublon / déjà archivé / longueur de clé, Q1 sur dossiers normalisés, préfixes imbriqués refusés, plan périmé et refus enregistrés (`assessPlanFreshness`).
- 2026-09-15 : seconde revue — instantané de configuration dans le plan et l'empreinte, `verifyStoredPlan` (recalcul et comparaison d'empreinte), légitimité des exclusions, `repair.ignoredExtensions`, clé exacte des déjà archivés.
- 2026-09-15 : troisième revue — aucun média excluable (refus de configuration, invariant indépendant), réécriture d'un plan corrompu à empreinte identique, `verifyStoredPlan` refuse un plan stocké non exécutable, consigne de buckets à l'affichage.

## Consignes impératives pour la story 3.1

- **Avant toute exécution, appeler `verifyStoredPlan(plan relu, entrée actuelle, dernier refus)`** et refuser si la liste
  n'est pas vide. L'entrée actuelle se construit comme pour la génération (`readPlanInput` de `src/commands/plan.ts` :
  inventaire source et datations, inventaire du bucket dédié, configuration actuelle, mêmes `--bucket`/`--destination`).
  Cette fonction couvre, et la 3.1 ne doit rien en retirer :
  - **recalculer le plan avec `buildRepairPlan` depuis l'index et la configuration actuels, et refuser si l'empreinte
    diffère de celle du plan stocké** (ou si le recalcul est refusé) ;
  - refuser un plan périmé : index (inventaires source et dédié, datations) ou configuration effective modifiés ;
  - refuser si la dernière génération a été refusée (`repair_plan_refusals` non vide) ;
  - refuser un plan stocké marqué non exécutable ou portant des violations, et, sans faire confiance au booléen
    `executable` stocké, tout plan à objets non reconnus, anomalies
    de nommage, `checkPlanInvariants` rejoué sur les lignes relues de la base avec le périmètre et les destinations
    occupées actuels, contenu stocké cohérent avec son empreinte.
- Ré-inventorier le bucket dédié juste avant l'exécution rend le plan périmé : régénérer alors le plan, qui tiendra compte
  des destinations occupées.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 5 passes : APPROUVER, aucun BLOQUANT ni IMPORTANT restant.
- BLOQUANT corrigé (passe 1) : objets sous les préfixes source hors `supportedFormats` (HEIC, 3GP…) absents du plan alors qu'il était déclaré exécutable. Désormais : tout objet sous les préfixes est une ligne, une exclusion justifiée ou un non reconnu (bloquant) ; formats par défaut élargis.
- IMPORTANTS corrigés : invariants de contenu (doublon et déjà archivé), collisions de dossiers casse/NFC, plan périmé (index et configuration), légitimité des exclusions, exclusion par extension, média exclu via `ignoredFileNames` (règle d'invariant indépendante).
- Ajouté par l'orchestrateur après approbation, puis relu et approuvé : règle unique de reconnaissance des médias (`isSupportedFormat` utilisée par le plan et la datation, marqueur de dossier `x.jpg/` jamais média) ; issue `repare` pour un plan réparé à l'identique. 183 tests.
- Consignes impératives pour la story 3.1 : voir la section dédiée ci-dessus (`verifyStoredPlan` avant toute exécution).
- À faire en epic 4 : `takeout import` a sa propre liste de formats en dur, sans HEIC.
