---
baseline_commit: 611c1ce
---

# Story 3.2 : Reprendre une réparation interrompue

Status: done

## Story

En tant que Marceau,
je veux qu'une réparation coupée reprenne où elle s'est arrêtée,
afin de ne pas tout recommencer parce que mon poste s'est mis en veille.

**Exigences :** FR-7 — **NFR :** NFR-5 (idempotence), NFR-6 (reprise : coupure réseau, `Ctrl-C`, extinction), NFR-1
(point d'accès unique, inchangé), NFR-3 (confirmation inchangée), NFR-10 (français), NFR-11 (qualité) — **consignes
impératives de la story 3.1** (reprise des multipart, verrou, exception `CreateDate`).

Aucune nouvelle commande : la relance est `gpb reparation executer --confirmer <empreinte>`, déjà idempotente depuis 3.1.
Cette story rend la reprise **fine** (copie tentée mais non journalisée, vidéo multipart, erreur transitoire) et le verrou
**fiable** (activité récente plutôt que nom d'hôte).

## Acceptance Criteria

1. **Reprise à partir des objets non traités (epic).** Une exécution interrompue (`Ctrl-C` simple ou double, coupure
   réseau, extinction, `kill -9`) puis relancée ne retraite que les lignes non terminées ; aucune ligne `copie` /
   `deja_present` n'est retraitée ; aucun objet déjà copié n'est recopié (compte des `CopyObject` par clé, toutes
   exécutions confondues ≤ 1 par destination) ; aucun objet n'est jamais écrasé.
2. **Résultat identique (epic).** Après reprise, le contenu du bucket dédié et les états finaux du journal sont
   identiques à ceux d'une exécution ininterrompue, pour une interruption à chacune des étapes : (a) avant la copie (HEAD
   fait, rien journalisé), (b) après journalisation `copie_en_cours` et avant l'envoi, (c) après la copie et avant la
   vérification, (d) après la vérification et avant la journalisation `copie` — pour une source MD5 comme pour une
   source multipart dont Cubbit changerait l'ETag à la copie.
3. **État `copie_en_cours` (consigne 1).** Avant chaque envoi de copie, la ligne passe `copie_en_cours` (écrit et commité
   AVANT la requête) et le journal retient qu'une copie a été tentée (`copy_attempted`). `copie` n'est toujours écrit
   qu'après vérification réussie.
4. **Règles de reprise par état.**
   - `copie` / `deja_present` (même destination) : sautées, aucune requête.
   - `a_faire`, ou `echec` sans copie tentée : HEAD ; absent → copie normale ; présent → `deja_present` seulement si
     `isSameAsSource` (taille et ETag identiques, multipart compris) ; sinon arrêt, rien écrit (règle 3.1).
   - `copie_en_cours`, ou `echec` après une copie tentée : HEAD ; absent → copie normale ; présent et `isVerifiedCopy`
     (taille, et ETag si la source est un MD5 simple ; taille seule si multipart) → `copie` **sans recopier** (message
     « copie antérieure vérifiée à la reprise ») ; présent et non conforme → arrêt « à examiner », rien écrit.
   - Copie refusée par 412 (source modifiée) : le serveur n'a rien écrit → `echec` et la copie n'est plus réputée tentée.
5. **Erreurs transitoires.** Erreur réseau, 500, 503, `SlowDown` sur le HEAD, la copie ou la vérification : la ligne
   passe `echec` et l'exécution s'arrête (comportement 3.1). À la relance, la ligne est retentée selon le point 4 (échec
   avant envoi : règles `a_faire` ; échec après envoi ou pendant la vérification : règles `copie_en_cours`). Pas de
   retentative supplémentaire dans l'outil : le SDK en fait déjà (voir Décisions).
6. **Arrêts de sûreté toujours bloquants.** Destination non conforme et source modifiée (412) sont réévalués contre S3 à
   chaque relance : tant que la cause subsiste, la relance s'arrête sur la même ligne, affichée clairement (clé source,
   destination, raison) ; rien n'est écrit ni écrasé.
