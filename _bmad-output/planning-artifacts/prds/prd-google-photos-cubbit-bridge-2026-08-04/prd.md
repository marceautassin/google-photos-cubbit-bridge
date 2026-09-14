---
title: "PRD — google-photos-cubbit-bridge"
status: final
created: 2026-08-04
updated: 2026-09-14
author: Marceau Tassin
---

# PRD — google-photos-cubbit-bridge

## 1. Le problème

Google Photos est un compte payant à capacité finie. Marceau continue de photographier ;
le compte se remplit ; à terme il faut payer davantage ou arrêter de prendre des photos.

L'échappatoire est connue : sortir les photos de Google, les archiver ailleurs, vider le
compte, recommencer. Elle a été empruntée une fois, en 2025, avec une V1 de cet outil. Elle
a libéré de l'espace — mais elle a laissé une archive dégradée, et la procédure a été
oubliée.

Deux verrous s'ajoutent :

- **L'API Google Photos est fermée.** Depuis le 1er avril 2025, les scopes `photoslibrary`,
  `photoslibrary.readonly` et `photoslibrary.sharing` sont supprimés ; une application ne
  voit plus que les médias qu'elle a elle-même créés. La Picker API qui la remplace exige une
  sélection manuelle, média par média. **Google Takeout est la seule voie d'export en masse**,
  et le restera.
- **Il n'y a plus de filet.** Les archives Takeout de la V1 ont été effacées, les photos
  correspondantes ont été supprimées de Google Photos, et la base SQLite de suivi a disparu.
  Le bucket Cubbit est le **seul exemplaire survivant** de ces souvenirs.

## 2. L'objectif

Une **boucle d'archivage répétable et sûre** :

> photographier → le compte Google se remplit → exporter un Takeout → archiver sur Cubbit,
> classé par date de prise de vue → vider Google Photos à la main → recommencer.

Le critère de réussite n'est pas « les photos sont sur Cubbit ». C'est :
**« je peux relancer le cycle dans six mois, sans notes, et sans rien casser. »**

Et avant de pouvoir relancer, il faut **réparer ce que la V1 a laissé**.

## 3. L'utilisateur

Marceau, seul. Exécution locale, en ligne de commande, sur son poste. Aucune distribution,
aucun autre utilisateur, aucun service en ligne. Il est à la fois l'utilisateur, le
développeur et le support — ce qui autorise une CLI aride, mais interdit la moindre magie
non documentée : dans six mois, il aura tout oublié.

## 4. État des lieux — constat mesuré

Relevé effectué le 2026-08-04 par inventaire direct du bucket.

**Bucket `marceau` : 17 875 objets, 62,90 Go.** Il héberge aussi des données hors projet
(`2_Personnel` : 7 151 objets ; `1_Professionel` : 516).

L'archive photo est **éclatée en deux emplacements**, produits par deux tentatives
successives :

| Emplacement | Origine | Objets | Volume |
|---|---|---:|---:|
| `backup_google_photos/photos/` | la V1 de l'outil | 10 198 | 35,23 Go |
| `2_Personnel/Photos/google_photos/` | premier essai, manuel | 2 538 | 7,05 Go |
| **Total** | | **12 736** | **42,28 Go** |

