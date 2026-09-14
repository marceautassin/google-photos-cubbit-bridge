---
baseline_commit: 5b0e67d553647d65a39cf95186ee75875fcc19e1
---

# Story 1.1 : Rétablir une installation qui aboutit

Status: done

## Story

En tant que Marceau,
je veux que `npm install` puis une commande de l'outil aboutissent sur mon poste,
afin de pouvoir enfin exécuter l'outil que je dois utiliser.

**Exigences :** FR-21 — **Question tranchée :** Q2 (moteur d'index)

## Acceptance Criteria

1. **Étant donné** un poste avec Node 24.13 et un dépôt fraîchement cloné, **quand** j'exécute
   `npm install`, **alors** l'installation aboutit sans erreur de compilation native.
2. **Et** `npx tsc --noEmit` ne rapporte aucune erreur.
3. **Et** `npm test` s'exécute (vert).
4. **Étant donné** que `better-sqlite3@9.1.1` est la cause du blocage (`node-gyp`), **quand** Q2
   est tranchée, **alors** le choix du moteur d'index est consigné en une ligne dans le dépôt,
   avec sa raison.
5. **Et** la solution retenue ne réintroduit pas de dépendance à compiler.
6. **Étant donné** que l'index est reconstructible depuis le bucket (FR-1), la solution la plus
   simple qui marche l'emporte (KISS).

## Décision Q2

**Moteur d'index : `node:sqlite` (intégré à Node ≥ 22.16) — aucune dépendance native, API
synchrone quasi identique à `better-sqlite3`, donc migration minimale du code existant.**

Alternatives écartées :
- montée de version de `better-sqlite3` : reste un module natif (prébuilds ou `node-gyp`),
  le problème peut revenir à chaque version majeure de Node ;
- `sql.js` : WASM en mémoire, écriture disque manuelle, API différente → plus de code ;
- JSON/JSONL : oblige à réécrire tous les modèles (`models.ts`) et les requêtes → plus de code
  maintenant, alors que les epics 2 et 4 redéfiniront de toute façon le contenu de l'index.

Contrepartie connue : `node:sqlite` émet un `ExperimentalWarning` au chargement sous Node 24.
Acceptable pour un outil perso ; l'index étant reconstructible, une évolution d'API n'est pas
un risque de perte de données.

## Tasks / Subtasks

- [x] T1 — Retirer `better-sqlite3` (AC 1, 5)
  - [x] Supprimer `better-sqlite3` et `@types/better-sqlite3` de `package.json`
  - [x] Monter `@types/node` à une version qui type `node:sqlite` (^24)
  - [x] `engines.node` → `>=22.16.0` (relevé en revue : `backup()` de `node:sqlite` n'existe que depuis 22.16 / 23.8)
  - [x] Régénérer `package-lock.json` via `npm install`
- [x] T2 — Migrer `src/database/connection.ts` vers `node:sqlite` (AC 4, 5)
  - [x] `new DatabaseSync(path)` ; `pragma()` → `exec('PRAGMA …')`
  - [x] `transaction()` → `BEGIN` / `COMMIT` / `ROLLBACK` explicites
  - [x] `db.backup(path)` → fonction `backup(db, path)` de `node:sqlite`
  - [x] Commentaire d'une ligne consignant le choix Q2 à l'initialisation du moteur
- [x] T3 — Adapter `src/database/models.ts` (AC 2)
  - [x] Type `DatabaseSync` ; `undefined` n'est pas liable dans `node:sqlite` → `?? null`
  - [x] `lastInsertRowid` peut être `bigint` → `Number(...)`
- [x] T4 — Rendre `npm test` exécutable (AC 3)
  - [x] `jest.config.js` référence `tests/` et `tests/setup.ts`, inexistants : corriger
  - [x] Ajouter un test de fumée de la couche base (migrations + CRUD sur base temporaire)
- [x] T5 — Vérifications brutes (`rtk proxy`) : `npm install`, `npx tsc --noEmit`, `npm test`

## Dev Notes

### État actuel (à lire avant de modifier)

- `src/database/connection.ts` : singleton `db`, `initDatabase` (crée le dossier, pragmas WAL /
  NORMAL / foreign_keys, migrations versionnées dans `schema_version` via transaction),
  `getDatabase`, `closeDatabase`, `backupDatabase`, `restoreDatabase`. Appelé par
  `src/index.ts` au démarrage de toute commande.
- `src/database/models.ts` : `SyncRecordModel`, `SyncSessionModel`, `AppMetadataModel`, qui
  n'utilisent que `prepare().run/get/all` — API compatible avec `StatementSync`.
- Consommateurs : `commands/takeout.ts`, `commands/status.ts`, `sync/sync-manager.ts`,
  `utils/fix-dates.ts`, `utils/fix-cubbit-paths.ts` (ces deux derniers seront supprimés en 1.3 :
  ne pas les toucher).
- **Piège :** le script `prepare` lance `npm run build` (`tsc`) pendant `npm install`. Si la
  compilation TypeScript échoue, `npm install` échoue aussi. AC 1 dépend donc d'AC 2.
- **Piège :** `jest.config.js` pointe vers `tests/` et `tests/setup.ts`, absents du dépôt → Jest
  plante avant de lancer le moindre test.

### À préserver

- Schéma et migrations inchangés (le contenu de l'index sera redéfini en epics 2/4, pas ici).
- Signatures publiques de `connection.ts` et `models.ts` inchangées.

### Hors périmètre

- Suppression du code API Google (story 1.2), des scripts `fix-*` (story 1.3), du README (epic 5).

### Contraintes différences `better-sqlite3` → `node:sqlite`

- Pas de `pragma()`, `transaction()`, ni méthode `backup()` d'instance.
- Liaison de `undefined` refusée (lève une erreur) ; utiliser `null`.
- `node:sqlite` n'est disponible que sous le préfixe `node:` ; vérifier que Jest le résout.

### Tests

- Jest + ts-jest, tests dans `tests/` (exclu de `tsc` par `tsconfig.json`).
- Aucune écriture hors répertoire temporaire, aucun accès réseau, aucun `.env`.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 1.1]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#4.5, #Q2]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/addendum.md#Index local]
- [Source: CLAUDE.md#Qualité de code]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- Red : test de la couche base en échec (`Cannot find module 'better-sqlite3'`) après retrait de la dépendance.
- Green : `npx tsc --noEmit` code 0 ; `npm test` 5/5 verts, code 0.
- `rm -rf node_modules dist && npm install` : code 0, `prepare` (`tsc`) exécuté, aucune trace de `node-gyp`.
- Smoke CLI : `node dist/index.js --help` code 0 (les dossiers `data/` et `logs/` créés par ce lancement ont été supprimés).

### Completion Notes List

- Q2 tranchée : `node:sqlite` (voir section « Décision Q2 » et commentaire dans `src/database/connection.ts`).
- `connection.ts` : `DatabaseSync`, pragmas via `exec`, migrations en `BEGIN/COMMIT/ROLLBACK`, `backup()` du module (désormais réellement asynchrone, attendu).
- `models.ts` : liaison `undefined` → `null` (create et update), `lastInsertRowid` → `Number(...)`. Signatures publiques inchangées.
- `jest.config.js` : retrait de `setupFilesAfterEnv` pointant vers `tests/setup.ts` inexistant ; ajout de `tests/database/connection.test.ts`.
- `package.json` : retrait `better-sqlite3` et `@types/better-sqlite3`, `@types/node` ^24.10.0, `engines.node` >=22.16.0.
- À signaler, hors périmètre : `npm run lint` est cassé avant cette story (`.eslintrc.json` étend `@typescript-eslint/recommended` au lieu de `plugin:@typescript-eslint/recommended`) ; `npm audit` remonte 46 vulnérabilités préexistantes ; `node:sqlite` émet un `ExperimentalWarning` sur stderr.
- Stories 1.2 / 1.3 non touchées (aucune modification nécessaire pour que `tsc` passe).

### File List

- package.json (modifié)
- package-lock.json (modifié)
- jest.config.js (modifié)
- src/database/connection.ts (modifié)
- src/database/models.ts (modifié)
- tests/database/connection.test.ts (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-14 : moteur d'index migré de `better-sqlite3` vers `node:sqlite` (Q2), installation et tests rétablis.
