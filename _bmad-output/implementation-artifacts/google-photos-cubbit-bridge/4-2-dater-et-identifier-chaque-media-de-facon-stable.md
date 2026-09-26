---
baseline_commit: 39951b463a570eaea99b49b30e35090ab3a3702f
---

# Story 4.2 : Dater et identifier chaque média de façon stable

Status: done

## Story

En tant que Marceau,
je veux que chaque photo du Takeout soit datée correctement et reconnue si elle est déjà archivée,
afin qu'un export ne réenvoie pas mes photos déjà sauvegardées.

**Exigences :** FR-10, FR-11 (epic 4 révisée le 2026-09-16).

## Acceptance Criteria

1. **Commande.** `gpb takeout analyser --export <horodatage> --parties <n> [--dossier <chemin>] [--fuseau <iana>]
   [--sortie <fichiers...>]`. Refus (code 1, message français) si : l'export n'existe pas ou en désigne plusieurs,
   `--parties` absent, invalide ou différent du nombre de parties, validation 4.1 non exploitable, bucket dédié non
   configuré, aucun inventaire local du bucket dédié, fuseau inconnu.
2. **Téléchargement local en lecture seule.** Chaque partie de `backups/` est téléchargée dans un dossier de travail
   local non versionné (défaut `data/takeout/<export>/`) par une interface de lecture dédiée (`ObjectDownloader`,
   module qui n'importe que `GetObjectCommand` et `S3Client` ; inventaire figé de l'analyse statique mis à jour).
   Écriture dans `<zip>.partiel`, synchronisation disque, puis renommage atomique. Progression affichée. Aucune
   écriture S3.
3. **Intégrité du zip.** Taille reçue = taille listée ; ETag listé = ETag de la réponse ; ETag MD5 simple : MD5
   recalculé égal, sinon refus ; ETag multipart `-N` : recalcul MD5 des MD5 des parties pour les tailles de partie
   déductibles (multiples entiers de Mio ou de Mo donnant exactement N parties, parties égales `⌈taille/N⌉`), tous
   calculés en une passe ; si aucune ne correspond (tailles de partie inconnues), vérification de repli documentée :
   lecture intégrale de toutes les entrées du zip avec contrôle CRC32 et taille décompressée. Un zip non vérifié
   n'est jamais analysé (refus). Méthode de vérification affichée et consignée.
4. **Reprise.** Un zip local déjà vérifié (marqueur `<zip>.verification.json` : nom, taille, ETag, date de modification
   du fichier, méthode) n'est ni retéléchargé ni revérifié ; un zip complet sans marqueur valide est revérifié sans
   téléchargement ; un fichier partiel ou non conforme est remplacé.
