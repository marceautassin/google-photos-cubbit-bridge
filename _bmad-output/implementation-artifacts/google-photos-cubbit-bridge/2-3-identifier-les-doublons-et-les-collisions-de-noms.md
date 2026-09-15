---
baseline_commit: 799cc22
---

# Story 2.3 : Identifier les doublons et les collisions de noms

Status: done

## Story

En tant que Marceau,
je veux savoir exactement quels objets sont des doublons et quels noms entrent en collision,
afin qu'aucune photo ne soit écrasée par une autre qui porte le même nom.

**Exigences :** FR-4 ; tranche la question ouverte **Q1** du PRD (collisions de noms, bloquante avant toute écriture)
— **NFR :** NFR-2 (lecture seule), traçabilité, volumétrie, français, qualité (DRY/KISS/SOLID)

## Acceptance Criteria

1. **Doublons.** **Étant donné** l'inventaire daté (2.1 + 2.2), **quand** la détection s'exécute, **alors** les médias
   partageant (nom de fichier, taille) sont groupés comme doublons, **et** le volume récupérable est chiffré (somme des
   tailles de toutes les copies sauf une par groupe).
2. **Exemplaire conservé.** Dans chaque groupe, l'exemplaire conservé est choisi de façon **déterministe** et
   indépendante de l'ordre d'entrée : d'abord la copie datée de la manière la plus fiable (nom de fichier > EXIF
   `DateTimeOriginal` > `CreateDate` > `ModifyDate` > indéterminée > non datée), puis la clé la plus petite dans l'ordre
   lexicographique (la destination dépend de la date, pas de l'emplacement source : la clé ne sert qu'à départager).
3. **Collision de noms.** **Étant donné** deux objets de même nom mais de tailles différentes (`IMG_0044.JPG`, 2016 et
   2025), **quand** la détection s'exécute, **alors** ils sont signalés comme **homonymes**, jamais comme doublons ; s'ils
   visent le même dossier de destination `photos/AAAA/AAAA-MM/`, ils forment une **collision**.
4. **Désambiguïsation (Q1).** **Étant donné** une collision détectée, **quand** je consulte le rapport, **alors** la règle
   retenue est affichée, explicite, déterministe, stable d'une exécution à l'autre, indépendante de l'ordre d'entrée et
   appliquée uniformément ; **et** aucune destination ne reçoit deux objets distincts (invariant vérifié, erreur sinon).
   La règle est une **fonction pure** réutilisable par la story 2.4.
5. **Sans date.** Un exemplaire sans date (indéterminée ou non daté) ne reçoit **aucun** dossier daté ni date inventée :
   il est compté à part (quarantaine : story 2.4).
6. **Incohérences.** Un groupe (même nom + taille) dont les copies ont des dates ou des sources de date différentes est
   signalé ; un groupe dont les ETag MD5 diffèrent est signalé comme **contenus différents** et n'est **pas** traité
   comme doublon (scindé par ETag).
7. **Empreinte (ETag).** **Étant donné** un doublon présumé, **quand** je demande la confirmation par empreinte, **alors**
   l'ETag (déjà dans l'inventaire, aucune lecture réseau) est comparé pour les objets déposés en une seule requête (MD5,
   32 caractères hexadécimaux) ; les ETag *multipart* (`…-N`) ou absents sont signalés **non confirmables**, jamais
   déclarés identiques ou différents à tort.
8. **Restitution.** `gpb inventory doublons` affiche : médias, contenus distincts, groupes, copies en trop, volume
   récupérable (doublons confirmés par ETag uniquement ; les doublons présumés non confirmables sont affichés à part avec
   leur volume maximal, hors volume récupérable), homonymes, collisions, incohérences, groupes non confirmables, exemplaires
   sans date ; listes détaillées via options. Lecture seule, **aucun appel réseau**.

## Tasks / Subtasks