7. **Verrou (consigne 2).** Le verrou porte un horodatage d'activité, rafraîchi à chaque ligne traitée (le processus
   vérifie en même temps qu'il détient toujours le verrou ; sinon arrêt propre « verrou perdu »). `--lever-verrou` refuse
   si la dernière activité date de moins de `LOCK_IDLE_MINUTES` (60 min, dérivé de la durée maximale d'une ligne — voir T9), quels que soient l'hôte et le PID ; au-delà,
   levée possible même si le PID existe encore (réutilisé) ou si l'hôte diffère, avec un message explicite (hôte, PID,
   dernière activité). Horloge injectée dans les tests.
8. **Analyse statique (consigne 3).** L'exception `CreateDate` n'est admise que dans les fichiers de datation
   (`inventory/dating.ts`, `inventory/duplicates.ts`) ; ailleurs, `CreateDate` est signalé.
9. **Affichage.** Au début : résumé de reprise (déjà copiés, en cours à vérifier, en échec à retenter, restants) et, s'il
   y en a, les lignes en échec avec leur message. À la fin : bilan (copiés, reprises vérifiées sans recopie, déjà
   présents, déjà faits, restants).
10. **Migration 8.** Le journal gagne l'état `copie_en_cours` et la colonne `copy_attempted` (reconstruction de table,
    SQLite ne modifie pas un `CHECK`) ; le verrou gagne `last_activity_at`. La migration 7 n'est pas modifiée. Un journal
    3.1 existant est repris tel quel (`copy_attempted = 0`, activité = date de prise du verrou).
11. **Aucune régression 3.1.** Point d'accès, gardes, `verifyStoredPlan`, confirmation, simulation, Ctrl-C, analyse
    statique : inchangés. Les tests 3.1 restent verts ; seules les assertions dont le comportement change par décision
    de cette story sont ajustées (et listées).

## Tasks / Subtasks

- [x] T1 — Migration 8 (AC 10) : `MIGRATIONS` exporté ; reconstruction de `repair_execution_lines`, colonne
      `last_activity_at` ; `connection.test.ts` → 8 migrations ; test de compatibilité d'un journal 3.1
- [x] T2 — Journal (AC 3, 4) : `ExecutionState` + `copie_en_cours`, `JournalEntry.copyAttempted`, `record(…, copyAttempted?)`
- [x] T3 — Exécution (AC 1–6) : `processLine` selon l'état journalisé ; `copie_en_cours` avant envoi ; 412 → tentative
      effacée ; `recovered` ; `keepAlive` par ligne ; `summarizeExecution` : `inProgress`, `failed`, `notStarted`
- [x] T4 — Verrou (AC 7) : `last_activity_at`, `touchLock`, `forceReleaseLock(now)`, `LOCK_IDLE_MINUTES`, messages
- [x] T5 — CLI (AC 9) : résumé de reprise, lignes en échec, bilan ; horloge injectable (`ExecuteDeps.now`)
- [x] T6 — Analyse statique (AC 8)
- [x] T7 — Tests (S3 entièrement mocké, aucun `.env`) : interruptions (a)–(d) × MD5/multipart, multipart copié non
      journalisé, objet non conforme en `copie_en_cours`, échec transitoire avant/après envoi, 412 bloquant, verrou
      (récent, ancien, PID réutilisé, autre hôte, verrou perdu), journal 3.1, `CreateDate`
- [x] T8 — Vérifications : tsc, test, eslint, build, aide CLI (copie du projet, sans `.env` ni `data/`), contre-épreuves
      (reprise `copie_en_cours`, refus de levée récent), `data/` inchangé (SHA-256)
- [x] T9 — Revue `pr-reviewer` (aucun BLOQUANT ; corrections demandées par l'orchestrateur)
  - [x] [AI-Review][IMPORTANT] Délais S3 explicites (connexion, inactivité, tentatives) dans `createS3Client`, échéance
        par envoi dans le point d'accès, `LOCK_IDLE_MINUTES` dérivé de ces valeurs (> durée maximale d'une ligne)
  - [x] [AI-Review][IMPORTANT] `PRAGMA synchronous = FULL`
  - [x] [AI-Review][MINEUR] `forceReleaseLock` : suppression conditionnelle vérifiée (`changes`), sinon erreur explicite
  - [x] [AI-Review][MINEUR] Tentative effacée aussi sur refus du garde, 403, 404 `NoSuchKey`/`NoSuchBucket`
  - [x] [AI-Review][MINEUR] Horloge : dépendance documentée, activité dans le futur → levée refusée avec l'écart

