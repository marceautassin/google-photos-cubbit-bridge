---
baseline_commit: 1c8e9f6
---

# Story 3.1 : Copier l'archive vers le bucket dédié selon le plan

Status: done

## Story

En tant que Marceau,
je veux que le plan validé soit exécuté vers le bucket dédié,
afin d'avoir enfin une archive unique et correctement classée.

**Exigences :** FR-1b, FR-5 — **NFR :** NFR-1 (révisée le 2026-09-15 : cloisonnement porté par le code), NFR-2 (aucune
suppression dans `marceau`), NFR-3 (simulation puis confirmation), NFR-5 (idempotence), NFR-6 (prépare la reprise 3.2),
NFR-9 (secrets), NFR-10 (français), NFR-11 (qualité) — décisions **D3** (bucket dédié `marceau-photos`), D1/D2 (chemins du
plan), consignes impératives de la story 2.4.

**Première story qui écrit dans S3.** Le bucket `marceau` est l'unique exemplaire des photos ; `marceau-photos/backups/`
contient les exports Takeout d'août 2026, eux aussi exemplaires uniques. Les clés Cubbit donnent accès à tout l'espace de
travail : rien, côté infrastructure, n'empêche une écriture au mauvais endroit. **Le code est la seule barrière.**

## Acceptance Criteria

1. **Point d'accès en écriture unique (NFR-1).** `src/clients/archive-writer.ts` est le seul module de `src/` qui importe
   une commande S3 d'écriture. Il n'expose que la copie serveur (`CopyObjectCommand`) et la lecture de métadonnées de
   destination (`HeadObjectCommand`). Il refuse, par une erreur levée **avant tout appel réseau** : un bucket de destination
   vide ou différent du bucket dédié configuré ; un bucket de destination égal au bucket source ; une clé de destination
   hors de `photos/`, `albums/`, `quarantaine/` (dont toute clé sous `backups/`), vide après l'espace, finissant par `/`, ou
   contenant un segment `.`/`..` ou vide. Aucune suppression n'existe dans le code (ni suppression d'objet unitaire ou
   multiple, ni dépôt d'objet par `PutObject`). Un test d'analyse des sources le vérifie.
2. **Vérification du plan stocké (consignes 2.4).** Avant toute exécution, même simulée, `verifyStoredPlan(plan relu,
   entrée actuelle, dernier refus)` est appelé ; la moindre raison → refus, rien n'est écrit (ni S3, ni journal), message
   clair, code 1. Le plan exécuté est celui **relu en base**, jamais un plan recalculé à la volée. Le bucket dédié vient de
   la configuration (`repair.destinationBucket` / `CUBBIT_DESTINATION_BUCKET`), pas d'une option : s'il diffère de celui
   du plan → refus.
