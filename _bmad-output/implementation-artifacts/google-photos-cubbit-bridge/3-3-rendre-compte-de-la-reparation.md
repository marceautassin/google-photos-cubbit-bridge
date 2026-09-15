---
baseline_commit: 28b6d27
---

# Story 3.3 : Rendre compte de la réparation

Status: done

## Story

En tant que Marceau,
je veux un rapport de ce qui a été fait,
afin de vérifier que rien n'a disparu avant de supprimer quoi que ce soit.

**Exigences :** FR-8 — **NFR :** Sûreté (aucune suppression dans `marceau` par l'outil ; Marceau supprime lui-même « une
fois la migration vérifiée »), Traçabilité, Langue — **contre-métriques du PRD §8** (objets à l'arrivée contre 12 736 au
départ moins les doublons, quarantaine, suppressions par l'outil = 0, écart non expliqué) — **point ouvert 3.1 n° 5 / 3.2
n° 1** : les lignes `copie` / `deja_present` ne sont jamais revérifiées, la contre-vérification de l'arrivée relève de
cette story.

Aucune écriture S3, aucune suppression, aucune requête réseau dans la commande de rapport.

## Acceptance Criteria

1. **Commande.** `gpb reparation rapport [--bucket <source>] [--verifier] [--export <fichier.json|.csv>]`. Aucun client
   S3 créé. Sans plan enregistré → message, code 1.
2. **Niveau a — rapport du journal (local).** Pour le plan courant : lignes attendues `copier` et `quarantaine` (nombre,
   volume) rapprochées des états du journal `copie`, `deja_present` (arrivées d'après le journal), `echec`,
   `copie_en_cours`, `a_faire` (absentes du journal comprises) ; doublons écartés (`ignorer_doublon`, nombre et **espace
   économisé**), déjà archivés, exclusions du plan (listées, ex. 2 `.DS_Store`), objets en quarantaine listés avec leur
   nouvelle destination. Statut de l'exécution : **complète** ; **incomplète** (`a_faire`, `copie_en_cours`) avec la
   commande de relance `gpb reparation executer --confirmer <12 car.>` ; **bloquée** (au moins une ligne `echec`, listée
   avec son message, commande de relance rappelée). Aucune exécution journalisée pour le plan courant → dit explicitement,
   avec les empreintes des autres plans journalisés s'il y en a (plan régénéré après exécution).
3. **Niveau b — vérification de l'arrivée (`--verifier`).** Contrôle sur le **dernier inventaire local du bucket dédié**
   (`gpb inventory scan --bucket <dédié>`, lecture seule, réutilisé tel quel). Pour chaque ligne à destination (`copier`,
   `quarantaine`, et `ignorer_deja_archive`) : objet présent à la **clé exacte** (sans normalisation), taille égale à la
   source, ETag égal si l'ETag source est un MD5 simple (taille seule si multipart — règle `isVerifiedCopy` de 3.1/3.2,
   réutilisée). Résultat : conformes / manquants / non conformes, chacun listé (clé source, destination, détail).
   Inventaire du bucket dédié absent → vérification impossible, consigne de scan, code 1.
4. **Fraîcheur de l'inventaire dédié.** La vérification ne compte pour l'attestation que si l'inventaire du bucket dédié
   a été terminé **après la fin de l'exécution** (dernière écriture du journal de ce plan). Sinon : « inventaire antérieur
   à la fin de l'exécution », consigne de scan.
5. **Fraîcheur du plan, côté source.** Le plan courant est vérifié contre l'index **source** et la configuration :
   configuration effective, inventaire source et datations inchangés (`assessPlanFreshness` avec l'inventaire dédié
   neutralisé), dernière génération non refusée, contenu cohérent avec l'empreinte, plan marqué exécutable sans violation,
   non reconnu ni anomalie de nommage, invariants rejoués sur les lignes relues avec le périmètre source actuel. L'état
   **nouveau** du bucket dédié (copies arrivées, inventaire rescanné) ne rend pas le plan périmé pour le rapport.
6. **Conservation des comptes.** Objets à l'arrivée + doublons écartés = médias inventoriés (lignes du plan) ; et + exclusions
   + non reconnus = objets sous les préfixes source dans l'inventaire source. Arrivée = `copie` + `deja_present` + déjà
   archivés (niveau a), ou conformes (niveau b). Tout écart est une **anomalie** listée.
7. **Contre-métriques (PRD §8).** Objets à l'arrivée contre objets inventoriés au départ moins doublons (et exclusions),
   rappel du relevé du PRD (12 736) avec avertissement si le périmètre actuel diffère ; nombre et volume en quarantaine ;
   suppressions par l'outil dans `marceau` : 0, **garanti par construction** (point d'accès unique sans suppression,
   analyse statique `tests/clients/archive-writer.test.ts`), cité et non mesuré.
