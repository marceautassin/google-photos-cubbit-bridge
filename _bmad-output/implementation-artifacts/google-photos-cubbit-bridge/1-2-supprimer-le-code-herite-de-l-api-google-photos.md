---
baseline_commit: 722a607
---

# Story 1.2 : Supprimer le code hérité de l'API Google Photos

Status: done

## Story

En tant que Marceau,
je veux que le code de l'API Google Photos disparaisse du dépôt,
afin de ne plus croire, dans six mois, que `gpb auth login` fonctionne encore.

**Exigences :** FR-22

## Acceptance Criteria

1. **Étant donné** que l'API Google Photos est fermée depuis le 1er avril 2025, **quand** le
   nettoyage est appliqué, **alors** `src/auth/`, `src/clients/google-photos.ts`, les commandes
   `auth` et `list`, `debug-scopes.js` et `check-photos-scopes.js` n'existent plus.
2. **Et** aucune référence à ces modules ne subsiste dans le code ni dans `package.json`
   (imports, config `googlePhotos`, variables `GOOGLE_*`, dépendances devenues inutiles).
3. **Étant donné** que `src/utils/crypto-utils.ts` peut resservir pour les secrets Cubbit,
   **quand** je passe en revue ce qui est supprimé, **alors** ce module est conservé avec une
   affectation explicite, **ou** il est supprimé faute d'usage réel (choix consigné).
4. **Étant donné** le nettoyage terminé, **quand** j'exécute `npx tsc --noEmit` et `npm test`,
   **alors** les deux passent.
5. (Vérification) `node dist/index.js --help` après build fonctionne et ne liste plus `auth`
   ni `list`.

## Tasks / Subtasks

- [x] T1 — Supprimer les fichiers hérités (AC 1)
  - [x] `src/auth/` (`google-auth.ts`, `token-manager.ts`)
  - [x] `src/clients/google-photos.ts`
  - [x] `src/commands/auth.ts`, `src/commands/list.ts` + enregistrement dans `src/index.ts`
  - [x] `debug-scopes.js`, `check-photos-scopes.js`
