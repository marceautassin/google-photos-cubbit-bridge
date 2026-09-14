---
baseline_commit: 9898225
---

# Story 2.1 : Inventorier le bucket entier

Status: done

## Story

En tant que Marceau,
je veux un inventaire complet du bucket, sans qu'aucun préfixe ne soit présumé,
afin de ne pas répéter l'erreur d'avoir cru que mes photos tenaient dans un seul dossier.

**Exigences :** FR-1 — **NFR :** NFR-2 (lecture seule), NFR-6 (reprise), NFR-8 (volumétrie), NFR-9 (secrets), NFR-10 (français), NFR-11 (qualité)

## Acceptance Criteria

1. **Étant donné** des identifiants en lecture sur le bucket `marceau`, **quand** je lance la
   commande d'inventaire, **alors** tous les objets du bucket sont listés, **sans filtre de préfixe
   en dur** (aucun `Prefix` transmis à `ListObjectsV2`).
2. **Et** clé, taille, date de modification (et ETag, utile à la story 2.3) sont conservées pour chacun.
3. **Et** l'inventaire est persisté localement et **rejouable sans nouvel appel réseau**.
4. **Étant donné** un inventaire terminé, **quand** je consulte le résultat, **alors** les emplacements
   contenant des médias sont identifiés et présentés avec leur volumétrie, **y compris hors de
   `backup_google_photos/`**. La détection « média » repose sur `config.sync.supportedFormats`.
5. **Étant donné** que le bucket contient des données perso et pro hors périmètre, **quand**
   l'inventaire s'exécute, **alors** il est strictement en lecture — aucune écriture, aucune
   suppression S3. Un test le vérifie (seules des commandes `ListObjectsV2` sont envoyées).
6. **Étant donné** les identifiants du bucket source, **quand** l'outil les charge, **alors** ils
   proviennent du `.env` non versionné (config existante) **et** n'apparaissent jamais dans la console
   ni dans les journaux.
7. **Étant donné** une interruption réseau en cours de listing, **quand** je relance la commande,
   **alors** l'inventaire aboutit sans état corrompu (l'inventaire précédent reste intact tant qu'un
   nouveau listing complet n'a pas abouti).
8. (Évolutivité, story 3.1) Le bucket source est paramétrable (option CLI, défaut = bucket de la config).

## Tasks / Subtasks

- [x] T1 — Client S3 en lecture seule (AC 1, 5, 6, 8)
  - [x] Extraire la construction du `S3Client` dans `src/clients/s3-client.ts` (`createS3Client`),
        réutilisée par `CubbitClient` (DRY)
  - [x] `src/clients/bucket-lister.ts` : `S3BucketLister` qui n'importe et n'envoie **que**
        `ListObjectsV2Command`, paginé par `ContinuationToken`, sans `Prefix` ; bucket en paramètre
  - [x] Interface `BucketLister` + type `BucketObject` dans `src/clients/types.ts`
- [x] T2 — Persistance (AC 2, 3, 7)
  - [x] Migration 4 : tables `inventory_objects` (bucket, key, size, last_modified, etag ; PK bucket+key)
        et `inventory_runs` (bucket PK, completed_at, object_count, total_size)
  - [x] `src/database/inventory-model.ts` : `replace(bucket, objects)` en **une transaction**
        (DELETE + INSERT + upsert du run), `findAll(bucket)`, `findRun(bucket)`
  - [x] Adapter `tests/database/connection.test.ts` (version 3 → 4)
- [x] T3 — Inventaire et restitution (AC 1, 4, 7)
  - [x] `src/inventory/inventory.ts` : `scanBucket(lister, onProgress?)` accumule toutes les pages en
        mémoire ; `summarizeInventory(objects, supportedFormats, depth)` pur (groupement par préfixe de
        dossier tronqué à `depth` segments, médias/volume, extensions non reconnues les plus fréquentes)
- [x] T4 — Commande CLI (AC 3, 4, 6, 8)
  - [x] `src/commands/inventory.ts` : `gpb inventory scan [--bucket <nom>] [--depth <n>]` et
        `gpb inventory show [--bucket <nom>] [--depth <n>]` (hors ligne) ; enregistrement dans `src/index.ts`
  - [x] Messages en français ; jamais d'identifiant affiché ; erreur de listing → message « rien n'a été
        modifié, relancez »
- [x] T5 — Tests (client S3 mocké, aucun réseau, aucun `.env`)
  - [x] Lister : pagination sur plusieurs pages, `Bucket` transmis, pas de `Prefix`, seules des
        `ListObjectsV2Command` envoyées
  - [x] Inventaire : objets hors préfixe photo conservés et présentés ; interruption en page 2 → inventaire
        précédent intact ; relance → inventaire complet remplacé
  - [x] Restitution : groupement, profondeur, extensions non reconnues
- [x] T6 — Vérifications brutes (`rtk proxy`) : `npx tsc --noEmit`, `npm test`, `npm run clean && npm run build`,
      `node dist/index.js --help` et `inventory --help` ; suppression de `data/` et `logs/`