## Dev Notes

### État actuel (lu avant modification, commit 611c1ce)

- `src/inventory/plan-execution.ts` : `executePlan` (pré-vol → `journal.prepare` → saut `copie`/`deja_present` →
  `checkAccess` → `processLine` séquentiel). `processLine` : HEAD ; présent → `isSameAsSource` ou arrêt ; copie ; 412 →
  « source modifiée » ; HEAD de vérification → `isVerifiedCopy`. `record` n'est appelé qu'après le résultat de la ligne :
  une copie faite puis coupée laisse `a_faire`/`echec`, et la relance applique `isSameAsSource` → **blocage d'un
  multipart copié dont Cubbit a changé l'ETag** (consigne 1).
- `src/database/repair-execution-model.ts` : `prepare`, `findStates`, `record(…, at)` ; verrou `acquireLock`,
  `releaseLock(owner)`, `forceReleaseLock(isAlive, host)` (refus si même hôte et PID vivant : levée d'une exécution
  vivante possible si l'hôte change ; levée refusée à vie si le PID est réutilisé — consigne 2).
- `src/database/connection.ts` : migrations 1–7 dans un tableau local à `runMigrations`, appliquées dans une transaction.
  Base réelle `data/app.db` en version 6 : elle appliquera 7 puis 8.
- `src/commands/reparation.ts` : `executeCommand` ; `--lever-verrou` avant le résumé ; verrou pris après confirmation ;
  Ctrl-C en deux temps ; `displayOverview`, `displayProgress`, `displayResult`.
- `tests/clients/archive-writer.test.ts` : `analyzeSources`, `NOT_WRITE_NAMES = {'CreateDate'}` global (consigne 3).
- **À préserver** : aucun module hors `archive-writer.ts` ne doit contenir un nom `Copy…`/`Put…`/`Create…` (analyse
  statique) — ne pas écrire « CopyObject » dans les commentaires de `plan-execution.ts`, du modèle ou de la commande.

### Décisions

- **Pourquoi `copie_en_cours` rend l'acceptation par `isVerifiedCopy` sûre.** Cet état est commité avant l'envoi : il
  prouve que l'outil a lancé, vers cette destination exacte, une copie serveur conditionnée à l'ETag source
  (`CopySourceIfMatch`). Un objet présent à cette clé, de la taille de la source (et de son ETag si MD5 simple), est donc
  le résultat de cette copie — exactement le raisonnement de la vérification post-copie de 3.1, simplement différé à la
  relance. Sans cet état (ligne `a_faire`), l'outil n'a jamais écrit : un objet présent est d'origine inconnue, et
  `isSameAsSource` (ETag identique) reste exigé.
- **Course résiduelle, dite honnêtement.** Entre la tentative et la relance, un écrivain externe (console Cubbit, autre
  outil) pourrait déposer à cette clé un objet multipart de même taille que la source : il serait accepté comme notre
  copie. Même famille que la course documentée en 3.1 (dépôt entre HEAD et copie). Le bucket dédié ne reçoit rien d'autre
  pendant l'exécution, et **le versioning recommandé sur `marceau-photos`** rend tout écrasement récupérable ; la
  contre-vérification de l'arrivée relève du rapport 3.3.
- **`copy_attempted` plutôt qu'un état `echec_apres_envoi`** : `echec` reste l'unique état d'échec (lisible, compatible
  3.1), la colonne distingue un échec avant envoi d'un échec après envoi ou pendant la vérification. 412 : le serveur a
  refusé, rien n'a été écrit (et le HEAD juste avant montrait la destination libre) → la tentative est effacée.
- **Journal 3.1 existant** : `copy_attempted = 0` pour toutes les lignes → règles strictes (`isSameAsSource`), soit le
  comportement 3.1 ; aucun journal réel n'existe (base en version 6).
