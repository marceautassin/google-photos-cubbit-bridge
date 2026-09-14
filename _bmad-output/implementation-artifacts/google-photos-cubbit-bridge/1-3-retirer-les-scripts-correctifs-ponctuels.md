---
baseline_commit: 2aab0e6
---

# Story 1.3 : Retirer les scripts correctifs ponctuels

Status: done

## Story

En tant que Marceau,
je veux que `fix-dates.ts` et `fix-cubbit-paths.ts` disparaissent,
afin que personne ne les relance et ne recrée les dégâts qu'ils ont produits.

**Exigences :** FR-23

## Acceptance Criteria

1. **Étant donné** que ces deux scripts ont corrigé les chemins en base sans déplacer les objets S3,
   produisant 4 820 doublons, **quand** ils sont retirés, **alors** `src/utils/fix-dates.ts` et
   `src/utils/fix-cubbit-paths.ts` n'existent plus.
2. **Et** `extractDateFromFilename` (`src/utils/file-utils.ts`), dont ils dépendaient, est conservé
   **sans modification**.
3. **Étant donné** leur suppression, **quand** j'exécute `npx tsc --noEmit`, **alors** la compilation passe.
4. (Vérification) Aucune référence restante hors `_bmad-output` :
   `grep -rn "fix-dates\|fix-cubbit-paths\|fixDatesInDatabase\|fixCubbitPathsInDatabase"` (hors
   `node_modules`, `.git`) ; `npm test` et `npm run build` passent.
5. (Documentation du comportement) Un test unitaire de `extractDateFromFilename` fige son comportement
   **actuel** sur des noms réels du bucket, y compris des noms sans date — sans modifier la fonction
   (la correction éventuelle relève de la story 2.2).

## Tasks / Subtasks

- [x] T1 — Supprimer `src/utils/fix-dates.ts` et `src/utils/fix-cubbit-paths.ts` (AC 1)
- [x] T2 — Vérifier l'absence de référence : `package.json` (scripts), `src/index.ts` (commandes),
      `jest.config.js`, imports ; régénérer `dist/` (`npm run clean` puis `npm run build`) pour
      purger les artefacts compilés périmés (AC 4)
- [x] T3 — Test `tests/utils/file-utils.test.ts` sur `extractDateFromFilename` (AC 2, 5)
  - [x] `IMG_20230101_120000.jpg`, `PXL_20240315_180000123.jpg`, `VID_20250720_144314853.mp4`,
        `20170326_173149.jpg` : date attendue
  - [x] `IMG_0005.JPG`, `f3aba967-9be6-45bd-bdae-fe26540ea847.jpg` : comportement actuel (null attendu)
  - [x] Assertions indépendantes du fuseau (composantes locales `getFullYear()`… : la fonction construit
        `new Date(y, m-1, d, h, mi, s)` en heure locale)
- [x] T4 — Vérifications brutes (`rtk proxy`) : `tsc --noEmit`, `npm test`, `npm run build`, grep ;
      suppression de `data/` et `logs/` éventuellement créés (AC 3, 4)

## Dev Notes

### État actuel (lu avant modification)

- `fix-dates.ts` et `fix-cubbit-paths.ts` sont des scripts autonomes (`#!/usr/bin/env node`, appel
  direct via `require.main`), qui ouvrent la base, réécrivent dates/chemins Cubbit des `sync_records`
  et exportent `fixDatesInDatabase` / `fixCubbitPathsInDatabase`. **Aucun import** ailleurs dans `src/`,
  aucun script npm, aucune commande CLI, rien dans `jest.config.js` : la suppression est isolée.
- `dist/utils/fix-*.js` existent (artefacts compilés, `dist/` ignoré par git) : `tsc` ne supprime pas
  les sorties orphelines → `npm run clean` avant `npm run build`.
- `extractDateFromFilename` **garde des appelants** : `src/takeout/takeout-parser.ts` (l. 199 et 236),
  qui la préfère à `photoTakenTime` du JSON, puis retombe sur le JSON ou `stats.mtime`. La fonction
  elle-même renvoie `null` quand aucun motif ne correspond (pas de date du jour).