8. **Attestation.** Le rappel « la suppression des anciens emplacements vous appartient » et la liste des emplacements à
   supprimer ne s'affichent que si : exécution journalisée pour le plan courant ; aucun verrou d'exécution ; fraîcheur
   source (AC 5) sans problème ; aucune ligne `echec`, `copie_en_cours`, `a_faire` ; vérification (niveau b) faite sur un
   inventaire dédié postérieur à la fin d'exécution ; aucun manquant ni non conforme ; aucune anomalie de conservation ou
   de journal. Sinon : « NE SUPPRIMEZ RIEN » et chaque raison.
9. **Emplacements à supprimer.** Bucket source + chaque préfixe source du plan, avec nombre et volume d'objets sous le
   préfixe dans l'inventaire source ; pour chaque préfixe, le dossier de premier niveau et le nombre d'objets **hors
   périmètre** qu'il contient (ex. `2_Personnel/` : autres dossiers personnels, à NE PAS supprimer ; seul
   `2_Personnel/Photos/google_photos/` est concerné). Rien n'est supprimé par l'outil.
10. **Export.** `--export` `.json` (rapport complet, clés en français, anomalies et raisons de refus d'attestation) ou
    `.csv` (séparateur `;`, BOM : une ligne par objet du périmètre avec action, destination, état du journal, vérification,
    puis une ligne par anomalie). Autre extension → erreur.
11. **Code de sortie.** 0 seulement si l'attestation est accordée (complet et vérifié conforme) ; 1 sinon (sans
    `--verifier`, incomplet, anomalie, vérification impossible).

## Tasks / Subtasks

- [x] T1 — Module pur `src/inventory/repair-report.ts` : rapport du journal, vérification de l'arrivée, conservation,
      emplacements à supprimer, fraîcheur source, attestation, exports (AC 2–10)
- [x] T2 — `repair-plan.ts` : extraire les contrôles du contenu stocké de `verifyStoredPlan` (DRY) pour la fraîcheur source
- [x] T3 — `RepairExecutionModel` : `lastUpdate(planId)`, `findPlanIds()`
- [x] T4 — CLI `src/commands/reparation-rapport.ts`, sous-commande enregistrée dans `reparation.ts` (AC 1, 11)
- [x] T5 — Tests (aucun réseau, aucun `.env`, base temporaire) : fonctions pures et commande
- [x] T6 — Vérifications : tsc, test, eslint, build, aide CLI dans une copie, essai niveau a sur copie de `data/app.db`,
      contre-épreuve, SHA-256 de `data/`
- [x] T7 — Revue `pr-reviewer` (décisions de l'orchestrateur)
  - [x] [AI-Review][BLOQUANT] Attestation sur un inventaire source refait après l'exécution : tampon source neutralisé
        seulement dans ce cas, comparaison objet par objet à l'instantané du plan (ajoutés / retirés / modifiés, clé exacte,
        taille, ETag normalisé strict), âge maximal de 24 h des deux inventaires (horloge injectée), export
        `--export-suppression` des clés exactes, refusé sans attestation
  - [x] [AI-Review][IMPORTANT] `isSameAsSource` pour `ignorer_deja_archive` et les lignes `deja_present` ; `isVerifiedCopy`
        pour les seules lignes journalisées `copie`
  - [x] [AI-Review][IMPORTANT] Exclusions non archivées affichées sous chaque emplacement à supprimer
  - [x] [AI-Review][MINEUR] Objets non prévus sous `photos/`, `albums/`, `quarantaine/` : avertissement non bloquant
  - [x] [AI-Review][MINEUR] `listed` : `items.length - max`