- [x] T1 — Module pur `src/inventory/duplicates.ts` (AC 1–7)
  - [x] `etagKind(etag)` : `md5` / `multipart` / `absent`
  - [x] `destinationFolder(takenAt)` → `photos/AAAA/AAAA-MM/` (découpage de la `LocalDateTime`, aucun fuseau)
  - [x] `disambiguateNames(entries)` : règle Q1 + vérification de l'invariant d'unicité
  - [x] `analyzeDuplicates(media, datings)` : groupes, exemplaire, verdict ETag, incohérences, homonymes, collisions,
        destinations, exemplaires sans date
  - [x] Réutiliser `isSameObject` de `dating.ts` (exporté, DRY)
- [x] T2 — CLI `gpb inventory doublons [--bucket] [--prefix <p...>] [--groupes] [--collisions] [--incoherences] [--empreinte]`
      (AC 8), réutilise `selectMedia`, `InventoryModel`, `InventoryDateModel`
- [x] T3 — Tests `tests/inventory/duplicates.test.ts`, données en mémoire (AC 1–7)
- [x] T4 — Vérifications : tsc, test, clean+build, aide CLI, contre-épreuve ; suppression `data/` `logs/`
- [x] T5 — Corrections de revue `pr-reviewer` (décisions arrêtées par l'orchestrateur)
  - [x] [AI-Review][IMPORTANT] Doublons groupés sur `comparableName(nom) + taille` (NFC/NFD, casse), comme les collisions
  - [x] [AI-Review][IMPORTANT] Règle ETag stricte : doublon = nom comparable + taille + ETag identique non nul ; ETag absent
        ou différent jamais fusionné ; « présumés non confirmables » signalés, hors volume récupérable et hors `others`
  - [x] [AI-Review][IMPORTANT] Stabilité dans le temps : destinations occupées en entrée ; nom occupé jamais renommé, seul
        l'arrivant suffixé ; ETag identique déjà présent (nom d'origine ou variante suffixée) → « déjà archivé »
  - [x] [AI-Review][IMPORTANT] Rapport robuste : `resolveNames` collecte les anomalies (listées en entier, code de sortie 1) ;
        `disambiguateNames` reste la variante stricte (erreur) pour les chemins qui écriront
  - [x] [AI-Review][MINEUR] Suffixe allongé par pas de 8 jusqu'à l'ETag complet (préfixe partagé, nom suffixé occupé)
  - [x] [AI-Review][MINEUR] Nom commençant par un point (`.jpg`) : extension conservée (`splitName`)
  - [x] [AI-Review][MINEUR] Rang EXIF à champ inconnu/vide strictement moins fiable que `ModifyDate`

## Dev Notes

### État actuel (lu avant modification)

- `InventoryModel.findAll(bucket)` → `BucketObject { key, size, lastModified, etag }` (ETag sans guillemets).
- `InventoryDateModel.findAll(bucket)` → `ObjectDating { key, size, etag, source, takenAt, detail, exifRead }` ;
  `source` ∈ `nom_fichier | exif | indeterminee`, `detail` = champ EXIF retenu. Une datation ne vaut que si clé, taille
  et ETag correspondent à l'objet (`isSameObject`, privé dans `dating.ts`).
- `selectMedia(objects, formats, prefixes)` et `summarizeDates` dans `src/inventory/dating.ts`.
- `src/commands/inventory.ts` : sous-commandes `scan`, `show`, `dates` ; `run()` gère les erreurs.

### Décisions

