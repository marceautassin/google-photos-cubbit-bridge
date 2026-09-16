---
baseline_commit: 222ee1bb3bef0dce651546638cf241c432b565d7
---

# Story 4.1 : Valider une archive Takeout avant traitement

Status: done

## Story

En tant que Marceau,
je veux savoir si un export Takeout est exploitable avant de lancer une passe,
afin de ne pas perdre une soirée sur un export incomplet ou mal compris.

**Exigences :** FR-9 (epic 4 révisée le 2026-09-16).

## Acceptance Criteria

1. **Lecture sans téléchargement.** Étant donné des zips Takeout dans `marceau-photos/backups/` (ou un zip local),
   quand je lance la validation, l'outil lit la table des matières de chaque zip par lectures partielles (fin de fichier
   → EOCD → zip64 le cas échéant → répertoire central) sans le télécharger en entier, et le nombre d'octets lus est
   très inférieur à la taille du zip.
2. **Regroupement.** Les parties d'un même export (`takeout-<horodatage>-<n>-<nnn>.zip`) sont regroupées ; une
   numérotation lacunaire (partie manquante) rend l'export non exploitable.
3. **Intégrité de chaque partie.** EOCD trouvé, zip non multi-volume, zip64 lu, nombre d'entrées annoncé = nombre lu,
   taille du répertoire central annoncée = consommée, entrées (en-tête local + données compressées) dans les bornes du
   fichier, méthode stockée ou deflate, pas de chiffrement, noms UTF-8 valides. Toute violation : partie illisible,
   raison en français, export non exploitable.
4. **Reconnaissance du format réel.** Racine `Takeout/Google Photos/` quelle que soit la forme de l'espace (normal,
   insécable U+00A0) et la normalisation Unicode (NFC/NFD) ; dossiers d'année `Photos de AAAA` / `Photos from AAAA` vs
   dossiers d'album ; médias selon `sync.supportedFormats` via `isSupportedFormat` (règle unique) ; métadonnées d'album
   `métadonnées.json` / `metadata.json` ; fichiers non reconnus (avec raison).
5. **Appariement média ↔ JSON** par une fonction pure testée sur une table de cas : `<média>.supplemental-metadata.json`,
   variantes tronquées (`.supplemental-metada.json`, `.supplemental-me.json`, `.supp.json`…), nom du média lui-même
   tronqué, ancien format `<média>.json`, suffixes de doublon `(n)` placés de manière irrégulière. Appariement un pour
   un, au sein d'un même dossier de l'export, toutes parties confondues. Jamais d'appariement ambigu en silence : un JSON
   qui désigne plusieurs médias n'est pas apparié.
6. **Restitution.** Commande `gpb takeout valider [--export <horodatage>] [--zip <chemins...>]` : par export, les parties
   (taille, entrées, octets lus), puis par dossier : type (année/album), médias, volume, métadonnées d'album ; liste des
   médias sans métadonnées, liste des non reconnus ; verdict « exploitable » ou « non exploitable » avec raisons. Code de
   sortie 1 si un export affiché est non exploitable.
7. **Lecture seule stricte.** Aucun octet écrit dans aucun bucket ; seuls le listing (`S3BucketLister`) et le GET partiel
   (`S3ObjectRangeReader`) sont utilisés ; aucune nouvelle importation du SDK S3 (inventaire figé de
   `tests/clients/archive-writer.test.ts` inchangé). Aucune écriture en base.
8. **Code hérité.** `takeout import/list/validate` et `archive` refusent explicitement (comme `sync`) ; parseur, scanner,
   extracteur de l'ancien format supprimés ; `docs/TAKEOUT_STRUCTURE.md` décrit le format réel ; plus aucun message ne
   renvoie à `gpb takeout import`.

## Tasks / Subtasks

- [x] T1 Lecteur minimal du répertoire central (AC 1, 3)
  - [x] `src/takeout/zip-directory.ts` : `ZipSource { size, read(start, end) }`, `readZipDirectory`, erreurs françaises
  - [x] Sources : zip local (`fs` en lecture seule) et objet distant (`ObjectRangeReader`) ; compteur d'octets lus
- [x] T2 Reconnaissance et appariement (AC 4, 5)
  - [x] `src/takeout/takeout-layout.ts` : normalisation, classement d'un chemin, `metadataTargetOf`/`pairMetadata`
- [x] T3 Analyse d'export (AC 2, 6)
  - [x] `src/takeout/takeout-validation.ts` : regroupement des parties, lecture des parties, synthèse par dossier, verdict