- **Pas de retentative dans l'outil (KISS).** Le client S3 (SDK v3, mode `standard`) réessaie déjà 3 fois avec
  temporisation exponentielle les erreurs réseau (`ECONNRESET`, `ETIMEDOUT`…), 500/502/503/504 et `SlowDown`. Empiler
  une boucle multiplierait les attentes sans rien garantir de plus ; une erreur qui survit aux retentatives du SDK arrête
  l'exécution, et la relance est la retentative (sûre, grâce aux règles ci-dessus).
- **Verrou.** `LOCK_IDLE_MINUTES = 15` : largement au-dessus de la durée d'une ligne (HEAD + copie serveur du plus gros
  objet, 687 Mo, + HEAD). L'activité est rafraîchie au début de chaque ligne par `touchLock(owner)`, qui rend `false` si
  le verrou n'appartient plus au processus (levé pendant une mise en veille) → arrêt propre avant la ligne suivante.
  Conséquence assumée : après un `kill -9` ou une extinction, la levée n'est possible que 60 min après la dernière
  activité (le message donne l'heure). `acquireLock` n'est jamais levé en silence (inchangé) ; verrou « périmé » = PID
  mort sur ce poste ou inactivité au-delà du seuil.
- **Arrêts de sûreté réévalués** à chaque relance plutôt que figés dans un état : tant que la cause subsiste (objet
  différent, source modifiée), la relance s'arrête sur la même ligne ; si Marceau corrige la cause, la relance continue.
- **Migration 8** par reconstruction (`CREATE … _v8`, `INSERT … SELECT`, `DROP`, `RENAME`) ; `ALTER TABLE ADD COLUMN`
  pour le verrou. `MIGRATIONS` exporté pour que le test de compatibilité applique la vraie migration 7.

### Hors périmètre

- Rapport de réparation et contre-métrique : 3.3. Concurrence des copies : non. Nouvelle commande : non.

### Tests

- Jest, logger mocké ; `FakeS3` (compte des écrasements) branché sur le vrai `S3ArchiveWriter` ; journal en mémoire pour
  la mécanique, `RepairExecutionModel` sur base temporaire pour la migration et le verrou. Interruption simulée par un
  « processus tué » : à partir du point choisi, plus aucune écriture de journal ni requête S3 n'aboutit. Aucun réseau,
  aucun `.env`, horloge injectée (aucun `setTimeout`).

### Apprentissages des stories précédentes

- `rtk proxy` + redirection + `echo $?` ; `clean` + `build`. Vérifier chaque fichier modifié (`file`, fin de fichier,
  octets NUL). Aide CLI dans une copie du projet, jamais sur `data/`. Contre-épreuves avec `cmp`. Pas de commit.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 3.2, NFR-5, NFR-6]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#6. Exigences non fonctionnelles (Sûreté révisée le 2026-09-15, Idempotence, Reprise)]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-1-copier-l-archive-vers-le-bucket-dedie-selon-le-plan.md#Consignes impératives pour la story 3.2]
- [Source: node_modules/@smithy/service-error-classification, @smithy/util-retry (3 tentatives, codes transitoires)]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 16 suites, 370/370 (3.1 : 324 ; `plan-execution.test.ts` 33 → 68, `repair-execution-model.test.ts`
  8 → 15, `reparation.test.ts` 16 → 19, `archive-writer.test.ts` 49 → 50).
- `npx eslint` des fichiers `src/` touchés : code 0, aucun signalement. Tests touchés : code 0, 28 avertissements
  « Missing return type » (style des tests existants, 15 avant la story).
