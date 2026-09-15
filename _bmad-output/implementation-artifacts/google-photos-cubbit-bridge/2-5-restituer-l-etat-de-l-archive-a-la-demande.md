---
baseline_commit: 6ce59e0
---

# Story 2.5 : Restituer l'état de l'archive à la demande

Status: done

## Story

En tant que Marceau,
je veux consulter l'état de mon archive quand je veux,
afin de vérifier où j'en suis sans relire le code ni refaire un inventaire complet.

**Exigences :** FR-18 — **NFR :** NFR-2 (lecture seule), NFR-8 (volumétrie ~18 000 objets), NFR-10 (français),
NFR-11 (qualité : DRY, KISS).

## Acceptance Criteria

1. **Synthèse en un écran.** **Étant donné** un inventaire local du bucket source, **quand** je lance `gpb etat`
   (options `--bucket`, `--destination` comme `gpb plan`), **alors** s'affichent : inventaire (date du dernier scan,
   objets, volume) ; périmètre photo d'après `repair.sourcePrefixes` (objets sous les préfixes, médias et volume,
   exclusions déclarées, objets non reconnus) ; répartition par année ; doublons ; quarantaine ; état du plan ;
   prochaine action recommandée.
2. **Répartition par année.** Chaque média du périmètre est compté (nombre, volume) dans l'année de sa **date
   reconstruite** (2.2). Les médias à date indéterminée forment une ligne « date indéterminée » et les médias sans
   datation valide (non datés ou datation périmée) une ligne « non daté » ; ni l'une ni l'autre n'est rangée dans une
   année. Les dates suspectes (2.2 : futur, avant 2000, EXIF ModifyDate) restent dans leur année, leur nombre est signalé.
   La somme des lignes égale le nombre de médias du périmètre.
3. **Doublons.** Groupes confirmés, copies en trop et volume récupérable (`analyzeDuplicates`, règle 2.3) ; doublons
   présumés non confirmables affichés à part, hors volume récupérable.
4. **Quarantaine.** Nombre et volume de médias en quarantaine d'après le plan courant s'il existe (précisé « plan
   périmé » le cas échéant) ; sans plan, le nombre de médias à date indéterminée est rappelé (estimation).
5. **État du plan.** `absent` (avec le dernier refus éventuel), `a_jour`, `perime` (raisons de `verifyStoredPlan`),
   `non_executable` (plan stocké non exécutable, raisons).
6. **Prochaine action.** Une seule, par priorité : inventaire absent → `gpb inventory scan` ; médias non datés →
   `gpb inventory dates` ; objets non reconnus → configuration puis `gpb plan generer` ; plan absent → `gpb plan generer` ;
   plan périmé → régénérer ; plan non exécutable → corriger (`gpb plan afficher`) puis régénérer ; plan à jour →
   « plan prêt à relire » (`gpb plan afficher --export plan.csv`).
7. **Français.** Nombres avec séparateur de milliers français, tailles en octets / Ko / Mo / Go / To avec virgule
   décimale, dates en toutes lettres (`fr-FR`).
8. **Lecture seule, sans réseau.** Aucun client S3 créé, aucune écriture S3 ni en base. Inventaire absent → message
   clair, prochaine action `gpb inventory scan`.
9. **Rapide.** Calcul en mémoire depuis les lectures groupées existantes (`findAll`), aucune requête par objet.

## Tasks / Subtasks

- [x] T1 — Formatage (AC 7) : une seule implémentation de `formatBytes` (dans `src/utils/format.ts`, unités françaises),
      suppression de celle de `src/utils/file-utils.ts`, appelants mis à jour ; `formatNumber` en `fr-FR` ;
      tests `tests/utils/format.test.ts`
- [x] T2 — Module pur `src/inventory/archive-state.ts` (AC 1–6, 9) : `yearBreakdown`, `scopeOverview`,
      `buildArchiveState` (agrège `summarizeInventory`, `classifyScope` exporté de `repair-plan.ts`, `summarizeDates`,
      `analyzeDuplicates`, `summarizePlan`, `verifyStoredPlan`), `recommendAction`