- [x] T7 — Corrections de revue `pr-reviewer`
  - [x] [AI-Review][BLOQUANT] Pagination : `isTruncated` remonté dans `BucketObjectPage`, arrêt sur `!isTruncated`,
        erreur si page tronquée sans jeton (plus d'inventaire tronqué enregistré comme complet)
  - [x] [AI-Review][IMPORTANT] Terminaison : erreur si un jeton de continuation est reçu deux fois
  - [x] [AI-Review][MINEUR] Objet sans `Key` ou sans `Size` → erreur (plus de filtrage ni de taille 0 silencieux)
  - [x] [AI-Review][MINEUR] Toutes les extensions non reconnues affichées, triées par nombre (plus de `slice(0, 10)`)
  - [x] [AI-Review][MINEUR] `objects.push(...page.objects)` → boucle `for…of`
  - [x] [AI-Review][MINEUR] ROLLBACK en échec ne masque plus l'erreur d'origine
  - [x] [AI-Review][MINEUR] Tests de pagination : page sans `Contents` (bucket vide, page intermédiaire vide)

## Dev Notes

### État actuel (lu avant modification)

- `src/index.ts` : charge la config (`.env` via `dotenv` dans `src/config/index.ts`), initialise logger et
  base (`initDatabase`, migrations 1–3 dans `connection.ts`), enregistre `setup`, `sync`, `status`,
  `takeout` (`register(program, config)`) et `archive`. La base est donc disponible hors ligne pour toute
  commande.
- `src/clients/cubbit.ts` : `CubbitClient` mêle lecture et écriture (`PutObject`, `Upload`,
  `CreateBucket`), bucket figé sur `config.cubbit.bucket`, `listFiles(prefix)` ne rend que les clés et
  s'arrête à `maxKeys`. **Ne pas l'utiliser pour l'inventaire** : il expose l'écriture et perd taille/date.
  Seul son constructeur `S3Client` est à mutualiser.
- `isSupportedFormat(filename, formats)` (`src/utils/file-utils.ts`) : réutiliser pour la détection média.
- `formatBytes` existe en double (`utils/format.ts` et `utils/file-utils.ts`) — dette préexistante, ne pas
  en créer une troisième.
- `config.sync.supportedFormats` par défaut : jpg, jpeg, png, gif, bmp, webp, mp4, mov, avi, mkv — **pas de
  HEIC ni 3GP**. Ne pas modifier les défauts (impacte `takeout import`) ; la restitution affiche les
  extensions non reconnues les plus fréquentes pour que rien ne passe inaperçu.

### Décisions

- **Persistance : l'index `node:sqlite` existant** (migration 4), pas un fichier à part. Raisons : la base
  est déjà ouverte au démarrage (rien à ajouter), les stories 2.2–2.4 agrégeront sur cet inventaire (dates,
  doublons nom+taille → `GROUP BY`), et le remplacement atomique est gratuit via transaction.
- **Reprise = listing complet en mémoire puis remplacement transactionnel.** ~18 000 objets ≈ 18 requêtes
  et quelques Mo en mémoire : reprendre au `ContinuationToken` ne vaut pas sa complexité (KISS). Une
  coupure pendant le listing n'écrit rien ; une coupure pendant la transaction est annulée par SQLite.
- **Clé `bucket` dans les tables** : un inventaire par bucket, le bucket dédié de l'epic 3 pourra être
  inventorié sans migration.
- **ETag stocké sans guillemets** (forme brute S3 `"…"`), pour faciliter la comparaison en 2.3.
- **Lecture seule par construction** : le module d'inventaire ne dépend que de l'interface `BucketLister`
  (une seule méthode de listing) ; l'implémentation S3 n'importe que `ListObjectsV2Command`.
  Le cloisonnement réel reste la clé en lecture seule côté Cubbit (NFR-1/2).
- **Secrets** : identifiants lus par `loadConfig` ; la commande n'affiche que le nom du bucket ; les erreurs
  affichent `error.message` du SDK (pas les identifiants).

### Hors périmètre

- Dates (2.2), doublons/collisions (2.3), plan (2.4), état de l'archive (2.5), second jeu d'identifiants (3.1).

### Tests

- Jest + ts-jest, `tests/` miroir de `src/`, logger mocké (cf. `tests/sync/sync-manager.test.ts`), base
  temporaire dans `os.tmpdir()`. `S3Client` : objet `{ send: jest.fn() }`. Aucun réseau, bucket ou `.env`.

### Apprentissages des stories 1.1 à 1.3

- `rtk` tronque les sorties : `rtk proxy` + redirection + code de sortie.
- `node:sqlite` : pas d'aide aux transactions (`BEGIN/COMMIT/ROLLBACK` explicites, `isTransaction`),
  `undefined` non liable (→ `null`), `lastInsertRowid` peut être `bigint`.
- Régénérer `dist/` par `clean` + `build` ; supprimer `data/` et `logs/` créés par les exécutions.
- `tests/database/connection.test.ts` fige le nombre de migrations : à mettre à jour.
- Pas de commit : proposer seulement.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 2.1]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#4, #FR-1, #6]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/addendum.md#Inventaire brut, #Résidu]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/1-1-retablir-une-installation-qui-aboutit.md]
- [Source: CLAUDE.md#Qualité de code]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 5 suites, 20/20 verts (dont `tests/clients/bucket-lister.test.ts` 2 cas,
  `tests/inventory/inventory.test.ts` 6 cas).