- `npm run clean` + `npm run build` : code 0.
- CLI dans une copie du projet (dossier temporaire de session, `dist/` + `package.json` + lien `node_modules`, sans `.env`) :
  `reparation --help`, `reparation executer --help` code 0 (aide `--lever-verrou` : « refusé si sa dernière activité date
  de moins de 60 min ») ; base neuve → schéma en version 8. **Copie** de `data/app.db` (+ `-wal`, `-shm`) dans ce dossier :
  migrations 7 puis 8 appliquées sur la copie, simulation `reparation executer` (bucket dédié par variable
  d'environnement, aucun identifiant) code 0, plan `6b67339c…`, 7 690 copies, 114 quarantaines, « Simulation : rien n'a
  été écrit ». Copie supprimée.
- Contre-épreuves (fichiers restaurés, `cmp` identique) : (1) reprise `copie_en_cours` neutralisée (`if (attempted &&
  line.size < 0)`) → 18 tests en échec (arrêts brutaux après copie × MD5/multipart, réponse perdue et HEAD de vérification
  × 4 erreurs, objets non conformes, multipart non journalisé, test commande second Ctrl-C) ; (2) refus de levée récent
  neutralisé → 6 tests en échec (3 propriétaires, verrou périmé, 2 tests commande).
- `data/` : SHA-256 des 4 fichiers identiques avant et après la session.
- Fichiers touchés : texte UTF-8, aucun octet NUL, fin de fichier `\n`.
- **Après revue (T9)** : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 16 suites, 396/396 ; `npx eslint` des fichiers
  `src/` touchés (dont `s3-client.ts`, `archive-writer.ts`) code 0 ; tests touchés code 0 (35 avertissements, tous
  « Missing return type ») ; `npm run clean` + `npm run build` code 0 ; `reparation executer --help` dans une copie du projet
  sans `.env` ni `data/` : code 0, « refusé si sa dernière activité date de moins de 60 min ».
- Contre-épreuves après revue (fichiers restaurés, `cmp` identique) : (1a) `LOCK_IDLE_MINUTES = 15` non dérivé → 1 test en
  échec (seuil vs durée d'une ligne) ; (1b) seuil dérivé avec marge négative (inférieur à une ligne) → 1 ; (1c) échéance
  d'envoi retirée du point d'accès → 1 (requête bloquée non abandonnée) ; (4) liste « rien écrit » réduite au 412 → 7 (4
  classifications, 3 exécutions).
- `data/` : SHA-256 identiques après les corrections de revue.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- **États du journal** : `a_faire` → (`copie_en_cours` →) `copie` | `deja_present` | `echec` ; `echec` → retentée à la
  relance (mêmes transitions). `copy_attempted` passe à 1 avec `copie_en_cours` (écrit avant l'envoi), reste inchangé sur
  les autres écritures, repasse à 0 sur 412.
- **Règles de reprise** (`processLine`) : copie tentée → objet présent accepté par `isVerifiedCopy` (état `copie`, message
  « copie antérieure vérifiée à la reprise, non recopiée », compteur `recovered`) sinon arrêt « copie antérieure non
  conforme, à examiner » ; copie non tentée → `isSameAsSource` (inchangé). Destination absente → copie normale dans les deux cas.
- **Verrou** : `last_activity_at`, `touchLock(owner, at)` appelé par `keepAlive` avant chaque ligne (faux → arrêt « verrou
  perdu ») ; `forceReleaseLock(now)` refuse sous `LOCK_IDLE_MINUTES` = 15 quel que soit le propriétaire, lève au-delà
  (suppression conditionnée au verrou lu) ; `isStaleLock(lock, now, …)` ; messages avec hôte, PID, prise, dernière
  activité et heure de levée possible. Horloge `ExecuteDeps.now`.
- **Migration 8** : reconstruction de `repair_execution_lines` (état `copie_en_cours`, `copy_attempted`), `ALTER TABLE`
  du verrou ; `MIGRATIONS` exporté (sans changement du texte des migrations 1–7) ; test de compatibilité appliquant les
  vraies migrations 1–7, journal et verrou 3.1, puis `initDatabase`.
- **Affichage** : résumé de reprise (déjà copiés, en cours à vérifier, en échec à retenter avec leur message, jamais
  traitées), bilan avec reprises vérifiées, consigne de relance après arrêt.
- **Analyse statique** : `CreateDate` admis dans `inventory/dating.ts` et `inventory/duplicates.ts` seulement.
- **Pas de retentative ajoutée** : le SDK (3 tentatives, réseau, 500–504, `SlowDown`) suffit ; la relance est la retentative.
- **Assertions 3.1 ajustées par décision de cette story** (aucune affaiblie) : `toEqual` du résultat nominal (+`recovered`)
  et de `summarizeExecution` (+ catégories) ; « réponse de copie perdue » → reprise vérifiée (`recovered: 1`, état `copie`)
  au lieu de `deja_present` ; second SIGINT → la ligne en cours est `copie_en_cours` (jamais `copie`) ; tests de levée du
  verrou réécrits avec horloge (ancienne règle hôte/PID remplacée) ; `connection.test.ts` → 8 migrations ;
  `findStates` renvoie `copyAttempted`.
- **Points à signaler** :
  1. Course résiduelle : un écrivain externe déposant, entre une tentative et la relance, un multipart de même taille à la
     destination serait accepté. Versioning de `marceau-photos` toujours recommandé ; contre-vérification en 3.3.
  2. Après `kill -9` ou extinction, `--lever-verrou` n'est accepté que 60 min après la dernière activité (message avec l'heure).
  3. Mise en veille pendant une ligne : si le verrou est levé entre-temps et qu'une seconde exécution démarre, la ligne en
     cours du processus réveillé peut se terminer (au plus une copie identique, conditionnée à l'ETag source) ; il
     s'arrête avant la ligne suivante.
  4. Erreur eslint préexistante `validateConfig` dans `src/index.ts` (hors fichiers touchés), non corrigée.
- Écart au cycle red-green : tests écrits juste après chaque module, validés par contre-épreuves.
- **Corrections de revue (T9)** — elles remplacent les valeurs contraires des Dev Notes et des AC (60 min) :
  - **Délais S3** (`src/clients/s3-client.ts`, appliqués à tous les clients via `createS3Client`) : connexion 10 s
    (`S3_CONNECTION_TIMEOUT_MS`) ; inactivité du socket 5 min (`S3_REQUEST_TIMEOUT_MS`) — le gestionnaire HTTP du SDK n'en
    avait aucun (0) ; généreux car une copie serveur ne répond qu'une fois faite : 687 Mo tiennent dès 2,3 Mo/s de débit
    interne ; `maxAttempts` 3 explicite ; attente maximale entre tentatives du SDK 20 s (`MAXIMUM_RETRY_DELAY` de
    `@smithy/util-retry`). Le délai du SDK est une **inactivité**, pas une durée totale : le point d'accès passe donc à
    chaque envoi un `AbortSignal.timeout(S3_SEND_DEADLINE_MS)`, échéance = 3 × (10 s + 5 min) + 2 × 20 s = 970 s ;
    durée maximale d'un envoi = échéance + 20 s (abandon constaté après une attente) = 990 s.
  - **Seuil de levée dérivé** : `MAX_LINE_DURATION_MS` = 3 envois (HEAD, copie, HEAD) × 990 s = 49,5 min ; marge 10 min
    (écritures du journal, écarts d'horloge usuels) ; `LOCK_IDLE_MINUTES = ceil((49,5 + 10) min)` = **60 min**. Une
    exécution vivante, même bloquée sur une requête, rafraîchit donc son activité avant le seuil. Contrepartie : après un
    `kill -9` ou une extinction, la levée n'est acceptée qu'une heure après la dernière activité (message avec l'heure).
    Test : recalcul depuis les constantes et seuil strictement supérieur à la durée d'une ligne.
  - **`PRAGMA synchronous = FULL`** : en WAL, `NORMAL` peut perdre les dernières transactions validées sur coupure de
    courant ; une ligne `copie_en_cours` validée doit survivre (coût négligeable : quelques écritures par ligne). Test du pragma.
  - **Levée concurrente** : suppression conditionnée à hôte, PID, prise ET dernière activité lues ; `changes` ≠ 1 → erreur
    « repris ou rafraîchi pendant la levée », jamais « Verrou levé ». Test.
  - **Tentative effacée** (`isCopyRefusedBeforeWrite`, `archive-writer.ts`) : refus du garde (avant tout réseau) ; et, à la
    **première tentative** du SDK seulement (`$metadata.attempts` = 1), 412 (condition évaluée avant la copie), 403 (droits
    vérifiés avant toute opération), 404 `NoSuchKey`/`NoSuchBucket` (rien à copier). Après plusieurs tentatives, une
    tentative précédente (délai dépassé, réponse perdue) a pu écrire : doute, tentative conservée — le 412 n'efface plus
    la tentative dans ce cas. Autres erreurs (réseau, abandon, 5xx, 404 générique) : doute. Tests (13 classifications, 6
    exécutions).
  - **Horloge** : activité, prise et levée utilisent l'horloge système du poste. Horloge **reculée** (ou autre poste en
    retard) : l'activité paraît dans le futur → levée refusée, écart affiché (« datée de N min dans le futur… horloge
    reculée ? »). Horloge **avancée** (correction NTP vers l'avant, autre poste en avance) chez celui qui lève : la levée
    peut être acceptée plus tôt que prévu, de l'écart ; les corrections NTP usuelles (secondes) sont couvertes par la
    marge de 10 min, un saut plus grand ne l'est pas (limite assumée, rien de plus construit). Chez l'exécution, une
    horloge qui avance ne fait qu'avancer son activité. Test de l'horloge reculée.

### File List

- src/database/connection.ts (modifié : `MIGRATIONS` exporté, migration 8, `synchronous = FULL`)
- src/clients/s3-client.ts (modifié : délais de connexion et d'inactivité, tentatives, échéance d'envoi)
- src/clients/archive-writer.ts (modifié : échéance par envoi, `isCopyRefusedBeforeWrite`)
- src/database/repair-execution-model.ts (modifié : `copyAttempted`, activité du verrou, `touchLock`, levée par inactivité)
- src/inventory/plan-execution.ts (modifié : `copie_en_cours`, règles de reprise, `recovered`, `keepAlive`, résumé de reprise)
- src/commands/reparation.ts (modifié : horloge, `keepAlive`, résumé de reprise, bilan, aide)
- tests/fixtures/fake-s3.ts (modifié : `copyError`, `overwrites`, `options`, `attempts` des erreurs)
- tests/inventory/plan-execution.test.ts (modifié)
- tests/database/repair-execution-model.test.ts (modifié)
- tests/database/connection.test.ts (modifié)
- tests/commands/reparation.test.ts (modifié)
- tests/clients/archive-writer.test.ts (modifié : exception `CreateDate` par fichier)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-2-reprendre-une-reparation-interrompue.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-15 : reprise d'une réparation interrompue — état `copie_en_cours` journalisé avant l'envoi et reprise des copies
  tentées par `isVerifiedCopy` (multipart compris), échecs transitoires retentés à la relance, arrêts de sûreté réévalués,
  verrou à horodatage d'activité (levée refusée sous 60 min), migration 8, résumé de reprise, exception `CreateDate`
  restreinte (FR-7, NFR-5, NFR-6).
- 2026-09-15 : revue `pr-reviewer` — délais S3 explicites et échéance par envoi, seuil de levée du verrou dérivé (60 min),
  `synchronous = FULL`, levée concurrente détectée, tentative effacée sur refus certain avant écriture, horloge reculée.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 2 passes : APPROUVER, aucun BLOQUANT.
- IMPORTANTS corrigés : absence de délai maximal sur les requêtes S3 (verrou levable pendant une requête bloquée) ; `synchronous = NORMAL` (journal non durable après coupure de courant).
- Vérifié par le relecteur contre un vrai client SDK et un serveur qui ne répond pas : l'échéance s'applique à chacun des cinq envois et coupe réellement la connexion côté client ; `$metadata.attempts` fiable.
- Limite documentée : l'abandon borne le client, pas une copie serveur déjà reçue par Cubbit, qui peut aboutir après la coupure. Conséquence réaliste nulle (mêmes octets, même condition d'ETag) ; le cas dangereux exige une copie serveur de plus de 60 min, une levée manuelle et un plan régénéré réattribuant la destination.
- Bout en bout sur une copie du plan réel (`kill -9` après copie d'une vidéo multipart, relance) : 7 804 lignes `copie`, aucune copie en double, aucun écrasement.
- Mentions « 15 min » de la story corrigées en 60 min par l'orchestrateur (6 occurrences).
