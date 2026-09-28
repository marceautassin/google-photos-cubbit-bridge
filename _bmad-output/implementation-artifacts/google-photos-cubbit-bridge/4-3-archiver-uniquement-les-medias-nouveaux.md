# Story 4.3: Archiver uniquement les médias nouveaux

Status: done

## Story

En tant que Marceau,
je veux un plan d'archivage relu avant envoi, puis l'envoi des seules photos absentes,
afin de ne rien réenvoyer et de ne rien écraser.

**Exigences :** FR-12, FR-13, FR-15

## Acceptance Criteria

1. **Étant donné** un export validé (4.1) et analysé (4.2, analyse exigée valide au sens `TakeoutAnalysisModel.findValid`)
   **Quand** je génère le plan d'archivage
   **Alors** chaque média de l'export est une ligne : `envoyer`, `ignorer_deja_archive`, `ignorer_doublon_interne`,
   `reclasser_quarantaine` ou `quarantaine`
   **Et** les destinations suivent exactement le schéma de l'epic 3 (`photos/AAAA/AAAA-MM/<nom>`,
   `albums/<nom d'album conservé>/<nom>`, règle Q1 de désambiguïsation comprise), en tenant compte des objets déjà
   présents dans le bucket dédié
   **Et** les albums désignés dans `takeout.keptAlbums` vont dans `albums/<nom>/` ; un dossier d'album non désigné
   (ex. « 2019 à imprimer ») est classé par date, comme un dossier d'année