- [x] T2 — Retirer la partie Google de `sync` sans réécrire la logique Takeout (AC 2)
  - [x] `src/sync/sync-manager.ts` : plus de `GooglePhotosClient` ; seule source = enregistrements
        Takeout `pending` ; plus de branche de téléchargement distant (source locale absente → erreur
        sur l'enregistrement) ; options `albumId`, `albumTitle`, `dateRange`, `mediaTypes`,
        `takeoutOnly` retirées (n'avaient de sens qu'avec l'API)
  - [x] `src/commands/sync.ts` : options `--album`, `--album-id`, `--from`, `--to`, `--type`,
        `--all`, `--takeout-only` retirées ; restent `--force`, `--dry-run`, `--concurrent`
  - [x] `src/commands/takeout.ts` : suggestion `gpb sync --all` → `gpb sync`
- [x] T3 — Configuration (AC 2)
  - [x] `src/config/types.ts` : bloc `googlePhotos` et `SearchFilters` retirés
  - [x] `src/config/index.ts` : défauts `GOOGLE_*`, fusion et validation Google retirés
  - [x] `src/commands/setup.ts` : questions Google et « prochaines étapes » `auth`/`list` retirées
  - [x] `config/.env.example`, `config/config.example.json`, `config/config.json.backup` : bloc Google retiré
  - [x] `src/clients/types.ts` : type `Album` (API seule) retiré
- [x] T4 — `crypto-utils.ts` (AC 3) : trancher et consigner
- [x] T5 — `package.json` : retirer `googleapis`, `open`, `axios`, et `crypto-js` + `@types/crypto-js`
      si T4 supprime le module — après vérification d'usage ; régénérer le lock (AC 2)
- [x] T6 — Bonus lint : corriger l'`extends` de `.eslintrc.json`, lancer le lint, compter les erreurs
      sans les corriger en masse
- [x] T8 — Corrections de revue `pr-reviewer`
  - [x] [AI-Review][IMPORTANT] `sync --force` écrasait chemin et métadonnées d'import : `createSyncRecords`
        et son appel supprimés, option `--force` retirée de `sync` (le renvoi passe par `takeout import --force`) ;
        indication `gpb sync --force` de `status` remplacée
  - [x] [AI-Review][IMPORTANT] Code mort : commande `cleanup`, `SyncManager.cleanup()`, `sync.downloadPath`
        (type, défauts, `ensureDir`, exemples de config) et indication `gpb cleanup` de `status` supprimés
  - [x] [AI-Review][MINEUR] `CubbitClient.generateStoragePath` sans appelant supprimé
  - [x] [AI-Review][MINEUR] `dist/` régénéré (`npm run clean` puis `npm run build`)
- [x] T7 — Vérifications brutes (`rtk proxy`) : `tsc --noEmit`, `npm test`, build + `--help`,
      nettoyage de `data/` et `logs/` créés

## Dev Notes

### État actuel (lu avant modification)

- `src/index.ts` enregistre `setup`, `auth`, `list`, `sync` (+ `resume`, `cleanup`), `status`,
  `takeout`, `archive`.
- `GooglePhotosClient` est consommé par `commands/auth.ts`, `commands/list.ts`, `commands/sync.ts`
  (vérif d'auth + résolution d'album par nom) et `sync/sync-manager.ts` (vérif d'auth,
  listage d'albums/recherche, téléchargement des médias distants).
- `sync-manager.ts` a déjà un mode `takeoutOnly` : il lit les `sync_records` `pending` de source
  `takeout` et envoie le fichier local (`googleUrl` contient le chemin local). C'est **la seule
  logique encore valide** : elle devient le comportement unique.
- **Piège existant :** `takeout import` suggère `gpb sync --all`, qui exigeait l'auth Google
  (sans `--takeout-only`). Après la story, `gpb sync` suffit.
- `crypto-utils.ts` n'est importé que par `auth/token-manager.ts` (chiffrement des tokens OAuth
  avec une clé dérivée du nom d'hôte). Les secrets Cubbit vivent en clair dans `.env` et aucune
  story des epics 2–4 ne prévoit de les chiffrer.
- `commands/status.ts` n'utilise pas l'API ; l'affichage `session.config.albumTitle` concerne
  d'anciennes sessions en base — à laisser.

### À préserver

- Schéma SQLite et noms de colonnes (`google_photo_id`, `google_url`) inchangés : l'index sera
  redéfini en epics 2/4. Ce ne sont pas des références au module supprimé.
- `MediaItem` (`clients/types.ts`) reste utilisé par `takeout-scanner.ts`.
- `resume`, `cleanup`, `status`, `takeout`, `archive` inchangés fonctionnellement.

### Hors périmètre

- `src/utils/fix-dates.ts`, `fix-cubbit-paths.ts` (story 1.3), README/QUICKSTART (story 5.2),
  logique métier des epics 2–4, correction en masse des erreurs de lint préexistantes.

### Tests

- Jest + ts-jest, `tests/`. Pas de test nouveau pertinent pour une suppression : la non-régression
  est garantie par `tsc` (références mortes) et le test existant de la couche base. Aucun accès
  réseau, bucket ou `.env`.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 1.2]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#FR-22]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/1-1-retablir-une-installation-qui-aboutit.md]
- [Source: CLAUDE.md#Qualité de code, #Architecture]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npm uninstall axios googleapis open crypto-js @types/crypto-js` : code 0 (le `prepare` → `tsc` passe).
- `npx tsc --noEmit` : code 0.
- `npm test` : code 0, 1 suite, 5/5 verts.
- `npm run build` : code 0 ; `node dist/index.js --help` : code 0, commandes listées : setup, sync, resume,
  cleanup, status, history, takeout, archive (plus de `auth` ni `list`). Dossiers `data/` et `logs/` créés
  par ce lancement supprimés.
- `npm run lint` (après correction de config) : s'exécute, code 1, 53 problèmes (17 erreurs, 36 avertissements),
  tous préexistants (imports inutilisés, `prefer-const`, échappements inutiles) — non corrigés.
- Après revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 (5/5) ; `npm run clean` code 0 ;
  `npm run build` code 0 ; `node dist/index.js --help` code 0 (setup, sync, resume, status, history,
  takeout, archive) ; `node dist/index.js sync --help` code 0 (`--dry-run`, `--concurrent`) ; `data/` et
  `logs/` supprimés. Grep `createSyncRecords|cleanup|downloadPath|temp_downloads|generateStoragePath`
  dans `src`, `config`, `tests` : seule occurrence `archive cleanup` (nettoyage d'extractions Takeout, légitime).
- Recherche `axios|googleapis|crypto-js|open|crypto-utils|google-photos|/auth/|GOOGLE_|googlePhotos|SearchFilters|Album`
  dans `src`, `tests`, `config`, `package.json` : plus aucune référence aux modules supprimés.

### Completion Notes List

- Pas de test ajouté : story de suppression ; `tsc` garantit l'absence de référence morte, le test
  de la couche base garantit la non-régression.
- **crypto-utils supprimé** : unique consommateur = `auth/token-manager.ts` (tokens OAuth). Les secrets
  Cubbit sont lus en clair depuis `.env` et aucune story des epics 2–4 ne prévoit leur chiffrement ;
  `sha256`/`generateId` n'étaient utilisés nulle part. Conserver un module sans usage contredit KISS ;
  `crypto-js` et `@types/crypto-js` retirés avec lui.
- **Commandes supprimées** : `auth` (login/logout/status OAuth) et `list` (albums/photos via l'API).
- Revue `pr-reviewer` : corrections appliquées (voir T8). `sync` n'a plus que `--dry-run` et
  `--concurrent` ; `cleanup` supprimée ; `generateStoragePath` supprimé. L'entrée `temp_downloads/`
  du `.gitignore` est volontairement conservée (dossiers locaux éventuels).
- **Commande `sync` modifiée (avant revue)** : le mode Takeout devient le seul mode. Options `--album`, `--album-id`,
  `--from`, `--to`, `--type`, `--all`, `--takeout-only` retirées (elles pilotaient l'API). Restent
  `--force`, `--dry-run`, `--concurrent`. `SyncManager` : plus de vérif d'auth ni de téléchargement
  distant ; une source locale absente met l'enregistrement en erreur.
- **Commande `setup` modifiée** : questions OAuth Google et prochaines étapes `auth`/`list` retirées,
  remplacées par `takeout import` puis `sync`. `takeout import` suggère désormais `gpb sync` (l'ancien
  `gpb sync --all` exigeait l'auth Google : chemin cassé).
- Config : bloc `googlePhotos`, variables `GOOGLE_*`, validation Google et type `SearchFilters` retirés ;
  type `Album` retiré de `clients/types.ts`. Bloc Google retiré aussi de `config/config.json.backup`
  (placeholders uniquement, doublon de `config.example.json`).
- Dépendances retirées : `googleapis`, `open`, `axios`, `crypto-js`, `@types/crypto-js`.
- Bonus lint : `.eslintrc.json` étend `plugin:@typescript-eslint/recommended`.
- Dette identifiée (hors périmètre, notée en revue) :
  - `status.ts` affiche encore `albumTitle`/`dateRange`/`mediaTypes` des anciennes sessions ;
  - statut `DOWNLOADING`, champs `MediaItem.baseUrl`/`productUrl`, colonne `googleUrl` qui stocke un chemin local ;
  - `resumeSync` ne reprend que les enregistrements `PENDING` → à traiter en story reprise 3.2 / 4.4.
- À signaler : les colonnes SQLite
  `google_photo_id`/`google_url` sont conservées (index redéfini en epics 2/4). `status.ts` affiche
  encore `albumTitle` des anciennes sessions en base. Une config utilisateur `config/config.json`
  contenant encore `googlePhotos` reste chargée sans erreur (clé ignorée).

### File List

- .eslintrc.json (modifié)
- package.json (modifié)
- package-lock.json (modifié)
- config/.env.example (modifié)
- config/config.example.json (modifié)
- config/config.json.backup (modifié)
- check-photos-scopes.js (supprimé)
- debug-scopes.js (supprimé)
- src/auth/google-auth.ts (supprimé)
- src/auth/token-manager.ts (supprimé)
- src/clients/google-photos.ts (supprimé)
- src/clients/cubbit.ts (modifié)
- src/clients/types.ts (modifié)
- src/commands/auth.ts (supprimé)
- src/commands/list.ts (supprimé)
- src/commands/setup.ts (modifié)
- src/commands/status.ts (modifié)
- src/commands/sync.ts (modifié)
- src/commands/takeout.ts (modifié)
- src/config/index.ts (modifié)
- src/config/types.ts (modifié)
- src/index.ts (modifié)
- src/sync/sync-manager.ts (modifié)
- src/utils/crypto-utils.ts (supprimé)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-14 : suppression du code hérité de l'API Google Photos (FR-22) ; `sync` limité aux imports Takeout ; crypto-utils supprimé ; config ESLint réparée.
- 2026-09-14 : corrections de revue — 4 points résolus (`createSyncRecords`/`--force`, `cleanup`/`downloadPath`, `generateStoragePath`, `dist/`).

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 3 passes ; verdict final APPROUVER, aucun BLOQUANT.
- Corrigé après approbation : `sync --dry-run` passait les enregistrements en `SYNCED` sans rien envoyer (défaut préexistant) — la simulation ne modifie plus aucun statut. Test `tests/sync/sync-manager.test.ts`, vérifié en échec sur l'ancien comportement. Import `--force` : `errorMessage` et `syncDate` remis à zéro. Imports inutilisés retirés de `sync-manager.ts`.
- Dette supplémentaire : en simulation, le résumé final affiche le compteur global de `SYNCED` au lieu du nombre d'éléments qui seraient envoyés ; 5 erreurs eslint préexistantes dans `takeout.ts`.