- [x] T4 Commande (AC 6, 7, 8)
  - [x] `src/commands/takeout.ts` réécrit : `valider` + anciennes sous-commandes désactivées
  - [x] `src/commands/disabled-command.ts` partagé avec `sync.ts` (DRY) ; `archive` désactivée
  - [x] Messages de `setup.ts` / `status.ts` mis à jour
- [x] T5 Suppression du code hérité (AC 8) : parseur, scanner, extracteur, `MediaItem`, dépendance `yauzl`
- [x] T6 Documentation : `docs/TAKEOUT_STRUCTURE.md`
- [x] T7 Tests : encodeur zip de test, lecteur (zip64, corrompu, octets lus), appariement (table), analyse, commande ;
  contre-épreuves (appariement tronqué, U+00A0)

### Review Follow-ups (AI)

- [x] [AI-Review][BLOQUANT] Dernier recours `sans_extension` pour les JSON des noms UUID, unicité sur tous les fichiers
- [x] [AI-Review][IMPORTANT] Suppression de la troncature du nom du média
- [x] [AI-Review][IMPORTANT] Vidéos de Live Photo (`companion`), affichage séparé
- [x] [AI-Review][IMPORTANT] Documentation des faits réels (`docs/TAKEOUT_STRUCTURE.md`, Dev Notes)
- [x] [AI-Review][IMPORTANT] Partie vide / sans média ; répertoire central contigu
- [x] [AI-Review][IMPORTANT] Dernière partie manquante : avertissements et `--parties`
- [x] [AI-Review][MINEUR] Taille du répertoire central plausible, plafond 64 Mio
- [x] [AI-Review][MINEUR] Chevauchement des entrées
- [x] [AI-Review][MINEUR] Tests manquants du parseur
- [x] [AI-Review][MINEUR] Commentaire `file-utils.ts` et test des résidus hérités
- [x] [AI-Review][MINEUR] `S3ObjectRangeReader` : refus d'une réponse non partielle

## Dev Notes

### Réalité des exports (constatée le 2026-09-16, sans téléchargement)

- `marceau-photos/backups/` : `takeout-20260806T062636Z-1-001.zip` à `-004.zip` (2,15 / 2,13 / 2,14 / 0,61 Go ;
  2 759 / 1 285 / 596 / 169 entrées) et `takeout-20260810T070025Z-1-001.zip` (663 Ko, 3 entrées : une photo, son JSON,
  le `métadonnées.json` de l'album « 2019 à imprimer »). Chaque partie est un zip complet et autonome, < 4 Gio.
- Chemins : `Takeout/Google Photos/Photos de 2020/IMG_….jpg`, **U+00A0** dans `Google Photos` et `Photos de AAAA` ;
  albums avec espaces normaux et accents. Un export anglais : `Photos from 2020`.
- 2 407 médias (jpg, mp4, png, mov, jpeg), 2 400 `.supplemental-metadata.json`, 9 médias sans JSON au nom attendu.
- Troncature Google du nom des JSON (≈ 51 caractères `.json` compris) : `.supplemental-metada.json`, `.supplemental-me.json`,
  `.supp.json`… ; suffixes `(n)` : `IMG_1234(1).jpg` ↔ `IMG_1234.jpg.supplemental-metadata(1).json` (ou ancien
  `IMG_1234.jpg(1).json`).

### Décisions techniques

- **Parseur maison du répertoire central plutôt qu'une bibliothèque** : `yauzl` (déjà en dépendance) sait lire depuis un
  `RandomAccessReader`, mais lit entrée par entrée (46 octets, puis nom/extra/commentaire) : sans couche de cache, des
  milliers de GET partiels ; il ne vérifie pas non plus la cohérence taille annoncée/consommée ni les bornes des
  entrées. Le format du répertoire central est simple et stable (APPNOTE 4.3.12, 4.3.14–16) : ~150 lignes testées.
  Trois lectures par zip au plus : queue (≤ 65 557 octets), éventuel EOCD zip64 hors de la queue, répertoire central.
- **Taille des zips distants** : obtenue par listing du bucket dédié via `S3BucketLister` + `scanBucket` (existant,
  garde-fous de pagination), filtré sur `backups/`. Aucune nouvelle commande S3.
- **Pas de persistance** : l'analyse coûte quelques GET partiels et se recalcule en secondes ; 4.2/4.3 téléchargeront
  les zips de toute façon et relanceront l'analyse sur les fichiers locaux (même code, `ZipSource` local). Pas de
  migration 9, `data/app.db` n'est ni lu ni écrit par cette commande (hors ouverture/migration au démarrage du CLI).
- **Verdict** : non exploitable si partie illisible, partie manquante, chemin présent deux fois dans l'export, ou aucun
  média. Médias sans métadonnées et non reconnus : signalés et listés, sans bloquer (4.2 date par nom/EXIF).
- **Appariement** : tronquer peut rendre un JSON ambigu ; il n'est alors pas apparié (média compté sans métadonnées,
  JSON non reconnu) — jamais un mauvais appariement silencieux.