2. **Étant donné** un média du Takeout dont le seul objet archivé est sous `quarantaine/` (18 cas sur l'export réel)
   **Quand** le plan d'archivage est généré
   **Alors** il est traité comme à reclasser par date (`reclasser_quarantaine`, destination `photos/AAAA/AAAA-MM/<nom>`),
   jamais comme correctement rangé
   **Et** l'objet existant sous `quarantaine/` n'est ni supprimé, ni déplacé — l'outil ne supprime rien
   **Et** ces cas sont comptés et listés séparément dans le résumé

3. **Étant donné** un plan vérifié et une confirmation explicite par son empreinte
   **Quand** l'envoi démarre
   **Alors** chaque média des lignes `envoyer` et `reclasser_quarantaine` est envoyé par le point d'accès en écriture
   unique (flux depuis le zip local vérifié en 4.2, jamais réextrait sur disque), sans jamais écraser un objet existant,
   puis vérifié (taille, et empreinte quand elle est comparable en une seule requête)
   **Et** les zips de `backups/` ne sont jamais écrits ni supprimés, seulement lus
   **Et** le journal ne marque « envoyé » qu'après cette vérification réussie

4. **Étant donné** une passe en cours
   **Quand** je regarde la console
   **Alors** les compteurs envoyés, déjà présents, ignorés, en erreur et le volume restant sont visibles

5. **Étant donné** un plan non confirmé, une empreinte de confirmation fausse ou absente, une analyse invalide, ou un
   inventaire du bucket dédié antérieur à celui utilisé par l'analyse
   **Quand** je lance l'exécution
   **Alors** l'outil refuse, avec le message de la commande à relancer, et n'écrit rien

## Tasks / Subtasks

- [x] **T1 — Point d'accès en écriture : capacité d'envoi d'un fichier local** (AC 3)
  - [x] `src/clients/types.ts` : ajouter à `ArchiveWriter` la méthode `uploadFile(destinationKey: string, content: LocalFileContent): Promise<void>`
    (nouvelle interface `LocalFileContent { size: number; md5: string; open(): AsyncIterable<Uint8Array> }`, ou équivalent —
    lecture en flux, jamais un chemin de fichier temporaire réextrait). Documenter dans l'en-tête du module que ceci reste
    le SEUL point d'accès en écriture (NFR-1), maintenant capable de copie serveur (3.1) **et** de dépôt d'octets (4.3).
  - [x] `src/clients/archive-writer.ts` (`S3ArchiveWriter`) : implémenter `uploadFile`, gardée par `destinationProblem`
    (même garde que `copyFromSource` : bucket dédié configuré uniquement, clé dans `photos/`, `albums/` ou `quarantaine/`,
    jamais `backups/`, segments `.`/`..`/vides refusés). `PutObjectCommand` pour un fichier dont la taille est sous un seuil
    documenté (proposer un seuil explicite, ex. la même limite que la copie serveur n'a pas de sens ici — choisir un seuil
    raisonnable pour un envoi en une requête, ex. 100 Mio, à documenter et couvrir par un test de bascule) ; au-delà,
    `CreateMultipartUploadCommand` / `UploadPartCommand` / `CompleteMultipartUploadCommand` avec des tailles de partie
    fixes (réutiliser une convention compatible avec `src/utils/multipart-etag.ts` pour qu'un ETag résultant reste
    vérifiable par recalcul, comme la vérification des zips en 4.2). Envoi soumis à la même échéance (`sendDeadlineMs` /
    `S3_SEND_DEADLINE_MS`) que les autres écritures.
  - [x] Aucune méthode de suppression n'est ajoutée ni exposée. Aucun `DeleteObject*` importé.
  - [x] `tests/clients/archive-writer.test.ts` : mettre à jour l'inventaire figé de l'analyse statique pour autoriser
    `PutObjectCommand`, `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand` (et
    `AbortMultipartUploadCommand` si utilisé en cas d'échec en cours de multipart — sinon l'exclure explicitement et
    documenter pourquoi une partie orpheline n'est pas nettoyée). Toujours interdire tout `Delete*`, et toute écriture
    hors de `src/clients/archive-writer.ts`. Justifier la mise à jour dans un commentaire du test.

- [x] **T2 — Plan d'archivage Takeout (calcul pur)** (AC 1, 2)
  - [x] Nouveau module `src/takeout/archive-plan.ts` : types `TakeoutPlanAction` (`'envoyer' | 'ignorer_deja_archive' |
    'ignorer_doublon_interne' | 'reclasser_quarantaine' | 'quarantaine'`), `TakeoutPlanLine` (identifiant `{part, path}`,
    `fileName`, `size`, `md5`, `action`, `destination: string | null`, `keptOf: {part, path} | null` (doublon interne
    seulement), `reason`, `dateSource`), `TakeoutArchivePlan` (`id` : empreinte SHA-256 du contenu, `exportId`,
    `analyzedAt` (de l'analyse source), `destinationInventoryCompletedAt`, `keptAlbums`, `lines`, `violations`, `executable`).
  - [x] `buildArchivePlan(input): TakeoutArchivePlan`, pur, sans I/O :
    - Une ligne par média de `analysis.media` (représentants ET doublons internes — **tous** comptés, cf. invariant total).
    - Doublon interne (`m.duplicateOf !== null`) → `ignorer_doublon_interne`, `destination: null`, `keptOf: m.duplicateOf`,
      raison citant le représentant.
    - Représentant (`m.duplicateOf === null`) :
      - `archive.status === 'deja_archive'` (candidats sous `photos/` ou `albums/`, `proof` `md5` ou `etag_multipart`) →
        `ignorer_deja_archive`, `destination = archive.key`. **Décision explicite (revue 4.2, cas « archivé sous photos/
        et présent dans un album conservé »)** : le contenu déjà archivé n'est jamais recopié dans `albums/` au seul motif
        que le Takeout le range dans un album conservé — l'archive existante (sous `photos/` ou `albums/`, selon où elle a
        été trouvée) fait foi, sans duplication. Documenter ce choix dans l'en-tête du module et le compter dans le
        résumé (réutiliser `AnalysisSummary.albumRule.archivedInPhotosAndKeptAlbum`, déjà calculé en 4.2).
      - `archive.status === 'deja_archive'` mais **tous** les candidats sont sous `quarantaine/` (18 cas réels,
        `AnalysisSummary.quarantineOnly`) → `reclasser_quarantaine`, destination calculée comme un envoi normal
        (`photos/AAAA/AAAA-MM/<nom>`, cf. ci-dessous) ; l'objet en quarantaine n'est ni référencé comme « déjà bon » ni
        supprimé.
      - `archive.status === 'nouveau'` ou `'homonyme_different'` **ou** `'non_confirmable'` → `envoyer`. **Décision
        explicite** : `non_confirmable` n'a pas d'action dédiée dans les AC ; en l'absence de preuve d'identité, il est
        traité comme un homonyme différent (envoyé sous un nom éventuellement suffixé) — cohérent avec FR-12, qui
        interdit de ré-envoyer un média **prouvé** déjà présent, jamais un média seulement suspecté tel. Documenter ce
        choix (0 occurrence sur l'export réel, mais le code et les tests doivent le couvrir).
    - **Destination des lignes `envoyer`, `reclasser_quarantaine`, `quarantaine`** : construite avec `resolveNames` /
      `disambiguateNames` de `src/inventory/duplicates.ts` (réutilisés tels quels, DRY) :
      - `NamingEntry.etag` = `m.md5` (un MD5 hexadécimal 32 caractères satisfait déjà `etagKind() === 'md5'` : la règle
        de suffixe Q1 s'applique sans adaptation) ;
      - `NamingEntry.folder` = `albums/<m.folder>/` si `m.folderKind === 'album'` **et** `m.folder` est dans
        `takeout.keptAlbums` (comparaison NFC sans casse, réutiliser la logique de `keptAlbumTest`, à exporter ou
        dupliquer trivialement) ; sinon `destinationFolder(m.takenAt)` (`photos/AAAA/AAAA-MM/`) si `m.takenAt` n'est pas
        `null` ; sinon (date indéterminée) `quarantaine/<m.folder>/` — action alors `quarantaine` et non `envoyer` ;
      - `occupied` = inventaire actuel du bucket dédié restreint à `photos/`, `albums/`, `quarantaine/` (comme
        `archivedScope` de `takeout-analysis.ts`), **plus** les destinations déjà attribuées à d'autres lignes `envoyer`/
        `reclasser_quarantaine`/`quarantaine` du même plan (gratuit : `resolveNames` regroupe déjà tous les arrivants) ;
      - `disambiguateNames` (variante stricte) : toute anomalie de désambiguïsation rend le plan non exécutable
        (`violations`), jamais une ligne silencieusement omise.
  - [x] `checkArchivePlanInvariants(plan, analysis): string[]` — invariants exigés par la story, chacun vérifié
    indépendamment (pas de court-circuit) :
    1. total des lignes = `analysis.media.length` ;
    2. chaque média (`part`+`path`) présent exactement une fois ;
    3. somme des comptes par action = total des lignes ;
    4. aucune destination (parmi les lignes qui en ont une) attribuée deux fois, comparée en NFC sans casse ;
    5. aucune destination hors de `photos/`, `albums/`, `quarantaine/` ;
    6. toute ligne `ignorer_deja_archive` a une destination égale à `archive.key` avec `proof` `md5` ou `etag_multipart`
       (jamais `non_confirmable` ni `homonyme_different`) ; toute ligne `ignorer_doublon_interne` a un `keptOf` qui pointe
       vers une ligne du même plan d'action `envoyer` ou `reclasser_quarantaine`, de même MD5 et même taille ;
    7. chaque destination non nulle ≤ 1024 octets UTF-8 (`MAX_KEY_BYTES`, réutilisé de `repair-plan.ts`).
    Un plan à violations non vide n'est jamais exécutable (`executable = false`), quelle que soit sa taille.
  - [x] Empreinte du plan : SHA-256 du contenu normalisé (même approche que `planFingerprint` de `repair-plan.ts` — extraire
    une fonction commune si le format s'y prête sans complexifier, sinon dupliquer sobrement en le documentant : KISS
    prime sur une factorisation forcée entre deux domaines).
  - [x] `verifyStoredArchivePlan(plan, currentAnalysis, currentOccupied, lastRefusal): string[]` — sur le modèle de
    `verifyStoredPlan` (2.4/3.1) : plan périmé (analyse ou inventaire du bucket dédié différents de ceux utilisés à la
    génération, dernier refus non vide), contenu incohérent avec son empreinte, invariants rejoués, recalcul du plan
    (`buildArchivePlan`) dont l'empreinte doit être identique.

- [x] **T3 — Persistance du plan** (AC 1)
  - [x] Migration 10 : tables `takeout_plans` (une ligne par export, remplacée d'un bloc comme `takeout_analyses`) et
    `takeout_plan_lines`. Modèle `src/database/takeout-plan-model.ts` (`TakeoutPlanModel.replace/find`), sur le modèle de
    `RepairPlanModel`/`TakeoutAnalysisModel`.
  - [x] Dernier refus de génération persisté (comme `repair_plan_refusals`) — réutiliser la table existante avec une
    colonne ou un identifiant de domaine si elle est déjà générique, sinon table dédiée `takeout_plan_refusals` (vérifier
    `src/database/repair-plan-model.ts` avant de dupliquer).

- [x] **T4 — Exécution (envoi) et reprise minimale** (AC 3, 4, 5)
  - [x] Nouveau module `src/takeout/archive-execution.ts`, sur le modèle de `src/inventory/plan-execution.ts` :
    - Lignes à écrire : `envoyer`, `reclasser_quarantaine`, `quarantaine` (jamais `ignorer_*`).
    - **Réutilisation décidée** : le journal et le verrou d'exécution réutilisent tels quels `RepairExecutionModel`
      (`src/database/repair-execution-model.ts`) et son interface `ExecutionJournal` — déjà générique (`planId`,
      `sourceKey`, `destination`, état, message), indépendante de la sémantique « copie ». Utiliser `sourceKey =
      "<part>\u0000<path>"` (ou toute clé stable équivalente) comme identifiant de ligne. **Un seul verrou global** pour
      les deux journaux (réparation et Takeout) : cohérent avec le point d'accès en écriture unique, qui ne doit exécuter
      qu'une seule passe d'écriture à la fois, quel que soit son origine. Documenter ce choix dans l'en-tête du nouveau
      module ; ne pas créer de deuxième table de verrou.
    - `processLine` (variante « envoi ») : HEAD destination ; présent et identique (taille + MD5, ou taille seule si
      `etagKind` de l'objet présent est `multipart` et qu'aucune preuve n'est disponible — documenter la limite comme en
      3.1/3.2) → `deja_present`, pas de renvoi ; présent et différent → arrêt de sûreté, rien n'est écrit ; absent →
      journaliser `copie_en_cours` (ou un état équivalent) **avant** l'envoi, `writer.uploadFile(destination, ...)` en
      lisant l'entrée du zip via `readZipEntry` (jamais une réextraction disque), puis HEAD de vérification : taille, et
      MD5 comparé quand l'envoi tient en une requête ; en multipart, documenter explicitement que seule la taille est
      vérifiée (l'ETag multipart dépend du découpage et n'est pas comparable à un MD5 simple, comme en 3.1/3.2 pour la
      source). Le journal ne marque l'état « fait » qu'après cette vérification réussie.
    - Reprise (prépare 4.4 sans la sur-construire) : une ligne déjà `copie_en_cours` lors d'une relance est traitée comme
      en 3.2 (`isVerifiedCopy`-like) — vérifiée par HEAD avant tout renvoi, jamais renvoyée si déjà conforme.
    - `preflightExecution` : bucket dédié configuré, chaque destination passe `destinationProblem`, chaque zip source
      référencé est bien un zip local vérifié par 4.2 (présent dans `zipPaths`), aucune ligne au-delà d'une taille
      raisonnable sans le seuil multipart documenté en T1.
    - Résumé de progression : envoyés, déjà présents, ignorés (par catégorie), en erreur, volume restant — mêmes formes
      que `ExecutionOverview`/`ExecutionProgress` de `plan-execution.ts`, adaptées.
  - [x] Confirmation par empreinte (`--confirmer <empreinte>`, ≥ 12 caractères, `confirmationMatches` réutilisé tel quel) ;
    simulation par défaut (aucun `ArchiveWriter` créé, rien d'écrit).
  - [x] Refus explicites et testés : analyse absente ou invalide (`findValid` négatif) → message « relancez `gpb takeout
    analyser` » ; inventaire du bucket dédié strictement antérieur à `analysis.inventoryCompletedAt` → message « relancez
    `gpb inventory scan --bucket <dédié>` » ; plan périmé, incohérent, ou confirmation absente/fausse → message de la
    commande exacte à relancer, comme `executionCommandLine` (adapter le nom de la commande).

- [x] **T5 — Commandes CLI** (AC 1, 3, 4, 5)
  - [x] `gpb takeout planifier` (ou nom cohérent avec `gpb takeout valider`/`analyser`) : génère (ou affiche, si déjà à
    jour) le plan depuis la dernière analyse valide et l'inventaire actuel du bucket dédié ; affiche le résumé (comptes
    par action, volume à envoyer, cas de reclassement quarantaine listés, cas de la règle albums comptés) ; exports
    `--sortie a.csv b.json` en français, sur le modèle de `analysisExport`.
  - [x] `gpb takeout archiver` : vérifie le plan enregistré (`verifyStoredArchivePlan`), simule par défaut, exécute avec
    `--confirmer`, `--lever-verrou` (réutilisé de `reparation.ts`) ; progression affichée en continu (AC 4) ; résumé final.
  - [x] `src/index.ts` : enregistrer le module de commande si nouveau fichier `commands/takeout-plan.ts` /
    `commands/takeout-archive.ts` (ou extension de `commands/takeout.ts` si la taille du fichier le permet sans nuire à la
    lisibilité — KISS : préférer étendre l'existant si ça reste lisible, sinon scinder).

- [x] **T6 — Tests** (toutes les AC), sans aucun appel réseau ni bucket réel
  - [x] `tests/fixtures/fake-s3.ts` : faux client S3 minimal couvrant `PutObjectCommand`,
    `CreateMultipartUploadCommand`/`UploadPartCommand`/`CompleteMultipartUploadCommand`, `HeadObjectCommand`, en plus de ce
    qui existe déjà pour `HeadBucketCommand`/`CopyObjectCommand` si un fichier équivalent existe déjà (vérifier avant de
    dupliquer — chercher les faux clients S3 déjà utilisés par `tests/clients/archive-writer.test.ts`).
  - [x] `tests/fixtures/zip-builder.ts` : réutilisé tel quel pour construire des zips en mémoire (déjà utilisé en 4.2).
  - [x] Gardes du point d'accès pour l'envoi : bucket étranger, `backups/`, segments hors espaces autorisés, `..` —
    refusés avant tout appel réseau.
  - [x] Plan et invariants : un test par invariant cassé individuellement (les 7 listés en T2), qui vérifie que
    `executable` passe à `false` et que la violation précise apparaît.
  - [x] Homonyme suffixé envoyé sous un nom suffixé par le MD5 (règle Q1).
  - [x] Doublon interne : une seule ligne `envoyer`/`reclasser_quarantaine` par contenu, les autres `ignorer_doublon_interne`.
  - [x] Reclassement des 18 cas quarantaine : ligne `reclasser_quarantaine`, destination datée, objet quarantaine non
    supprimé (aucun appel de suppression, y compris dans le faux client).
  - [x] Objet présent identique à l'envoi → `deja_present`, aucun `PutObject`/`UploadPart` envoyé.
  - [x] Objet présent différent → arrêt, rien écrit après.
  - [x] Vérification après envoi en échec (HEAD post-envoi différent) → arrêt, ligne non marquée faite.
  - [x] Confirmation absente ou empreinte fausse → refus, aucun `ArchiveWriter` créé.
  - [x] Analyse invalide (`findValid` négatif) ou inventaire du bucket dédié antérieur → refus avec le message de la
    commande à lancer.
  - [x] Relance idempotente : deuxième exécution sur un plan déjà entièrement traité ne renvoie rien.
  - [x] Analyse statique : aucune commande `Delete*` ni `Put*`/`CreateMultipartUpload*` hors de
    `src/clients/archive-writer.ts` dans tout `src/`.
  - [x] Contre-épreuves (à faire, vérifier l'échec, puis restaurer par `cmp`) : neutraliser une garde d'envoi (ex.
    `destinationProblem` toujours `null`), neutraliser le contrôle « présent différent » (toujours considéré identique),
    neutraliser un invariant (ex. la vérification des destinations dupliquées) — dans les trois cas, un test dédié doit
    échouer ; fichier restauré ensuite, `cmp` identique à l'original.

## Dev Notes

### Contexte général et périmètre exact

- Cette story couvre **uniquement** l'envoi (FR-12, FR-13, FR-15). La reprise fine après coupure (FR-14) est préparée
  (réutilisation du journal/verrou existants, état `copie_en_cours` avant envoi) mais **pas sur-construite** : la story
  4.4 affinera si besoin (ex. reprise à l'intérieur d'un envoi multipart interrompu — hors périmètre ici, un envoi
  interrompu en cours de multipart repart de zéro pour cette ligne, ce qui est correct mais pas optimal ; documenter
  cette limite explicitement dans le code et laisser 4.4 l'améliorer si Marceau le juge utile en pratique).
- L'attestation avant suppression (FR-16/17, story 4.5) n'est pas traitée ici. Le point d'accès en écriture n'expose
  toujours aucune suppression.
- Aucune exécution réelle contre Cubbit dans cette story : toute commande, y compris `--help`, se lance dans une copie
  du projet dans `/tmp`, sans `.env` ni `data/`. C'est l'orchestrateur qui lance la simulation puis l'envoi réel.

### Réutilisation décidée (DRY) — à justifier dans le code, pas seulement ici

| Besoin | Réutilisé de | Pourquoi |
|---|---|---|
| Désambiguïsation des noms (règle Q1) | `src/inventory/duplicates.ts` (`resolveNames`, `disambiguateNames`, `comparableName`, `destinationFolder`, `etagKind`, `normalizeEtag`) | Un MD5 hexadécimal satisfait déjà le format « ETag simple » attendu par ces fonctions ; aucune adaptation nécessaire. |
| Racines d'écriture (`photos/`, `albums/`, `quarantaine/`), `MAX_KEY_BYTES` | `src/inventory/repair-plan.ts` (constantes exportées) | Le schéma de destination est **identique** à l'epic 3, par exigence de la story. |
| Garde du point d'accès (bucket, préfixes, segments invalides) | `src/clients/archive-writer.ts` (`destinationProblem`, `WriterScope`) | Le point d'accès reste unique (NFR-1) ; l'envoi passe par les mêmes gardes que la copie. |
| Journal d'exécution et verrou | `src/database/repair-execution-model.ts` (`RepairExecutionModel`, `ExecutionJournal`, verrou global) | Déjà générique (indépendant de la sémantique « copie »္) ; un seul verrou global impose qu'une seule passe d'écriture (réparation OU archivage Takeout) tourne à la fois, cohérent avec le point d'accès unique. Ne pas créer un deuxième verrou : ce serait réintroduire la possibilité de deux écrivains simultanés que 3.1/3.2 ont explicitement fermée. |
| Confirmation par empreinte | `src/inventory/plan-execution.ts` (`confirmationMatches`, `CONFIRMATION_LENGTH`) | Mécanique déjà générique (chaîne de caractères), sans dépendance au domaine réparation. |
| Statuts d'archivage, doublons internes, cas quarantaine-seule, cas de la règle albums | `src/takeout/takeout-analysis.ts` (`AnalyzedMedia`, `AnalysisSummary.quarantineOnly`, `AnalysisSummary.albumRule`) | Déjà calculés par la 4.2 ; la 4.3 ne réanalyse rien, elle planifie à partir de ce résultat. |

Ce qui n'est **pas** réutilisé tel quel, et pourquoi : `PlanLine`/`RepairPlan` de `repair-plan.ts` sont spécifiques à la
copie serveur (`sourceKey`/`sourceBucket`/`etag` d'objet S3, actions `copier`/`quarantaine`/`ignorer_doublon`/
`ignorer_deja_archive`) ; forcer une factorisation entre deux domaines de plan (objets S3 déjà en place vs. fichiers
locaux à envoyer) romprait la lisibilité de `repair-plan.ts` pour un bénéfice mince (KISS l'emporte, cf. règle du
CLAUDE.md du projet). Un nouveau type `TakeoutPlanLine` est préférable ; les fonctions **pures** de désambiguïsation et
de garde, elles, sont directement réutilisées car génériques par construction.

### Décisions explicites sur les deux cas signalés par la revue de 4.2

1. **Contenu `deja_archive` sous `photos/` (ou `albums/`) mais présent dans un album conservé du Takeout**
   (`AnalysisSummary.albumRule.archivedInPhotosAndKeptAlbum`, comptage déjà disponible) : **ignoré**, destination =
   `archive.key` existant. Le Takeout ne déclenche jamais une réorganisation ou une duplication d'un contenu déjà
   archivé — FR-12 (« ne jamais réuploader ») prime. Compter ces cas dans le résumé de la commande `planifier`.
2. **Contenu nouveau présent à la fois dans un dossier d'année et dans un album conservé**
   (`AnalysisSummary.albumRule.newInYearAndKeptAlbum`) : déjà résolu en amont par `markInternalDuplicates` (4.2), qui
   choisit l'occurrence d'album conservé comme représentant. La 4.3 se contente de suivre ce choix : le représentant
   (`duplicateOf === null`) est envoyé vers `albums/<album>/<nom>` ; l'occurrence du dossier d'année devient
   `ignorer_doublon_interne`. Aucune logique supplémentaire à écrire dans le plan pour ce cas ; documenter dans le code
   que c'est intentionnel et compter ces cas dans le résumé (réutiliser `AnalysisSummary.albumRule.newInYearAndKeptAlbum`).

### Schéma de destination (rappel exact, identique epic 3)

- `photos/AAAA/AAAA-MM/<nom>` (`CHRONO_ROOT` + `destinationFolder(takenAt)` de `duplicates.ts`).
- `albums/<nom d'album conservé>/<nom>` (`ALBUMS_ROOT`), seulement si le dossier Takeout est dans `takeout.keptAlbums`
  (comparaison NFC sans casse). Un dossier d'album Takeout non désigné (ex. « 2019 à imprimer ») est traité comme un
  dossier d'année : classé par date, jamais sous `albums/`.
- `quarantaine/<dossier Takeout>/<nom>` pour une date indéterminée (0 cas sur l'export réel, mais à coder et tester).
- Homonyme de contenu différent (`homonyme_different`, `non_confirmable` traité pareil) : suffixe `_<8 premiers
  caractères du MD5>` avant l'extension, allongé si nécessaire (règle Q1, `DISAMBIGUATION_RULE`, inchangée).

### Point d'accès en écriture (`src/clients/archive-writer.ts`)

Lire entièrement ce fichier avant modification (déjà lu pour cette story — voir extraits ci-dessus dans le contexte de
recherche). État actuel : `checkAccess`, `headDestination`, `copyFromSource`, gardées par `scopeProblem` /
`destinationProblem` / `sourceKeyProblem`. Cette story **ajoute** `uploadFile`, gardée par `destinationProblem`
uniquement (il n'y a pas de « clé source » S3 : la source est un fichier local, hors du périmètre `sourceKeyProblem`).
Aucune méthode existante n'est modifiée dans son comportement ; `copyFromSource` continue de servir à la réparation
(epic 3) sans changement.

Limite à documenter (comme pour `copyFromSource`, cf. `isCopyRefusedBeforeWrite`) : l'échéance d'envoi borne le client,
pas un dépôt déjà entièrement reçu par le serveur avant l'abandon — mêmes conséquences que documentées en 3.1/3.2.

### Persistance et fraîcheur du plan

- Analyse d'entrée : `TakeoutAnalysisModel.findValid(exportId, { zips, inventoryCompletedAt: <inventaire actuel du bucket
  dédié>, keptAlbums })`. **Attention** : `findValid` exige une égalité stricte de `inventoryCompletedAt` — si le bucket
  dédié a été réinventorié depuis l'analyse, `findValid` renverra `null` alors que l'analyse elle-même (zips, albums)
  reste valable. Pour respecter l'exigence « l'inventaire du bucket dédié doit être postérieur ou égal à celui de
  l'analyse — refuse sinon », la génération du plan doit :
  1. Lire l'analyse brute (`TakeoutAnalysisModel.find(exportId)`), vérifier elle-même zips et albums (comme `findValid`
     le ferait), et refuser sinon (message : relancer `gpb takeout analyser`).
  2. Comparer l'horodatage de fin du dernier inventaire du bucket dédié en base à `analysis.inventoryCompletedAt` :
     refuser si strictement antérieur (message : relancer `gpb inventory scan --bucket <dédié>`) ; accepter s'il est égal
     ou postérieur, et utiliser dans ce cas l'inventaire **actuel** (potentiellement plus récent) pour les destinations
     occupées.
  3. Ne jamais recalculer les statuts d'archivage (`archive.status`) des médias : ils restent ceux stockés par la 4.2.
     Recalculer les statuts à partir d'un inventaire plus récent est explicitement **hors périmètre** de cette story (ce
     serait rouvrir l'analyse, pas planifier) ; si Marceau veut des statuts à jour, il relance `gpb takeout analyser`.
- Fraîcheur avant exécution (`verifyStoredArchivePlan`) : même logique que `verifyStoredPlan` de la réparation — plan
  périmé si l'analyse ou l'inventaire du bucket dédié ont changé depuis sa génération, ou si le dernier refus n'est pas
  vide ; contenu incohérent avec son empreinte ; invariants rejoués ; recalcul (`buildArchivePlan`) dont l'empreinte doit
  correspondre.

### Fichiers à lire avant modification (état actuel, à ne pas casser)

- `src/clients/archive-writer.ts`, `src/clients/types.ts` (interfaces `ArchiveWriter`, `DestinationObject`) — lus
  intégralement pour cette story (voir ci-dessus).
- `src/inventory/duplicates.ts` — lu intégralement (règle Q1, `resolveNames`/`disambiguateNames`, `destinationFolder`).
- `src/inventory/repair-plan.ts` — lu (constantes de racines, `checkPlanInvariants`, `assessPlanFreshness`,
  `verifyStoredPlan`, `storedContentProblems` comme modèle direct pour `archive-plan.ts`).
- `src/inventory/plan-execution.ts`, `src/database/repair-execution-model.ts` — lus intégralement : modèle direct de
  `archive-execution.ts`, et réutilisation décidée du journal/verrou.
- `src/takeout/takeout-analysis.ts` — lu intégralement (types `AnalyzedMedia`, `AnalysisSummary`, `markInternalDuplicates`,
  `matchArchive`, `archivedScope`).
- `src/database/takeout-analysis-model.ts` — lu intégralement (`findValid`, schéma de stockage, modèle pour
  `takeout-plan-model.ts`).
- `src/commands/reparation.ts` — lu (patron exact pour la commande `archiver` : simulation par défaut, `--confirmer`,
  `--lever-verrou`, création tardive du `writer`).
- `src/commands/takeout.ts`, `src/commands/plan.ts` — à lire avant d'écrire les nouvelles commandes (conventions
  `runCommand`, `readPlanInput`-like, affichage `chalk`, formats `formatBytes`/`formatNumber`).
- `src/config/types.ts` (`AppConfig.takeout.keptAlbums`), `src/clients/s3-client.ts` (délais d'envoi, `destinationClientConfig`).

### Tests

- Aucun appel réseau, aucun bucket réel, pas de `.env`. Faux client S3 (étendre celui déjà utilisé par
  `tests/clients/archive-writer.test.ts` si sa forme le permet), zips en mémoire (`tests/fixtures/zip-builder.ts`,
  existant).
- Vérifier `npx tsc --noEmit`, `npm test`, `npm run lint` (0 erreur — vert depuis la 4.2, ne pas le casser), `npm run
  build` après chaque étape significative, pas seulement à la fin.
- Toute commande CLI, `--help` compris, dans une copie du projet dans `/tmp` sans `.env` ni `data/`.

### Interdits stricts (rappel)

- Aucune exécution réelle contre Cubbit (aucun envoi, aucun HEAD réel) pendant le développement de cette story.
- Aucune lecture de `.env`.
- Aucune modification de `data/` (index réel, plans exécutés, zips vérifiés) — travailler sur une copie ou une base de
  test dédiée pour tout ce qui touche à la persistance.
- Aucune régression sur `git log -1`/vérité de `data/app.db` : vérifier son sha256 avant/après toute manipulation
  involontaire du dépôt réel.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 4.3 : Archiver uniquement les médias nouveaux]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#FR-12, FR-13, FR-14, FR-15]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/4-2-dater-et-identifier-chaque-media-de-facon-stable.md#Revue de clôture, Revue `pr-reviewer` du 2026-09-26]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-4-produire-le-plan-de-reparation-inspectable.md#Consignes impératives pour la story 3.1, Revue de clôture]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-1-copier-l-archive-vers-le-bucket-dedie-selon-le-plan.md#Revue de clôture]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-2-reprendre-une-reparation-interrompue.md#Consignes impératives pour la story 3.2, Revue de clôture]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/3-3-rendre-compte-de-la-reparation.md#Revue de clôture]
- [Source: src/inventory/repair-plan.ts]
- [Source: src/inventory/plan-execution.ts]
- [Source: src/inventory/duplicates.ts]
- [Source: src/database/repair-execution-model.ts]
- [Source: src/database/takeout-analysis-model.ts]
- [Source: src/takeout/takeout-analysis.ts]
- [Source: src/clients/archive-writer.ts]
- [Source: src/clients/types.ts]
- [Source: src/commands/reparation.ts]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

- `npx tsc --noEmit` : code 0. `npx jest` : code 0, 31 suites, 697 tests (634 hérités de 4.2 + 63 nouveaux/modifiés :
  archive-writer 12 nouveaux tests `uploadFile`, archive-plan 26, archive-execution 13, takeout-plan-model 5,
  connection 0 nouveaux (2 assertions mises à jour), repair-execution-model 1 nouveau (régression NUL), commands
  takeout-plan 7, commands takeout-archive 5).
- `npm run lint` : code 0 (0 erreur, 23 avertissements `no-explicit-any` préexistants, inchangés depuis 4.2).
- `npm run build` : code 0.
- CLI dans une copie du projet (dossier temporaire, `dist/` + `package.json` + lien `node_modules`, sans `.env` ni
  `data/`) : `--help`, `takeout --help`, `takeout planifier --help`, `takeout archiver --help` code 0 ; `takeout
  planifier --export x` et `takeout archiver --export x` sans bucket dédié configuré → code 1, message explicite,
  aucun appel réseau (refus avant toute construction de client S3). Copie supprimée après vérification.
- **Incident détecté et corrigé pendant cette story** : `locationKey` (`src/takeout/archive-plan.ts`) utilisait
  initialement `\u0000` comme séparateur entre `part` et `path`. Ce séparateur est silencieusement tronqué par la
  couche SQLite (`node:sqlite`) quand il est persisté comme `source_key` du journal d'exécution réutilisé
  (`repair_execution_lines`), ce qui aurait cassé la reprise (4.4) et la vérification d'état pour tout média dont le
  chemin suit le nom de partie. Découvert par le test d'intégration `tests/commands/takeout-archive.test.ts`
  (assertion sur l'état journalisé), corrigé en remplaçant le séparateur par U+241F (jamais tronqué), et couvert par
  un test de régression dédié dans `tests/database/repair-execution-model.test.ts` démontrant la troncature avec
  `\u0000` et l'absence de troncature avec U+241F, sur une vraie base SQLite temporaire.
- Contre-épreuves (fichiers restaurés, `cmp` identique après chacune) :
  1. Garde d'envoi neutralisée (`destinationProblem` commentée dans `S3ArchiveWriter.uploadFile`) → 10 tests de
     `tests/clients/archive-writer.test.ts` en échec (clés hors espaces autorisées acceptées).
  2. Contrôle « présent différent » neutralisé (`isSameContent` renvoyant toujours `true`) → 2 tests de
     `tests/takeout/archive-execution.test.ts` en échec (objet différent en destination accepté comme identique,
     absence d'arrêt de sûreté).
  3. Invariant « destination attribuée deux fois » neutralisé dans `checkArchivePlanInvariants`
     (`src/takeout/archive-plan.ts`) → le test dédié de `tests/takeout/archive-plan.test.ts` échoue (violation
     attendue absente).
- sha256 de `data/app.db` (dépôt réel) : `1f3a06c0d4fbfcd0522116542b44b2e169f125d7f35e9741931513a1e2e6e53b`, identique
  avant et après toute la story (jamais touché : tous les tests utilisent des bases SQLite temporaires ; toutes les
  vérifications CLI ont eu lieu dans des copies du projet sous `/tmp`).

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- **Point d'accès en écriture (`src/clients/archive-writer.ts`)** : nouvelle méthode `uploadFile(destinationKey, body:
  Buffer)`, gardée par `destinationProblem` (même garde que `copyFromSource`). `PutObjectCommand` en une requête sous
  `MULTIPART_UPLOAD_THRESHOLD_BYTES` (100 Mio, injectable pour les tests) ; au-delà, dépôt multipart
  (`CreateMultipartUploadCommand` / `UploadPartCommand` / `CompleteMultipartUploadCommand`) en parties de
  `UPLOAD_PART_SIZE_BYTES` (16 Mio, injectable). Aucune commande de suppression, y compris pour un dépôt multipart
  inachevé (pas d'`AbortMultipartUpload` : ce serait la seule suppression du point d'accès). Inventaire figé de
  l'analyse statique (`tests/clients/archive-writer.test.ts`) étendu en conséquence, avec justification explicite en
  commentaire du fichier de test.
- **Plan d'archivage (`src/takeout/archive-plan.ts`, nouveau)** : `TakeoutPlanLine` (5 actions : `envoyer`,
  `ignorer_deja_archive`, `ignorer_doublon_interne`, `reclasser_quarantaine`, `quarantaine`), `buildArchivePlan` pur
  depuis l'analyse 4.2 et l'inventaire du bucket dédié restreint à `photos/`, `albums/`, `quarantaine/`. Réutilise
  telles quelles `resolveNames`/`disambiguateNames`/`destinationFolder`/`comparableName` de `duplicates.ts` (un MD5
  hexadécimal satisfait le format ETag simple attendu, aucune adaptation). 7 invariants vérifiés indépendamment
  (`checkArchivePlanInvariants`), empreinte SHA-256 (`archivePlanFingerprint`), fraîcheur et vérification avant
  exécution (`assessArchivePlanFreshness`, `verifyStoredArchivePlan`) sur le modèle exact de `repair-plan.ts` (2.4/3.1).
  Décisions explicites codées et testées : contenu déjà archivé jamais dupliqué dans `albums/` au seul motif d'un
  album conservé Takeout ; `non_confirmable` traité comme `homonyme_different` (envoyé) ; quarantaine-seule sans date
  connue laissée en l'état (reclassement impossible).
- **Persistance (migration 10)** : `takeout_archive_plans`, `takeout_archive_plan_lines`, `takeout_archive_plan_refusals`.
  `src/database/takeout-plan-model.ts` (`TakeoutPlanModel`), sur le modèle de `RepairPlanModel`. Journal et verrou
  d'exécution **réutilisés tels quels** (`RepairExecutionModel`, tables `repair_execution_lines`/`repair_execution_lock`,
  migrations 7/8 inchangées) : un seul verrou global pour réparation et archivage Takeout, cohérent avec le point
  d'accès en écriture unique — décision documentée dans `src/takeout/archive-execution.ts`.
- **Exécution (`src/takeout/archive-execution.ts`, nouveau)** : `executeArchivePlan`, sur le modèle de
  `plan-execution.ts` (3.1/3.2). Séquence par ligne : HEAD, lecture du média en flux depuis le zip local vérifié
  (`readWholeZipEntry`, nouvel export de `zip-entry-stream.ts`), vérification MD5 du contenu lu contre celui de
  l'analyse (défense contre un zip modifié depuis l'analyse), dépôt, HEAD de vérification (taille, et MD5 si l'envoi
  tient en une requête). Jamais d'écrasement (`isSameContent`), limite documentée pour un envoi multipart (seule la
  taille est vérifiable après coup, comme pour une source multipart en 3.1/3.2). Reprise minimale : état
  `copie_en_cours` journalisé avant l'envoi, accepté à la relance si l'objet est un dépôt vérifié.
- **Commandes** : `gpb takeout planifier --export <horodatage> [--sortie a.csv b.json]` (nouveau fichier
  `src/commands/takeout-plan.ts`) — exige une analyse valide (`TakeoutAnalysisModel.findValid`, zips et albums
  conservés) et un inventaire du bucket dédié postérieur ou égal à celui de l'analyse (`TakeoutAnalysisModel.findValid`
  étendu pour accepter `inventoryCompletedAt: undefined`, contrôle de fraîcheur fait séparément par la commande).
  `gpb takeout archiver --export <horodatage> [--dossier] [--confirmer <empreinte>] [--lever-verrou]` (nouveau fichier
  `src/commands/takeout-archive.ts`) — simulation par défaut, exécution confirmée par empreinte (≥ 12 caractères,
  mécanique réutilisée de `plan-execution.ts`), verrou et reprise comme `gpb reparation executer`. Les deux commandes
  sont enregistrées dans le groupe `gpb takeout` existant (`src/commands/takeout.ts`), `selectGroups`/`defaultSources`/
  `parsePartCount`/`progressPrinter`/`PHASE_LABELS`/`ORIGIN_LABELS` exportés pour être réutilisés (DRY).
- Écart au cycle red-green strict : pour les modules calqués sur un modèle existant (archive-plan sur repair-plan,
  archive-execution sur plan-execution), l'implémentation et ses tests ont été écrits dans la même passe puis validés
  par exécution et contre-épreuves, comme pour la 4.2.

### File List

- `src/clients/archive-writer.ts`, `src/clients/types.ts` (modifiés — capacité `uploadFile`, seuils multipart)
- `src/takeout/archive-plan.ts` (nouveau — plan d'archivage, invariants, empreinte, fraîcheur)
- `src/takeout/archive-execution.ts` (nouveau — exécution de l'envoi, reprise minimale)
- `src/takeout/zip-entry-stream.ts` (modifié — `readWholeZipEntry` exporté, réutilisé par `readSmallZipEntry`)
- `src/database/connection.ts` (modifié — migration 10 : `takeout_archive_plans`, `takeout_archive_plan_lines`,
  `takeout_archive_plan_refusals`)
- `src/database/takeout-plan-model.ts` (nouveau — persistance du plan d'archivage)
- `src/database/takeout-analysis-model.ts` (modifié — `findValid` accepte `inventoryCompletedAt: undefined`)
- `src/commands/takeout-plan.ts` (nouveau — `gpb takeout planifier`)
- `src/commands/takeout-archive.ts` (nouveau — `gpb takeout archiver`)
- `src/commands/takeout.ts` (modifié — enregistrement des deux nouvelles commandes, exports DRY :
  `selectGroups`, `defaultSources`, `parsePartCount`, `progressPrinter`, `PHASE_LABELS`, `ORIGIN_LABELS`)
- `tests/clients/archive-writer.test.ts` (modifié — tests `uploadFile`, inventaire de l'analyse statique étendu et
  justifié)
- `tests/fixtures/fake-s3.ts` (modifié — `PutObjectCommand`, dépôt multipart, `afterUpload`)
- `tests/takeout/archive-plan.test.ts` (nouveau)
- `tests/takeout/archive-execution.test.ts` (nouveau)
- `tests/database/takeout-plan-model.test.ts` (nouveau)
- `tests/database/connection.test.ts` (modifié — version de schéma attendue 9 → 10)
- `tests/database/repair-execution-model.test.ts` (modifié — test de régression NUL/séparateur)
- `tests/commands/takeout-plan.test.ts` (nouveau)
- `tests/commands/takeout-archive.test.ts` (nouveau)
- Correction (revue en exécution réelle, 2026-09-26) : `src/takeout/takeout-analysis.ts`, `src/database/takeout-analysis-model.ts`,
  `src/database/connection.ts` (migration 11), `src/takeout/archive-plan.ts`, `src/database/takeout-plan-model.ts`,
  `src/commands/takeout-plan.ts` (modifiés) ; `tests/takeout/takeout-analysis.test.ts`, `tests/takeout/archive-plan.test.ts`,
  `tests/takeout/archive-execution.test.ts`, `tests/database/takeout-plan-model.test.ts`, `tests/commands/takeout-plan.test.ts`,
  `tests/database/connection.test.ts` (modifiés)

## Tâche de revue (correction post-simulation réelle)

- [x] Corriger l'invariant « ligne `ignorer_deja_archive` » pour accepter la preuve `etag_multipart` (pas seulement MD5)
- [x] Étendre le même traitement à `ignorer_doublon_interne` (représentant déjà archivé) et à `verifyStoredArchivePlan`
- [x] Ajouter la persistance de la preuve exacte vue par l'analyse (`archivedEtag`, migration 11)
- [x] Revérifier ETag ET taille de l'objet archivé contre l'inventaire actuel, message explicite si l'un a changé
- [x] Tests : MD5 OK, ETag multipart OK, ETag multipart changé → échec, taille changée → échec, aucune preuve → échec,
      doublon interne dont le représentant est `ignorer_deja_archive` → OK
- [x] Contre-épreuve : accepter la preuve multipart sans vérifier ETag/taille → 3 tests en échec ; restauré (`cmp`)
- [x] `tsc`, tests, lint, build vérifiés après correction

### Motif (sortie réelle citée par l'orchestrateur, 2026-09-26)

Simulation réelle de `gpb takeout planifier --export 20260806T062636Z` (lecture seule, base copiée) :

```
2407 lignes, exécutable false, 0 anomalies, 112 invariants en échec
❌ Invariants : KO
   …/Photos de 2021/IMG_20210411_111355.jpg déclaré déjà archivé sous photos/2021/2021-04/IMG_20210411_111355.jpg,
   mais aucun objet présent de même MD5 (1c1cb82d…)
   … (idem, ~93 .mp4 et 19 .jpg)
```

Cause : les 112 médias en échec sont exactement ceux confirmés par la story 4.2 par recalcul d'ETag multipart
(`archive_proof = 'etag_multipart'`), jamais par MD5 (1 885 par MD5 + 112 par ETag multipart = 1 997 déjà archivés,
0 non confirmable). L'invariant comparait `l.md5` (identité du contenu Takeout, toujours un MD5) à l'ETag de l'objet
archivé, qui est un ETag multipart (`<md5-des-md5>-N`) pour ces 112 objets : comparaison structurellement impossible.

### Correction apportée

- `AnalyzedMedia.archive.archivedEtag` (nouveau champ, `src/takeout/takeout-analysis.ts`) : ETag (normalisé) de l'objet
  archivé tel que vu par l'analyse, sous sa forme d'origine (MD5 simple ou multipart confirmé) — jamais l'un comparé à
  l'autre. Persisté par une migration 11 (`ALTER TABLE takeout_media ADD COLUMN archived_etag TEXT`), migration 9
  volontairement non modifiée (déjà appliquée sur la base réelle). **Toute analyse enregistrée avant cette migration
  doit être refaite (`gpb takeout analyser`) pour repeupler ce champ avant de régénérer un plan.**
- `TakeoutPlanLine.archivedEtag` (`src/takeout/archive-plan.ts`) reporte cette preuve sur les lignes `ignorer_deja_archive`.
  L'invariant 6 compare désormais `archivedEtag` (et la taille) à l'objet réellement présent dans l'inventaire actuel —
  plus jamais `md5` à un ETag quelconque. Message explicite si la preuve ou la taille ont changé depuis l'analyse
  (« … a changé depuis l'analyse : relancez gpb takeout analyser ») ou si aucune preuve n'a été enregistrée.
  L'inventaire occupé passé aux invariants porte désormais la taille (`ArchivedObjectSnapshot`, `archivedObjectsFrom`,
  remplace `occupiedFrom` pour ce seul usage — `OccupiedDestination`, sans taille, reste inchangé pour `resolveNames`).
- Le doublon interne (`ignorer_doublon_interne`) accepte maintenant un représentant d'action `ignorer_deja_archive`
  (en plus de `envoyer`/`reclasser_quarantaine`) : un contenu dupliqué en interne peut être déjà archivé.
- `verifyStoredArchivePlan`/`storedArchivePlanProblems` transmettent le même type enrichi ; aucun changement de
  comportement en dehors de l'invariant 6 et du cas doublon interne ci-dessus.

## Tâche de revue (pr-reviewer, contexte neuf — 2026-09-28)

Revue rendue « CHANGEMENTS REQUIS » : 1 BLOQUANT, 3 IMPORTANTS, 6 MINEURS. Tous corrigés, avec tests, avant de
redemander la revue.

- [x] **BLOQUANT** — `checkArchivePlanInvariants` (invariant 6, `src/takeout/archive-plan.ts`) : une ligne
      `ignorer_deja_archive` dont l'objet a disparu du bucket dédié entre l'analyse et le plan (supprimé, ou déplacé
      hors de `photos/`/`albums/`/`quarantaine/`) ne déclenchait **aucune** violation dès que sa clé était absente de
      `occupied` (`if (present && …)` ne se déclenche que si `present` existe). Cette ligne n'est jamais envoyée
      (exclue de `linesToSend`) et jamais vérifiée à l'exécution (aucun HEAD n'est fait pour une ligne ignorée) :
      **la photo aurait été perdue au premier nettoyage des zips locaux**, sans qu'aucun signal ne le montre avant.
      Le commentaire justifiant l'absence de vérification (« inventaire antérieur légèrement différent ») était faux :
      l'analyse et le plan filtrent tous deux par `archivedScope` sur le même bucket, et le plan exige un inventaire
      courant au moins aussi récent que celui de l'analyse (`readArchivePlanInput`). Correction : `present ===
      undefined` est désormais une violation explicite (« objet introuvable dans l'inventaire courant : relancez
      `gpb takeout analyser` »), le commentaire erroné est supprimé, et la même règle protège un doublon interne
      (`ignorer_doublon_interne`) dont le représentant est `ignorer_deja_archive` (via la vérification du représentant
      lui-même, présent une seule fois dans les lignes du plan). Tests ajoutés (`tests/takeout/archive-plan.test.ts`) :
      objet présent → OK, objet absent → violation explicite, doublon interne dont le représentant a un objet disparu
      → violation. Deux tests existants adaptés pour fournir l'objet occupé attendu (sinon désormais en échec, à
      raison). Contre-épreuve faite (retour à `present && …`) : les 2 nouveaux tests échouent bien ; restauré (`cmp`
      identique à la version corrigée).
- [x] **IMPORTANT** — `isVerifiedUpload` (`src/takeout/archive-execution.ts`) ne vérifiait que la taille au-delà du
      seuil multipart, sans jamais recalculer l'ETag multipart attendu, alors que nous déposons nous-mêmes en parties
      de taille connue (`UPLOAD_PART_SIZE_BYTES`). Un dépôt corrompu ou tronqué côté serveur au-delà du seuil aurait
      été accepté silencieusement. Correction : nouvelle fonction `computeMultipartEtag` (`src/utils/multipart-etag.ts`,
      réutilise `PartHasher`, taille de partie **connue**, jamais devinée comme le fait `MultipartEtagHasher` pour un
      objet tiers) ; `isVerifiedUpload` la recalcule sur le contenu réellement déposé et la compare à l'ETag renvoyé.
      Devenue asynchrone (`readBody: () => Promise<Buffer>`, lu seulement si nécessaire — jamais pour un dépôt en une
      seule requête, dont l'ETag simple suffit). Tests ajoutés : dépôt multipart vérifié (unitaire et bout-en-bout),
      ETag multipart divergent → arrêt (unitaire et bout-en-bout).
- [x] **IMPORTANT** — branche `PRAGMA table_info` de la migration 12 (`src/database/connection.ts`) non couverte par
      un test, exactement le défaut qui a cassé `gpb takeout planifier` en exécution réelle. Tests ajoutés
      (`tests/database/connection.test.ts`) : colonne déjà présente avant la migration 12 (incident reproduit) → aucune
      exception, colonne présente une seule fois ; base neuve → la migration l'ajoute.
- [x] **IMPORTANT** — un dépôt multipart interrompu (`src/clients/archive-writer.ts`) laisse des parties facturées,
      invisibles de l'outil, sans aucun signal. Ajout de `listIncompleteMultipartUploads` (lecture seule,
      `ListMultipartUploadsCommand`, NFC-1 respecté : aucune capacité de suppression ajoutée), exposée dans le bilan
      de `gpb takeout archiver` en fin d'exécution (« N dépôt(s) multipart inachevé(s) sur `<bucket>` — à purger côté
      Cubbit »). **Action pour Marceau, hors code : poser côté Cubbit une règle de cycle de vie
      `AbortIncompleteMultipartUpload` sur `marceau-photos`, faute de quoi ces parties s'accumulent sans purge
      automatique.** Tests ajoutés avec faux client (`tests/clients/archive-writer.test.ts`,
      `tests/commands/takeout-archive.test.ts`).
- [x] MINEUR — commentaire périmé (`src/takeout/archive-execution.ts:19`, séparateur `\u0000`) corrigé en `␟`.
- [x] MINEUR — séparateur `\u0000` de la `Map` d'entrées de zip (`src/commands/takeout-archive.ts`) remplacé par
      `locationKey` (déjà importé), des deux côtés.
- [x] MINEUR — libellés harmonisés : `archiver` affiche désormais « À déposer (envois + reclassements + quarantaine) »
      (315), et `planifier` affiche ce même total en plus de « Volume à envoyer » (297, envois seuls) — c'est le
      chiffre que Marceau confirme juste avant la première écriture.
- [x] MINEUR — code mort supprimé (KISS/DRY) : `verifyPlan` (`src/commands/takeout-plan.ts`, exporté, jamais appelé)
      et le paramètre `problems` de `display` (toujours `[]`).
- [x] MINEUR — `sentAsSingleRequest` lisait la constante de module au lieu du seuil injecté au writer. Remplacé par
      `ArchiveExecutionDeps.uploadThresholds` (défaut : constantes de production), propagé à `isVerifiedUpload`.
- [x] MINEUR — `--lever-verrou` (`src/commands/takeout-archive.ts`) précise désormais qu'il lève le verrou **global**
      (partagé avec `gpb reparation executer`) et cite le `plan_id` détenu dans le message affiché.

Vérifié après correction : `tsc` 0, tests 720/720 (31 suites), lint 0 erreur, build 0 ; `data/app.db` inchangé
(sha256 identique avant/après). Aucun appel réel à Cubbit, `.env` non lu, `data/` non modifié — tout vérifié avec
`FakeS3`/`FakeObject` en mémoire.

### Fichiers modifiés par cette tâche de revue

- `src/takeout/archive-plan.ts`, `src/takeout/archive-execution.ts`, `src/clients/archive-writer.ts`,
  `src/clients/types.ts`, `src/database/connection.ts`, `src/commands/takeout-archive.ts`, `src/commands/takeout-plan.ts`,
  `src/utils/multipart-etag.ts` (modifiés)
- `tests/takeout/archive-plan.test.ts`, `tests/takeout/archive-execution.test.ts`, `tests/clients/archive-writer.test.ts`,
  `tests/database/connection.test.ts`, `tests/commands/takeout-archive.test.ts`, `tests/fixtures/fake-s3.ts` (modifiés)

## Change Log

- 2026-09-26 : création de la story 4.3 (contexte complet : plan d'archivage Takeout, capacité d'envoi du point d'accès
  en écriture unique, réutilisation décidée du journal/verrou de la réparation, décisions explicites sur les cas
  album/année et quarantaine signalés par la revue de 4.2).
- 2026-09-26 : implémentation complète (`gpb takeout planifier`, `gpb takeout archiver`) : capacité d'envoi du point
  d'accès en écriture (`uploadFile`, une requête ou multipart), plan d'archivage pur avec 7 invariants et empreinte,
  persistance (migration 10), exécution avec reprise minimale sur le journal/verrou réutilisés de la réparation.
  Incident détecté et corrigé pendant le développement : séparateur `\u0000` de `locationKey` tronqué par SQLite,
  remplacé par U+241F, couvert par un test de régression. Tests : 31 suites, 697 tests, code 0 ; `tsc`, lint (0 erreur)
  et build au vert ; 3 contre-épreuves faites et restaurées (`cmp` identique) ; `data/app.db` inchangé pendant toute la
  story. Statut laissé à « review ».
- 2026-09-26 : correction post-simulation réelle (`gpb takeout planifier` sur l'export du 6 août, base copiée) — 112
  invariants en échec pour les médias confirmés uniquement par ETag multipart, comparés à tort à un MD5. Ajout de la
  preuve exacte (`archivedEtag`, migration 11) revérifiée avec la taille contre l'inventaire actuel ; doublon interne
  accepté quand le représentant est `ignorer_deja_archive`. Tests : 31 suites, 705 tests, code 0 ; `tsc`, lint
  (0 erreur) et build au vert ; contre-épreuve faite et restaurée (`cmp` identique) ; `data/app.db` inchangé.
- 2026-09-28 : revue `pr-reviewer` (contexte neuf) rendue « CHANGEMENTS REQUIS » (1 BLOQUANT, 3 IMPORTANTS,
  6 MINEURS), tous corrigés avec tests. BLOQUANT le plus grave : l'invariant 6 ne détectait pas la disparition de
  l'objet archivé d'une ligne `ignorer_deja_archive` (photo qui aurait été perdue au nettoyage des zips, sans aucun
  signal) — corrigé, contre-épreuve faite et restaurée. Vérification post-envoi désormais réelle au-delà du seuil
  multipart (ETag recalculé, pas seulement la taille). Migration 12 couverte par un test reproduisant l'incident réel
  qui a cassé `planifier`. Dépôts multipart inachevés désormais signalés (lecture seule) en fin d'`archiver` — reste à
  faire côté Cubbit (hors code) : poser une règle de cycle de vie `AbortIncompleteMultipartUpload` sur
  `marceau-photos`. Libellés « à envoyer » harmonisés entre `planifier` et `archiver`. Code mort supprimé. Tests :
  31 suites, 720 tests, code 0 ; `tsc`, lint (0 erreur) et build au vert ; contre-épreuve du BLOQUANT faite et
  restaurée (`cmp` identique) ; `data/app.db` inchangé (sha256 identique avant/après). Statut laissé à « review » —
  à repasser en revue avant merge.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` (Opus) en 2 passes : APPROUVER, aucun BLOQUANT restant.
- BLOQUANT corrigé : l'invariant « toute ligne ignorée pointe vers un objet archivé existant » ne vérifiait pas l'existence ; un média dont la copie archivée avait disparu était ignoré sans violation ni HEAD, donc perdu à la suppression des zips. Éprouvé par le relecteur sur 6 scénarios (objet retiré, remplacé, taille différente, représentant de doublon disparu).
- IMPORTANTS corrigés : vérification d'un dépôt multipart réduite à la taille (ETag désormais recalculé sur le contenu déposé, formule comparée à celle de S3 sur 6 combinaisons) ; migration 12 non testée ; dépôts multipart inachevés invisibles (listés en lecture seule).
- Corrigé par l'orchestrateur après approbation : garde de progression sur la pagination des dépôts inachevés (boucle infinie possible), exception non rattrapée lors de la relecture d'un média en reprise, en-tête de module resté faux sur la vérification multipart.
- Incidents de la story, corrigés et consignés : séparateur `\u0000` tronqué silencieusement par SQLite (U+241F) ; migration 10 amendée après application (migration 12 conditionnelle) ; deux tests laissés cassés par une interruption (union `MigrationDef`, nombre de migrations).
- Exécutions réelles (lecture seule, base copiée hors du dépôt) : analyse 2 407 médias, 1 997 déjà archivés prouvés, 0 non confirmable ; plan `9afea5f8f519` exécutable, 0 invariant en échec ; 297 à envoyer, 18 reclassements de quarantaine, 113 doublons internes, 1 979 ignorés ; à déposer 315 (950,2 Mo) ; destinations : 174 dans `albums/`, 123 dans `photos/`, 121 noms suffixés ; simulation sans écriture.
- Vérifications : tsc 0, `npm test` 0 (31 suites, 720 tests), `npm run lint` 0 erreur, build 0. `data/app.db` inchangé ; aucune écriture S3.
- Action hors code pour Marceau : poser une règle de cycle de vie `AbortIncompleteMultipartUpload` sur `marceau-photos`.
- Dette notée : `uploadFile` prend un `Buffer` entier (flux demandé) ; la reprise d'un dépôt multipart relit le média entier. Sans effet sur cet export (seuil de 100 Mio jamais atteint).