- **Règle de désambiguïsation (Q1).** Clé de conflit = dossier de destination + nom normalisé (NFC, minuscules — un
  téléchargement vers macOS/Windows, insensibles à la casse, écraserait sinon `IMG_0044.JPG` par `img_0044.jpg`).
  - Nom seul dans son dossier → **nom d'origine conservé** (cas de l'immense majorité : lisible, pas de renommage inutile).
  - Plusieurs contenus → **tous** reçoivent le suffixe `_<8 premiers caractères hexadécimaux de l'ETag>` avant
    l'extension (`IMG_0044_1a2b3c4d.JPG`). Tous, pas « tous sauf un » : désigner un gagnant dépendrait de l'ensemble et
    serait moins explicite.
  - Pourquoi l'ETag : dérivé du contenu, déjà dans l'inventaire, stable d'une exécution à l'autre, indépendant de
    l'emplacement source et de l'ordre ; vérifiable dans la console S3. La taille ne suffit pas (homonymes du même mois
    et de même taille aux ETag différents). Un ETag *multipart* commence aussi par 32 caractères hexadécimaux : il reste
    un identifiant stable de l'objet même s'il n'est pas un MD5 comparable.
  - Garde-fous (révisés après revue) : suffixe allongé par pas de 8 jusqu'à l'ETag complet si deux ETag partagent le
    préfixe ou si le nom suffixé est occupé ; ETag absent dans une collision ou suffixe impossible → anomalie bloquante
    (rapport) ou erreur (variante stricte) — jamais d'écrasement silencieux.
- **Doublons et ETag — révisé après revue (interprétation stricte de FR-4, choisie pour la sûreté).** Un doublon exige
  **nom comparable identique + taille identique + ETag identique et non nul** (chaînes normalisées : sans guillemets,
  minuscules ; deux ETag multipart strictement identiques avec la même taille valent confirmation). Une copie dont l'ETag
  est absent ou différent (MD5 ou multipart) n'est **jamais fusionnée** : elle forme son propre contenu et sera copiée.
  Au pire une copie en trop, jamais une photo perdue. Les groupes « même nom comparable + même taille » contenant un ETag
  absent ou non MD5 et plusieurs contenus sont signalés « doublons présumés non confirmables » avec leur volume au plus
  récupérable, **hors** volume récupérable. Au moins deux MD5 différents : incohérence « contenus différents ».
- **Stabilité dans le temps — ajouté après revue.** `resolveNames(entries, occupied)` reçoit les destinations déjà
  présentes (dossier, nom, ETag). Un nom occupé ne change **jamais** ; seul l'arrivant est suffixé ; un arrivant dont
  l'ETag est identique à un objet déjà présent sous son nom ou une variante suffixée est « déjà archivé ». Archive vide :
  tous les homonymes d'un même lot sont suffixés. La commande 2.3 passe un ensemble vide (bucket dédié non inventorié) ;
  la 2.4/3.1 passera l'inventaire du bucket dédié.
- **Rapport vs écriture — ajouté après revue.** `resolveNames` ne lève jamais : les cas impossibles (ETag absent dans une
  collision, ETag identiques sous un même nom) sont collectés en anomalies bloquantes, listées en entier, code de sortie 1.
  `disambiguateNames` en est la variante stricte qui lève une erreur, pour les chemins qui écriront.
- **Persistance : aucune.** Le calcul est pur et rejoué depuis `inventory_objects` + `inventory_dates` (quelques ms
  pour ~12 700 objets) ; la story 2.4 appellera `analyzeDuplicates` / `disambiguateNames`. Une table dupliquerait un état
  dérivé qu'il faudrait invalider à chaque scan ou datation (KISS).
- **Albums (D1)** et quarantaine : hors périmètre (2.4). `disambiguateNames` reçoit le dossier en entrée : la 2.4
  l'appliquera aussi à `albums/<nom>/` et au dossier de quarantaine.

### Hors périmètre

