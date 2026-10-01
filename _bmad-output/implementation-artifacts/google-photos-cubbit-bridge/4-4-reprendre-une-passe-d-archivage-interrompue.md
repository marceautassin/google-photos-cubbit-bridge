---
baseline_commit: 76b919a
---

# Story 4.4 : Reprendre une passe d'archivage interrompue

Status: done

## Story

En tant que Marceau,
je veux qu'une passe coupée reprenne où elle en était,
afin qu'une soirée de travail ne soit pas perdue.

**Exigences :** FR-14.

## Contexte : ce qui existe déjà (story 4.3)

La 4.3 a posé l'essentiel de la reprise. **Ne pas le réécrire** :

- Journal et verrou partagés avec la réparation (`RepairExecutionModel`, `ExecutionJournal`), clé de ligne
  `locationKey` (`<part>␟<path>`).
- Ligne journalisée `copie_en_cours` (`copy_attempted = 1`) **avant** `uploadFile` ; à la relance, objet présent
  + ligne tentée → `isVerifiedUpload` → `copie` comptée « reprise vérifiée », sinon arrêt « à examiner », jamais
  d'écrasement (`src/takeout/archive-execution.ts`, `processLine`).
- Lignes `copie` / `deja_present` vers la même destination sautées (`isArchiveLineDone`).
- Ligne en `echec` (réseau, etc.) retentée à la relance.
- `Ctrl-C` : fin du média en cours puis arrêt ; second `Ctrl-C` : sortie immédiate, verrou libéré.
- Zips locaux réutilisés sans retéléchargement si leur marqueur de vérification correspond, revérifiés sinon,
  `.partiel` remplacé (`src/takeout/zip-download.ts`, story 4.2). Les médias ne sont **jamais extraits** sur disque :
  ils sont lus en flux depuis le zip. L'AC « zips extraits localement » se réduit donc aux zips eux-mêmes.

## Écarts réels à combler

1. **Extinction / `kill -9` / terminal fermé = une heure perdue.** Le verrou reste posé ; `--lever-verrou` n'est
   accepté qu'après 60 min sans activité (`forceReleaseLock`), même quand le verrou a été posé **sur ce poste** par
   un processus **qui n'existe plus** — situation qui prouve qu'aucune exécution ne tourne depuis ce poste. C'est
   précisément le cas « coupure » de l'AC.
2. **`SIGTERM` / `SIGHUP` non gérés** : fermer le terminal ou un `kill` simple tue le processus sans libérer le
   verrou → retombe sur l'écart 1.
3. **Aucune preuve que « le résultat final est identique à celui d'une passe ininterrompue »** : les tests couvrent
   des cas isolés, pas l'équivalence.
4. **Replanification après coupure non éprouvée** : après une passe partielle, Marceau peut réinventorier puis
   régénérer le plan (nouvelle empreinte, journal vierge). Les objets déjà déposés doivent alors apparaître « déjà
   archivés » ou être trouvés identiques en destination, et les noms suffixés (règle Q1) rester les mêmes.
5. **DRY** : `src/commands/takeout-archive.ts` recalcule « restant d'après le journal » avec sa propre condition au
   lieu de `isArchiveLineDone` (qui vérifie aussi la destination).

## Acceptance Criteria