- [x] T8 — Contre-revue `pr-reviewer`
  - [x] [AI-Review][IMPORTANT] Suppression par clés exactes (`--export-suppression`) prescrite comme LA méthode, préfixes
        pour information ; avertissements (dossiers entiers, objet écrasé en place, versioning du bucket source) ; commande
        exacte si l'option est absente
  - [x] [AI-Review][MINEUR] Date de l'inventaire source lue avec les objets (`current.index.sourceInventory.completedAt`)
  - [x] [AI-Review][MINEUR] Nombre de copies multipart vérifiées sur la taille seule, avec la limite
  - [x] [AI-Review][MINEUR] CSV de suppression avec empreinte du plan, date de l'inventaire source et date de génération
        (colonnes répétées) ; fichier existant jamais écrasé

## Dev Notes

### État actuel (lu, commit 28b6d27)

- `src/inventory/plan-execution.ts` : `linesToWrite`, `summarizeExecution` (done / inProgress / failed / notStarted,
  `failures`), `isVerifiedCopy`, `ExecutionState`, `JournalEntry`, `CONFIRMATION_LENGTH`. `isDone` non exporté (état fait
  ET destination identique).
- `src/database/repair-execution-model.ts` : `findStates(planId)`, `findLock()`. `updated_at` écrit à chaque `record`.
- `src/inventory/repair-plan.ts` : `assessPlanFreshness`, `verifyStoredPlan` (fraîcheur + contenu stocké + recalcul),
  `checkPlanInvariants`, `objectsInScope`, `occupiedFrom`, `summarizePlan`, CSV (`csvField` local).
- `src/commands/plan.ts` : `readPlanInput(config, {bucket, destination})` (index source, datations, inventaire dédié).
- `src/database/inventory-model.ts` : `findRun(bucket)` (`completedAt` = fin du listing, écrit par `replace`), `findAll`.
- Analyse statique : aucun mot commençant par `Put|Delete|Copy|Create…` (casse comprise) hors du point d'accès.

### Décisions