- `npx eslint` sur les fichiers nouveaux/modifiés : code 0, 0 erreur (3 avertissements `any` préexistants dans `cubbit.ts`).
- `npm run clean` puis `npm run build` : code 0.
- `node dist/index.js --help` : code 0, `inventory` listée ; `inventory --help` (scan, show) et
  `inventory show --help` (`--bucket`, `--depth`, `--limit`) : code 0. `data/` et `logs/` créés supprimés.
- Aucun `inventory scan` réel lancé (pas d'accès au bucket dans ce contexte).
- Après revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 5 suites, 27/27 verts ; eslint sur les fichiers
  corrigés code 0 ; `npm run clean` + `npm run build` code 0 ; `node dist/index.js inventory --help` code 0 ;
  `data/` et `logs/` supprimés. Contre-épreuve : le test « ROLLBACK en échec » échoue sur l'ancien code (1 failed).

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Commande `gpb inventory scan [--bucket <nom>] [--depth <n>] [--limit <n>]` : liste le bucket entier
  (ListObjectsV2 paginé, aucun `Prefix`), remplace l'inventaire local, affiche la restitution.
  `gpb inventory show` : même restitution depuis l'index local, sans réseau.
- Persistance : migration 4 de l'index `node:sqlite` (`inventory_objects`, `inventory_runs`), clé par bucket.
  Remplacement en une transaction (`InventoryModel.replace`) après listing complet en mémoire.
- Lecture seule : `inventory.ts` ne dépend que de l'interface `BucketLister` ; `S3BucketLister` n'importe que
  `ListObjectsV2Command`. Test : toutes les commandes envoyées au client mocké sont des `ListObjectsV2Command`
  sans `Prefix`.
- Reprise : tests d'interruption en page 2 (inventaire précédent intact, relance complète) et d'échec en cours
  de transaction (rollback, inventaire précédent intact).
- Secrets : `createS3Client` extrait (DRY avec `CubbitClient`) ; seul `name: message` de l'erreur SDK est
  journalisé/affiché (l'objet d'erreur S3 peut porter l'`AWSAccessKeyId`).
- Restitution : emplacements = dossier tronqué à `--depth` segments (défaut 3 : sépare
  `backup_google_photos/photos/AAAA/` et `2_Personnel/Photos/google_photos/`), triés par volume ; extensions
  non reconnues les plus fréquentes signalées (les défauts `supportedFormats` n'incluent ni `heic` ni `3gp`).
- Revue `pr-reviewer` : 7 points corrigés (T7). Nouveaux tests : arrêt sur `IsTruncated: false` malgré un jeton,
  page tronquée sans jeton, jeton répété, page sans `Contents` (vide et intermédiaire), objet sans clé, objet sans
  taille, erreur d'origine relancée si le ROLLBACK échoue.
- Écart au cycle red-green : tests écrits juste après le code, dans la même passe (vert au premier lancement).

### File List

- src/clients/bucket-lister.ts (nouveau)
- src/clients/s3-client.ts (nouveau)
- src/clients/cubbit.ts (modifié)
- src/clients/types.ts (modifié)
- src/commands/inventory.ts (nouveau)
- src/database/connection.ts (modifié)
- src/database/inventory-model.ts (nouveau)
- src/inventory/inventory.ts (nouveau)
- src/index.ts (modifié)
- tests/clients/bucket-lister.test.ts (nouveau)
- tests/inventory/inventory.test.ts (nouveau)
- tests/database/connection.test.ts (modifié)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-1-inventorier-le-bucket-entier.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-14 : commande `gpb inventory` (scan/show) — inventaire du bucket entier en lecture seule, persisté
  dans l'index `node:sqlite` (migration 4), restitution des emplacements de médias (FR-1).
- 2026-09-14 : corrections de revue — 7 points résolus (pagination tronquée/cyclique, objets incomplets,
  extensions toutes affichées, ROLLBACK, boucle d'accumulation).

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 3 passes : APPROUVER, aucun BLOQUANT restant.
- BLOQUANT corrigé : pagination sans contrôle de `IsTruncated` (inventaire tronqué enregistré comme complet). Garde-fous ajoutés : page tronquée sans jeton, jeton répété, objet sans clé ou taille, champ `IsTruncated` absent (ajouté en dernier par l'orchestrateur, avec test). 28 tests.
- Accepté (KISS) : pas de plafond du nombre de pages.
- Non encore exécuté sur le vrai bucket : nécessite une clé en lecture seule sur `marceau`.
