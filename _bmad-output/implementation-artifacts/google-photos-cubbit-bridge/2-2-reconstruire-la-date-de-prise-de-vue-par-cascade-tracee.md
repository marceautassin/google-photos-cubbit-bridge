---
baseline_commit: f3187ec
---

# Story 2.2 : Reconstruire la date de prise de vue par cascade tracée

Status: done

## Story

En tant que Marceau,
je veux que la vraie date de chaque photo soit retrouvée, et que je sache d'où elle vient,
afin qu'aucune photo de 2019 ne soit plus jamais rangée en août 2025.

**Exigences :** FR-2, FR-3 (partie « jamais de date par défaut » ; la quarantaine elle-même relève du plan, 2.4)
— **NFR :** NFR-2 (lecture seule), NFR idempotence, NFR-6 (reprise), traçabilité, volumétrie, secrets, français, qualité

## Acceptance Criteria

1. **Étant donné** un média de l'inventaire dont le nom contient une date (`IMG_20230101_120000.jpg`,
   `PXL_20240315_180000123.jpg`, `VID_…`, `20170326_173149.jpg`, `2019-08-17_18-10-59.jpg`, WhatsApp
   `IMG-20190817-WA0001.jpg`), **quand** la cascade s'applique, **alors** cette date est retenue et la source
   enregistrée est « nom de fichier ». Aucune lecture S3 n'a lieu pour cet objet.
2. **Étant donné** un média sans date exploitable dans son nom, **quand** la cascade s'applique, **alors** l'EXIF
   est lu par **GET partiel** (`Range: bytes=0-131071`), sans télécharger l'objet entier ; **si** aucune date
   n'est trouvée et que l'objet dépasse la plage, un **second essai** est fait sur une plage plus large
   (`bytes=0-1048575`) ; `DateTimeOriginal`, puis `CreateDate`, puis `ModifyDate` sont essayés dans cet ordre ;
   la source enregistrée est « EXIF » avec le champ retenu.
3. **Étant donné** un média dont aucune source ne rend de date, **quand** la cascade s'applique, **alors** il est
   marqué « date indéterminée » avec la raison, et **aucune** date par défaut (ni date courante) ne lui est attribuée.
4. **Étant donné** la métadonnée S3 `mtime` et le `LastModified` de l'inventaire, **quand** la cascade s'applique,
   **alors** ils ne sont **jamais** utilisés (le module de datation ne les lit pas ; un test le vérifie).
5. **Étant donné** la cascade appliquée à l'inventaire, **quand** je consulte le résultat, **alors** le nombre
   d'objets par source est affiché, ainsi que les indéterminés ; toute date **dans le futur ou antérieure à 2000**
   est comptée comme **suspecte** et consultable en liste — ni acceptée silencieusement, ni rejetée.
6. **Fuseau :** la date retenue est une date-heure **locale nominale sans fuseau** `AAAA-MM-JJTHH:MM:SS` ; le
   résultat est identique quel que soit le `TZ` de la machine (testé sous plusieurs `TZ`, y compris une heure
   inexistante au passage à l'heure d'été), et l'année/mois ne sont jamais décalés.
7. **Lecture seule :** l'accès EXIF passe par une interface dédiée dont l'implémentation n'importe que
   `GetObjectCommand` ; un test vérifie qu'aucune autre commande n'est émise. Les erreurs S3 ne journalisent que
   `name: message`.