- **Vérification par l'inventaire dédié, pas par HEAD** (KISS, réutilisation) : `gpb inventory scan --bucket
  marceau-photos` liste réellement le bucket (lecture seule, déjà testé) ; l'ETag et la taille du listing sont ceux du HEAD.
  7 800 HEAD séquentiels coûteraient autant qu'un listing de 8 pages, sans rien apporter, et exigeraient un nouveau client
  réseau dans la commande. La commande de rapport reste entièrement locale et testable sans S3.
- **« Postérieur à la fin d'exécution »** : `completedAt` de l'inventaire dédié > dernière écriture du journal du plan, et
  aucun verrou d'exécution présent. Un listing chevauchant une exécution ne peut produire que des faux manquants (l'outil
  ne supprime jamais) : direction sûre.
- **Fraîcheur après exécution** : l'exécution change le bucket dédié ; son nouvel inventaire rendrait le plan « périmé »
  pour `verifyStoredPlan` (tampon d'inventaire dédié, destinations désormais occupées, recalcul en `ignorer_deja_archive`).
  Pour le rapport, seules comptent la source et la configuration : `assessPlanFreshness` est appelé avec le tampon dédié
  du plan (neutralisé), les invariants sont rejoués avec, pour destinations occupées, celles des lignes
  `ignorer_deja_archive` du plan (état au moment du plan), et le recalcul complet n'est pas refait (il dépend de
  l'inventaire dédié d'avant exécution, disparu) : tampons source, datations et configuration identiques + contenu
  cohérent avec l'empreinte suffisent à garantir que le plan exécuté décrit bien l'index source actuel.
- **Plan régénéré après exécution** : le rapport porte sur le plan courant ; sans journal pour lui → pas d'attestation, et
  les autres plans journalisés sont cités.
- **Relevé du PRD (12 736)** : avertissement non bloquant si le périmètre actuel diffère (le bucket a pu évoluer) ; la
  conservation, elle, est vérifiée contre l'inventaire source réel.

### Procédure de fin pour Marceau (après revue)

1. `gpb reparation executer --confirmer <empreinte>` jusqu'à « Plan exécuté » (relancer tant qu'elle s'arrête).
2. `gpb inventory scan --bucket marceau-photos` (listing en lecture seule du bucket dédié, après la fin de l'exécution).
3. `gpb inventory scan --bucket marceau` (nouveau listing du bucket source, après la fin de l'exécution).
4. `gpb reparation rapport --verifier --export-suppression suppression.csv` (nouveau nom de fichier à chaque fois : un
   fichier existant n'est jamais écrasé) : code 0 et « La suppression des anciens emplacements vous appartient »
   seulement si tout est conforme ; sinon « NE SUPPRIMEZ RIEN », les raisons, et aucun fichier.
5. Supprimer **immédiatement**, dans `marceau`, **uniquement les clés exactes** de `suppression.csv` (colonnes `bucket`,
   `cle` ; chaque ligne rappelle l'empreinte du plan et les dates). Jamais un dossier entier depuis la console : un objet
   ajouté depuis l'inventaire serait perdu, et `2_Personnel/` contient d'autres dossiers personnels. Les exclusions
   (`.DS_Store`) figurent dans le fichier. Limite : un objet écrasé en place sous une clé listée depuis l'inventaire serait
   supprimé — activer le versioning sur `marceau` si Cubbit le propose. Ne pas lancer `gpb plan generer` entre les étapes
   1 et 4.

### Tests

- Jest, logger mocké, base temporaire, configuration écrite à la main (pas d'import de `src/config`).
- Pures : exécution conforme → attestation ; `a_faire` / `echec` / `copie_en_cours` → refus + relance ; manquant, taille,
  ETag MD5, multipart taille seule ; inventaire dédié antérieur ; plan périmé côté source ; inventaire dédié rescanné après
  exécution → pas périmé ; conservation et écart ; emplacements et avertissement `2_Personnel/` ; exports.
- Commande : aucun plan ; bout en bout exécution (FakeS3) → scan simulé (`InventoryModel.replace` depuis le FakeS3) →
  rapport code 0 ; sans `--verifier` code 1 ; export.

### Apprentissages des stories précédentes

- `rtk proxy` + redirection + `echo $?` ; `clean` + `build`. Vérifier chaque fichier modifié (`file`, fin de fichier).
  Aide CLI dans une copie du projet, jamais sur `data/`. Contre-épreuves avec `cmp`. Pas de commit.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 3.3]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#6 (Sûreté), #8 (Contre-métriques)]
- [Source: 3-1-copier-l-archive-vers-le-bucket-dedie-selon-le-plan.md#Points ouverts n° 5]
- [Source: 3-2-reprendre-une-reparation-interrompue.md#Points à signaler n° 1]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 18 suites, 435/435 (3.2 : 396 ; `repair-report.test.ts` 29 nouveau, `reparation-rapport.test.ts` 9
  nouveau, `repair-execution-model.test.ts` +1).
- `npx eslint` des 6 fichiers `src/` touchés : code 0, aucun signalement. Tests touchés : code 0, 4 avertissements « Missing
  return type » (style des tests existants).
- `npm run clean` + `npm run build` : code 0.
- CLI dans une copie du projet (dossier de session, `dist/` + `package.json` + lien `node_modules`, sans `.env`) :
  `reparation --help` et `reparation rapport --help` code 0.
- Copie de `data/app.db` (+ `-wal`, `-shm`) dans ce dossier : `reparation rapport` code 1 — plan `6b67339c…`, « aucune
  exécution journalisée », attendus 7 690 copies + 114 quarantaines, 4 930 doublons (16,2 Go économisés), 2 `.DS_Store`,
  12 736 objets au départ = relevé du PRD, anomalie de conservation (écart 7 804), « NE SUPPRIMEZ RIEN ». Aucun problème de
  fraîcheur source sur le plan réel. Puis, **dans la copie seulement**, exécution simulée (7 804 lignes `copie` au
  2026-09-16T20:00Z, inventaire du bucket dédié de 7 810 objets terminé à 21:00Z, multipart avec ETag changé) :
  `rapport --verifier --export rapport.csv` code 0, 7 804 conformes, attestation, emplacements
  `marceau/2_Personnel/Photos/google_photos/` (2 538 objets, 6,6 Go ; « Ne supprimez PAS « 2_Personnel/ » en entier : 4 615
  autres objets ») et `marceau/backup_google_photos/photos/` (10 198 objets, 32,8 Go) ; CSV de 12 737 lignes. Le tampon
  d'inventaire dédié du plan (6 objets) diffère de l'inventaire rescanné (7 810) sans rendre le plan périmé.
- Contre-épreuves (fichier restauré, `cmp` identique) : (1) manquants ignorés dans `attestationReasons` → 1 test en échec
  (l'attestation reste refusée par l'anomalie de conservation, qu'un manquant provoque toujours : double garde) ;
  (2) fraîcheur de l'inventaire dédié neutralisée → 2 tests en échec (pur et commande) ; (3) tampon dédié non neutralisé
  dans `sourceFreshnessProblems` → 1 test en échec (rescan après exécution déclaré périmé).
- `data/` : SHA-256 des 4 fichiers identiques avant et après la session.
- Fichiers touchés : texte UTF-8, aucun octet NUL, fin de fichier `\n`.

- **Après revue (T7)** : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 18 suites, 450/450 ; `npx eslint` des 6 fichiers
  `src/` touchés code 0 ; tests code 0 (4 avertissements « Missing return type ») ; `npm run clean` + `npm run build` code 0 ;
  `reparation rapport --help` code 0 dans une copie du projet sous le dossier temporaire de session (option
  `--export-suppression` affichée). Copie de `data/app.db` : rapport code 1, « NE SUPPRIMEZ RIEN » (aucune exécution,
  inventaires source et dédié non postérieurs). Puis, dans la copie seulement, exécution simulée (journal complet il y a
  2 h, inventaires source et dédié il y a 1 h) : code 0, attestation, « dont 2 exclusion(s) non archivée(s) », 
  `suppression.csv` de 12 736 clés (+ en-tête). Copie supprimée.
- Contre-épreuves après revue (fichier restauré, `cmp` identique) : (1c) écarts source ignorés dans l'attestation → 2 tests
  en échec (ajout, doublon modifié ; le retrait reste aussi refusé par l'invariant et la conservation) ; (1d) borne d'âge
  multipliée par 1 000 → 2 tests en échec (pur et commande) ; (2) `isVerifiedCopy` pour toutes les lignes → 1 test en échec
  (multipart `deja_present` d'ETag différent ; le cas « déjà archivé » MD5 reste refusé par la taille/ETag MD5 dans les deux règles).
- `data/` : la base réelle est passée en version 8 par une erreur du relecteur (hors de cette session) ; SHA-256 relevés au
  début des corrections et identiques à la fin (`app.db` 886bf88d…, `-shm` 00e4865a…, `-wal` 0bdb2989…,
  `plan-reparation.csv` f697bbbf…).

- **Après contre-revue (T8)** : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 18 suites, 451/451 ; `npx eslint` des
  fichiers `src/` touchés code 0 ; tests code 0 (4 avertissements « Missing return type ») ; `npm run clean` + `build`
  code 0 ; aide CLI code 0 dans une copie du projet. Copie de `data/app.db` : rapport code 1 (« NE SUPPRIMEZ RIEN ») ;
  exécution simulée dans la copie : code 0, « Méthode de suppression : UNIQUEMENT les clés exactes… », 351 copies
  multipart vérifiées sur la taille seule, `suppression.csv` 12 736 clés avec empreinte et dates ; relance sur le même
  fichier : code 1, « existe déjà », fichier intact. Copie supprimée. `data/` : SHA-256 identiques avant et après.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- **Commande** `gpb reparation rapport [--bucket] [--verifier] [--export .json|.csv]` : trois blocs « Niveau 1 — Rapport du
  journal », « Niveau 2 — Vérification de l'arrivée », « Contre-métriques », puis « Attestation ». Aucun client S3 (test sur
  les imports du module). Code 0 seulement si l'attestation est accordée.
- **Vérification de l'arrivée** par l'inventaire local du bucket dédié (réutilisation de `gpb inventory scan`, lecture
  seule), pas par HEAD : clé exacte, taille, ETag si MD5 simple (`isVerifiedCopy`). Couvre `copier`, `quarantaine` et
  `ignorer_deja_archive`.
- **Conditions d'attestation** (`attestationReasons`, pure) : journal existant pour le plan courant et complet (aucun
  `a_faire`, `copie_en_cours`, `echec`) ; aucun verrou d'exécution ; `sourceFreshnessProblems` vide ; `--verifier` demandé ;
  inventaire du bucket dédié présent et terminé strictement après la dernière écriture du journal ; aucun manquant ni non
  conforme ; aucune anomalie (conservation des comptes, journal incohérent).
- **Fraîcheur après exécution** (`sourceFreshnessProblems`) : `assessPlanFreshness` avec le tampon dédié du plan,
  `storedContentProblems` (extrait de `verifyStoredPlan`, DRY) avec pour destinations occupées les « déjà archivés » du plan ;
  pas de recalcul complet (il dépend de l'inventaire dédié d'avant exécution).
- **DRY** : `storedContentProblems` et `csvDocument` extraits de `repair-plan.ts` ; `isDone` exporté et
  `executionCommandLine` partagé avec `executer`.
- **Avertissement non bloquant** si le périmètre diffère du relevé du PRD (12 736) ; sur le plan réel il est égal.
- **Points à signaler** :
  1. Un inventaire du bucket dédié postérieur à l'exécution est requis pour attester (`gpb inventory scan --bucket
     marceau-photos`) ; il rescanne tout le bucket (dont `backups/`).
  2. Régénérer le plan après l'exécution remplace le plan courant : le rapport ne voit plus le journal (autre empreinte
     citée) et refuse d'attester. Ne pas lancer `gpb plan generer` entre l'exécution et le rapport.
  3. La vérification prouve l'état au moment du listing ; une modification manuelle ultérieure du bucket dédié n'est pas vue.
  4. Erreur eslint préexistante `validateConfig` dans `src/index.ts` (hors fichiers touchés), non corrigée.
- Écart au cycle red-green : tests écrits juste après le module, validés par contre-épreuves.
- **Corrections de revue (T7)** — elles remplacent les décisions contraires ci-dessus et des Dev Notes :
  - **Inventaire source postérieur exigé.** `completedAfter(inventaire source, fin d'exécution)` sinon refus « lancez gpb
    inventory scan --bucket marceau ». Dans ce cas seulement, `sourceFreshnessProblems(…, executionEnd)` neutralise le
    tampon source (configuration, datations, dernier refus, contenu stocké et invariants rejoués sur le nouvel inventaire
    restent vérifiés).
  - **`compareSourceSnapshot`** : objets du nouvel inventaire sous les préfixes contre lignes + exclusions + non reconnus du
    plan ; ajoutés, retirés, modifiés (taille ou ETag normalisé, strict même multipart) listés ; tout écart refuse.
  - **`MAX_INVENTORY_AGE_HOURS = 24`** : âge des deux inventaires à l'heure du rapport (horloge `now` injectée) affiché dans
    l'attestation ; au-delà, ou daté dans le futur, refus ; « Supprimez sans attendre ».
  - **`--export-suppression <fichier>`** (`deletionKeysCsv`) : bucket, clé, taille, ETag de chaque objet du nouvel
    inventaire source sous les préfixes ; sans attestation : code 1, rien écrit.
  - **Conformité selon l'origine** : `copie` → `isVerifiedCopy` ; `deja_present`, `ignorer_deja_archive` et autres →
    `isSameAsSource`.
  - **Exclusions par emplacement** (`DeletionLocation.exclusions`) affichées et exportées ; **objets non prévus** du bucket
    dédié (`unexpectedDestinationObjects`) en avertissement non bloquant.
  - Point 3 des points à signaler ci-dessus : la borne de 24 h et la comparaison du nouvel inventaire source le traitent
    côté source ; côté dédié, l'état reste celui du dernier listing de moins de 24 h.

- **Corrections de contre-revue (T8)** : attestation qui prescrit la suppression par clés exactes et relègue les préfixes à
  l'information (avertissements dossiers entiers, écrasement en place, versioning ; `suppressionCommandLine` si
  `--export-suppression` absent) ; `sourceInventoryCompletedAt` tiré de `readPlanInput` ; `VerificationReport.sizeOnlyCopies` ;
  `deletionKeysCsv(report, generatedAt)` avec colonnes `empreinte_plan`, `inventaire_source_du`, `genere_le` répétées sur
  chaque ligne (lisible tel quel par un tableur, contexte conservé par ligne) ; refus d'écraser un fichier de suppression.