### Faits réels relevés en revue (2026-09-16) — remplacent les hypothèses ci-dessus

Table des matières des vrais zips (4 812 entrées), lue par le relecteur, et exécution réelle de l'orchestrateur :
- **Aucune troncature de nom** (JSON jusqu'à 131 caractères), **aucun suffixe `(n)`**, aucun `-modifié`/`-edited`.
  Troncatures et `(n)` : non observés, hérités de formats antérieurs. La troncature du nom du média est **supprimée**
  (faux appariement démontré) ; seule la troncature du suffixe avec nom du média intact et les `(n)` restent tolérés.
- 452 noms en **NFD** ; 1 198 couples média/JSON **répartis sur deux parties** ; JSON surtout **en tête d'export**
  (001 : 1 856, puis 439, 96, 11).
- **JSON sans extension de média** pour les noms UUID (`<radical>.supplemental-metadata.json`) : dernier recours
  `sans_extension`, exigeant un seul fichier porteur du radical dans le dossier (tous fichiers comptés), sinon JSON
  ambigu (bloquant).
- Les 7 `IMG_00xx.MP4` sans JSON sont des **vidéos de Live Photo** (`X.JPG` + JSON + `X.MP4`) : exposées avec
  `companion`, listées à part, jamais appariées au JSON de l'image. **La décision de date de ces vidéos revient à 4.2.**
- Partie vide ou sans média, répertoire central non contigu (fin factice), taille de répertoire implausible (plafond
  64 Mio), entrées qui se chevauchent : bloquants.
- Dernière partie manquante : avertissements (JSON orphelins, dernière partie de taille pleine) et option `--parties` ;
  sans elle, verdict « nombre de parties non confirmé ». **La story 4.5 exigera ce nombre confirmé avant d'attester.**
- `S3ObjectRangeReader` refuse une réponse non partielle (statut ≠ 206, `Content-Range` absent ou incohérent) avant de
  lire le corps.

### Garanties à conserver (revues 2.1, 3.1, 3.2, 3.3)

- Analyse statique `tests/clients/archive-writer.test.ts` : aucun module ne doit importer le SDK hors inventaire figé ;
  aucun nom d'écriture (`Put…`, `Delete…`, `Copy…`, `Create…`, `Upload…`) dans `src/` hors point d'accès — attention aux
  identifiants et commentaires des nouveaux fichiers.
- `sync`/`resume` restent désactivées (`tests/commands/sync.test.ts`).
- Listing exhaustif ou erreur (2.1). Toute commande d'essai dans une copie du projet (incident 3.3 : `--help` a migré
  `data/app.db`).
- Messages et documentation en français ; aucun secret affiché.

### Fichiers

- NOUVEAUX : `src/takeout/zip-directory.ts`, `src/takeout/takeout-layout.ts`, `src/takeout/takeout-validation.ts`,
  `src/commands/disabled-command.ts`, `tests/fixtures/zip-builder.ts`, `tests/takeout/*.test.ts`,
  `tests/commands/takeout.test.ts`.
- MODIFIÉS : `src/commands/takeout.ts` (réécrit), `src/commands/sync.ts`, `src/index.ts`, `src/commands/setup.ts`,
  `src/commands/status.ts`, `src/clients/types.ts` (`MediaItem` retiré), `docs/TAKEOUT_STRUCTURE.md`, `package.json`.
- SUPPRIMÉS : `src/takeout/takeout-parser.ts`, `src/utils/takeout-scanner.ts`, `src/utils/takeout-extractor.ts`,
  `src/commands/archive.ts`.

### Pour la suite (4.2 à 4.5)