1. **Reprise après coupure franche.** Étant donné un verrou posé sur ce poste (même nom d'hôte) par un processus
   qui n'existe plus, quand Marceau relance `gpb takeout archiver … --lever-verrou`, le verrou est levé
   **immédiatement**, sans attendre les 60 min, avec un message qui dit pourquoi (processus <pid> absent de ce
   poste). Le message de refus sans `--lever-verrou` indique cette possibilité. Inchangé : un verrou d'un autre poste,
   ou d'un processus vivant (PID réutilisé compris), n'est levable qu'après 60 min sans activité. Jamais levé en
   silence (`acquireLock` reste strict). Le comportement vaut aussi pour `gpb reparation executer` (verrou commun) :
   le dire dans son aide.
2. **Signaux de fin.** `SIGTERM` et `SIGHUP` sont traités comme `Ctrl-C` : fin du média en cours (envoi et
   vérification), arrêt propre, verrou libéré, message de relance. Un second signal sort immédiatement en libérant le
   verrou (comportement actuel du second `Ctrl-C`). Les gestionnaires sont retirés en fin d'exécution. Même chose
   pour `reparation executer` si son code de gestion de signal est le même (factoriser, DRY ; sinon ne pas y toucher).
3. **Équivalence avec une passe ininterrompue.** Test d'équivalence dans `tests/takeout/archive-execution.test.ts` :
   pour un plan d'au moins 5 lignes à envoyer (dont une `reclasser_quarantaine`, un objet déjà présent identique et
   un dépôt au-delà du seuil multipart injecté), on simule une coupure **à chaque point possible** — avant la ligne
   k, après le journal `copie_en_cours` mais avant le dépôt, après le dépôt mais avant le journal `copie`, pendant la
   vérification (HEAD qui lève) — puis une relance (nouveau writer sur le **même** bucket simulé, même journal).
   Pour chaque point : état final du bucket (clé → taille, ETag) identique à celui d'une passe sans coupure, journal
   final entièrement « fait », aucun `uploadFile` sur une clé déjà occupée, aucun envoi en double d'une ligne
   vérifiée. La « coupure » est simulée par une exception levée par le faux writer / faux journal (le processus
   meurt : rien n'est enregistré après), pas par `shouldStop`.
4. **Replanification après coupure.** Test (niveau `archive-plan` + exécution) : passe interrompue après k lignes,
   inventaire du bucket simulé refait, plan régénéré → les k médias déposés sont `deja_archive` (ou trouvés
   identiques en destination), les destinations des médias restants sont **identiques** à celles du premier plan
   (suffixes Q1 compris), et l'exécution du nouveau plan aboutit au même état final qu'une passe sans coupure.
   S'appuyer sur les fonctions de planification existantes ; ne rien modifier si le test passe tel quel, et sinon
   corriger le défaut révélé.
5. **Zips réutilisés.** Test (ou vérification d'un test existant de `zip-download.test.ts`, à citer dans le Dev
   Agent Record) : relance avec des zips intacts → aucun téléchargement ; zip partiel (`.partiel`) ou modifié →
   retéléchargé ou revérifié. Ajouter un test seulement s'il manque.
6. **DRY.** Le décompte « restant d'après le journal » de la commande utilise `isArchiveLineDone`.
7. **Garanties inchangées.** Aucune suppression, aucun écrasement, point d'accès en écriture unique, `backups/`
   jamais écrit ; l'analyse statique des imports `@aws-sdk/*` passe sans modification de sa liste figée.

## Tasks / Subtasks

- [x] AC1 : `forceReleaseLock(now, isAlive, host)` accepte la levée immédiate si `lock.host === host && !isAlive(lock.pid)` ;
  rend aussi la raison de la levée (processus absent / inactivité) pour le message ; message de `ExecutionLockedError`
  mis à jour ; tests unitaires dans `tests/database/repair-execution-model.test.ts` (même poste + PID mort → levée
  immédiate ; même poste + PID vivant → refus avant 60 min ; autre poste + récent → refus) ; commandes `takeout archiver`
  et `reparation executer` affichent la raison.
- [x] AC2 : gestion `SIGINT`/`SIGTERM`/`SIGHUP` factorisée (un seul endroit si les deux commandes ont le même code) ;
  test de commande qui émet `SIGTERM` pendant l'exécution et vérifie arrêt propre + verrou libéré.
- [x] AC3 : test d'équivalence paramétré sur les points de coupure.
- [x] AC4 : test de replanification après coupure.
- [x] AC5 : vérifier / compléter la couverture de réutilisation des zips.
- [x] AC6 : `isArchiveLineDone` dans `takeout-archive.ts`.
- [x] Mettre à jour l'en-tête de `src/takeout/archive-execution.ts` (« prépare la story 4.4 » → décrire la reprise
  telle qu'elle est désormais, limite multipart comprise).

## Dev Notes

### Règles impératives

- **Ne jamais toucher à `data/app.db` ni au bucket réel.** Tous les tests sur bases SQLite temporaires et faux clients
  S3. Toute exécution de la CLI (même `--help`, qui applique les migrations) dans une **copie du projet sous `/tmp`**
  sans `.env` ni `data/`. Relever le sha256 de `data/app.db` avant et après, le noter.
- **Ne jamais modifier une migration déjà livrée.** Cette story ne devrait en ajouter aucune.
- Aucune commande de suppression S3 ajoutée, nulle part (pas d'`AbortMultipartUpload`).
- KISS : pas de reprise partie par partie d'un dépôt multipart (seuil 200 Mio, aucun média de l'export ne
  l'atteint). Limite à documenter, pas à construire.
- Français : commentaires, messages, tests.
- Aucun commit (l'orchestrateur s'en charge après revue).

### Fichiers probables

- `src/database/repair-execution-model.ts` (levée de verrou)
- `src/commands/takeout-archive.ts`, `src/commands/reparation.ts` (signaux, message de levée)
- `src/takeout/archive-execution.ts` (en-tête)
- `tests/takeout/archive-execution.test.ts`, `tests/takeout/archive-plan.test.ts`,
  `tests/database/repair-execution-model.test.ts`, `tests/commands/takeout-archive.test.ts`

### Vérifications attendues

`npx tsc --noEmit`, `npm test`, `npm run lint` (0 erreur), `npm run build` : sorties réelles dans le Dev Agent Record.
Au moins une contre-épreuve : neutraliser la levée immédiate ou la vérification à la reprise et montrer quels tests
échouent, puis restaurer (`cmp` identique).

## Dev Agent Record

### Agent Model Used

claude-sonnet-5-5 (Sonnet 5.5)

### Debug Log References

- `data/app.db` : sha256 avant = après = `20b20900bd73fb3c0590950c4603538c9cc14eeff61f1f200ada365d70a5a248`. Aucune exécution de la CLI ; tests sur SQLite temporaires et faux clients S3 uniquement.
- `npx tsc --noEmit` : code 0. `npm test` : 32 suites, 773 tests, tous verts (base : 757). `npm run lint` : 0 erreur, 24 avertissements (`no-explicit-any`, hors fichiers de cette story). `npm run build` : code 0.
- Contre-épreuve A (levée immédiate neutralisée par `&& Date.now() < 0`) : 3 tests échouent (modèle, `takeout archiver`, `reparation executer`) ; restauré, `cmp` identique.
- Contre-épreuve B (vérification à la reprise `if (attempted)` neutralisée) : 19 tests échouent (les coupures après dépôt de l'équivalence AC3 + le test de reprise existant) ; restauré, `cmp` identique.
- Premier jet du test AC4 : échec révélant deux défauts réels (voir notes), le second corrigé dans `resolveNames`.

### Completion Notes List

- AC1 : `forceReleaseLock(now, isAlive, host)` lève immédiatement si le verrou est de ce poste et son PID absent ; rend `LiftedLock` (verrou + `reason`). Message de `ExecutionLockedError` : mentionne la levée immédiate si le processus n'existe plus. `acquireLock` inchangé (strict). Aide des deux commandes mise à jour. Affichage factorisé dans `liftLock` (`src/commands/execution-control.ts`).
- AC2 : `installStopHandlers` (même fichier) gère SIGINT/SIGTERM/SIGHUP pour les deux commandes (le code était identique : factorisé). Premier signal = arrêt demandé, signal suivant (quel qu'il soit) = verrou libéré + `exit(130)`. Gestionnaires retirés en `finally`.
- AC3 : 31 cas paramétrés (7 lignes dont reclassement, homonymes Q1, vidéo multipart au-delà du seuil injecté 10 octets, objet déjà présent ; 5 points de coupure par ligne déposée, `avant-ligne` seul pour l'objet déjà présent). Coupure = exception du faux writer/journal, après laquelle tout est mort (aucune écriture de journal). Aucun défaut trouvé dans `executeArchivePlan`.
- AC4 : `tests/takeout/archive-execution.test.ts`, k = 1..6, analyse refaite (`matchArchive`, y compris la preuve d'ETag multipart pour la vidéo) puis plan régénéré. Défaut révélé : un homonyme (Q1) restant, dont le jumeau est déjà déposé sous `img_<hex>.jpg`, était replanifié sous le nom nu `img.jpg` (seul arrivant sur un nom libre), donc état final différent d'une passe ininterrompue. Correction : `resolveNames(..., variantsCountAsHomonyms)` ; une variante suffixée déjà présente compte comme porteuse du nom. Activé uniquement par `buildArchivePlan` (la réparation 2.x/3.x garde son comportement). Test unitaire dans `tests/inventory/duplicates.test.ts`.
- AC5 : couvert par `tests/takeout/zip-download.test.ts` (« reprise : un zip déjà vérifié n'est ni retéléchargé ni relu », « zip complet sans marqueur : revérifié localement, sans téléchargement », « marqueur périmé ou fichier local altéré : remplacé par un nouveau téléchargement », « fichier partiel d'une exécution interrompue : remplacé »). Aucun test ajouté.
- AC6 : `takeout-archive.ts` utilise `isArchiveLineDone`.
- AC7 : aucun accès S3 ajouté, aucune suppression, aucune migration ; l'analyse statique des imports `@aws-sdk/*` passe sans modification.
- En-tête de `archive-execution.ts` réécrit (reprise telle qu'elle est, limite multipart documentée).
- Limite connue : si un groupe d'homonymes avait dû allonger son suffixe au-delà de 8 caractères (collision de préfixes), la replanification d'un sous-groupe pourrait raccourcir le suffixe des restants. Cas théorique (collision de 8 hex), non traité (KISS).
- Tests existants adaptés : `reparation.test.ts` (verrou PID mort = levée immédiate ; cas des 60 min porté sur un PID vivant), `takeout-archive.test.ts` et `repair-execution-model.test.ts` (nouveaux messages).

### File List

- `src/commands/execution-control.ts` (nouveau)
- `src/commands/reparation.ts`
- `src/commands/takeout-archive.ts`
- `src/database/repair-execution-model.ts`
- `src/inventory/duplicates.ts`
- `src/takeout/archive-plan.ts`
- `src/takeout/archive-execution.ts`
- `tests/commands/execution-control.test.ts` (nouveau)
- `tests/commands/reparation.test.ts`
- `tests/commands/takeout-archive.test.ts`
- `tests/database/repair-execution-model.test.ts`
- `tests/inventory/duplicates.test.ts`
- `tests/takeout/archive-execution.test.ts`
- `_bmad-output/implementation-artifacts/google-photos-cubbit-bridge/4-4-reprendre-une-passe-d-archivage-interrompue.md`

### Change Log

- 2026-10-01 : story 4.4 implémentée (levée immédiate de verrou orphelin, signaux SIGTERM/SIGHUP, preuves d'équivalence et de replanification, correction des noms Q1 à la replanification, DRY du décompte restant). Statut : review.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` (Opus) : APPROUVER, aucun BLOQUANT ni IMPORTANT. Levée immédiate du verrou jugée sûre (suppression conditionnée au verrou lu, PID réutilisé ou d'un autre utilisateur vu vivant, autre poste inchangé) ; test d'équivalence jugé probant.
- Corrigé par l'orchestrateur après approbation : erreurs d'écriture sur un terminal raccroché (SIGHUP) ignorées pour garder un arrêt propre (M2) ; gestionnaires de signaux posés dès la prise du verrou, avant la préparation des zips (M3) ; limites documentées dans le code — espaces de PID distincts au même nom d'hôte (M1), faux positif de la détection de variante suffixée `IMG_20230415.jpg` (M4).
- Non traité, assumé : coupure au milieu d'un dépôt multipart non simulée (seuil 200 Mio jamais atteint) ; deux homonymes multipart non couverts par le test d'équivalence (M5) ; `liftLock` dépend de la classe concrète du journal (M6, KISS).
- À savoir : fermer le terminal arrête désormais la passe proprement ; pour une passe détachée, utiliser `tmux` ou `screen` (`nohup` est neutralisé).
- Vérifications après corrections : tsc 0, `npm test` 0 (32 suites, 773 tests), `npm run lint` 0 erreur. `data/app.db` inchangé ; aucune écriture S3.