### File List

- src/inventory/repair-report.ts (nouveau)
- src/commands/reparation-rapport.ts (nouveau)
- src/commands/reparation.ts (modifié : sous-commande `rapport`, `executionCommandLine`)
- src/inventory/plan-execution.ts (modifié : `isDone` exporté, `executionCommandLine`)
- src/inventory/repair-plan.ts (modifié : `storedContentProblems`, `csvDocument` extraits)
- src/database/repair-execution-model.ts (modifié : `lastUpdate`, `findPlanIds`)
- tests/inventory/repair-report.test.ts (nouveau)
- tests/commands/reparation-rapport.test.ts (nouveau)
- tests/database/repair-execution-model.test.ts (modifié)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-3-rendre-compte-de-la-reparation.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-15 : rapport de réparation — `gpb reparation rapport` (journal rapproché du plan, vérification de l'arrivée sur
  l'inventaire du bucket dédié, conservation des comptes, contre-métriques, attestation conditionnelle listant les
  emplacements à supprimer par Marceau, export JSON/CSV), sans réseau ni écriture (FR-8).
- 2026-09-15 : revue `pr-reviewer` — attestation sur inventaires source et dédié refaits après exécution et de moins de
  24 h, écarts source listés, liste exacte des clés à supprimer (`--export-suppression`), `isSameAsSource` hors copies de
  l'outil, exclusions par emplacement, objets non prévus en avertissement.