- Le modèle d'analyse expose, par média : chemin complet dans le zip, partie, taille décompressée, dossier (année/album),
  JSON apparié (chemin et partie). 4.2 lira `photoTakenTime` dans ce JSON ; 4.3 les albums via le nom de dossier et
  `keptAlbums`-like ; 4.5 la liste exacte des zips.
- Un même média présent dans un dossier d'année et un dossier d'album est compté deux fois ici (entrées distinctes) :
  la déduplication par contenu relève de 4.2.

### Tests

Aucun réseau, aucun `.env`, aucune écriture dans `data/`. Zips construits en mémoire (encodeur minimal de test, méthode
stockée, zip64 forcé possible) ; faux lecteur par plages qui compte les octets.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Epic 4 : La boucle Takeout (révisée)]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/.memlog.md (2026-09-16)]
- [Source: src/clients/types.ts#ObjectRangeReader, src/clients/bucket-lister.ts, src/inventory/inventory.ts#scanBucket]
- [Source: tests/clients/archive-writer.test.ts#analyse statique]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0. `npm test` : code 0, 22 suites, 532 tests. `npm run build` : code 0 (dist nettoyé puis
  reconstruit). eslint des fichiers touchés : 0 erreur, 4 avertissements `any` préexistants (`clients/types.ts`,
  `commands/status.ts`).
- Aide CLI et essais de bout en bout lancés dans une copie du projet sous le répertoire temporaire de session (sans
  `data/`, sans `.env`) : `gpb --help`, `gpb takeout --help`, `gpb takeout valider --help` code 0 ; validation de zips
  locaux produits par Python `zipfile` (deflate, zip64 forcé, U+00A0) : exploitable, code 0 ; partie 003 tronquée et
  partie 002 absente : non exploitable, code 1 ; `gpb takeout import`, `gpb archive list` : refus, code 1.
- Contre-épreuves : appariement réduit à la forme exacte (troncatures refusées) → 11 tests en échec ; espaces
  insécables non normalisés → 17 tests en échec ; fichier restauré, `cmp` identique, 81 tests verts.
- sha256 de `data/app.db` inchangé avant/après : `1f3a06c0…6e53b`.
- Incident outil : l'outil d'écriture a converti les échappements `\u00a0` en caractères insécables bruts ; remplacés
  par des échappements explicites (sources et tests), vérifié par script.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Lecteur du répertoire central maison (`zip-directory.ts`) : queue ≤ 65 557 octets, localisateur et EOCD zip64 (pris
  dans la queue ou lus à part), répertoire central en une lecture. Contrôles : EOCD, multi-volume, bornes du répertoire,
  entrées annoncées = lues, taille consommée = annoncée, signature, UTF-8 strict, méthode 0/8, chiffrement, bornes des
  données. Octets lus comptés par `countingSource`, y compris en échec. Aucune dépendance ajoutée ; `yauzl` et
  `@types/yauzl` retirées (seul utilisateur supprimé).
- Reconnaissance et appariement (`takeout-layout.ts`) : forme comparable NFC + espaces insécables ; dossiers d'année
  `Photos de|from AAAA` ; `isSupportedFormat` ; `métadonnées.json`/`metadata.json` ; appariement par préfixe de
  `<média>.supplemental-metadata` à numéro de doublon égal, troncature du nom du média (supprimée en revue),
  un pour un, ambiguïté = non apparié.
- Analyse (`takeout-validation.ts`) : regroupement `takeout-<horodatage>-<n>-<nnn>.zip`, appariement à l'échelle de
  l'export (toutes parties), verdict non exploitable si partie illisible, partie manquante, chemin en double, aucun média.
- Commande `gpb takeout valider [--export] [--zip]` : listing exhaustif du bucket dédié (`S3BucketLister` + `scanBucket`)
  filtré sur `backups/*.zip`, GET partiels (`S3ObjectRangeReader`). Aucune nouvelle importation du SDK : inventaire figé
  de l'analyse statique inchangé. Aucune écriture S3 ni base ; pas de persistance (analyse recalculable en quelques GET,
  4.2/4.3 la relanceront sur les zips téléchargés).
- Hérité : `takeout import/list/validate` et `archive` refusent (helper `disabled-command.ts`, partagé avec `sync`/`resume`) ;
  parseur, scanner, extracteur, `commands/archive.ts`, type `MediaItem` supprimés ; messages de `setup`/`status` mis à
  jour ; nettoyage lint de `setup.ts`/`index.ts` (imports et fonction inutilisés). `requireValidConfig` exporté de
  `commands/inventory.ts` pour réutilisation.