8. **Persistance et reprise :** la source et la date sont persistées par objet à côté de l'inventaire (migration 5
   `node:sqlite`) ; la relance est idempotente ; une interruption pendant les lectures EXIF ne corrompt rien et les
   EXIF déjà lus ne sont pas relus (tant que l'objet — taille, ETag — est inchangé). Une erreur de lecture n'est
   **pas** enregistrée comme « indéterminée » : l'objet reste à lire à la prochaine relance.
9. **Coût :** l'EXIF n'est lu que pour les médias (extensions de la config) **sans date dans le nom** et dont le
   format peut porter de l'EXIF lisible ; jamais pour les autres.

## Tasks / Subtasks

- [x] T1 — Représentation et parsing sans fuseau (AC 1, 6)
  - [x] `src/utils/local-date-time.ts` : `buildLocalDateTime(y, mo, d, h, mi, s)` → `AAAA-MM-JJTHH:MM:SS` ou
        `null` (validation calendaire via `Date.UTC`, indépendante du fuseau ; 31 février refusé)
  - [x] `parseFilenameDate(filename)` dans `src/utils/file-utils.ts` (motifs existants + formats séparés) ;
        `extractDateFromFilename` délègue (DRY) et garde ses bornes d'année et son retour `Date` locale
        (appelants de `takeout-parser.ts` inchangés)
- [x] T2 — Lecteur S3 partiel en lecture seule (AC 2, 7)
  - [x] Interface `ObjectRangeReader` dans `src/clients/types.ts` ; `src/clients/object-range-reader.ts`
        n'important que `GetObjectCommand`
- [x] T3 — Cascade (AC 1–4, 8, 9) : `src/inventory/dating.ts`
  - [x] `parseExifDate(buffer)` via `exifr` (`reviveValues: false` : chaînes brutes, pas de `Date` JS)
  - [x] `readExifDate(reader, object)` : plage 128 Ko puis 1 Mo si nécessaire
  - [x] `dateInventory(...)` : purge des datations périmées, nom de fichier, cache EXIF, lectures unitaires
        persistées au fil de l'eau, erreurs collectées sans persistance
  - [x] `summarizeDates(...)` pur : compteurs par source/champ EXIF, indéterminés, suspects, non datés
- [x] T4 — Persistance : migration 5 `inventory_dates` + `src/database/inventory-date-model.ts` ; test connexion 4 → 5
- [x] T5 — CLI `gpb inventory dates [--bucket] [--prefix <p...>] [--suspects] [--indeterminees]`
- [x] T6 — Tests (client S3 mocké, fixture JPEG construite, aucun réseau, aucun `.env`)
- [x] T7 — Vérifications brutes : tsc, test, clean+build, aide CLI ; suppression `data/` `logs/`
- [x] T8 — Corrections de revue `pr-reviewer`
  - [x] [AI-Review][IMPORTANT] EXIF : un champ de rang inférieur trouvé dans les 128 premiers Ko n'arrête plus la lecture ;
        arrêt anticipé seulement sur `DateTimeOriginal` ou objet lu en entier, meilleur champ retenu (test TIFF 600 Ko,
        `ModifyDate` en tête, `DateTimeOriginal` à 500 Ko ; test « garde CreateDate si rien de mieux »)
  - [x] [AI-Review][IMPORTANT] Motifs de nom : blocs 8+6 chiffres encadrés (non précédés d'une lettre/chiffre pour le
        motif générique, non suivis de 4 chiffres ; 3 chiffres de millisecondes tolérés), préfixes `PXL|MVIMG|PANO|BURST`
        explicites, toutes les occurrences essayées
  - [x] [AI-Review][IMPORTANT] Tests : noms réels du bucket sans date + faux positifs `hash…abc`, `received_…7890` → null ;
        `16587232_20190101235959.jpg`, `12345678_20190817123456.jpg` → date
  - [x] [AI-Review][MINEUR] Dates EXIF `ModifyDate` signalées suspectes (raison affichée dans `--suspects`)
  - [x] [AI-Review][MINEUR] Datation précédente supprimée quand un objet repart en lecture EXIF (non daté si échec)
  - [x] [AI-Review][MINEUR] Migration 5 : `CHECK` du format `taken_at` (GLOB)

## Dev Notes

### État actuel (lu avant modification)

- `extractDateFromFilename` (`src/utils/file-utils.ts`) : motifs `IMG|DSC|PHOTO|VID|MOV_AAAAMMJJ_HHMMSS`,
  générique `\d{8}_?\d{6}` (couvre `PXL_`, `MVIMG_`, `PANO_`, `BURST`), WhatsApp `IMG-AAAAMMJJ-`,
  `AAAA-MM-JJ_HH-MM-SS` (**déjà présent**, mais non testé), `AAAA.MM.JJ_HH.MM.SS`. Construit
  `new Date(y, m-1, d, h, mi, s)` en **heure locale** (dépend du fuseau, et une heure inexistante au passage à
  l'heure d'été est décalée) ; jour borné à 31 sans contrôle du mois (`20190231` → 3 mars) ; année bornée à
  `année courante + 1`. Appelée par `src/takeout/takeout-parser.ts` (l. 199, 236).
- Inventaire (2.1) : `InventoryModel.findAll(bucket)` rend `BucketObject { key, size, lastModified, etag }`.
  `lastModified` = date d'upload : **interdit** comme date de prise de vue.
- `createS3Client` (`src/clients/s3-client.ts`) mutualisé ; `S3BucketLister` = modèle de client lecture seule.
- `src/commands/inventory.ts` : sous-commandes `scan`/`show`, `run()` gère erreurs, erreurs S3 en `name: message`.
- Migrations dans `src/database/connection.ts` (4 à ce jour) ; `tests/database/connection.test.ts` fige le nombre.

### Décisions

- **Représentation : date-heure locale nominale sans fuseau, chaîne `AAAA-MM-JJTHH:MM:SS`.** Ni EXIF
  `DateTimeOriginal` ni un nom de fichier ne portent de fuseau : c'est l'heure affichée par l'appareil. La
  convertir en instant (`Date`, UTC) inventerait un fuseau et ferait dépendre le mois du `TZ` de la machine
  (une photo du 31/12 23:30 changerait d'année). La chaîne est triable, comparable lexicographiquement,
  stockable telle quelle en SQLite, et le dossier `photos/AAAA/AAAA-MM/` s'en déduit par simple découpage.
  Aucune `Date` JS n'intervient dans la chaîne de datation (la validation calendaire utilise `Date.UTC`, sans fuseau).
- **EXIF : `exifr` 7.x** — pur JS, **zéro dépendance**, aucun script d'installation ni `gypfile` (vérifié
  `npm view`), MIT, types fournis, sait parser un buffer partiel JPEG/TIFF/HEIC/PNG. `reviveValues: false` rend
  les chaînes brutes `AAAA:MM:JJ HH:MM:SS` (pas de conversion en `Date` locale). Formats lus : `jpg jpeg tif
  tiff heic heif avif png` ∩ extensions de la config. Vidéos, gif, bmp, webp : pas d'EXIF lisible par exifr →
  « indéterminée » sans requête (raison tracée).
- **Plages :** `bytes=0-131071` (mesuré : 10/12), puis `bytes=0-1048575` si pas de date et objet > 128 Ko
  (segment APP1 précédé d'autres segments, HEIC). Fin de plage bornée à `taille - 1` ; objet vide → indéterminé
  sans requête (un `Range` sur 0 octet rend 416).
- **Suspects :** calculés à l'affichage (dépendent de « maintenant ») : `< 2000-01-01T00:00:00` ou postérieur à
  l'instant présent + 14 h (décalage maximal d'un fuseau), pour ne dépendre d'aucun `TZ`.
- **Persistance : table `inventory_dates`** (bucket, key, size, etag, source, taken_at, detail, exif_read, dated_at ;
  PK bucket+key). Réutilisation d'une lecture EXIF si taille et ETag identiques ; les datations dont l'objet
  n'existe plus (ou a changé) dans l'inventaire sont purgées à chaque passe. Dates « nom de fichier » recalculées
  à chaque passe (gratuit, suit l'évolution des motifs).
- **Périmètre des objets :** tous les médias de l'inventaire ; option `--prefix` (répétable) pour restreindre —
  aucun préfixe en dur (leçon de 2.1). Lectures EXIF séquentielles (≈ 300 à quelques milliers : KISS).

### Hors périmètre (à ne pas toucher)

- `src/takeout/takeout-parser.ts` : l'ordre de cascade Takeout (préférer `photoTakenTime` du JSON au nom de
  fichier) et la suppression du repli sur `stats.mtime` relèvent de la **story 4.2** (consigne de revue 1.3).
  `extractDateFromFilename` y reste appelée avec le même contrat (seul effet de bord : dates calendaires
  impossibles désormais refusées au lieu d'être reportées au mois suivant).
- Quarantaine et chemin cible (2.4), doublons (2.3), date des vidéos (métadonnées QuickTime `mvhd`).

### Tests

- Jest + ts-jest, logger mocké, base temporaire `os.tmpdir()`, `S3Client` = `{ send: jest.fn() }`.
- Fixture JPEG construite en mémoire (SOI + APP1 Exif TIFF avec IFD0 `ModifyDate` et sous-IFD Exif
  `DateTimeOriginal`/`CreateDate`) ; variante avec segment APP de remplissage > 128 Ko avant l'EXIF.
- Fuseaux : `process.env.TZ` modifié en cours de test (`UTC`, `Europe/Paris`, `Pacific/Kiritimati`,
  `America/Sao_Paulo`) + cas `20190331_023000` (heure inexistante à Paris).

### Apprentissages des stories 1.3 et 2.1

- `rtk proxy` + redirection + code de sortie ; `clean` + `build` ; supprimer `data/` et `logs/`.
- `node:sqlite` : transactions explicites, `undefined` non liable (→ `null`), ROLLBACK ne doit pas masquer l'erreur.
- Revue 2.1 : toute anomalie doit être visible, jamais filtrée silencieusement.
- Pas de commit : proposer seulement.

### Dette et points pour la suite (revue)

- **Dette :** une lecture EXIF « indéterminée » est réutilisée indéfiniment tant que l'objet (taille, ETag) est inchangé,
  même si les plages lues ou les formats EXIF évoluent plus tard. Il faudrait alors invalider ces lignes (ex. version de
  la cascade stockée par ligne) — non traité (KISS).
- **Pour la story 4.2 :** l'élargissement des motifs de nom (préfixes, formats séparés, toutes occurrences) fait que
  `takeout-parser.ts:199` préfère le nom de fichier au JSON `photoTakenTime` pour davantage de fichiers. La 4.2 doit
  inverser cet ordre (JSON d'abord) et supprimer le repli `stats.mtime`.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 2.2]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#4, #4.1, #4.7, #FR-2, #FR-3, #6]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/addendum.md#Sources de date — cascade proposée]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/1-3-retirer-les-scripts-correctifs-ponctuels.md#Revue de clôture]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-1-inventorier-le-bucket-entier.md]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- Prototype exifr sur JPEG construit : EXIF complet lu ; EXIF repoussé à 200 Ko et buffer tronqué à 128 Ko → `undefined`
  (d'où le second essai) ; contenu illisible → exception « Unknown file format » (traitée comme « pas de date »).
- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 7 suites, 70/70 verts.
- Contre-épreuve : plage unique à 128 Ko + `ModifyDate` ignoré → 6 tests en échec dans `dating.test.ts` (restauré ensuite).
  `process.env.TZ` modifié en cours de processus est bien pris en compte (`new Date(2019,2,31,2,30).getHours()` : 2 en UTC, 3 à Paris).
- `npx eslint` sur les fichiers nouveaux/modifiés : code 0, 0 erreur (2 avertissements `any` préexistants dans `types.ts`).
- `npm run clean` puis `npm run build` : code 0.
- `node dist/index.js --help`, `inventory --help`, `inventory dates --help` : code 0. `inventory dates --bucket essai-inexistant`
  (base neuve) : code 0, « Aucun inventaire local… », aucun appel réseau. `data/` et `logs/` supprimés.
- Après revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 7 suites, 88/88 ; `TZ=Pacific/Kiritimati npm test` code 0 —
  88/88 ; eslint code 0 ; `npm run clean` + `npm run build` code 0 ; `inventory dates --help` code 0 (migration 5 avec
  CHECK appliquée sur base neuve) ; `data/` et `logs/` supprimés.
- `exifr@7.1.3` : `dependencies = {}`, aucun script d'installation, pas de `gypfile` (`npm view`), entrée lockfile sans
  `hasInstallScript`.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Commande `gpb inventory dates [--bucket <nom>] [--prefix <p...>] [--suspects] [--indeterminees]` : date les médias de
  l'inventaire local, affiche le nombre par source (nom de fichier / EXIF avec détail par champ / indéterminée), les non
  datés (lecture en échec), le compteur de suspects ; listes complètes via `--suspects` et `--indeterminees`. Code de
  sortie 1 si des lectures ont échoué.
- Représentation : `LocalDateTime` = chaîne `AAAA-MM-JJTHH:MM:SS` sans fuseau (`src/utils/local-date-time.ts`),
  validation calendaire par `Date.UTC`. Aucune `Date` JS dans la chaîne de datation.
- Nom de fichier : `parseFilenameDate` (motifs historiques + formats séparés `-`, `.`, espace, `Screenshot_…`) ;
  `extractDateFromFilename` y délègue (DRY) en gardant son contrat `Date` locale bornée — seul changement pour
  `takeout-parser.ts` : une date calendaire impossible (31 février) est refusée au lieu d'être reportée au mois suivant.
- EXIF : `exifr` (`reviveValues: false`, chaînes brutes) ; `DateTimeOriginal` → `CreateDate` → `ModifyDate`, date nulle
  `0000:00:00` ignorée. GET partiel `bytes=0-131071`, puis `bytes=131072-1048575` (sans relire le début) si pas de date
  et objet plus grand ; plages bornées à la taille. Formats lus : jpg, jpeg, tif, tiff, heic, heif, avif, png (∩ config) ;
  vidéos/gif/bmp/webp et objets vides → indéterminée sans requête, raison tracée.
- Lecture seule : interface `ObjectRangeReader`, `S3ObjectRangeReader` n'importe que `GetObjectCommand` (test sur les
  commandes émises et sur les imports du module). Lecteur S3 créé seulement si une lecture est nécessaire (hors ligne sinon).
- Persistance : migration 5 `inventory_dates` (contrainte : `taken_at` NULL ⇔ indéterminée). Dates « nom de fichier »
  enregistrées en une transaction ; chaque lecture EXIF enregistrée dès obtenue ; réutilisée si taille et ETag inchangés ;
  datations d'objets disparus/modifiés purgées. Erreur de lecture : non enregistrée, relue à la relance ; arrêt des
  lectures après 5 échecs consécutifs. Erreurs en `name: message` (`describeError`, mutualisé avec `inventory scan`).
- Suspects : calculés à l'affichage, `< 2000-01-01T00:00:00`, postérieur à maintenant + 14 h (indépendant du fuseau), ou issus d'EXIF `ModifyDate` ; chaque suspect porte sa raison.
- Refactor DRY : `inTransaction` extrait dans `connection.ts`, utilisé par les migrations, `InventoryModel` et
  `InventoryDateModel` ; `requireValidConfig` dans `commands/inventory.ts`.
- Hors périmètre respecté : `src/takeout/takeout-parser.ts` non modifié (ordre JSON Takeout / repli `stats.mtime` : story 4.2).
- Points à signaler : les noms `PXL_…` des Pixel sont en UTC (pas en heure locale) — une photo prise juste après minuit
  un 1er du mois peut tomber dans le mois précédent ; les dates de vidéos sans date dans le nom restent indéterminées
  (métadonnées QuickTime non lues) ; `heic`/`3gp` absents des `supportedFormats` par défaut, donc non datés.
- Écart au cycle red-green : tests écrits juste après le code dans la même passe ; validés par contre-épreuve (mutations).
- Aucun appel réseau réel, aucun accès au bucket, `.env` non lu.
- Revue `pr-reviewer` (2026-09-15) : 3 IMPORTANT et 3 MINEUR corrigés (T8), chacun avec test. Contre-épreuves : arrêt
  sur le premier champ trouvé → 2 tests en échec ; suppression de `model.remove` → 1 test en échec ; motif générique
  sans encadrement → 4 tests en échec (code restauré ensuite).

### File List

- package.json (modifié : dépendance `exifr`)
- package-lock.json (modifié)
- src/utils/local-date-time.ts (nouveau)
- src/utils/file-utils.ts (modifié)
- src/utils/format.ts (modifié)
- src/clients/types.ts (modifié)
- src/clients/object-range-reader.ts (nouveau)
- src/database/connection.ts (modifié)
- src/database/inventory-model.ts (modifié)
- src/database/inventory-date-model.ts (nouveau)
- src/inventory/dating.ts (nouveau)
- src/commands/inventory.ts (modifié)
- tests/fixtures/jpeg-exif.ts (nouveau)
- tests/inventory/dating.test.ts (nouveau)
- tests/clients/object-range-reader.test.ts (nouveau)
- tests/utils/file-utils.test.ts (modifié)
- tests/database/connection.test.ts (modifié)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-2-reconstruire-la-date-de-prise-de-vue-par-cascade-tracee.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-14 : commande `gpb inventory dates` — datation par cascade tracée (nom de fichier, EXIF par GET partiel,
  indéterminée), persistée dans `inventory_dates` (migration 5), dates suspectes signalées (FR-2, FR-3).
- 2026-09-15 : corrections de revue — 6 points résolus (meilleur champ EXIF au-delà de 128 Ko, motifs de nom encadrés et
  toutes occurrences, noms réels en test, ModifyDate suspecte, datation périmée supprimée, CHECK du format de date).

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 3 passes (une première passe interrompue par une coupure réseau, relancée) : APPROUVER, aucun BLOQUANT.
- IMPORTANTS corrigés : arrêt EXIF sur un champ de rang inférieur (TIFF : ModifyDate 2024 retenu au lieu de DateTimeOriginal 2016) ; motifs de nom non encadrés (faux positifs `hash19991231235959abc`, faux négatifs `16587232_20190101235959`) ; noms réels du bucket ajoutés aux tests.
- Ajouté par l'orchestrateur après approbation, puis relu et approuvé : `Screenshot_20190817-181059`, `WhatsApp Image … at …`, `Capture d'écran … à …` (normalisation NFC pour les accents décomposés de macOS). Ces fichiers ont rarement un EXIF : sans ce motif ils partaient en quarantaine. 94 tests.
- Limite connue : un compteur à 6 chiffres collé à une date (`scan-20190817-000123`) est lu comme une heure. Le dossier AAAA/AAAA-MM reste juste, seule l'heure est douteuse. À garder en tête si l'heure sert un jour à départager des doublons (story 2.3).
- Non encore exécuté sur le vrai bucket.