3. **Simulation par défaut (NFR-3).** Sans `--confirmer`, la commande affiche le résumé de ce qui serait fait (lignes à
   copier et en quarantaine, volumes, lignes déjà faites d'après le journal, lignes restantes) et la commande exacte à
   lancer ; aucun client S3 n'est créé ; code 0.
4. **Confirmation explicite.** `gpb reparation executer --confirmer <empreinte>` : l'empreinte complète ou au moins ses
   12 premiers caractères. Empreinte fausse ou trop courte → refus, rien n'est écrit, code 1. Pas de prompt interactif.
5. **Identifiants.** Paire dédiée `CUBBIT_DESTINATION_ACCESS_KEY_ID` / `CUBBIT_DESTINATION_SECRET_ACCESS_KEY` si les deux
   sont définies, sinon repli sur la paire principale ; une seule des deux → refus. Avant la première copie, l'accès au
   bucket dédié est vérifié par une opération non destructive (HEAD d'une clé de contrôle sous `photos/`). Secrets jamais
   affichés ; erreurs S3 en `name: message` (`describeError`).
6. **Séquence par ligne `copier` et `quarantaine`.** (1) HEAD destination : objet présent identique (même taille, et même
   ETag si l'ETag source est un MD5 simple) → `deja_present`, rien n'est copié ; présent mais différent → **arrêt immédiat,
   jamais d'écrasement**, anomalie. (2) Sinon `CopyObject` serveur, `CopySource` encodé (espaces, accents NFC/NFD, `&`, `#`,
   `+`, `?`), `CopySourceIfMatch` sur l'ETag source ; échec (dont source modifiée, 412) → arrêt, anomalie. (3) HEAD
   destination : présent, taille égale, ETag égal si la source est un MD5 simple ; source multipart : taille seule. Échec →
   arrêt, anomalie. Aucune suppression dans aucun cas.
7. **Lignes sans écriture.** `ignorer_doublon` et `ignorer_deja_archive` (et les exclusions) ne donnent lieu à aucune
   requête S3.
8. **Aucun octet par le poste.** Le chemin d'exécution n'envoie que `HeadObject` et `CopyObject` (assertions sur les
   commandes envoyées) ; aucun `GetObject`, aucun `Upload`.
9. **Journal d'exécution (migration 7).** Table `repair_execution_lines` : empreinte du plan, clé source, destination, état
   (`a_faire`, `copie`, `deja_present`, `echec`), message, date. Lignes créées `a_faire` au démarrage confirmé, mises à jour
   ligne par ligne au fil de l'eau. `copie` n'est écrit qu'après vérification réussie. Un journal d'un autre plan n'est
   jamais réutilisé. Une relance du même plan saute les lignes `copie` / `deja_present` ; les lignes `echec` / `a_faire`
   sont retraitées (HEAD d'abord : rien n'est recopié si la copie existe).
10. **Idempotence (NFR-5).** Une exécution relancée après une exécution complète ne recopie rien et n'envoie aucune copie ;
    sans journal (autre base), le HEAD reconnaît les copies existantes (`deja_present`).
11. **Arrêt et `Ctrl-C`.** Exécution séquentielle. Premier arrêt de sûreté → arrêt propre, lignes suivantes intactes
    (`a_faire`). `Ctrl-C` : la ligne en cours se termine (copie + vérification + journal), puis arrêt ; un second `Ctrl-C`
    quitte immédiatement — une ligne interrompue reste `a_faire`, jamais `copie`.
12. **Affichage.** Progression (copiés, déjà présents, restants, volume copié) et résumé final ; code de sortie non nul si
    refus, anomalie, échec ou interruption.

## Tasks / Subtasks

- [x] T1 — Point d'accès (AC 1, 5, 6, 8) : `src/clients/archive-writer.ts` (`S3ArchiveWriter`, `checkDestination`,
      `encodeCopySource`, `isNotFound`) ; interface `ArchiveWriter` + `DestinationObject` dans `src/clients/types.ts` ;
      retrait de `CubbitClient.createFolder` (code mort, seul import de `PutObjectCommand`)
- [x] T2 — Identifiants (AC 5) : `cubbit.destinationAccessKeyId` / `destinationSecretAccessKey` (variables d'environnement)
      dans `AppConfig` et `defaultConfig` ; `destinationClientConfig(config)` dans `s3-client.ts` ; `.env.example`
- [x] T3 — Journal (AC 9) : migration 7 ; `src/database/repair-execution-model.ts` (`prepare`, `findStates`, `record`) ;
      `connection.test.ts` → 7 migrations
- [x] T4 — Exécution (AC 6, 7, 9, 10, 11) : `src/inventory/plan-execution.ts` pur (dépend des interfaces) :
      `linesToWrite`, `preflightExecution`, `summarizeExecution`, `executePlan`, `matchesSource`, `confirmationMatches`
- [x] T5 — CLI (AC 2, 3, 4, 12) : `src/commands/reparation.ts` (`gpb reparation executer [--bucket] [--confirmer]`),
      enregistrement dans `src/index.ts`
- [x] T6 — Tests (client S3 entièrement mocké, base temporaire, aucun `.env`) : garde, analyse statique, encodage,
      séquence, MD5/multipart, collisions, 412, vérification, idempotence, journal, commande (refus, simulation, confirmation)
- [x] T7 — Vérifications : tsc, test, eslint, clean + build, aide CLI dans un dossier de travail séparé (ne jamais toucher
      `data/`), contre-épreuves (garde, vérification post-copie)
- [x] T8 — Revue `pr-reviewer` (décisions arrêtées par l'orchestrateur)
  - [x] [AI-Review][BLOQUANT] `gpb sync` / `gpb resume` écrivaient (`Upload`) avec la clé de l'espace de travail dans
        `marceau` et pouvaient créer un bucket : commandes désactivées (refus, code 1, aucun client), `SyncManager` et
        `CubbitClient` supprimés, `status` en index local seul, dépendance `@aws-sdk/lib-storage` retirée
  - [x] [AI-Review][IMPORTANT] Noms de bucket validés (minuscules, 3 à 63 caractères) dans le point d'accès et le plan ;
        comparaison source/destination sans casse
  - [x] [AI-Review][IMPORTANT] Clé source contrôlée (segments, préfixes source du plan) dans le point d'accès et le pré-vol
  - [x] [AI-Review][IMPORTANT] Objet présent avant copie : `deja_present` seulement si taille ET ETag identiques, multipart
        compris (« objet existant à examiner ») ; refus d'un plan généré sans inventaire du bucket dédié
  - [x] [AI-Review][IMPORTANT] Verrou d'exécution exclusif (SQLite), verrou périmé détecté et levable par `--lever-verrou`
  - [x] [AI-Review][IMPORTANT] Analyse statique non contournable (guillemets, alias, sous-chemins, require, import(),
        réexport, noms d'écriture) avec sources piégées en test
  - [x] [AI-Review][MINEUR] `checkAccess` : `HeadBucketCommand` puis HEAD de sonde
  - [x] [AI-Review][MINEUR] Test de la commande sous `SIGINT` (1er et 2e signal, écouteurs restaurés)
  - [x] [AI-Review][MINEUR] HEAD de destination en erreur 500 ou coupure réseau → `echec`, aucune copie

## Dev Notes

### État actuel (lu avant modification)

- `src/clients/` : `bucket-lister.ts` (`ListObjectsV2Command`) et `object-range-reader.ts` (`GetObjectCommand`) en lecture
  seule, testés par analyse de leurs imports ; `s3-client.ts` (`createS3Client(config.cubbit)`) ; **`cubbit.ts` (hérité,
  utilisé par `SyncManager`) importe `PutObjectCommand` (méthode `createFolder`, jamais appelée), `CreateBucketCommand` et
  `Upload` de `@aws-sdk/lib-storage`.** `createFolder` est retiré (code mort) ; `Upload`/`CreateBucket` restent (epic 4) et
  sont figés par l'inventaire des imports du test statique — trou de NFR-1 à signaler (voir « Points ouverts »).
- `src/commands/plan.ts` : `readPlanInput(config, {bucket, destination})`, `resolveBuckets`, `run` (convertit
  `PlanRefusedError`), `showCommand` (motif : `verifyStoredPlan` + `bucketMismatchHint`, `PlanRefusedError` → problème).
- `src/inventory/repair-plan.ts` : `RepairPlan`, `PlanLine` (`sourceKey`, `sourceBucket`, `size`, `etag` sans guillemets,
  `action`, `destination`), `verifyStoredPlan`, `CHRONO_ROOT`/`ALBUMS_ROOT`/`QUARANTINE_ROOT`, `summarizePlan`.
- `src/inventory/duplicates.ts` : `etagKind` (`md5` = 32 hexadécimaux, sinon `multipart`, `absent`), `normalizeEtag`.
- `src/database/repair-plan-model.ts` : `findCurrent`, `findLastRefusal`. `connection.ts` : 6 migrations, `inTransaction`.
- `src/utils/format.ts` : `describeError`, `formatBytes`, `formatNumber`. `run-command.ts` : erreur → exit 1.
- **`src/config/index.ts` charge `.env` à l'import** : aucun module importé par les tests de cette story ne doit l'importer
  (d'où la validation d'identifiants dans `s3-client.ts`, pas `validateConfig`).
- `data/app.db` contient l'inventaire et le plan réels : `node dist/index.js` sur le projet appliquerait la migration 7 à
  cette base. L'aide CLI se vérifie dans une copie du projet (dossier de travail séparé : `PROJECT_ROOT` = dossier de
  `dist/../`).

### Décisions

- **Garde double.** `checkDestination(bucket, key, {sourceBucket, destinationBucket})` pure, appelée (a) sur toutes les
  destinations en pré-vol, avant la première requête, et (b) dans chaque méthode du point d'accès. Le constructeur refuse
  déjà bucket dédié vide ou égal à la source. Espaces autorisés : `photos/`, `albums/`, `quarantaine/` (constantes du plan,
  DRY) ; `backups/` explicitement cité dans le message.
- **Bucket dédié non surchargeable par option** pour l'exécution : une faute de frappe dans `--destination` ne peut pas
  rediriger des écritures. `--bucket` (source) reste, pour retrouver le plan généré avec `--bucket`.
- **Contrôle d'accès** : HEAD de `photos/.gpb-controle-acces` (absent → 404 = accès OK ; 403/erreur → refus avant toute
  copie). Limite assumée : un HEAD ne prouve pas le droit d'écrire sans écrire ; un refus d'écriture apparaîtrait à la
  première copie, qui arrête l'exécution sans rien avoir écrit.
- **MD5 / multipart.** L'ETag d'un objet déposé en une requête est le MD5 du contenu et `CopyObject` le conserve chez AWS ;
  un ETag multipart (`…-N`) dépend du découpage, et ce que Cubbit renvoie après copie d'un multipart est **inconnu** : on ne
  présume rien, taille seule. Si Cubbit changeait l'ETag d'une copie MD5, la vérification échouerait dès la première ligne :
  arrêt sûr, rien d'écrasé. Un objet de destination multipart de même taille est considéré déjà copié (le bucket dédié ne
  contient rien d'autre sous ces espaces ; `CopySourceIfMatch` a garanti le contenu à la copie).
- **ETag source absent** : aucune ligne réelle (0), mais la copie conditionnelle serait impossible → refus en pré-vol.
  Objet > 5 Gio (limite `CopyObject`) → refus en pré-vol (plus gros réel : 687 Mo).
- **Encodage `CopySource`** : `<bucket>/<encodeURIComponent(clé) avec %2F rendu à />` ; la clé n'est jamais normalisée
  (une clé NFD reste NFD, sinon ce serait un autre objet).
- **Arrêt sur toute erreur de copie** (KISS) : le SDK réessaie déjà les erreurs transitoires ; la reprise fine est la 3.2.
- **Séquentiel** : copies côté serveur (aucun débit local), ~7 800 lignes, arrêt au premier incident trivial à garantir,
  journal ordonné. Une concurrence bornée pourra être ajoutée si l'exécution réelle est trop lente.
- **Journal sans clé étrangère** vers `repair_plans` : régénérer un plan ne doit pas effacer la trace de ce qui a été copié
  (utile à la 3.3). Filtré par empreinte : un autre plan n'est jamais réutilisé. Une ligne journalisée n'est sautée que si
  sa destination est celle de la ligne du plan.

### Hors périmètre

- Reprise avancée (`en_cours`, coupure réseau pendant la copie, statistiques de reprise) : 3.2. Rapport et contre-métrique :
  3.3. Suppression : jamais dans l'epic 3. Réécriture du chemin d'upload hérité (`cubbit.ts`) : epic 4.

### Tests

- Jest, logger mocké. Faux S3 en mémoire (`send` inspecte le type de commande, enregistre chaque commande) branché sur le
  vrai `S3ArchiveWriter`. Base temporaire `os.tmpdir()` pour le journal et la commande. Aucun réseau, aucun `.env`.

### Apprentissages des stories précédentes

- `rtk proxy` + redirection + `echo $?` ; `clean` + `build`. Vérifier chaque fichier modifié (`file`, fin de fichier, octets
  NUL). Toute anomalie visible en entier. Contre-épreuves avec `cmp`. Pas de commit.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 3.1, #Story 3.2, #Story 3.3, NFR-1]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#Sûreté (révisé le 2026-09-15), #D3]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/.memlog.md (entrées du 2026-09-15)]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-4-produire-le-plan-de-reparation-inspectable.md#Consignes impératives pour la story 3.1]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-3-identifier-les-doublons-et-les-collisions-de-noms.md#Revue de clôture]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 16 suites, 272/272 (nouveaux : `archive-writer.test.ts` 20, `plan-execution.test.ts` 25,
  `repair-execution-model.test.ts` 3, `reparation.test.ts` 10 ; `connection.test.ts` → 7 migrations). (Les « 457 s »
  affichés étaient l'estimation du cache Jest ; durée réelle ≈ 5 s.)
- `npx eslint` des fichiers `src/` touchés : code 1, **uniquement** l'erreur préexistante `validateConfig` inutilisé dans
  `src/index.ts` (déjà signalée en 2.4) et des avertissements `any` préexistants ; aucun signalement sur les nouveaux
  fichiers. Tests : code 0, avertissements « return type » (style des tests existants).
- `npm run clean` + `npm run build` : code 0.
- Aide CLI dans une copie du projet (`dist/` + `package.json` + lien vers `node_modules`, dans le dossier temporaire de
  session : `PROJECT_ROOT` y pointe, base et journaux neufs, aucun `.env`) : `--help`, `reparation --help`,
  `reparation executer --help` code 0 (migrations 1 à 7 appliquées sur la base neuve).
- Bout en bout dans cette copie (base fictive `essai-source` → `essai-photos`, variables d'environnement, aucun réseau) :
  `plan generer` code 0 ; `reparation executer` code 0, « Simulation : rien n'a été écrit », commande `--confirmer
  e41e2d4b1650` proposée ; `--confirmer 000000000000` code 1, refus ; bonne empreinte sans endpoint ni identifiants → code 1,
  « configuration incomplète (CUBBIT_ENDPOINT, …) », aucun client créé ; objet ajouté à l'inventaire → code 1, « plan
  périmé », invariants rejoués en échec, recalcul refusé. Copie supprimée ensuite.
- `data/` du projet (inventaire et plan réels) : SHA-256 de chaque fichier identiques avant et après la session.
- Contre-épreuves (fichiers restaurés, `cmp` identique) : (1) garde des espaces neutralisée dans `destinationProblem` →
  8 tests en échec (6 garde du point d'accès, 2 pré-vol) ; (2) vérification post-copie neutralisée (taille/ETag et copie
  introuvable) → 2 tests en échec.
- Fichiers modifiés contrôlés : texte UTF-8, aucun octet NUL, fin de fichier `\n`. L'outil d'écriture a converti un
  échappement `\u0301` en caractère combinant dans un test : remplacé par `'…'.normalize('NFD')`.
- **Après revue (T8)** : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 16 suites, 324/324, durée réelle 6 s
  (`archive-writer.test.ts` 49, `plan-execution.test.ts` 33, `repair-execution-model.test.ts` 8, `reparation.test.ts` 16,
  `sync.test.ts` 5 nouveau ; `sync-manager.test.ts` supprimé avec le code) ; `npx eslint` des fichiers `src/` touchés code 1,
  seule erreur `validateConfig` préexistante (4 avertissements `any` préexistants) ; tests code 0 (15 avertissements
  « return type ») ; `npm run clean` + `npm run build` code 0 (`dist/sync/` et `dist/clients/cubbit.js` absents).
- CLI dans une copie du projet (dossier temporaire, sans `.env`) : `--help` code 0 (`sync` et `resume` marquées
  « (désactivée) ») ; `sync --help` code 0 ; `sync`, `sync --dry-run`, `resume` code 1, « désactivée : l'archivage des
  nouveaux Takeout sera reconstruit sur le point d'accès en écriture (epic 4). Rien n'a été envoyé. » ;
  `reparation executer --help` code 0 (`--lever-verrou`) ; `status` code 0, index local seul. Copie supprimée.
- Contre-épreuves après revue (fichiers restaurés, `cmp` identique) : (1c) `sync.ts` crée un `S3Client` → 6 tests en échec
  (3 refus sans client, code hérité, 2 analyse statique) ; (3) contrôle de la clé source neutralisé → 9 ; (4a) objet présent
  multipart accepté sur la taille seule → 2 ; (4b) refus du plan sans inventaire dédié neutralisé → 2 ; (5) prise de verrou
  qui efface le verrou existant → 4 ; (5b) libération du verrou en fin d'exécution retirée → 4 ; fichier `src/commands/evil.ts`
  (guillemets doubles, alias `PutObjectCommand as Envoi`, sous-chemin `dist-cjs`, `require` en backticks) → 2 tests en
  échec (5 violations listées), fichier supprimé.
- `data/` : SHA-256 identiques à ceux du début de session. Aucun octet NUL, fins de fichier `\n` sur tous les fichiers touchés.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- **Commande** : `gpb reparation executer [--bucket <source>] [--confirmer <empreinte>]`. Refus (code 1) : aucun plan,
  bucket dédié non configuré ou différent de celui du plan, `verifyStoredPlan` non vide (+ `bucketMismatchHint`),
  confirmation fausse ou < 12 caractères, identifiants incomplets, pré-vol ou contrôle d'accès en échec. Sans
  `--confirmer` : résumé et commande exacte, aucun client S3, journal non touché, code 0.
- **Point d'accès** `src/clients/archive-writer.ts` : `S3ArchiveWriter` (`checkAccess`, `headDestination`,
  `copyFromSource`) ; `destinationProblem` pure (bucket dédié vide / égal à la source / bucket étranger, espaces
  `photos/` `albums/` `quarantaine/` — constantes du plan —, `backups/` nommé, segments vides, `.`, `..`) ;
  `encodeCopySource` (segment par segment, `/` conservés, jamais normalisé) ; `isNotFound`, `isPreconditionFailed`.
  Le bucket de destination de chaque requête est celui du point d'accès, fixé à la construction depuis la configuration.
- **Test statique** : aucun fichier de `src/` hors du point d'accès ne contient `DeleteObject(s)`, `PutObject`,
  `CopyObject` ni `Delete…Command` ; le point d'accès n'importe que `CopyObjectCommand`, `HeadObjectCommand`, `S3Client` et
  ne contient ni `Delete`, ni `Put…`, ni `Upload`, ni `GetObject` ; inventaire figé de tous les imports du SDK par fichier ;
  aucun import du SDK par `require`, `import *` ou import dynamique. `CubbitClient.createFolder` (code mort, seul
  `PutObjectCommand` du code) retiré.
- **Séquence par ligne** (`executePlan`, séquentiel) : pré-vol sur tout le plan (garde, ETag présent, ≤ 5 Gio, buckets) →
  `journal.prepare` (`a_faire`) → saut des lignes `copie`/`deja_present` du même plan → `checkAccess` (HEAD de
  `photos/.gpb-controle-acces`) → pour chaque ligne : HEAD ; présent et conforme → `deja_present` ; présent non conforme →
  `echec`, arrêt ; `CopyObject` avec `CopySourceIfMatch` ; 412 → « source modifiée », arrêt ; HEAD de vérification ;
  absent ou non conforme → `echec`, arrêt ; sinon `copie`. Conformité : taille égale, et ETag égal si l'ETag source est un MD5
  simple (32 hexadécimaux) ; multipart : taille seule, l'ETag d'un multipart copié par Cubbit n'étant pas connu.
- **Journal** : migration 7 `repair_execution_lines` (plan_id, source_key, destination, state, message, updated_at ; PK
  plan_id + source_key ; CHECK sur les 4 états ; sans clé étrangère). `RepairExecutionModel` : `prepare` (ne réécrit pas),
  `findStates(planId)`, `record` (erreur si ligne absente). Journal incohérent (même plan, autre destination) → refus.
- **Ctrl-C** : premier signal → la ligne en cours finit (copie, vérification, journal), arrêt entre deux lignes, code 1 ;
  second signal → sortie 130 immédiate. `copie` n'est écrit qu'après la vérification ; une ligne coupée reste `a_faire`
  (ou `echec`) et la relance la reconnaît par HEAD.
- **Identifiants** : `destinationClientConfig` (paire `CUBBIT_DESTINATION_*` si les deux, sinon principale ; une seule →
  refus ; messages sans valeur). La copie serveur utilise la paire retenue pour lire la source et écrire la destination.
- **Corrections de revue (T8)** — elles remplacent les décisions contraires des Dev Notes :
  - **Écritures héritées supprimées.** `src/sync/sync-manager.ts`, `src/clients/cubbit.ts` et leur test supprimés (seule
    l'écriture les justifiait ; leurs lectures ne servaient qu'à `status`). `gpb sync` et `gpb resume` restent visibles,
    marquées « (désactivée) », et refusent (code 1) sans rien créer : un ancien mode d'emploi mène à une explication plutôt
    qu'à « commande inconnue » (KISS : trois lignes). `gpb status` n'affiche plus que l'index local. Vérifié : `setup`
    (fichier de configuration), `takeout`, `archive`, `history`, `etat`, `plan` n'atteignent aucune écriture S3.
    Dépendance `@aws-sdk/lib-storage` désinstallée (`package.json`, `package-lock.json`). Types morts `FileInfo`,
    `DownloadProgress`, `UploadProgress` retirés.
  - **Noms de bucket** : `src/utils/bucket-name.ts` (`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`, sans normalisation), utilisé
    par le point d'accès et `validateInput` du plan ; comparaison source/destination sans casse.
  - **Périmètre du point d'accès** `WriterScope` (`sourceBucket`, `sourcePrefixes` du plan, `destinationBucket`) ;
    `sourceKeyProblem` (segments vides, `.`, `..`, clé hors préfixes) dans `copyFromSource` et le pré-vol.
  - **Objet présent avant copie** : `isSameAsSource` (taille et ETag identiques, ETag non nul, multipart compris) ; sinon
    arrêt « objet différent » ou, pour un multipart de même taille, « objet existant à examiner ». Après NOTRE copie,
    conditionnée à l'ETag source : `isVerifiedCopy` (MD5 → taille et ETag ; multipart → taille). Conséquence : une
    relance sans journal ou après coupure sur une ligne multipart dont Cubbit aurait changé l'ETag à la copie s'arrêtera
    pour examen (arrêt sûr).
  - **Plan sans inventaire du bucket dédié refusé** au pré-vol (consigne : `gpb inventory scan --bucket <dédié>` puis
    `gpb plan generer`).
  - **Verrou d'exécution** (table `repair_execution_lock` dans la migration 7, modifiée en place : story non livrée) :
    une ligne `id = 1` (plan, pid, poste, date) ; la clé primaire départage deux prises simultanées. Pris après
    confirmation et création du point d'accès, libéré dans `finally` (fin normale, arrêt, refus, erreur) et avant la
    sortie 130 du second Ctrl-C. Verrou d'un processus mort sur ce poste : « verrou d'exécution périmé », jamais levé en
    silence ; `--lever-verrou` le lève (refusé si le processus tourne encore ; verrou d'un autre poste : non vérifiable,
    levable explicitement). Un `kill -9` laisse un verrou périmé, détecté à la relance.
  - **Course résiduelle, dite honnêtement** : le verrou n'exclut que les exécutions de cet outil sur cette base. Un
    écrivain externe (console Cubbit, autre outil, autre poste avec une autre base) qui dépose un objet entre notre HEAD
    et notre `CopyObject` serait écrasé : S3 n'offre pas de copie conditionnelle sur l'absence de la destination
    (`If-None-Match` n'est pas garanti sur Cubbit pour `CopyObject`). La vérification après copie le détecterait
    rarement (même clé, notre contenu). **Recommandation : activer le versioning sur `marceau-photos`** avant l'exécution
    réelle, pour qu'un écrasement éventuel reste récupérable, et ne rien écrire d'autre dans ce bucket pendant l'exécution.
  - **Contrôle d'accès** : `HeadBucketCommand` (bucket inexistant ou inaccessible → refus avant toute copie), puis HEAD de
    `photos/.gpb-controle-acces`.
  - **Analyse statique** (`tests/clients/archive-writer.test.ts`, fonction pure `analyzeSources`) : toute référence
    `['"\`]@aws-sdk/…['"\`]` ; seul module autorisé `@aws-sdk/client-s3` (sous-chemins `dist…` refusés) ; chaque
    référence doit être un `import … from` / `export … from` analysable (sinon : `require`, `import()`, import à effet de
    bord refusés) ; identifiants importés (alias compris) égaux à l'inventaire figé par fichier (point d'accès :
    `CopyObjectCommand`, `HeadBucketCommand`, `HeadObjectCommand`, `S3Client` ; lecteurs : listing, GET partiel, client) ;
    liste des fichiers importateurs figée ; hors point d'accès, aucun nom d'écriture (`Put*`, `Delete*`, `Copy*`,
    `Create*`, `Restore*`, `Upload*`, `CompleteMultipart*`, `UploadPart*`, `AbortMultipart*`, `*Acl/*Policy/*Lifecycle/
    *Versioning…Command`, exception documentée : balise EXIF `CreateDate`) et aucune commande hors lecture ; dans le point
    d'accès, aucune commande hors copie et HEAD. Onze sources piégées vérifiées en test, plus la contre-épreuve `evil.ts`.
- **Points ouverts à signaler** :
  1. Versioning de `marceau-photos` recommandé (course résiduelle ci-dessus).
  2. Le contrôle d'accès est un HEAD : il prouve la lecture du bucket dédié, pas le droit d'écrire (impossible sans écrire).
     Un refus d'écriture arrêtera la première copie sans rien avoir écrit.
  3. À surveiller à la première exécution réelle : si Cubbit ne conserve pas l'ETag MD5 lors d'une copie, la vérification
     s'arrêtera dès la première ligne MD5 (arrêt sûr). Les 701 objets multipart sont vérifiés par la taille seule.
  4. Arrêt sur toute erreur de copie (le SDK réessaie déjà les erreurs transitoires) : une coupure réseau impose une
     relance manuelle ; reprise fine en 3.2.
  5. Une ligne journalisée `copie`/`deja_present` n'est plus vérifiée à la relance (pas de HEAD) : la contre-vérification
     de l'arrivée relève du rapport 3.3.
  6. Erreur eslint préexistante dans `src/index.ts` (`validateConfig`), non corrigée.
- Écart au cycle red-green : tests écrits juste après le code de chaque module, validés par contre-épreuves.

### File List

- src/clients/archive-writer.ts (nouveau)
- src/inventory/plan-execution.ts (nouveau)
- src/database/repair-execution-model.ts (nouveau)
- src/commands/reparation.ts (nouveau)
- src/utils/bucket-name.ts (nouveau)
- src/clients/types.ts (modifié : `ArchiveWriter`, `DestinationObject` ; types morts retirés)
- src/clients/s3-client.ts (modifié : `destinationClientConfig`)
- src/clients/cubbit.ts (supprimé)
- src/sync/sync-manager.ts (supprimé)
- src/commands/sync.ts (modifié : `sync` et `resume` désactivées)
- src/commands/status.ts (modifié : index local seul)
- src/inventory/repair-plan.ts (modifié : validation des noms de bucket)
- package.json, package-lock.json (modifiés : `@aws-sdk/lib-storage` retiré)
- src/config/types.ts (modifié : paire d'identifiants de destination)
- src/config/index.ts (modifié : `CUBBIT_DESTINATION_ACCESS_KEY_ID` / `CUBBIT_DESTINATION_SECRET_ACCESS_KEY`)
- src/database/connection.ts (modifié : migration 7)
- src/index.ts (modifié : commande `reparation`)
- config/.env.example (modifié)
- tests/fixtures/fake-s3.ts (nouveau)
- tests/clients/archive-writer.test.ts (nouveau)
- tests/inventory/plan-execution.test.ts (nouveau)
- tests/database/repair-execution-model.test.ts (nouveau)
- tests/commands/reparation.test.ts (nouveau)
- tests/commands/sync.test.ts (nouveau)
- tests/sync/sync-manager.test.ts (supprimé)
- tests/inventory/repair-plan.test.ts (modifié : noms de bucket)
- tests/database/connection.test.ts (modifié : 7 migrations)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-1-copier-l-archive-vers-le-bucket-dedie-selon-le-plan.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)
- _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md, prd.md, .memlog.md (modifications de l'orchestrateur, révision NFR-1, à commiter avec la story)

## Change Log

- 2026-09-15 : exécution du plan vers le bucket dédié — `gpb reparation executer` (simulation par défaut, confirmation par
  empreinte), point d'accès en écriture unique (copie serveur et HEAD, garde de cloisonnement, aucune suppression),
  vérification par HEAD (MD5 / multipart), journal d'exécution (migration 7), relance idempotente, arrêt sur Ctrl-C (FR-1b, FR-5, NFR-1).
- 2026-09-15 : revue `pr-reviewer` — `gpb sync`/`gpb resume` désactivées et code d'envoi hérité supprimé (BLOQUANT), noms de
  bucket validés, clé source contrôlée, objet présent multipart comparé par ETag, plan sans inventaire dédié refusé, verrou
  d'exécution exclusif (`--lever-verrou`), analyse statique renforcée, `HeadBucket` au contrôle d'accès, tests SIGINT et HEAD en erreur.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 2 passes : APPROUVER, aucun BLOQUANT restant.
- BLOQUANT corrigé : `gpb sync`/`resume` écrivaient dans `marceau` (zone source) hors du point d'accès, avec écrasement possible ; code d'écriture hérité supprimé, commandes désactivées jusqu'à l'epic 4.
- IMPORTANTS corrigés : noms de bucket non validés (casse), clé source non contrôlée par le point d'accès, `deja_present` multipart sur la taille seule, course entre deux exécutions (verrou), analyse statique contournable.
- Base réelle `data/app.db` vérifiée en lecture : schéma en version 6, la migration 7 (modifiée sur place pendant la story) s'appliquera proprement. Empreinte de la base inchangée pendant toute la story.
- Recommandation transmise à Marceau : activer le versioning sur `marceau-photos` avant l'exécution réelle (course résiduelle avec un écrivain externe).

### Consignes impératives pour la story 3.2
1. **Reprise des multipart** : une vidéo multipart copiée mais non journalisée (2e Ctrl-C, coupure, erreur SQLite juste après la copie) bloque aujourd'hui toute relance (« objet existant à examiner »), car `deja_present` exige un ETag identique et Cubbit peut renvoyer un ETag MD5 simple après copie. Journaliser `copie_en_cours` avant le `CopyObject` ; à la relance, pour une ligne dans cet état, accepter l'objet s'il passe `isVerifiedCopy` et le passer en `copie`. Garder `isSameAsSource` pour les objets que l'outil n'a pas écrits. À traiter avant la première exécution réelle.
2. **Verrou** : la levée compare le nom d'hôte ; un nom d'hôte changeant ou un `data/` partagé permet de lever le verrou d'une exécution vivante. Rafraîchir l'horodatage d'activité à chaque ligne et refuser la levée si la dernière activité est récente ; cela règle aussi le PID réutilisé (levée refusée indéfiniment aujourd'hui).
3. Restreindre l'exception `CreateDate` de l'analyse statique aux fichiers de datation.