- [x] T3 — Commande `src/commands/etat.ts` (`gpb etat`), réutilisant `readPlanInput` / `resolveBuckets` exportés de
      `src/commands/plan.ts` ; enregistrement dans `src/index.ts` (AC 1, 8)
- [x] T4 — Tests `tests/inventory/archive-state.test.ts` (pur, en mémoire) : années avec non datés, indéterminés et
      suspects ; périmètre = comptes de `buildRepairPlan` ; états du plan → action ; inventaire absent
- [x] T6 — Corrections de revue `pr-reviewer` (décisions arrêtées par l'orchestrateur)
  - [x] [AI-Review][IMPORTANT] Quarantaine sans plan : `quarantineView` (pure) — médias non datés → « estimation
        impossible : N média(s) non daté(s) » ; sinon « au plus N média(s) à date indéterminée (albums et doublons compris) »
  - [x] [AI-Review][SUGGESTION] Plan intact, dernière génération refusée : « non exécutable en l'état », plus « périmé »
        (second `verifyStoredPlan` sans le refus, seulement en présence d'un refus) ; raisons inchangées
  - [x] [AI-Review][SUGGESTION] `repair.sourcePrefixes` vide : signalé à l'écran, action « renseignez repair.sourcePrefixes »
        prioritaire
  - [x] [AI-Review][SUGGESTION] `formatBytes` : arrondi à 1024 → unité suivante ; négatif, `NaN`, infini → « taille inconnue »
  - [x] [AI-Review][SUGGESTION] Code de sortie toujours 0, documenté dans l'aide de `gpb etat`
- [x] T5 — Vérifications : tsc, test, eslint, clean + build, aide, bout en bout sur base fictive, contre-épreuve ;
      suppression de `data/` et `logs/`

## Dev Notes

### Existant à réutiliser (ne rien réimplémenter)

- `summarizeInventory(objects, formats, depth)` (`src/inventory/inventory.ts`) : objets et volume totaux.
- `InventoryModel.findRun/findAll`, `InventoryDateModel.findAll` : lectures groupées (une requête chacune).
- `summarizeDates(media, datings, now)` et `suspectReason` (`src/inventory/dating.ts`) : sources, indéterminés, suspects,
  non datés. `isSameObject` : une datation ne vaut que pour l'objet inchangé.
- `analyzeDuplicates(media, datings)` (`src/inventory/duplicates.ts`) : `groups`, `extraCopyCount`, `recoverableSize`,
  `unconfirmed`, `unconfirmedSize`.
- `repair-plan.ts` : `classifyScope` (privé → à exporter, même classement que le plan), `normalizePlanConfig`,
  `summarizePlan`, `verifyStoredPlan`, `UNRECOGNIZED_HINT`.
- `src/commands/plan.ts` : `readPlanInput`, `resolveBuckets` (privés → à exporter) ; `RepairPlanModel.findCurrent`,
  `findLastRefusal`. `readPlanInput` lève `PlanRefusedError` si l'inventaire source est absent : le vérifier avant.
- `runCommand` (`src/commands/run-command.ts`).

### Décisions

- **Commande `gpb etat`** (top-level) : elle agrège inventaire, dates, doublons et plan ; la ranger sous `inventory`
  laisserait croire qu'elle ne parle que de l'inventaire.
- **Périmètre = `repair.sourcePrefixes`**, le même que le plan : répartition par année, doublons et quarantaine portent
  sur les médias du plan (le bucket `marceau` contient aussi des données perso/pro hors archive).
- **Quarantaine** : source de vérité = le plan (un média d'album indéterminé ne va pas en quarantaine) ; sans plan,
  rappel du nombre d'indéterminés, présenté comme estimation. Pas de recalcul du plan hors `verifyStoredPlan` (DRY).
- **État non exécutable prioritaire sur périmé** : l'action « corrigez puis régénérez » couvre les deux.
- **formatBytes** : conservé dans `utils/format.ts` (module des formatteurs), unités françaises (base 1024, comme avant).
  Les sorties des commandes existantes passent de `KB/MB` à `Ko/Mo` : voulu (NFR-10).
- **Code de sortie** : 0 dans tous les cas où l'état a pu être restitué (consultation, pas contrôle).

### Tests

- Jest, pur en mémoire (pas de base, pas de réseau, pas de `.env`). Séparateur de milliers `fr-FR` = espace fine
  insécable U+202F : comparer avec `toLocaleString('fr-FR')` ou le caractère explicite (`String.fromCharCode`).

### Apprentissages des stories 2.1 à 2.4

- `rtk proxy` + redirection + `echo $?` ; `clean` + `build` ; supprimer `data/` et `logs/`.
- Vérifier chaque fichier modifié (`file`, fin de fichier) : troncature (2.2), octets NUL (2.3, 2.4) — ne jamais écrire
  l'échappement NUL.
- Toute anomalie visible, jamais filtrée silencieusement (revues 2.1, 2.3).
- `plan afficher` : même `--bucket` / `--destination` qu'à la génération (`bucketMismatchHint`).
- Erreur eslint préexistante (`validateConfig` inutilisé dans `src/index.ts`).
- Pas de commit : proposer seulement.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 2.5]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#FR-18]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-4-produire-le-plan-de-reparation-inspectable.md]
- [Source: CLAUDE.md#Qualité de code]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 12 suites, 205/205 (dont `tests/inventory/archive-state.test.ts` 17 cas, `tests/utils/format.test.ts` 5 cas).
- `npx eslint` des fichiers touchés : code 1, uniquement des erreurs **préexistantes** hors lignes modifiées
  (`src/index.ts` `validateConfig` inutilisé ; `src/commands/takeout.ts` `config` inutilisé et échappements inutiles) et
  des avertissements `any` préexistants. Aucun problème dans `archive-state.ts`, `etat.ts`, `format.ts` ni les tests.
- `npm run clean` + `npm run build` : code 0. `node dist/index.js --help` code 0 (`etat` listée) ; `etat --help` code 0.
- Bout en bout (base fictive `essai-etat`, remplie par script, aucun réseau) : sans inventaire → code 0, « Prochaine
  action : inventoriez le bucket : gpb inventory scan » ; inventaire sans datations → « datez les 1 505 média(s) » ;
  datations sans plan → « générez le plan » ; après `plan generer` → « à jour et exécutable », quarantaine d'après le
  plan, « plan prêt à relire » ; inventaire rescanné → « périmé » avec raisons, « régénérez le plan ». Sur 18 007
  objets : `gpb etat` en 0,6 s (plan vérifié et recalculé compris). `data/` et `logs/` supprimés.
- Contre-épreuves (fichier restauré, `cmp` identique) : (1) non datés rangés en « date indéterminée » → 3 tests en
  échec ; (2) priorité périmé / non exécutable inversée → 1 test en échec.
- Aucun octet NUL dans les fichiers modifiés, fins de fichier vérifiées.

- Après revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 12 suites, 214/214 (`archive-state.test.ts` 24 cas,
  `format.test.ts` 7) ; `npx eslint` de `archive-state.ts`, `etat.ts`, `format.ts` et des deux tests code 0 ;
  `npm run clean` + `npm run build` code 0 ; `etat --help` code 0 (code de sortie documenté). Bout en bout « non datés
  sans plan » (base fictive, 8 médias non datés) : code 0, « Aucun plan : estimation impossible, 8 média(s) non
  daté(s) », action « datez les 8 média(s) ». `data/` et `logs/` supprimés. Contre-épreuve : contrôle des non datés
  retiré de `quarantineView` → 1 test en échec ; restauré, `cmp` identique.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Commande `gpb etat [--bucket] [--destination]` : un écran — inventaire, périmètre photo, répartition par année,
  doublons, quarantaine, état du plan, prochaine action. Aucun client S3, aucune écriture ; code 0.
- Module pur `src/inventory/archive-state.ts` : `yearBreakdown`, `planStatus`, `recommendAction`, `buildArchiveState`,
  `volumeOf`. Réutilise `classifyScope` (exporté), `normalizePlanConfig`, `attachDatings`, `suspectReason`,
  `analyzeDuplicates`, `summarizePlan`, `verifyStoredPlan`, `bucketMismatchHint`, `UNRECOGNIZED_HINT` ; la commande
  réutilise `readPlanInput` et `resolveBuckets` (exportés de `plan.ts`). `summarizeDates` et `summarizeInventory` ne
  sont pas appelés : `attachDatings` + `suspectReason` donnent les mêmes classes avec les volumes, et `InventoryRun`
  porte déjà objets et volume totaux.
- `formatBytes` : implémentation unique dans `src/utils/format.ts`, unités françaises (octet(s), Ko, Mo, Go, To, Po,
  virgule décimale, base 1024) ; celle de `file-utils.ts` (sans appelant passant `decimals`) supprimée ; appelants
  `inventory`, `plan`, `status`, `takeout`, `sync-manager` redirigés. Les sorties existantes passent de `KB/MB` à `Ko/Mo`.
  `formatNumber` en `fr-FR`.
- Écart au cycle red-green : tests écrits juste après le code, validés par contre-épreuves.
- Points à signaler : (1) la quarantaine sans plan est une estimation (indéterminés, albums compris) ; (2) « non datés »
  inclut les datations périmées ; (3) `gpb etat` recalcule le plan via `verifyStoredPlan` (0,6 s sur 18 000 objets) ;
  (4) sans `--bucket/--destination` identiques à la génération, le plan apparaît périmé avec la consigne des options.

- Revue `pr-reviewer` : approuvée sans BLOQUANT ; 1 IMPORTANT et 4 SUGGESTION traités (T6), chacun testé.
- **Note pour la 3.1** : `readPlanInput` et `resolveBuckets` sont exportés de `src/commands/plan.ts` et utilisés par
  `etat.ts` ; si une troisième commande (exécution du plan) en a besoin, les déplacer dans un module partagé
  (ex. `src/commands/plan-input.ts`) plutôt que d'importer une commande depuis une autre.

### File List

- src/inventory/archive-state.ts (nouveau)
- src/commands/etat.ts (nouveau)
- src/index.ts (modifié : commande `etat`)
- src/commands/plan.ts (modifié : `readPlanInput`, `resolveBuckets` exportés, import `formatBytes`)
- src/inventory/repair-plan.ts (modifié : `classifyScope` exporté)
- src/utils/format.ts (modifié : `formatBytes` français, `formatNumber` fr-FR)
- src/utils/file-utils.ts (modifié : doublon `formatBytes` supprimé)
- src/commands/inventory.ts, src/commands/status.ts, src/commands/takeout.ts, src/sync/sync-manager.ts (modifiés : import `formatBytes`)
- tests/inventory/archive-state.test.ts (nouveau)
- tests/utils/format.test.ts (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-5-restituer-l-etat-de-l-archive-a-la-demande.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-15 : corrections de revue — quarantaine sans plan (estimation impossible / borne haute), refus seul non
  étiqueté « périmé », préfixes source vides signalés, `formatBytes` robuste, code de sortie documenté.
- 2026-09-15 : `gpb etat` — état de l'archive à la demande depuis l'index local (FR-18) ; `formatBytes` unique et en français.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 2 passes : APPROUVER, aucun BLOQUANT. Aucun faux « plan prêt » sur 9 situations réelles puis 7 situations de refus.
- IMPORTANT corrigé : sans plan, la quarantaine affichait « 0 média » alors que des médias n'étaient pas datés (désormais « estimation impossible »).
- Décision : `gpb etat` renvoie toujours 0 (écran de consultation, documenté dans l'aide) ; le contrôle bloquant reste dans `gpb plan afficher` et dans l'exécution (story 3.1).
- Epic 2 terminée. Rien n'a encore été exécuté sur le vrai bucket : inventaire, datation et plan réels nécessitent une clé en lecture seule sur `marceau`.