- Pour 4.2/4.3 : `ExportReport.media` donne, par média, partie, chemin exact, dossier, taille décompressée et JSON
  apparié (partie + chemin). Restent hérités : `extractDateFromFilename` (file-utils, sans utilisateur hors tests),
  `SyncRecordModel`/`status`/`history` (ancien suivi de synchronisation). Le comportement
  sur les 9 médias sans JSON sont à confirmer sur les vrais zips (première exécution réelle de `gpb takeout valider`).

- Correctifs de revue (2026-09-16) : ✅ 11 remarques traitées (1 BLOQUANT, 5 IMPORTANTS, 5 MINEURS), voir « Review
  Follow-ups ». Contre-épreuves : sans dernier recours → 4 échecs ; unicité limitée aux médias libres → 3 ; troncature
  du nom réintroduite → 2 ; contiguïté relâchée → 2 ; partie vide ignorée → 1 ; avertissement JSON orphelins coupé → 1 ;
  avertissement partie pleine coupé → 1 ; `--parties` ignoré → 2 ; chaque fois fichier restauré, contenu identique.

### File List

- `src/takeout/zip-directory.ts` (nouveau)
- `src/takeout/takeout-layout.ts` (nouveau)
- `src/takeout/takeout-validation.ts` (nouveau)
- `src/commands/disabled-command.ts` (nouveau)
- `src/commands/takeout.ts` (réécrit)
- `src/commands/sync.ts`, `src/commands/setup.ts`, `src/commands/status.ts`, `src/commands/inventory.ts`, `src/index.ts`,
  `src/clients/types.ts` (modifiés)
- `src/takeout/takeout-parser.ts`, `src/utils/takeout-scanner.ts`, `src/utils/takeout-extractor.ts`,
  `src/commands/archive.ts` (supprimés)
- `tests/fixtures/zip-builder.ts`, `tests/takeout/zip-directory.test.ts`, `tests/takeout/takeout-layout.test.ts`,
  `tests/takeout/takeout-validation.test.ts`, `tests/commands/takeout.test.ts` (nouveaux)
- `docs/TAKEOUT_STRUCTURE.md` (réécrit)
- `package.json`, `package-lock.json` (retrait de `yauzl` et `@types/yauzl`)
- `src/clients/object-range-reader.ts`, `src/utils/file-utils.ts`, `tests/clients/object-range-reader.test.ts`,
  `tests/inventory/dating.test.ts` (modifiés en revue)
- `_bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml`

### Change Log

- 2026-09-16 : implémentation de la story 4.1 (validation des exports Takeout par lecture de la table des matières),
  retrait du code Takeout hérité.
- 2026-09-16 : correctifs de la revue pr-reviewer (appariement sans extension, Live Photos, suppression de la
  troncature du nom, contrôles de parties et du répertoire central, `--parties`, GET partiel strict).

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 2 passes : APPROUVER, aucun BLOQUANT restant.
- BLOQUANT corrigé, révélé par l'exécution réelle sur les zips : JSON `<radical sans extension>.supplemental-metadata.json` non apparié (2 images UUID privées de `photoTakenTime`).
- IMPORTANTS corrigés : troncature du nom du média (faux appariement démontré), Live Photos confondues avec des orphelins, documentation contredite par les données réelles, partie vide ou EOCD factice acceptés, dernière partie manquante non détectable (`--parties`).
- Exécution réelle en lecture seule après corrections : export du 6 août exploitable, 4 parties confirmées, 2 407 médias (2 398 appariés `complet`, 2 `sans_extension`, 7 vidéos de Live Photo), 0 sans métadonnées, 0 non reconnu ; export du 10 août exploitable (1 média). Lecture ≤ 0,03 % des zips ; contrôle 206 validé contre Cubbit.
- Ajouté par l'orchestrateur après approbation (suggestion du relecteur) : l'image compagnon d'une Live Photo est limitée à jpg/jpeg/heic/heif. Testé, contre-épreuve faite, exécution réelle inchangée.
- Pour 4.2 : date des 7 vidéos de Live Photo (recouper avec la date QuickTime) ; une partie manquante non détectée peut encore faire rattacher un JSON sans extension à un homonyme (mitigation : `--parties`, exigé en 4.5).
- Pour 4.5 : exiger `--parties` confirmé et refuser toute attestation en présence de fichiers non reconnus, JSON orphelins ou ambigus, ou médias sans métadonnées inexpliqués.