- Plan complet, albums partagés, quarantaine (2.4) ; écriture S3 (epic 3) ; empreinte recalculée par lecture (non
  nécessaire : l'ETag est déjà inventorié).

### Tests

- Jest, fonctions pures, objets en mémoire ; aucun réseau, aucun `.env`, aucune base.
- Cas : IMG_0044 2016 (293 332 o) + 2025 (67 347 o ×2) ; doublon inter-emplacements `backup_google_photos/photos/` ↔
  `2_Personnel/Photos/google_photos/` ; homonymes même mois ; homonymes même mois et même taille, ETag différents ;
  multipart ; sans date ; stabilité entre deux exécutions et indépendance à l'ordre (entrée inversée/mélangée) ; casse.

### Apprentissages des stories 2.1 et 2.2

- `rtk proxy` + redirection + code de sortie ; `clean` + `build` ; supprimer `data/` et `logs/`.
- Toute anomalie visible, jamais filtrée silencieusement (revue 2.1).
- Limite 2.2 : l'heure d'un nom `scan-20190817-000123` peut être fausse → ne jamais départager par l'heure ; seul le
  mois compte pour le dossier. `PXL_…` en UTC : mois possiblement décalé d'un jour en bord de mois (connu).
- Remplacements de texte ayant tronqué un fichier en 2.2 : vérifier les fichiers modifiés.
- Pas de commit : proposer seulement.

### References

- [Source: _bmad-output/planning-artifacts/google-photos-cubbit-bridge/epics.md#Story 2.3]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md#4.2, #FR-4, #9 D1–D4, #10 Q1]
- [Source: _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/addendum.md#Réparation — mécanique S3]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-1-inventorier-le-bucket-entier.md]
- [Source: _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-2-reconstruire-la-date-de-prise-de-vue-par-cascade-tracee.md#Revue de clôture]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- `npx tsc --noEmit` : code 0.
- `npm test` : code 0 — 8 suites, 108/108 (dont `tests/inventory/duplicates.test.ts` 14 cas).
- `npx eslint` sur `duplicates.ts`, `commands/inventory.ts`, `dating.ts` : code 0.
- `npm run clean` puis `npm run build` : code 0.
- `node dist/index.js inventory --help` et `inventory doublons --help` : code 0 ; `inventory doublons --bucket
  essai-inexistant` : code 0, « Aucun inventaire local… ».
- Essai de bout en bout sur une base locale remplie à la main (6 objets fictifs, aucun réseau) : `inventory doublons
  --collisions --incoherences --empreinte` code 0, IMG_0044 2016 conservé tel quel, collision 2025-08 suffixée
  `_bbbbbbbb` / `_cccccccc`, vidéo multipart non confirmable. `data/` et `logs/` supprimés ensuite.
- Contre-épreuves (restaurées, `cmp` identique) : désambiguïsation désactivée → 5 tests en échec ; scission par ETag
  désactivée → 1 test en échec ; choix de l'exemplaire neutralisé → 1 test en échec.
- Après revue : `npx tsc --noEmit` code 0 ; `npm test` code 0 — 8 suites, 118/118 (`duplicates.test.ts` 24 cas) ; eslint
  (fichiers touchés + test) code 0 ; `npm run clean` + `npm run build` code 0 ; `inventory doublons --help` code 0.
  Bout en bout sur base fictive : rapport normal code 0 ; collision avec ETag absent → rapport complet affiché, anomalie
  listée, code 1. `data/` et `logs/` supprimés.
- Contre-épreuves après revue (fichier restauré, comparaison octet à octet identique) : (1) regroupement sur le nom exact
  → 1 test en échec ; sans normalisation NFC seule → 1 test en échec ; (2) fusion de tous les ETag → 4 tests en échec ;
  (3) destinations occupées ignorées → 2 tests en échec.
- Incident : l'outil d'écriture a converti les échappements `\u0000` en octets NUL réels dans `duplicates.ts` (fichier
  vu « binaire » par grep) ; remplacés par l'échappement littéral, fichiers contrôlés (`file` : texte UTF-8). Les noms
  NFC/NFD du test sont écrits en échappements explicites.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Commande `gpb inventory doublons [--bucket] [--prefix <p...>] [--groupes] [--collisions] [--incoherences] [--empreinte]` :
  médias, contenus distincts, groupes, copies en trop, volume récupérable (présumé et confirmé par ETag MD5), homonymes,
  collisions et règle appliquée, exemplaires sans date, incohérences. Aucun client S3 créé, aucune validation de config.
- `src/inventory/duplicates.ts` (pur) : `analyzeDuplicates`, `disambiguateNames`, `chooseKept`, `datingRank`,
  `destinationFolder`, `etagKind`, `DISAMBIGUATION_RULE`. Aucune persistance (calcul rejoué depuis la base).
- `isSameObject` exporté de `dating.ts` (DRY) ; `selectMedia` réutilisé par la commande ; `EXIF_TAGS` pour le rang.
- Écart au cycle red-green : tests écrits juste après le code dans la même passe, validés par contre-épreuves.
- Revue : 4 IMPORTANT et 3 MINEUR corrigés (T5), chacun avec tests. API : `resolveNames` (rapport), `disambiguateNames`
  (stricte), `OccupiedDestination`, `splitName`, `normalizeEtag` ; rapport : `unconfirmed`, `unconfirmedSize`,
  `alreadyArchived`, `namingAnomalies` (plus de `etagVerdict` ni de volume « confirmé » séparé : tout doublon est confirmé).
- Points à signaler (point 1 caduc après revue : MD5 + multipart n'est plus fusionné) : (1) un groupe mixte MD5 + multipart restait doublon présumé ; (2) la collision est comparée sans casse ni différence de normalisation Unicode, les doublons
  sur le nom exact ; (3) le suffixe d'un exemplaire dépend de son ETag : si le choix de l'exemplaire change (nouvelle
  datation), le suffixe peut changer — stable tant que l'inventaire et les datations sont inchangés ; (4) les
  « non datés » (datation absente) sont rangés sans dossier comme les indéterminés : lancer `inventory dates` d'abord.

### File List

- src/inventory/duplicates.ts (nouveau)
- src/inventory/dating.ts (modifié : `isSameObject` exporté)
- src/commands/inventory.ts (modifié : sous-commande `doublons`)
- tests/inventory/duplicates.test.ts (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/2-3-identifier-les-doublons-et-les-collisions-de-noms.md (nouveau)
- _bmad-output/implementation-artifacts/google-photos-cubbit-bridge/sprint-status.yaml (modifié)

## Change Log

- 2026-09-15 : commande `gpb inventory doublons` — doublons (nom + taille, contrôle par ETag), homonymes, collisions par
  dossier de destination et règle de désambiguïsation déterministe (Q1), incohérences signalées (FR-4).
- 2026-09-15 : corrections de revue — regroupement NFC/casse, règle ETag stricte (jamais de fusion sans ETag identique),
  destinations occupées et « déjà archivé », anomalies collectées sans faire échouer le rapport, suffixe allongeable,
  noms sans base, rang EXIF inconnu.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` en 2 passes : APPROUVER, aucun BLOQUANT.
- IMPORTANTS corrigés : regroupement sensible à la casse et à la forme Unicode (plantage sur `Été.jpg` NFC/NFD) ; copie à ETag non comparable fusionnée puis non copiée (risque de perte) ; renommage d'une photo déjà archivée lors d'une passe ultérieure ; rapport interrompu par la première anomalie.
- Décisions Q1 consignées dans le journal du PRD : doublon = nom comparable + taille + ETag identique non nul ; un nom déjà occupé ne change jamais.
- **Consignes impératives pour la story 2.4** :
  - `analyzeDuplicates` utilise la variante tolérante. Avant toute écriture, exiger `namingAnomalies.length === 0` ou repasser les noms par `disambiguateNames` (stricte), sinon les objets en anomalie disparaîtraient du plan en silence et le total ne correspondrait plus à l'inventaire.
  - L'affichage des collisions montre `(anomalie)` pour un exemplaire « déjà archivé » (`finalName === null`) : à corriger dès que des destinations occupées sont passées.
- Dette mineure : `unconfirmedSize` surestime le volume présumé (jamais sous-estimé) ; cas 14h, si A et B ont été suffixés, un C ultérieur peut prendre le nom nu (aucun écrasement).
- Pour la story 4.3 : « déjà archivé » repose sur l'égalité exacte des ETag ; un upload multipart découpé autrement ne sera pas reconnu et sera recopié sous suffixe (doublon, pas perte).