Les deux ne se recouvrent presque pas : sur 5 377 et 2 536 noms de fichiers uniques,
**seuls 110 sont communs**. 2 426 noms n'existent que dans le premier essai — dont
**l'intégralité de l'année 2017** (1 300 fichiers, absente de l'archive de la V1) et
**l'essentiel de 2023** (426 fichiers, contre 2 côté V1).

Le premier essai contient par ailleurs `mariage/` — 701 fichiers à plat, correspondant à un
album Google partagé.

**Conséquence de méthode :** l'inventaire initial de ce PRD s'était arrêté au préfixe
`backup_google_photos/`, celui que le code désigne, et avait manqué un cinquième de l'archive.
Toute opération de réparation doit partir d'un **inventaire du bucket entier**, jamais d'un
préfixe supposé.

### 4.1 Les dates de classement sont fausses sur 4 820 fichiers

Deux arborescences coexistent : 5 378 objets en `photos/AAAA/fichier`, 4 820 en
`photos/2025/2025-08/fichier`. Ce second lot ne contient pas des photos d'août 2025 :

| Année réelle (d'après le nom du fichier) | Fichiers rangés dans `2025-08` |
|---|---|
| 2019 | 1 952 |
| 2020 | 865 |
| 2024 | 580 |
| 2021 | 536 |
| 2022 | 496 |
| 2025 | 336 |
| 2023 | 2 |

Ces fichiers ont été classés **au mois d'exécution de la synchronisation**, pas à leur date
de prise de vue : quand la date réelle n'est pas résolue, le code retombe sur la date
courante. L'outil a manqué sa seule mission.

### 4.2 Près de la moitié de l'archive est en double

10 198 objets pour **5 377 noms de fichiers uniques**. 4 820 objets sont des doublons exacts
(même nom, même taille, deux emplacements) : **17,18 Go payés en double sur 35,23 Go**.

Cause : les scripts correctifs `fix-dates.ts` et `fix-cubbit-paths.ts` ont corrigé les chemins
**en base de données** mais les objets S3 ont été **réuploadés** au lieu d'être déplacés.
Les deux défauts n'en forment qu'un seul.

### 4.3 Le code produirait encore le mauvais schéma

`generateTakeoutStoragePath` (`src/commands/takeout.ts:283`) génère `photos/AAAA/AAAA-MM/`,
alors que l'essentiel de l'archive vit en `photos/AAAA/`. Une nouvelle passe écrirait à côté
de l'existant. La même fonction envoie par ailleurs **tout** média appartenant à un album dans
`albums/<nom>/`, au lieu de l'arborescence par date : le classement chronologique saute dès
qu'une photo appartient à un album, quel qu'il soit. La règle retenue (D1) est l'inverse — le
classement par date s'applique par défaut, et seuls les albums partagés explicitement désignés
échappent à la règle.

### 4.4 La déduplication ne survit pas à un second Takeout

L'identité d'un média est `base64(filepath | filename | fileSize)`
(`src/commands/takeout.ts:104`), où `filepath` est le **chemin d'extraction local de
l'archive**. Au prochain export, ce chemin change : toutes les identités changent, et l'outil
considère l'intégralité de l'archive comme nouvelle. **La boucle répétable est structurellement
impossible en l'état.**

### 4.5 Le projet ne s'installe plus

`npm install` échoue : `better-sqlite3@9.1.1` ne compile pas sous Node 24.13 (`node-gyp`,
erreur de build V8). L'outil est aujourd'hui **inexécutable**.

### 4.6 La documentation ment

`README.md` et `QUICKSTART.md` décrivent encore le fonctionnement par API Google
(`gpb auth login`, `gpb list albums`, `gpb sync --album`). Aucune de ces commandes ne peut
fonctionner. La procédure réelle, par Takeout, n'est écrite nulle part.

### 4.7 Ce qui rend la réparation possible

Vérifié empiriquement :

- **5 074 des 5 377 noms uniques (94,4 %) portent une date extractible** du nom de fichier
  (`IMG_20230101_…`, `PXL_…`, `VID_…`).
- Sur les **303 restants**, l'EXIF lu par requête partielle de 128 Ko a rendu une date de
  prise de vue dans **10 cas sur 12** testés.
- La métadonnée S3 `mtime` présente sur les objets est **inexploitable** : sur `IMG_0005.JPG`
  elle vaut 2024-01-29 quand l'EXIF donne 2016-02-20. C'est la date du fichier à l'upload.

La matière est donc suffisante pour reconstruire le classement **sans réexport Takeout**.

## 5. Exigences fonctionnelles

### A. Réparer et unifier l'archive existante

- **FR-1** — Reconstruire un index de l'état réel de l'archive à partir du **bucket entier**
  (aucune base préexistante n'est disponible), et le persister localement. L'inventaire ne
  présume d'aucun préfixe : c'est ainsi qu'un cinquième de l'archive avait échappé au premier
  relevé.
- **FR-1b** — Fusionner les deux emplacements historiques
  (`backup_google_photos/photos/` et `2_Personnel/Photos/google_photos/`) en une archive
  unique, dans le bucket dédié aux photos. À l'issue de la réparation, **il n'existe plus
  qu'un seul endroit où vivent les photos.**
- **FR-2** — Déterminer la date de prise de vue de chaque objet selon une cascade explicite et
  tracée : *(1)* date lisible dans le nom du fichier, *(2)* EXIF `DateTimeOriginal` /
  `CreateDate` lu par requête partielle, *(3)* échec assumé. La source retenue est enregistrée
  pour chaque fichier.
- **FR-3** — Isoler dans un emplacement de quarantaine dédié les fichiers dont la date reste
  indéterminée, plutôt que de leur attribuer une date par défaut. **Aucun repli silencieux sur
  la date courante n'est acceptable** — c'est l'origine du défaut 4.1.
- **FR-4** — Détecter les doublons par couple (nom, taille), et sur demande par empreinte
  (ETag), et n'en conserver qu'un exemplaire à l'emplacement correct.
- **FR-5** — Reclasser chaque objet conservé à l'emplacement dérivé de sa date réelle, par
  copie côté serveur, jamais par réupload depuis le poste local. Lors de la migration vers le
  bucket dédié, la source n'est pas supprimée : les doublons sont écartés en n'étant pas
  copiés.
- **FR-6** — Produire un plan de réparation complet et inspectable **avant toute écriture**,
  exécutable en simulation, et n'exécuter qu'après confirmation explicite.
- **FR-7** — Être reprenable : une réparation interrompue reprend où elle s'est arrêtée sans
  refaire ni casser ce qui est déjà fait.
- **FR-8** — Produire un rapport de réparation : objets déplacés, doublons supprimés, espace
  récupéré, fichiers mis en quarantaine.

### B. Archiver un nouveau Takeout

- **FR-9** — Valider une archive Takeout avant traitement : structure attendue, nombre de
  médias, médias dépourvus de métadonnées JSON.
- **FR-10** — Extraire la date de prise de vue depuis le JSON d'accompagnement Takeout
  (`photoTakenTime`), en tête de la cascade définie en FR-2.
- **FR-11** — Identifier chaque média par une identité **stable d'un export Takeout à l'autre**,
  indépendante du répertoire d'extraction local.
- **FR-12** — Ne jamais réuploader un média déjà présent dans l'archive, et le signaler comme
  ignoré.
- **FR-13** — Classer chaque média selon le schéma de chemins unique retenu, identique à celui
  produit par la réparation.
- **FR-14** — Reprendre une passe d'archivage interrompue sans repartir de zéro.
- **FR-15** — Rendre compte de la progression pendant l'exécution : traités, ignorés, en
  erreur, volume restant.

### C. Vérifier avant de détruire

- **FR-16** — Comparer une archive Takeout au contenu du bucket et attester, fichier par
  fichier, que chaque média est présent avec la bonne taille — **avant que Marceau ne
  supprime quoi que ce soit dans Google Photos.**
- **FR-17** — Signaler tout écart (manquant, taille divergente) sous une forme actionnable,
  et refuser d'attester tant qu'un écart subsiste.
- **FR-18** — Restituer à la demande l'état de l'archive : volumétrie, répartition par année,
  doublons, fichiers en quarantaine.

### D. Documenter la marche à suivre

- **FR-19** — Fournir un **runbook** décrivant le cycle complet de bout en bout : demander
  l'export à Google Takeout, le récupérer, le valider, l'archiver, vérifier, supprimer côté
  Google. Rédigé pour être suivi sans mémoire préalable, six mois plus tard.
- **FR-20** — Réécrire `README.md` et `QUICKSTART.md` pour décrire l'outil réel. Toute
  référence à l'API Google Photos est supprimée, et la raison de son abandon est consignée.

### E. Remettre le projet en état

- **FR-21** — Rétablir une installation qui aboutit sur l'environnement Node courant.
- **FR-22** — Supprimer le code hérité de l'API Google Photos, définitivement inutilisable :
  `src/auth/`, `src/clients/google-photos.ts`, commandes `auth` et `list`, `debug-scopes.js`,
  `check-photos-scopes.js`. Ce qui a une seconde vie — le chiffrement de secrets de
  `src/utils/crypto-utils.ts` — est conservé et réaffecté.
- **FR-23** — Retirer les scripts correctifs ponctuels `fix-dates.ts` et `fix-cubbit-paths.ts`,
  dont la fonction est absorbée par le groupe A.

## 6. Exigences non fonctionnelles

**Sûreté — l'exigence dominante.** Le bucket actuel ne contient pas que des photos : 7 667
objets personnels et professionnels vivent à côté, et l'archive photo est elle-même à cheval
sur les deux mondes. Depuis la suppression des Takeout et des originaux Google, **cette
archive est l'unique exemplaire**. En conséquence :

- Une fois la migration faite (D3), l'outil n'a d'accès qu'au bucket photo. Le cloisonnement
  est porté par l'infrastructure — une clé qui ne voit rien d'autre — et non par une
  vérification de préfixe dans le code.
- Pendant la migration elle-même, seule phase où l'outil lit le bucket mixte, **l'accès à ce
  bucket est en lecture seule.** Aucune suppression dans `marceau` n'est effectuée par
  l'outil : la source est laissée intacte, et Marceau la supprime lui-même une fois la
  migration vérifiée.
- Toute opération destructive est précédée d'une simulation inspectable et d'une confirmation
  explicite.
- Une suppression n'intervient qu'après confirmation que la copie de destination existe.

**Idempotence.** Toute commande relancée sur un état déjà traité ne produit ni doublon, ni
déplacement, ni suppression.

**Reprise.** Toute opération longue survit à une interruption — coupure réseau, `Ctrl-C`,
extinction du poste.

**Traçabilité.** Chaque décision de classement conserve la source de la date retenue. Sans
cela, un défaut comme celui de 4.1 reste invisible jusqu'à ce qu'il ait tout contaminé.

**Volumétrie.** Dimensionné pour des dizaines de milliers d'objets et des dizaines de Go par
passe. Une passe complète doit tenir dans une soirée, sans surveillance continue.

**Secrets.** Les identifiants Cubbit ne sont jamais écrits en clair dans un fichier versionné,
ni affichés dans les journaux ou la sortie console.

**Langue.** Interface, messages et documentation en français.

## 7. Hors périmètre

- Toute intégration à l'API Google Photos, y compris la Picker API — techniquement close pour
  cet usage.
- La suppression des médias dans Google Photos : **Marceau la fait à la main.** L'outil vérifie
  et atteste, il ne détruit rien côté Google.
- Le déclenchement automatisé de l'export Takeout : Google ne l'expose pas.
- Toute interface graphique, tout service hébergé, tout multi-utilisateur.
- La restauration depuis Cubbit vers Google Photos.

## 8. Critères de succès

1. **Il n'existe plus qu'un seul endroit où vivent les photos** — un bucket dédié, alimenté
   par les deux archives historiques fusionnées.
2. Cette archive ne contient **plus aucun doublon**, et les 17,18 Go sont récupérés.
3. **Aucun fichier n'est classé à une date qui n'est pas la sienne.** Les fichiers dont la date
   est indéterminable sont en quarantaine, comptés et assumés — pas dissimulés.
4. Une **seconde passe** d'archivage sur un nouveau Takeout ne réuploade **aucun** média déjà
   présent.
5. Marceau exécute le cycle complet en suivant le runbook, **sans poser de question et sans
   lire le code**.
6. `npm install` puis une commande de l'outil aboutissent sur son poste.

**Contre-métriques** — ce qu'il faut surveiller pour ne pas gagner à l'envers :

- **Nombre d'objets photo à l'arrivée contre 12 736 au départ** (moins les doublons connus).
  Tout manquant est un souvenir perdu sans recours. C'est la métrique qui prime sur toutes les
  autres.
- Nombre de fichiers mis en quarantaine : un dédoublonnage brillant qui met 2 000 photos en
  quarantaine est un échec.
- Nombre d'objets supprimés par l'outil dans le bucket `marceau` : doit rester **zéro**,
  absolument.
- Écart entre le nombre de médias d'un Takeout et le nombre d'objets archivés : tout écart non
  expliqué est une perte potentielle.

## 9. Décisions arrêtées

- **D1 — Le classement par date est la règle ; les albums partagés sont l'exception.**
  Par défaut, tout média est classé chronologiquement et son appartenance à un album n'est
  qu'une métadonnée de l'index. Les **albums partagés explicitement désignés** — à ce jour
  `mariage/`, 701 fichiers — sont conservés tels quels, comme regroupement à part entière.
  Ils ne sont ni éclatés par date, ni dupliqués dans l'arborescence chronologique.
- **D2 — Un schéma de chemins unique**, appliqué à l'identique par la réparation (groupe A) et
  par les passes futures (groupe B) : `photos/AAAA/AAAA-MM/<fichier>` pour le classement
  chronologique, `albums/<nom>/<fichier>` pour les albums conservés. Les objets aujourd'hui
  en `photos/AAAA/` sont migrés vers ce schéma.
- **D3 — Les photos vivent dans un bucket dédié.** Elles quittent le bucket `marceau`, qui
  mêle aujourd'hui archive photo, documents personnels et données professionnelles. La clé
  d'accès de l'outil ne voit que ce bucket. La migration se fond dans la réparation
  (groupe A) : celle-ci réécrit de toute façon l'emplacement de chaque objet, une copie vers
  un autre bucket ne coûte pas davantage.
- **D4 — Les deux archives sont unifiées.** Le premier essai manuel
  (`2_Personnel/Photos/google_photos/`) et l'archive de la V1 (`backup_google_photos/`)
  fusionnent. Aucune des deux ne fait autorité *a priori* : les dates des deux sont
  reconstruites par la même cascade (FR-2).

## 10. Questions ouvertes — pour l'architecture

- **Q1 — Collisions de noms.** Deux fichiers distincts peuvent porter le même nom dans le même
  mois (`IMG_0044.JPG` existe en 2016 et en 2025, avec des tailles différentes). La stratégie
  de désambiguïsation reste à définir. Un écrasement silencieux détruirait un original sans
  aucun recours. **Bloquant pour le groupe A** : à trancher avant la première écriture.
- **Q2 — Sort de la base SQLite.** L'index reste-t-il en SQLite — ce qui impose de régler le
  problème de compilation native — ou bascule-t-on sur un format sans dépendance binaire ?
  L'index étant reconstructible depuis le bucket (FR-1), sa perte n'est pas grave, ce qui
  autorise une solution simple.
- **Q3 — Identité stable d'un média entre deux Takeout.** Conditionne FR-11 et FR-12, donc la
  faisabilité même de la boucle répétable. Pistes dans l'addendum.