- 2026-09-15 : contre-revue — suppression prescrite par clés exactes uniquement, copies multipart vérifiées sur la taille
  seule comptées, CSV de suppression daté et lié au plan, jamais écrasé.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 4 passes : APPROUVER, aucun BLOQUANT restant.
- BLOQUANT corrigé (passe 1) : l'attestation reposait sur l'inventaire source figé au moment du plan, et un nouveau scan la faisait refuser ; un objet ajouté ou modifié sous les préfixes après ce scan aurait été supprimé sans être archivé. Désormais : inventaires source et dédié postérieurs à l'exécution et de moins de 24 h, source identique au plan clé par clé, suppression par liste de clés exactes.
- IMPORTANTS corrigés : vérification multipart trop faible pour les objets non écrits par l'outil ; exclusions non rappelées à l'attestation ; écran qui mettait en avant les préfixes ; fichier de suppression désigné avant d'avoir été produit.
- Ajouté par l'orchestrateur après la dernière approbation, sur prescription du relecteur : refus quand `--export` et `--export-suppression` désignent le même fichier (testé).
- Incident : un `--help` lancé depuis le dépôt pendant la revue a appliqué les migrations 7 et 8 sur `data/app.db` (schéma seulement, données vérifiées intactes, journal vide). Consigne maintenue : toute commande d'essai dans une copie du projet.
- Epic 3 terminée. Aucune copie réelle n'a été exécutée.