5. **Lecture en flux.** Chaque entrée lue depuis le zip local (répertoire central de `zip-directory.ts` enrichi du CRC32
   et de la position de l'en-tête local) : en-tête local contrôlé, données bornées, décompression deflate en flux
   (`node:zlib`), CRC32 et taille décompressée vérifiés ; erreur explicite sinon. Aucune extraction sur disque.
6. **Datation tracée.** Cascade : (1) `photoTakenTime.timestamp` du JSON apparié, instant UTC converti en heure locale
   nominale `AAAA-MM-JJTHH:MM:SS` dans le fuseau `--fuseau` (défaut `Europe/Paris`), indépendamment du `TZ` de la
   machine ; (2) nom de fichier (`parseFilenameDate`) ; (3) EXIF des octets locaux (`parseExifDate`, premier Mio) ;
   sinon indéterminée avec raison. `creationTime`, date du zip, date du fichier et date courante jamais utilisées.
   Dates suspectes signalées comme en 2.2 (`suspectReason`).
7. **Live Photos.** Vidéo compagnon : date QuickTime (`mvhd` creation time, UTC depuis 1904, convertie dans le fuseau)
   si présente et non nulle, sinon date du JSON de l'image compagnon (source « compagnon_live_photo »), sinon cascade
   ordinaire ; écart > 1 jour entre `mvhd` et le JSON de l'image signalé.
8. **Identité.** MD5 du contenu décompressé + taille, indépendante de tout chemin. Doublons internes à l'export (même
   contenu dans un dossier d'année et un album, ou dans deux parties) regroupés ; un seul représentant par contenu :
   occurrence dans un album conservé (`takeout.keptAlbums`), sinon la première par partie puis chemin ; les autres
   marqués « doublon de ».
9. **Déjà archivé.** D'après l'inventaire local du bucket dédié hors `backups/` (date de l'inventaire affichée) :
   « deja_archive » si le MD5 égale l'ETag MD5 d'un objet ; sinon « non_confirmable » si un objet de même nom
   comparable et de même taille a un ETag multipart ou absent (jamais présumé identique, listé à part) ; sinon
   « homonyme_different » si un objet de même nom existe ; sinon « nouveau ». Le résumé donne, parmi les médias ayant un
   objet de même nom et même taille, combien sont confirmés par MD5.
10. **Concordance de mois.** Pour les médias confirmés, mois de la date retenue comparé au dossier
    `photos/AAAA/AAAA-MM/` de l'objet archivé, par source de date, et le même calcul en UTC pour les dates issues d'un
    instant (JSON, QuickTime) ; concordance nom de fichier / JSON également mesurée.
11. **Persistance (migration 9).** Analyse par média (partie, chemin, dossier et type, nom, taille, MD5, date, source,
    détail, JSON, compagnon, doublon de, statut d'archivage, clé archivée, candidats) liée à l'export, au fuseau, au
    bucket dédié, à la date d'inventaire et aux zips (nom, taille, ETag, méthode de vérification). Remplacée d'un bloc à
    chaque analyse ; lecture « valide » refusée si un zip a changé (pour 4.3).
12. **Résumé et exports.** Médias, contenus distincts, volume, dates par source, suspectes, indéterminées, Live Photos et
    écarts, doublons internes, statuts d'archivage (nombre et volume), volume à envoyer (contenus distincts nouveaux ou
    homonymes différents), concordances. `--sortie` : CSV (`;`, BOM) et/ou JSON, en français.
13. **Garanties.** Aucune écriture S3, aucune écriture dans `backups/`, aucune suppression distante ; `data/app.db` réel
    non touché pendant le développement ; aucun appel réseau dans les tests.

## Tasks / Subtasks

- [x] T1 Zip : `ZipEntry.crc32` et `localOffset` ; `src/takeout/zip-entry-stream.ts` (en-tête local, inflate, CRC32,
  taille) ; encodeur de test : CRC réel, deflate, CRC forcé (AC 5)
- [x] T2 Téléchargement : `ObjectDownloader` (types), `src/clients/object-downloader.ts`, `src/takeout/zip-download.ts`
  (ETag MD5 / multipart, repli CRC, marqueur, reprise, progression) ; inventaire figé de l'analyse statique (AC 2–4)
- [x] T3 Datation : conversion instant → heure locale d'un fuseau (`local-date-time.ts`), `photoTakenTime`,
  `src/takeout/mp4-creation-time.ts`, cascade (`src/takeout/media-dating.ts`) (AC 6, 7)
- [x] T4 Analyse : `src/takeout/takeout-analysis.ts` (lecture, identité, doublons internes, déjà archivé, concordances,
  résumé, exports) (AC 8–10, 12)
- [x] T5 Persistance : migration 9, `src/database/takeout-analysis-model.ts` (AC 11)
- [x] T6 Commande `takeout analyser`, configuration `takeout.keptAlbums` (AC 1, 12)
- [x] T7 Tests et contre-épreuves (CRC, intégrité du zip, « non confirmable ») ; documentation `docs/TAKEOUT_STRUCTURE.md`
- [x] T8 Revue `pr-reviewer` : 9 corrections (voir Revue de clôture)
- [x] T9 Revue `pr-reviewer` (approbation avec réserve IMPORTANT + MINEURs) : reclassement futur des médias
  `quarantaine/` (4.3), correction millisecondes/priorité Live Photo dans `media-dating.ts`, messages
  `zip-download.ts`, dédoublonnage epic 4 dans `epics.md`, nettoyage eslint (voir Revue de clôture)

## Dev Notes

### État actuel (lu avant modification)

- `src/takeout/zip-directory.ts` : `readZipDirectory(ZipSource)` rend `ZipEntry { name, size, compressedSize, method }`
  (pas de CRC ni de position locale), contrôle bornes et chevauchements avec la longueur du nom du répertoire central.
  `localZipSource(file)` lit par plages. À préserver : toutes les vérifications 4.1.
- `src/takeout/takeout-validation.ts` : `analyzeExport(group, formats, expectedParts)` → `ExportReport` (`media` avec
  partie, chemin, dossier, nom comparable, taille, JSON apparié, compagnon ; `partCountConfirmed`, `exploitable`).
  `ZipRef { name, location, size, open }` : ajouter `etag` optionnel (listing).
- `src/commands/takeout.ts` : `valider`, `TakeoutSources { remoteZips, localZip }`, `listBackupZips(lister, reader)`
  (listing exhaustif `scanBucket`), anciennes sous-commandes désactivées. À préserver.
- `src/inventory/dating.ts` : `parseExifDate(bytes)`, `EXIF_FORMATS`, `EXIF_RANGE_LIMITS` (1 Mio max),
  `suspectReason(row: ObjectDating, now)` (à élargir à `{ takenAt, source: string, detail }`), `SUSPECT_BEFORE`.
- `src/utils/file-utils.ts#parseFilenameDate`, `src/utils/local-date-time.ts` (`LocalDateTime`, `buildLocalDateTime`).
- `src/inventory/duplicates.ts` : `etagKind`, `normalizeEtag`, `comparableName` (NFC + minuscules) — règle de nom
  comparable des doublons de l'archive, réutilisée pour les homonymes.
- `src/inventory/repair-plan.ts#csvDocument` : CSV `;` + BOM, réutilisé.
- `src/database/connection.ts` : 8 migrations, `inTransaction`, `foreign_keys = ON` ; `tests/database/connection.test.ts`
  fige le nombre (→ 9). `InventoryModel.findAll/findRun(bucket)`.
- `tests/clients/archive-writer.test.ts` : `ALLOWED_IMPORTS` (inventaire figé) ; `WRITE_NAME` interdit `Put…`, `Delete…`,
  `Copy…`, `Create…`, `Upload…`, `Restore…` (majuscule) dans tout `src/` hors point d'accès, commentaires compris.
- Configuration : `config/index.ts` fusionne section par section ; nouvelle section `takeout` à fusionner.

### Décisions

- **Fuseau de conversion de `photoTakenTime` : `Europe/Paris` par défaut, option `--fuseau`.** L'archive existante est
  datée par le nom de fichier ou l'EXIF, c'est-à-dire l'heure affichée par l'appareil (2.2). `photoTakenTime` est un
  instant UTC : le garder en UTC décalerait d'un mois toute photo prise le dernier jour du mois entre 22 h et minuit
  (heure de Paris) par rapport à son dossier d'archive. Marceau vit en France : Europe/Paris reproduit l'heure locale
  pour l'immense majorité des photos ; les voyages (Tenerife, UTC+0/+1) ne changent de mois qu'à une heure près autour
  de minuit. La conversion passe par `Intl.DateTimeFormat` avec `timeZone` explicite : aucune dépendance au `TZ` de la
  machine. La règle est **mesurée** (AC 10) : concordance de mois avec le dossier des médias confirmés, dans le fuseau
  et en UTC, et concordance avec le nom de fichier. `--fuseau` permet de rejouer la mesure sans modifier le code.
- **Pourquoi JSON avant nom de fichier** : exigence FR-10 ; le JSON couvre aussi les noms sans date (IMG_xxxx, UUID).
- **Live Photos** : `mvhd` des vidéos Apple est en UTC ; lu en flux (boîtes de premier niveau, `moov` mis en mémoire
  jusqu'à 64 Mio, `mdat` sauté), sans dépendance. Seules les vidéos compagnons l'utilisent (KISS) ; les autres vidéos
  suivent la cascade ordinaire.
- **Téléchargement** : GET complet en flux (`ObjectDownloader`) plutôt que des milliers de GET partiels. Aucune
  bibliothèque ajoutée. Contrôle de statut 200, `Content-Length` et ETag de la réponse avant écriture.
- **ETag multipart** : la taille des parties n'est pas stockée par S3. Constat : `…-410` pour ≈ 2,15 Gio donne des
  parties de ≈ 5,3 Mio, ni multiple de Mio ni de Mo ; le recalcul peut donc échouer faute de taille connue. Un échec
  du recalcul multipart ne prouve pas une corruption : repli sur le contrôle CRC32 + taille de **toutes** les entrées
  du zip (intégrité de chaque octet utile, structure vérifiée par 4.1). Un ETag MD5 simple différent, une taille
  différente ou un CRC faux : refus.
- **Pas d'extraction sur disque** : empreinte, EXIF (premier Mio capturé) et `mvhd` se calculent en flux ; 4.3 relira
  l'entrée pour l'envoyer. Disque : seuls les zips (≈ 7 Go).
- **Doublons internes** : représentant dans un album conservé si possible (règle des albums de 4.3), sinon première
  occurrence (partie, chemin). Albums conservés : nouvelle clé de configuration `takeout.keptAlbums` (défaut
  « Baptême Raphaëlle », « tenerife 2026 », comparés en forme NFC sans casse) plutôt que `repair.keptAlbums`, dont la
  modification rendrait périmé le plan de réparation exécuté.
- **Déjà archivé** : un contenu confirmé l'est quel que soit son nom (renommé ou suffixé par la réparation). Un
  homonyme de même taille à ETag multipart est « non confirmable », même si un autre homonyme diffère. Pour 4.5 : un
  « non confirmable » ne peut pas être attesté.
- **Persistance** : recalcul complet à chaque analyse (quelques minutes de décompression), remplacé d'un bloc en
  transaction (KISS). `findValid(exportId, zips)` rend `null` si un zip (nom, taille, ETag) diffère.

### Hors périmètre

- Plan d'archivage, destinations, suffixes Q1, envoi (4.3) ; reprise d'envoi (4.4) ; attestation (4.5).
- Suppression des zips locaux (Marceau).
- Médias archivés seulement sous `quarantaine/` (`summary.quarantineOnly`) : cette story les date (désormais
  connu et affiché), mais ne les reclasse pas. **Ils ne doivent jamais être traités comme correctement rangés** :
  la 4.3 doit les reclasser par date (copie vers `photos/AAAA/AAAA-MM/`), sans quoi ils restent définitivement en
  quarantaine une fois les zips supprimés.

### Tests

- Aucun réseau, aucun `.env`, aucune écriture dans `data/` : bases et dossiers temporaires `os.tmpdir()`.
- Zips en mémoire (`tests/fixtures/zip-builder.ts` : CRC réel, deflate, CRC forcé), JSON réalistes
  (`photoTakenTime` ≠ `creationTime`), JPEG EXIF (`tests/fixtures/jpeg-exif.ts`), MP4 minimale `ftyp`/`mdat`/`moov`/`mvhd`
  (versions 0 et 1, `moov` après `mdat`, découpage en petits morceaux).
- Faux téléchargeur : reprise, fichier partiel, taille / ETag MD5 incorrects, multipart recalculé, multipart non
  recalculable → repli CRC, CRC corrompu → refus.
- Fuseaux : `process.env.TZ` modifié (`UTC`, `Pacific/Kiritimati`, `America/Sao_Paulo`) sans changement du résultat ;
  passage à l'heure d'été ; `--fuseau UTC`.
- Contre-épreuves : contrôle CRC neutralisé, vérification d'intégrité du zip neutralisée, règle « non confirmable »
  neutralisée → tests en échec → fichiers restaurés (`cmp`).

### Apprentissages des stories précédentes

- 2.2 : heure locale nominale sans fuseau ; aucune `Date` locale ; suspects indépendants du `TZ`.
- 2.3 : comparaison de noms NFC sans casse ; toute anomalie visible ; ETag multipart jamais présumé identique.
- 3.1 / 3.2 : analyse statique (noms d'écriture, commentaires compris) ; commandes d'essai dans une copie du projet.
- 4.1 : échappements `\u00a0` explicites (incident d'outil d'écriture) ; noms NFD ; couples média/JSON sur deux
  parties ; Live Photos (`companion`) ; `--parties` exigé.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Epic 4 : La boucle Takeout, Story 4.2]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/.memlog.md (2026-09-16)]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/4-1-valider-une-archive-takeout-avant-traitement.md#Revue de clôture]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-2-…md#Décisions, 2-3-…md#Revue de clôture]
- APPNOTE.TXT 4.3.7 (en-tête local) ; ISO/IEC 14496-12 §8.2.2 (`mvhd`).

## Revue de clôture

Revue `pr-reviewer` (contexte neuf) : 9 corrections demandées, toutes traitées avant de reclasser la story
« done ». Cinq d'entre elles (dont l'usage de l'ETag multipart comme preuve pour « non confirmable », la règle
de datation à 14 h, l'invalidation par `inventory_completed_at`, la restriction aux préfixes `photos/`,
`albums/`, `quarantaine/`, et le contrôle d'espace disque avant téléchargement) ont été traitées lors d'une
session précédente. Les deux dernières, détaillées ci-dessous, ont été traitées et vérifiées dans cette session :

1. **IMPORTANT — repli « CRC de toutes les entrées » sans preuve de correspondance à l'objet distant**
   (`src/takeout/zip-download.ts`). Constat du relecteur : quand l'ETag multipart ne se recalcule pour aucune
   taille de partie plausible, le repli ne contrôlait que la cohérence interne du zip local (CRC + taille de
   chaque entrée) puis comparait seulement le *nombre* de médias à la validation distante — un fichier local de
   même nom et même taille mais de contenu différent était accepté. Correction (déjà présente dans l'arbre de
   travail au moment de reprendre cette correction, vérifiée et contre-épreuvée dans cette session) :
   `directoryDifferences()` compare désormais le répertoire central local à celui du zip distant (lu par plages,
   `zip-directory.ts`), entrée par entrée : nom, taille décompressée, taille compressée, CRC-32, position de
   l'en-tête local et méthode, ainsi que le nombre d'entrées. Tout écart lève une erreur explicite ; le zip est
   supprimé et jamais analysé. Le repli n'est donc valide que si le répertoire central **et** le CRC de toutes les
   entrées correspondent. Le cas d'une taille de partie candidate donnant le bon nombre de parties mais un ETag
   différent est signalé explicitement (`EtagCheck.detail`, affiché en jaune par `commands/takeout.ts`) au lieu de
   basculer en silence vers le repli.
   Test : `tests/takeout/zip-download.test.ts` « sonde A : ETag non recalculable et fichier local différent de
   même nom et taille → refusé ». Contre-épreuve : `directoryDifferences()` neutralisée (retour `[]` systématique)
   → la sonde A échoue (`origin` attendu `telecharge`, reçu `reverifie`) ; fichier restauré, `cmp` identique.
2. **MINEUR — en-tête local non comparé au répertoire central sur le nom et la méthode**
   (`src/takeout/zip-entry-stream.ts`). Constat du relecteur : seules la signature et les deux longueurs de
   l'en-tête local étaient contrôlées ; un nom ou une méthode de compression divergents du répertoire central
   passaient sans erreur. Correction : les deux contrôles existaient déjà (comparaison du nom décodé et de la
   méthode lue dans l'en-tête local à celles du répertoire central) mais leurs messages ne se terminaient pas par
   « zip corrompu » comme les autres contrôles du module ; suffixe ajouté aux deux messages d'erreur.
   Test : `tests/takeout/zip-entry-stream.test.ts` « sonde B : en-tête local d'une autre entrée (nom ou méthode
   différents du répertoire central) : erreur ». Contre-épreuve : les deux contrôles neutralisés (bloc remplacé
   par un commentaire) → la sonde B échoue (promesse résolue au lieu de rejetée) ; fichier restauré, `cmp`
   identique.

Vérifications finales de cette clôture (répertoire de travail réel, aucune copie) : `npx tsc --noEmit` code 0 ;
`npm test` code 0, 26 suites, 634 tests ; eslint des 4 fichiers touchés (`src/takeout/zip-download.ts`,
`src/takeout/zip-entry-stream.ts`, `tests/takeout/zip-download.test.ts`, `tests/takeout/zip-entry-stream.test.ts`)
code 0 ; `npm run build` code 0. sha256 de `data/app.db` inchangé
(`1f3a06c0d4fbfcd0522116542b44b2e169f125d7f35e9741931513a1e2e6e53b`) avant et après. Aucun appel réseau, aucune
lecture de `.env`, aucune modification de `data/`.

### Revue `pr-reviewer` du 2026-09-26 (approbation, réserve IMPORTANT + MINEURs)

Approuvée sans point BLOQUANT, avec une réserve IMPORTANT (à lever avant la story 4.3) et des points MINEURs.
Tous traités dans cette session ; statut de la story laissé à l'orchestrateur.

1. **IMPORTANT — médias archivés uniquement sous `quarantaine/` silencieusement exclus de l'envoi.**
   Constat : `summary.quarantineOnly` (18 médias sur les données réelles) était compté « déjà archivé » et
   affiché avec la seule mention « aucune action ici (story 4.3) », sans garde-fou empêchant qu'ils restent
   définitivement en quarantaine si la 4.3 ne les reclasse pas avant que Marceau supprime les zips. Correction :
   - `src/commands/takeout.ts` (console) : intitulé reformulé en « à reclasser en 4.3, jamais laissés en
     quarantaine », date retenue affichée pour chaque média (`date retenue : … [source]`, déjà connue par 4.2).
   - Cette story (section « Hors périmètre ») : consigne explicite que ces médias ne doivent jamais être traités
     comme correctement rangés, et doivent être reclassés par date en 4.3.
   - `epics.md`, Story 4.3 : nouvel AC « un média dont le seul objet archivé est sous `quarantaine/` est traité
     comme à reclasser par date (copie vers `photos/AAAA/AAAA-MM/`), jamais comme correctement rangé, et ces cas
     sont comptés et listés ».
2. **MINEUR — `epics.md` : deux copies divergentes de l'epic 4 et des stories 4.1–4.5.** La section « Epic List »
   portait par erreur le détail complet (AC révisés du 2026-09-16), tandis que le corps du document (section
   dédiée à l'epic 4, avec les autres epics) avait gardé la version d'origine, aux AC différents pour la story 4.3
   notamment. Correction : le corps de l'epic 4 (anciennement lignes ≈ 693–815) a reçu la version révisée
   (contexte du 2026-09-16, AC actuels, nouvel AC quarantaine ci-dessus) ; la section « Epic List » a été ramenée
   à un résumé bref, au même format que les epics 1, 2, 3 et 5 (paragraphe + « FRs couvertes »), sans dupliquer
   les stories. Aucune autre epic n'a été touchée ; la structure du document (Epic List résumé, puis corps détaillé
   par epic) est restée cohérente. Incident d'outil corrigé au passage : la première tentative d'édition avait
   introduit des espaces insécables bruts (au lieu du texte échappé `\u00a0` utilisé partout ailleurs dans ce
   document) ; corrigé avant vérification finale (aucune espace insécable brute ni octet NUL dans le fichier).
3. **MINEUR — `src/takeout/media-dating.ts` : `photoTakenTime.timestamp` en millisecondes traité comme des
   secondes.** Un timestamp ≥ 10¹¹ (donc en millisecondes, jamais atteint par un timestamp en secondes avant l'an
   5138) rendait une date aberrante (an 55840) au lieu d'une alerte. Correction : `MILLISECOND_TIMESTAMP_THRESHOLD`
   (1e11) détecté dans `parsePhotoTakenTime`, qui rend désormais `problem: 'photoTakenTime en millisecondes ?'`.
   Test : `tests/takeout/media-dating.test.ts` (cas timestamp string et number). Contre-épreuve : détection
   neutralisée → les 2 nouveaux cas échouent (instant accepté au lieu du problème signalé) ; fichier restauré,
   `cmp` identique.
4. **MINEUR — `src/takeout/media-dating.ts` : priorité QuickTime non respectée pour une vidéo de Live Photo ayant
   son propre JSON.** La date `mvhd` ne primait que si la vidéo n'avait pas de `photoTakenTime` propre ; avec un
   JSON présent, la cascade `instant` était évaluée en premier, contrairement à l'AC 7. Correction : `dateMedia`
   teste désormais `livePhoto?.quicktime` avant la branche `instant`. Test : nouveau cas « Live Photo avec son
   propre JSON » (JSON divergent volontairement de la date QuickTime). Contre-épreuve : la vérification anticipée
   retirée → ce nouveau test et le test Live Photo existant échouent tous les deux (source `json_takeout` ou
   `compagnon_live_photo` au lieu de `quicktime`) ; fichier restauré, `cmp` identique.
5. **MINEUR — `src/takeout/media-dating.ts` : en-tête du module peu explicite sur la priorité EXIF/nom.** Ajout
   d'un paragraphe explicite : avec `photoTakenTime`, l'EXIF passe avant le nom (celui-ci sert de garde-fou de
   concordance) ; sans `photoTakenTime`, le nom passe avant l'EXIF (règle héritée de la story 2.2).
6. **MINEUR — `src/takeout/zip-download.ts:228` : message d'un exemplaire local de taille différente.** « exemplaire
   local incomplet (N octets) remplacé » reformulé en « taille locale N octets ≠ M listés, remplacé » (couvre aussi
   le cas, rare, où le fichier local serait plus grand que listé). Test mis à jour dans
   `tests/takeout/zip-download.test.ts`.
7. **MINEUR — `src/takeout/zip-download.ts` : en-tête du module.** Précision ajoutée : la vérification MD5/ETag
   multipart après téléchargement utilise l'empreinte calculée en flux pendant l'écriture (jamais une relecture du
   fichier renommé) ; seul le repli `crc_entrees` relit le fichier local ; le marqueur inclut `mtime_ms` et force
   une revérification si la date de modification change.
8. **MINEUR (hygiène) — 2 erreurs eslint préexistantes.** Imports inutilisés supprimés : `getLogger` dans
   `src/database/models.ts:4`, `path` dans `src/utils/logger.ts:2`. Les avertissements `no-explicit-any`
   préexistants (23, hors périmètre) n'ont pas été touchés.

Vérifications finales de cette revue (répertoire de travail réel, aucune copie, aucun `.env`, aucune écriture dans
`data/`) : `npx tsc --noEmit` code 0 ; `npm test` code 0, 26 suites, 637 tests (634 + 3 nouveaux) ; `npm run lint`
code 0 (0 erreur, 23 avertissements préexistants `no-explicit-any`) ; `npm run build` code 0. sha256 de
`data/app.db` inchangé (`1f3a06c0d4fbfcd0522116542b44b2e169f125d7f35e9741931513a1e2e6e53b`) avant et après. Aucun
octet NUL ni espace insécable brute dans les fichiers modifiés (vérifié fichier par fichier).

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0. `npm test` : code 0, 26 suites, 623 tests (nouveaux : `zip-entry-stream` 9,
  `zip-download` 15, `media-dating` 20, `takeout-analysis` 8, `commands/takeout` analyser 7 ; migrations → 9).
- eslint des 16 fichiers `src/` touchés : code 0 (2 avertissements `any` préexistants dans `clients/types.ts`) ; tests
  touchés : 0 erreur, 7 avertissements « return type » (style des tests existants).
- `npm run clean` + `npm run build` : code 0.
- CLI dans une copie du projet (dossier temporaire, `dist/` + `package.json` + lien `node_modules`, sans `.env` ni
  `data/`) : `--help`, `takeout --help`, `takeout analyser --help` code 0 ; `analyser` sans bucket dédié → code 1
  « aucun bucket dédié configuré » ; avec `CUBBIT_DESTINATION_BUCKET` mais base neuve → code 1 « aucun inventaire local
  du bucket dédié » ; `--fuseau Mars/Olympus` → code 1. Aucun appel réseau. Copie supprimée.
- Contre-épreuves (fichiers restaurés, `cmp` identique) : (1) contrôle CRC-32 neutralisé → 5 tests en échec ;
  (2) vérification d'intégrité du zip neutralisée (MD5 différent accepté, taille annoncée ignorée) → 4 tests en échec ;
  (3) règle « non confirmable » neutralisée → 2 tests en échec.
- Incident de lint : `require-yield` sur l'étape finale du pipeline ; remplacée par une fonction asynchrone, ce qui
  masquait l'erreur « contenu plus long » sous une `AbortError` : erreur conservée et relancée (test).
- Incident outil d'écriture (connu) : `\u0000` converti en octets NUL (`takeout-analysis.ts`) et `\u00a0` en espace
  insécable brute (test, story) ; remplacés par les échappements, fichiers contrôlés par script (UTF-8, ni NUL ni
  insécable brute, fin de fichier `\n`).
- sha256 de `data/app.db` inchangé : `1f3a06c0…e6e53b` avant et après.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- **Commande** `gpb takeout analyser --export <horodatage> --parties <n> [--dossier] [--fuseau Europe/Paris]
  [--sortie a.csv b.json]` : inventaire local du bucket dédié exigé ; validation 4.1 distante (nombre de parties
  confirmé) ; téléchargement/vérification ; validation 4.1 rejouée sur les zips locaux (même nombre de médias) ; analyse ;
  enregistrement ; résumé ; exports. `selectGroups`/`parsePartCount` partagés avec `valider` (DRY).
- **Téléchargement** (`zip-download.ts`, `S3ObjectDownloader`) : GET complet en flux, statut 200, `Content-Length` et
  ETag de la réponse comparés au listing avant écriture ; `.partiel` + `fsync` + renommage ; MD5 simple recalculé ;
  multipart recalculé en une passe pour ≤ 8 tailles de partie (Mio, Mo, parties égales) ; sinon repli : CRC-32 et taille
  de toutes les entrées. Marqueur `.verification.json` (nom, clé, taille, ETag, mtime, méthode) ; reprise sans
  retéléchargement ; exemplaire local non conforme remplacé avec raison affichée. Inventaire figé de l'analyse statique :
  `clients/object-downloader.ts` → `GetObjectCommand`, `S3Client`.
- **Constat pour l'exécution réelle** : `…-410` pour ≈ 2,15 Gio donne des parties de ≈ 5,3 Mio si « Go » est en base
  1024 (affichage de `formatBytes`) ; si la taille réelle est ≈ 2,15 × 10⁹ octets, 5 Mio convient. Selon le cas,
  vérification `etag_multipart` ou `crc_entrees` : la méthode est affichée par zip.
- **Lecture en flux** (`zip-entry-stream.ts`) : en-tête local (signature, longueurs nom/extra), bornes, inflate brut,
  CRC-32 (`zlib.crc32`) et taille vérifiés ; `ZipEntry` enrichi de `crc32` et `localOffset`.
- **Datation** (`media-dating.ts`) : `photoTakenTime` → fuseau (`instantToLocalDateTime`, `Intl` avec `timeZone`
  explicite) → nom → EXIF (premier Mio capturé en flux) → indéterminée avec raisons cumulées. `creationTime` jamais lu.
  Suspects via `suspectReason` (signature élargie). Live Photos : `mvhd` (`mp4-creation-time.ts`, flux, `moov` avant
  ou après `mdat`, tailles 64 bits) → `photoTakenTime` de l'image compagnon → cascade ; écart > 1 jour signalé.
- **Identité et doublons** : MD5 + taille ; représentant dans un album de `takeout.keptAlbums` (nouvelle section de
  configuration, défaut « Baptême Raphaëlle », « tenerife 2026 ») sinon première occurrence.
- **Déjà archivé** : `deja_archive` (ETag MD5 = MD5 et même taille, quel que soit le nom), `non_confirmable` (homonyme
  NFC/sans casse de même taille à ETag multipart ou absent), `homonyme_different`, `nouveau`. Résumé « même nom + même
  taille » ventilé par statut. Concordance de mois par source (fuseau et UTC) et concordance nom/JSON.
- **Persistance** : migration 9 (`takeout_analyses`, `takeout_media`, contraintes CHECK), `TakeoutAnalysisModel.replace`
  (transaction), `find`, `findValid` (zips identiques en nom, taille, ETag normalisé).
- Écart au cycle red-green : tests écrits juste après chaque module, dans la même passe, validés par contre-épreuves.

### File List

- `src/clients/object-downloader.ts` (nouveau)
- `src/takeout/zip-entry-stream.ts`, `src/takeout/zip-download.ts`, `src/takeout/mp4-creation-time.ts`,
  `src/takeout/media-dating.ts`, `src/takeout/takeout-analysis.ts` (nouveaux)
- `src/database/takeout-analysis-model.ts` (nouveau)
- `src/clients/types.ts`, `src/commands/takeout.ts`, `src/config/index.ts`, `src/config/types.ts`,
  `src/database/connection.ts`, `src/inventory/dating.ts`, `src/takeout/takeout-validation.ts`,
  `src/takeout/zip-directory.ts`, `src/utils/local-date-time.ts` (modifiés)
- `tests/fixtures/mp4.ts`, `tests/takeout/zip-entry-stream.test.ts`, `tests/takeout/zip-download.test.ts`,
  `tests/takeout/media-dating.test.ts`, `tests/takeout/takeout-analysis.test.ts` (nouveaux)
- `tests/fixtures/zip-builder.ts`, `tests/clients/archive-writer.test.ts`, `tests/commands/takeout.test.ts`,
  `tests/database/connection.test.ts`, `tests/database/repair-execution-model.test.ts`,
  `tests/takeout/zip-directory.test.ts` (modifiés)
- `docs/TAKEOUT_STRUCTURE.md` (modifié)
- `_bmad-output/implementation-artifacts/google-photos-cubbit-bridge/4-2-dater-et-identifier-chaque-media-de-facon-stable.md`,
  `_bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml`
- Revue de clôture (corrections 8/9 et 9/9) : `src/takeout/zip-entry-stream.ts` (modifié — suffixe « zip
  corrompu » sur les erreurs nom/méthode de l'en-tête local), `tests/takeout/zip-entry-stream.test.ts` (modifié —
  assertions correspondantes). `src/takeout/zip-download.ts` et `tests/takeout/zip-download.test.ts` relus et
  contre-épreuvés, non modifiés (le repli par répertoire central était déjà implémenté et testé).
- Revue `pr-reviewer` du 2026-09-26 (approbation, réserve IMPORTANT + MINEURs) : `src/commands/takeout.ts` (modifié
  — intitulé quarantaine), `src/takeout/media-dating.ts` (modifié — seuil millisecondes, priorité QuickTime, en-tête),
  `src/takeout/zip-download.ts` (modifié — messages et en-tête), `src/database/models.ts` (modifié — import
  inutilisé retiré), `src/utils/logger.ts` (modifié — import inutilisé retiré), `tests/takeout/media-dating.test.ts`
  (modifié — 3 nouveaux cas), `tests/takeout/zip-download.test.ts` (modifié — assertion mise à jour),
  `epics.md` (modifié — dédoublonnage epic 4, nouvel AC quarantaine story 4.3), cette story (modifiée — Hors
  périmètre, Revue de clôture, Tasks, File List, Change Log).

### Change Log

- 2026-09-16 : implémentation de la story 4.2 (téléchargement vérifié des zips, lecture en flux avec CRC, datation
  tracée avec fuseau, Live Photos, identité par MD5, doublons internes, rapprochement avec l'archive, migration 9,
  commande `gpb takeout analyser`).
- 2026-09-26 : clôture de la revue `pr-reviewer` (9 corrections). Dernières corrections : messages d'erreur de
  l'en-tête local (nom, méthode) terminés par « zip corrompu » comme les autres contrôles du module ; vérification
  et contre-épreuve du repli par comparaison du répertoire central au zip distant (déjà implémenté). Tests :
  26 suites, 634 tests, code 0 ; `tsc`, eslint et build au vert ; `data/app.db` inchangé.
- 2026-09-26 (session suivante) : nouvelle revue `pr-reviewer` (approbation, réserve IMPORTANT + MINEURs) traitée
  intégralement : garde-fou pour les médias `quarantaine/` (à reclasser en 4.3, AC ajouté à `epics.md`),
  dédoublonnage de l'epic 4 dans `epics.md`, correction millisecondes et priorité Live Photo/QuickTime dans
  `media-dating.ts`, messages et documentation de `zip-download.ts`, nettoyage eslint. Tests : 26 suites,
  637 tests, code 0 ; `tsc`, lint (0 erreur) et build au vert ; `data/app.db` inchangé.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` (Opus) en 2 passes : APPROUVER, aucun BLOQUANT. Réserve IMPORTANTE levée (médias archivés seulement sous `quarantaine/` : consigne écrite ici et critère ajouté à la story 4.3).
- IMPORTANTS corrigés : zip local accepté sur le seul CRC interne (comparaison du répertoire central local au distant), règle de datation revue (14 h, WhatsApp, voyages), invalidation de l'analyse sur l'inventaire et les albums conservés, `non_confirmable` résolu par recalcul d'ETag multipart.
- Corrigé par l'orchestrateur : niveau de titre de l'epic 5 dans « Epic List » de `epics.md`, cassé lors du dédoublonnage de l'epic 4.
- Exécution réelle (lecture seule, base copiée, zips réutilisés) : 2 407 médias ; dates exif 2 237, nom_fichier 152, json_takeout 11, quicktime 7, 0 indéterminée, 0 suspecte, 1 alerte (WhatsApp retouché, daté par le nom comme l'archive) ; déjà archivés 1 997 (1 885 MD5 + 112 ETag multipart), **0 non confirmable** ; homonymes différents 121 ; nouveaux 289 ; à envoyer 297 (933,8 Mo) ; 18 déjà archivés seulement en quarantaine ; concordance de mois avec l'archive : 1 979 concordants, 0 discordant.
- Vérifications : tsc 0, `npm test` 0 (26 suites, 637 tests), `npm run lint` 0 erreur, build 0. `data/app.db` inchangé pendant toute la story ; aucune écriture S3.
