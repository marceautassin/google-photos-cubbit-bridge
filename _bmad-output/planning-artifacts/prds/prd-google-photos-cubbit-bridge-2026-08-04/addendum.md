# Addendum — matière technique pour l'architecture

Ce document recueille ce qui ne relève pas du PRD mais devra être tranché en conception.
Il n'engage aucune décision produit.

## Alternatives écartées

**Retour à l'API Google Photos.** Vérifié le 2026-08-04. Les scopes `photoslibrary`,
`photoslibrary.readonly` et `photoslibrary.sharing` ont été supprimés le 1er avril 2025 ; la
Library API ne rend plus que les médias créés par l'application appelante. La Picker API qui
la remplace impose une sélection manuelle média par média, inutilisable pour un archivage de
masse. Google renvoie lui-même vers Takeout pour l'export.
Sources : [Updates to the Google Photos APIs](https://developers.google.com/photos/support/updates),
[Picker API launch and Library API changes](https://developers.googleblog.com/en/google-photos-picker-api-launch-and-library-api-updates/).

**Repartir d'un bucket vide.** Écartée définitivement : les archives Takeout de la V1 sont
effacées et les originaux ont été supprimés de Google Photos. Le bucket est l'unique
exemplaire. Toute remise à zéro détruirait des souvenirs irrécupérables.

**Métadonnée S3 `mtime` comme date de prise de vue.** Écartée : présente sur les objets mais
fausse. Sur `IMG_0005.JPG` elle vaut `1706564842` (2024-01-29) quand l'EXIF donne 2016-02-20.
C'est la date du fichier au moment de l'upload, héritée de l'extraction du Takeout.

## Sources de date — cascade proposée

Par ordre de fiabilité décroissante :

1. **JSON Takeout** — `photoTakenTime.timestamp`. Autoritatif, mais disponible uniquement
   lors d'une passe d'archivage, pas pour la réparation de l'existant.
2. **Nom de fichier** — motifs `IMG_AAAAMMJJ_`, `PXL_AAAAMMJJ_`, `VID_AAAAMMJJ_`, `MVIMG_`,
   `PANO_`, `BURST`. Couvre 5 074 des 5 377 noms uniques (94,4 %). Gratuit, aucune lecture
   d'objet.
3. **EXIF** — `DateTimeOriginal`, à défaut `CreateDate`, à défaut `ModifyDate`. Testé par
   requête HTTP partielle `Range: bytes=0-131071` : 10 succès sur 12 fichiers dépourvus de
   date dans leur nom. Les 2 échecs méritent un second essai sur une plage plus large avant
   d'être déclarés irrécupérables.
4. **Échec** — quarantaine explicite. Jamais de repli sur la date courante.

Volumétrie de la passe EXIF : ~303 fichiers × 128 Ko ≈ 39 Mo de trafic sortant. Négligeable.
Une lecture EXIF systématique sur les 5 377 fichiers coûterait ~690 Mo — envisageable si l'on
veut auditer la fiabilité des dates déduites des noms, mais pas nécessaire au traitement.

## Réparation — mécanique S3

Le reclassement se fait par `CopyObject` côté serveur puis `DeleteObject` de la source :
aucun octet ne transite par le poste local. Ordre impératif : copier, vérifier que la
destination existe avec la bonne taille, **puis seulement** supprimer.

Le dédoublonnage peut s'appuyer sur l'`ETag`, qui vaut le MD5 du contenu pour les objets
déposés en une seule requête. Attention : pour un objet chargé en plusieurs parties
(*multipart*), l'ETag n'est pas un MD5 simple et n'est pas comparable directement. À vérifier
sur les fichiers volumineux du bucket avant de s'y fier.

Le garde-fou de préfixe (`backup_google_photos/`) doit vivre dans le client S3 lui-même, au
point le plus bas possible, et non dans chaque commande appelante — 7 667 objets personnels
et professionnels cohabitent dans le bucket.

## Index local

Le problème de compilation de `better-sqlite3@9.1.1` sous Node 24.13 se règle soit par montée
de version, soit par changement de moteur. Pistes : `node:sqlite` (intégré à Node ≥ 22, aucune
compilation), `sql.js`, ou un simple fichier JSON/JSONL au vu de la volumétrie (quelques
dizaines de milliers de lignes). L'index étant reconstructible depuis le bucket (FR-1), sa
perte n'est plus un événement grave — ce qui autorise une solution simple.

## Identité stable d'un média

L'identité actuelle `base64(filepath | filename | fileSize)` dépend du répertoire
d'extraction, qui change à chaque export. Pistes de remplacement : chemin **relatif à la
racine `Google Photos/`** du Takeout, ou couple (nom de fichier, taille, date de prise de vue),
ou empreinte du contenu. Le choix conditionne directement la faisabilité de la boucle
répétable (FR-11, FR-12) — c'est la décision technique la plus structurante du projet.

## Résidu à vérifier avant la migration

`2_Personnel/Photos/`, hors du sous-dossier `google_photos/`, contient une quarantaine de
fichiers épars : quelques dossiers (`Séance photo dune du Pyla` 18, `Lacanau mai 2018` 7,
`Mariage Astrid et Marius` 4) et une douzaine de fichiers nommés `altA…_jpg.jpg`, forme
caractéristique des téléchargements par lien de partage Google Photos. Marceau considère que
seuls `backup_google_photos/` et `2_Personnel/Photos/google_photos/` sont dans le périmètre ;
ce résidu mérite un coup d'œil de sa part avant la migration, pas un traitement automatique.

Par ailleurs `2_Personnel/Mariage/` (1 594 fichiers) partage 278 noms de fichiers avec
l'album `mariage/` conservé. Les deux restent distincts : `mariage/` est dans le périmètre
photo, `2_Personnel/Mariage/` non.

## Inventaire brut

L'inventaire complet du bucket au 2026-08-04 (clé, taille, date de modification pour les
17 875 objets) a été produit pendant la découverte. Il n'est pas versionné : il est
reproductible par un simple `ListObjectsV2` paginé, et il contient l'arborescence de données
personnelles hors projet.