- Motifs de la fonction : préfixe `IMG|DSC|PHOTO|VID|MOV` + `YYYYMMDD_HHMMSS`, puis `\d{8}_?\d{6}`
  générique (couvre `PXL_…`, millisecondes ignorées), WhatsApp `IMG-YYYYMMDD-`, `YYYY-MM-DD_HH-MM-SS`,
  `YYYY.MM.DD_HH.MM.SS`. Date construite en **heure locale** ; année bornée à `année courante + 1`.

### À préserver

- `src/utils/file-utils.ts` inchangé. `takeout-parser.ts` inchangé.

### Hors périmètre

- README (story 5.2), toute logique de datation nouvelle ou correction de `extractDateFromFilename`
  (epic 2, story 2.2), correction des erreurs de lint préexistantes.

### Tests

- Jest + ts-jest, dossier `tests/` miroir de `src/`. Mock du logger comme dans
  `tests/sync/sync-manager.test.ts` (`getLogger` appelé dans le `catch`). Aucun accès réseau, bucket ou `.env`.

### Apprentissages des stories 1.1 / 1.2

- `rtk` tronque les sorties : `rtk proxy` + redirection + code de sortie.
- Régénérer `dist/` par `clean` + `build` (point de revue 1.2).
- Supprimer `data/` et `logs/` créés par les exécutions.
- Pas de commit : proposer seulement.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 1.3]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#FR-23]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/1-2-supprimer-le-code-herite-de-l-api-google-photos.md]
- [Source: CLAUDE.md#Qualité de code]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 3 suites, 12/12 verts (dont `tests/utils/file-utils.test.ts`, 6 cas).
- `npm run clean` puis `npm run build` : code 0 ; plus aucun `dist/utils/fix-*`.
- `grep -rn "fix-dates\|fix-cubbit-paths\|fixDatesInDatabase\|fixCubbitPathsInDatabase"` hors
  `node_modules`, `.git`, `_bmad-output` : aucune occurrence (code 1).
- `npx eslint src/utils/file-utils.ts` : code 0.
- Aucun dossier `data/` ni `logs/` créé.

### Completion Notes List

- Les deux scripts n'avaient aucune référence (ni script npm, ni commande CLI, ni import, ni config
  jest) : suppression des seuls fichiers source ; `dist/` régénéré pour purger les artefacts compilés.
- `extractDateFromFilename` non modifiée ; elle garde deux appelants dans `takeout-parser.ts`.
- Test de caractérisation, comportement actuel observé (heure locale) :
  `IMG_20230101_120000.jpg` → 2023-01-01 12:00:00 ; `PXL_20240315_180000123.jpg` → 2024-03-15 18:00:00
  (préfixe PXL non listé, capté par le motif générique, ms ignorées) ; `VID_20250720_144314853.mp4` →
  2025-07-20 14:43:14 (ms ignorées) ; `20170326_173149.jpg` → 2017-03-26 17:31:49 ; `IMG_0005.JPG` et
  `f3aba967-…-fe26540ea847.jpg` → `null` (pas de repli sur la date du jour dans la fonction ; le repli
  JSON / `mtime` est dans `takeout-parser.ts`).
- Pas de phase « rouge » : le test fige un comportement existant, la fonction n'est pas modifiée.
- À signaler pour la story 2.2 : date en heure locale (dépend du fuseau de la machine) ; borne d'année
  relative à l'année courante ; `takeout-parser.ts` préfère le nom de fichier à `photoTakenTime`.

### File List

- src/utils/fix-dates.ts (supprimé)
- src/utils/fix-cubbit-paths.ts (supprimé)
- tests/utils/file-utils.test.ts (créé)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/1-3-retirer-les-scripts-correctifs-ponctuels.md (créé)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-14 : suppression des scripts `fix-dates.ts` et `fix-cubbit-paths.ts` (FR-23) ; test de
  caractérisation de `extractDateFromFilename`.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 1 passe : APPROUVER, aucun BLOQUANT. Test robuste en UTC, Pacific/Kiritimati et America/Sao_Paulo.
- Pour la story 2.2 : ajouter les formats séparés (`2019-08-17_18-10-59`) et un cas d'heure au passage à l'heure d'été ; supprimer le repli sur `stats.mtime` dans `takeout-parser.ts` et faire passer `photoTakenTime` avant la date du nom de fichier.
