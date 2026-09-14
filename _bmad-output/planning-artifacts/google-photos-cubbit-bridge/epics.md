---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/prd.md
  - _bmad-output/planning-artifacts/prds/prd-google-photos-cubbit-bridge-2026-08-04/addendum.md
  - docs/TAKEOUT_STRUCTURE.md
  - CLAUDE.md
  - src/
---

# google-photos-cubbit-bridge - Epic Breakdown

## Overview

Ce document décompose les exigences du PRD en epics et stories implémentables.

**Pas de document d'architecture, pas d'UX** : outil CLI mono-utilisateur, sans interface
graphique. Les trois questions techniques ouvertes du PRD sont portées par des stories
dédiées plutôt que présumées résolues.

**Projet brownfield.** Du code existe (`src/`), il a tourné en production personnelle, et il
a produit une archive dégradée. Les stories disent donc aussi ce qu'on **supprime** et ce
qu'on **corrige**, pas seulement ce qu'on ajoute.

## Requirements Inventory

### Functional Requirements

**Groupe A — Réparer et unifier l'archive existante**

- **FR-1** : Reconstruire un index de l'état réel de l'archive à partir du bucket entier, sans présumer d'aucun préfixe, et le persister localement.
- **FR-1b** : Fusionner les deux emplacements historiques (`backup_google_photos/photos/` et `2_Personnel/Photos/google_photos/`) en une archive unique dans le bucket dédié.
- **FR-2** : Déterminer la date de prise de vue selon une cascade explicite et tracée — nom de fichier, puis EXIF, puis échec assumé. La source retenue est enregistrée par fichier.
- **FR-3** : Isoler en quarantaine les fichiers dont la date reste indéterminée. Aucun repli silencieux sur la date courante.
- **FR-4** : Détecter les doublons par couple (nom, taille), et sur demande par empreinte, et n'en conserver qu'un exemplaire.
- **FR-5** : Reclasser chaque objet conservé par copie côté serveur vers sa destination, jamais par réupload local. Lors de la migration vers le bucket dédié, la source n'est pas supprimée : les doublons sont écartés en n'étant pas copiés.
- **FR-6** : Produire un plan de réparation complet et inspectable avant toute écriture, exécutable en simulation, appliqué seulement après confirmation explicite.
- **FR-7** : Reprendre une réparation interrompue sans refaire ni casser ce qui est déjà fait.
- **FR-8** : Produire un rapport de réparation — objets déplacés, doublons supprimés, espace récupéré, fichiers en quarantaine.

**Groupe B — Archiver un nouveau Takeout**

- **FR-9** : Valider une archive Takeout avant traitement — structure, nombre de médias, médias sans métadonnées JSON.
- **FR-10** : Extraire la date depuis le JSON Takeout (`photoTakenTime`), en tête de la cascade FR-2.
- **FR-11** : Identifier chaque média par une identité stable d'un export à l'autre, indépendante du répertoire d'extraction local.
- **FR-12** : Ne jamais réuploader un média déjà présent, et le signaler comme ignoré.
- **FR-13** : Classer chaque média selon le schéma de chemins unique, identique à celui produit par la réparation.
- **FR-14** : Reprendre une passe d'archivage interrompue sans repartir de zéro.
- **FR-15** : Rendre compte de la progression — traités, ignorés, en erreur, volume restant.

**Groupe C — Vérifier avant de détruire**

- **FR-16** : Comparer une archive Takeout au bucket et attester fichier par fichier la présence et la taille, avant toute suppression côté Google.
- **FR-17** : Signaler tout écart sous forme actionnable, et refuser d'attester tant qu'un écart subsiste.
- **FR-18** : Restituer l'état de l'archive à la demande — volumétrie, répartition par année, doublons, quarantaine.

**Groupe D — Documenter la marche à suivre**

- **FR-19** : Fournir un runbook du cycle complet, suivable sans mémoire préalable six mois plus tard.
- **FR-20** : Réécrire `README.md` et `QUICKSTART.md` pour décrire l'outil réel, sans référence à l'API Google, en consignant la raison de son abandon.

**Groupe E — Remettre le projet en état**

- **FR-21** : Rétablir une installation qui aboutit sur l'environnement Node courant.
- **FR-22** : Supprimer le code hérité de l'API Google Photos, en conservant et réaffectant ce qui a une seconde vie (`crypto-utils.ts`).
- **FR-23** : Retirer les scripts correctifs ponctuels `fix-dates.ts` et `fix-cubbit-paths.ts`.

### NonFunctional Requirements

- **NFR-1 — Cloisonnement par l'infrastructure** : après migration, la clé de l'outil ne voit que le bucket photo. Le cloisonnement n'est pas une vérification de préfixe dans le code.
- **NFR-2 — Lecture seule sur le bucket mixte** : pendant la migration, l'outil n'effectue aucune suppression dans `marceau`. Marceau supprime les sources lui-même après vérification.
- **NFR-3 — Simulation obligatoire** : toute opération destructive est précédée d'une simulation inspectable et d'une confirmation explicite.
- **NFR-4 — Copier avant supprimer** : toute suppression effectuée par l'outil — hors migration, où il n'en fait aucune — n'intervient qu'après confirmation que la copie de destination existe.
- **NFR-5 — Idempotence** : toute commande relancée sur un état déjà traité ne produit ni doublon, ni déplacement, ni suppression.
- **NFR-6 — Reprise** : toute opération longue survit à une interruption — coupure réseau, `Ctrl-C`, extinction du poste.
- **NFR-7 — Traçabilité** : chaque décision de classement conserve la source de la date retenue.
- **NFR-8 — Volumétrie** : dimensionné pour des dizaines de milliers d'objets et des dizaines de Go par passe ; une passe tient dans une soirée sans surveillance.
- **NFR-9 — Secrets** : les identifiants Cubbit ne sont jamais écrits en clair dans un fichier versionné, ni affichés dans les journaux ou la console.
- **NFR-10 — Langue** : interface, messages et documentation en français.
- **NFR-11 — Qualité de code** : DRY, KISS, SOLID, KISS prioritaire en cas de conflit. TypeScript strict, `npx tsc --noEmit` vert avant toute proposition de commit (`CLAUDE.md`).

### Additional Requirements

Pas de document d'architecture. Les contraintes techniques ci-dessous proviennent du PRD, de
l'addendum et de l'état constaté du code.

- **Prérequis d'infrastructure** : un bucket Cubbit dédié aux photos doit exister, avec une clé
  d'accès restreinte à ce seul bucket, ainsi qu'une clé **en lecture seule** sur le bucket
  `marceau` pour la phase de migration. Bloquant pour l'epic 2.
- **Blocage d'installation** : `better-sqlite3@9.1.1` ne compile pas sous Node 24.13 (`node-gyp`).
  Le projet est aujourd'hui inexécutable — `node_modules` ne peut pas être construit.
- **Mécanique S3** : le reclassement se fait par `CopyObject` côté serveur puis `DeleteObject`.
  Aucun octet ne transite par le poste. Ordre impératif : copier, vérifier, puis supprimer.
- **Piège ETag** : l'ETag vaut le MD5 du contenu uniquement pour les objets déposés en une seule
  requête. Pour un objet *multipart*, il n'est pas comparable directement.
- **Métadonnée `mtime` inexploitable** : présente sur les objets mais fausse — c'est la date du
  fichier à l'upload, pas la date de prise de vue.
- **Volumétrie de référence** : 12 736 objets photo, 42,28 Go, répartis sur deux emplacements ;
  4 820 doublons exacts représentant 17,18 Go ; 4 820 objets mal datés.
- **Faisabilité de la reconstruction des dates** : 94,4 % des noms uniques portent une date
  exploitable ; l'EXIF par requête partielle de 128 Ko couvre l'essentiel du reste.
- **Résidu à arbitrer** : ~40 fichiers épars dans `2_Personnel/Photos/` hors `google_photos/`,
  dont des fichiers `altA…_jpg.jpg` typiques de liens de partage Google Photos.

**Questions techniques ouvertes — à trancher par des stories, non présumées résolues :**

- **Q1 — Collisions de noms** (`IMG_0044.JPG` existe en 2016 et 2025, tailles différentes).
  **Bloquant** : à trancher avant la première écriture du groupe A.
- **Q2 — Moteur d'index** : SQLite (avec le problème de compilation à régler) ou format sans
  dépendance binaire. L'index étant reconstructible (FR-1), sa perte n'est pas grave.
- **Q3 — Identité stable d'un média entre deux Takeout** : conditionne FR-11 et FR-12, donc la
  faisabilité même de la boucle répétable.

### UX Design Requirements

Sans objet — outil en ligne de commande, aucune interface graphique. Les exigences
d'expérience utilisateur qui comptent ici sont couvertes par NFR-3 (simulation avant
destruction), NFR-10 (français) et FR-19 (runbook suivable sans mémoire).

### FR Coverage Map

| FR | Epic | Ce que l'epic en fait |
|---|---|---|
| FR-1 | Epic 2 | Inventaire du bucket entier, sans présumer d'aucun préfixe |
| FR-1b | Epic 3 | Fusion des deux emplacements dans le bucket dédié |
| FR-2 | Epic 2 | Cascade de dates tracée : nom de fichier → EXIF → échec assumé |
| FR-3 | Epic 2 | Décision de quarantaine (l'exécution relève de l'epic 3) |
| FR-4 | Epic 2 | Détection des doublons (la suppression relève de l'epic 3) |
| FR-5 | Epic 3 | Reclassement par copie côté serveur puis suppression |
| FR-6 | Epic 2 | Plan de réparation inspectable, produit sans aucune écriture |
| FR-7 | Epic 3 | Reprise d'une réparation interrompue |
| FR-8 | Epic 3 | Rapport de réparation |
| FR-9 | Epic 4 | Validation d'une archive Takeout |
| FR-10 | Epic 4 | Date issue du JSON Takeout, en tête de cascade |
| FR-11 | Epic 4 | Identité de média stable d'un export à l'autre |
| FR-12 | Epic 4 | Aucun réupload d'un média déjà présent |
| FR-13 | Epic 4 | Classement selon le schéma unique fixé par l'epic 3 |
| FR-14 | Epic 4 | Reprise d'une passe d'archivage interrompue |
| FR-15 | Epic 4 | Compte rendu de progression |
| FR-16 | Epic 4 | Attestation fichier par fichier avant suppression côté Google |
| FR-17 | Epic 4 | Signalement des écarts, refus d'attester tant qu'il en reste |
| FR-18 | Epic 2 | Restitution de l'état de l'archive à la demande |
| FR-19 | Epic 5 | Runbook du cycle complet |
| FR-20 | Epic 5 | Réécriture du README et du QUICKSTART |
| FR-21 | Epic 1 | Installation qui aboutit sur Node courant |
| FR-22 | Epic 1 | Suppression du code hérité de l'API Google |
| FR-23 | Epic 1 | Retrait des scripts correctifs ponctuels |

**24 exigences, 24 couvertes.**

Les questions techniques ouvertes sont rattachées : **Q2** (moteur d'index) à l'epic 1,
**Q1** (collisions de noms) à l'epic 2, **Q3** (identité stable) à l'epic 4.

## Epic List

**Principe directeur : on sépare ce qui décide de ce qui détruit.** L'outil produit un plan,
Marceau le lit, et l'exécution ne vient qu'après. Le risque n'arrive qu'au quatrième temps —
et même là, la source reste intacte : on copie vers le bucket dédié, on vérifie, et l'ancien
bucket n'est jamais modifié par l'outil.

**Dépendances :** 2 dépend de 1 · 3 dépend de 2 · 4 dépend du schéma de chemins figé par 3 ·
5 se rédige en dernier, quand la procédure est éprouvée. Chaque epic livre néanmoins un
résultat exploitable seule.

### Epic 1 : Reprendre la main sur l'outil

L'outil se lance à nouveau sur le poste de Marceau, et ne contient plus que du code qui sert.
`npm install` aboutit ; le code hérité de l'API Google — définitivement inutilisable et
trompeur, puisque le README promet encore `gpb auth login` — disparaît. La question du moteur
d'index (Q2) est tranchée ici, puisqu'elle est la cause du blocage d'installation.
**FRs couvertes :** FR-21, FR-22, FR-23

### Epic 2 : Savoir ce qu'on a, et décider quoi en faire

Marceau obtient la vérité sur ses 12 736 objets et un plan de réparation lisible ligne à
ligne, **sans qu'un seul octet ne soit écrit**. L'inventaire balaye le bucket entier sans
présumer d'aucun préfixe. Pour chaque objet, la date réelle est reconstruite par la cascade et
**la source de cette date est enregistrée**. Doublons identifiés, indatables mis de côté,
collisions de noms (Q1) comptées plutôt que supposées.

C'est l'epic pivot : si le plan est juste, le reste est de la mécanique ; s'il est faux, on
l'apprend sans avoir rien cassé.
**FRs couvertes :** FR-1, FR-2, FR-3, FR-4, FR-6, FR-18

### Epic 3 : Exécuter le plan

Il n'existe plus qu'un seul endroit où vivent les photos : le bucket dédié, classé par date,
sans doublons. Le reclassement se fait par copie côté serveur — aucun octet ne transite par le
poste. L'opération est reprenable et rend compte de ce qu'elle a fait : objets déplacés,
doublons supprimés, espace récupéré, fichiers en quarantaine.
**FRs couvertes :** FR-1b, FR-5, FR-7, FR-8

### Epic 4 : La boucle Takeout

Marceau peut archiver un nouvel export Takeout **et vider Google Photos en confiance**. Le
cœur de l'epic est l'identité de média stable d'un export à l'autre (Q3) : sans elle, la
boucle répétable est impossible et l'archive entière serait réuploadée à chaque passe. La
vérification est incluse plutôt que séparée — c'est la même séance de travail, et le même code.
**FRs couvertes :** FR-9, FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17

### Epic 5 : La marche à suivre

Marceau refait le cycle complet six mois plus tard sans rien demander à personne et sans lire
le code. Le runbook décrit la procédure de bout en bout ; le README et le QUICKSTART cessent de
décrire un outil qui n'existe plus.
**FRs couvertes :** FR-19, FR-20

---

## Epic 1 : Reprendre la main sur l'outil

L'outil se lance à nouveau sur le poste de Marceau, et ne contient plus que du code qui sert.

### Story 1.1 : Rétablir une installation qui aboutit

En tant que Marceau,
je veux que `npm install` puis une commande de l'outil aboutissent sur mon poste,
afin de pouvoir enfin exécuter l'outil que je dois utiliser.

**Exigences :** FR-21

**Acceptance Criteria :**

**Étant donné** un poste avec Node 24.13 et un dépôt fraîchement cloné
**Quand** j'exécute `npm install`
**Alors** l'installation aboutit sans erreur de compilation native
**Et** `npx tsc --noEmit` ne rapporte aucune erreur
**Et** `npm test` s'exécute

**Étant donné** que `better-sqlite3@9.1.1` est la cause du blocage (`node-gyp`)
**Quand** la question Q2 du PRD est tranchée
**Alors** le choix du moteur d'index est consigné en une ligne dans le dépôt, avec sa raison
**Et** la solution retenue ne réintroduit pas de dépendance à compiler

**Étant donné** que l'index est reconstructible depuis le bucket (FR-1)
**Quand** on arbitre entre robustesse et simplicité
**Alors** la solution la plus simple qui marche l'emporte (KISS, `CLAUDE.md`)

### Story 1.2 : Supprimer le code hérité de l'API Google Photos

En tant que Marceau,
je veux que le code de l'API Google Photos disparaisse du dépôt,
afin de ne plus croire, dans six mois, que `gpb auth login` fonctionne encore.

**Exigences :** FR-22

**Acceptance Criteria :**

**Étant donné** que l'API Google Photos est fermée depuis le 1er avril 2025
**Quand** le nettoyage est appliqué
**Alors** `src/auth/`, `src/clients/google-photos.ts`, les commandes `auth` et `list`,
`debug-scopes.js` et `check-photos-scopes.js` n'existent plus
**Et** aucune référence à ces modules ne subsiste dans le code ni dans `package.json`

**Étant donné** que `src/utils/crypto-utils.ts` peut resservir pour les secrets Cubbit
**Quand** je passe en revue ce qui est supprimé
**Alors** ce module est conservé
**Et** sa nouvelle affectation est explicite, ou il est supprimé faute d'usage réel

**Étant donné** le nettoyage terminé
**Quand** j'exécute `npx tsc --noEmit` et `npm test`
**Alors** les deux passent

### Story 1.3 : Retirer les scripts correctifs ponctuels

En tant que Marceau,
je veux que `fix-dates.ts` et `fix-cubbit-paths.ts` disparaissent,
afin que personne ne les relance et ne recrée les dégâts qu'ils ont produits.

**Exigences :** FR-23

**Acceptance Criteria :**

**Étant donné** que ces deux scripts ont corrigé les chemins en base sans déplacer les objets S3,
produisant 4 820 doublons
**Quand** ils sont retirés
**Alors** `src/utils/fix-dates.ts` et `src/utils/fix-cubbit-paths.ts` n'existent plus
**Et** `extractDateFromFilename` (`src/utils/file-utils.ts`), dont ils dépendaient, est conservé

**Étant donné** leur suppression
**Quand** j'exécute `npx tsc --noEmit`
**Alors** la compilation passe

---

## Epic 2 : Savoir ce qu'on a, et décider quoi en faire

Marceau obtient la vérité sur ses 12 736 objets et un plan de réparation lisible ligne à
ligne, sans qu'un seul octet ne soit écrit.

### Story 2.1 : Inventorier le bucket entier

En tant que Marceau,
je veux un inventaire complet du bucket, sans qu'aucun préfixe ne soit présumé,
afin de ne pas répéter l'erreur d'avoir cru que mes photos tenaient dans un seul dossier.

**Exigences :** FR-1

**Acceptance Criteria :**

**Étant donné** des identifiants en lecture sur le bucket `marceau`
**Quand** je lance la commande d'inventaire
**Alors** tous les objets du bucket sont listés, sans filtre de préfixe en dur
**Et** clé, taille et date de modification sont conservées pour chacun
**Et** l'inventaire est persisté localement et rejouable sans nouvel appel réseau

**Étant donné** un inventaire terminé
**Quand** je consulte le résultat
**Alors** les emplacements contenant des médias sont identifiés et présentés avec leur
volumétrie, y compris ceux hors de `backup_google_photos/`

**Étant donné** que le bucket contient aussi des données perso et pro hors périmètre
**Quand** l'inventaire s'exécute
**Alors** il est strictement en lecture — aucune écriture, aucune suppression

**Étant donné** les identifiants du bucket source
**Quand** l'outil les charge
**Alors** ils proviennent du `.env` non versionné
**Et** ils n'apparaissent jamais dans la console ni dans les journaux

**Étant donné** une interruption réseau en cours de listing
**Quand** je relance la commande
**Alors** l'inventaire aboutit sans état corrompu

### Story 2.2 : Reconstruire la date de prise de vue par cascade tracée

En tant que Marceau,
je veux que la vraie date de chaque photo soit retrouvée, et que je sache d'où elle vient,
afin qu'aucune photo de 2019 ne soit plus jamais rangée en août 2025.

**Exigences :** FR-2, FR-3

**Acceptance Criteria :**

**Étant donné** un objet dont le nom contient une date (`IMG_20230101_…`, `PXL_…`, `VID_…`)
**Quand** la cascade s'applique
**Alors** cette date est retenue
**Et** la source enregistrée est « nom de fichier »

**Étant donné** un objet sans date exploitable dans son nom
**Quand** la cascade s'applique
**Alors** l'EXIF est lu par requête partielle, sans télécharger l'objet entier
**Et** `DateTimeOriginal`, puis `CreateDate`, puis `ModifyDate` sont essayés dans cet ordre
**Et** la source enregistrée est « EXIF »

**Étant donné** un objet dont aucune source ne rend de date
**Quand** la cascade s'applique
**Alors** il est marqué « date indéterminée »
**Et** aucune date par défaut, et surtout pas la date courante, ne lui est attribuée

**Étant donné** la métadonnée S3 `mtime` présente sur les objets
**Quand** la cascade s'applique
**Alors** elle n'est jamais utilisée comme date de prise de vue

**Étant donné** la cascade appliquée à l'inventaire complet
**Quand** je consulte le résultat
**Alors** le nombre d'objets par source de date est affiché
**Et** toute date dans le futur ou antérieure à 2000 est signalée comme suspecte plutôt qu'acceptée silencieusement

### Story 2.3 : Identifier les doublons et les collisions de noms

En tant que Marceau,
je veux savoir exactement quels objets sont des doublons et quels noms entrent en collision,
afin qu'aucune photo ne soit écrasée par une autre qui porte le même nom.

**Exigences :** FR-4

**Acceptance Criteria :**

**Étant donné** l'inventaire daté
**Quand** la détection s'exécute
**Alors** les objets partageant nom et taille sont groupés comme doublons
**Et** le volume récupérable est chiffré

**Étant donné** deux objets de même nom mais de tailles différentes (`IMG_0044.JPG`, 2016 et 2025)
**Quand** la détection s'exécute
**Alors** ils sont signalés comme collision de noms, jamais comme doublons

**Étant donné** une collision de noms détectée
**Quand** je consulte le rapport
**Alors** la règle de désambiguïsation retenue est explicite et appliquée uniformément
**Et** aucune destination ne reçoit deux objets distincts

**Étant donné** un doublon présumé sur des objets volumineux
**Quand** je demande une confirmation par empreinte
**Alors** l'ETag est utilisé pour les objets déposés en une seule requête
**Et** les objets *multipart*, dont l'ETag n'est pas un MD5 comparable, sont signalés plutôt
que déclarés identiques à tort

### Story 2.4 : Produire le plan de réparation inspectable

En tant que Marceau,
je veux lire le plan complet avant qu'un seul octet ne bouge,
afin de contester ce qui me paraît faux tant que rien n'est irréversible.

**Exigences :** FR-3, FR-6

**Acceptance Criteria :**

**Étant donné** l'inventaire daté et dédoublonné
**Quand** je lance la génération du plan
**Alors** un plan listant chaque objet, sa destination et la raison de cette destination est produit
**Et** aucune écriture n'a lieu sur aucun bucket

**Étant donné** le plan produit
**Quand** je le consulte
**Alors** il indique le nombre d'objets à copier, à ignorer comme doublons, à mettre en quarantaine
**Et** le total d'objets du plan correspond au total inventorié, sans perte inexpliquée

**Étant donné** un objet dont la date est indéterminée
**Quand** le plan est généré
**Alors** sa destination est un emplacement de quarantaine dédié, distinct de l'arborescence par date

**Étant donné** la liste des albums partagés à conserver
**Quand** l'outil la lit
**Alors** elle provient de la configuration, pas du code
**Et** elle contient à ce jour `mariage/`

**Étant donné** un média appartenant à un album partagé désigné (`mariage/`)
**Quand** le plan est généré
**Alors** sa destination suit `albums/<nom>/`, sans éclatement par date ni duplication

**Étant donné** un plan déjà généré et inchangé
**Quand** je relance la génération
**Alors** le plan produit est identique

### Story 2.5 : Restituer l'état de l'archive à la demande

En tant que Marceau,
je veux consulter l'état de mon archive quand je veux,
afin de vérifier où j'en suis sans relire le code ni refaire un inventaire complet.

**Exigences :** FR-18

**Acceptance Criteria :**

**Étant donné** un inventaire disponible
**Quand** je demande l'état de l'archive
**Alors** volumétrie totale, répartition par année, doublons et fichiers en quarantaine sont affichés

**Étant donné** un affichage de l'état
**Quand** je le consulte
**Alors** les nombres sont lisibles en français, tailles et dates comprises

---

## Epic 3 : Exécuter le plan

Il n'existe plus qu'un seul endroit où vivent les photos : le bucket dédié, classé par date,
sans doublons.

### Story 3.1 : Copier l'archive vers le bucket dédié selon le plan

En tant que Marceau,
je veux que le plan validé soit exécuté vers le bucket dédié,
afin d'avoir enfin une archive unique et correctement classée.

**Exigences :** FR-1b, FR-5

**Acceptance Criteria :**

**Étant donné** un plan généré et une confirmation explicite de ma part
**Quand** l'exécution démarre
**Alors** chaque objet retenu est copié côté serveur vers sa destination
**Et** aucun octet ne transite par mon poste

**Étant donné** deux jeux d'identifiants configurés — lecture sur `marceau`, écriture sur le bucket dédié
**Quand** l'exécution démarre
**Alors** l'outil vérifie qu'il peut écrire dans le bucket dédié avant la première copie
**Et** il n'utilise jamais les identifiants du bucket source pour écrire

**Étant donné** l'exécution en cours
**Quand** un objet est copié
**Alors** l'existence et la taille de la copie sont vérifiées avant de passer au suivant

**Étant donné** que le bucket `marceau` reste l'unique exemplaire pendant l'opération
**Quand** l'exécution se déroule
**Alors** aucune suppression n'y est effectuée par l'outil
**Et** les doublons sont écartés en n'étant pas copiés, jamais en étant supprimés à la source

**Étant donné** que je n'ai pas confirmé
**Quand** je lance la commande
**Alors** rien n'est écrit et le plan est simplement affiché

**Étant donné** une exécution déjà menée à son terme
**Quand** je la relance
**Alors** aucune copie ni suppression supplémentaire n'a lieu

### Story 3.2 : Reprendre une réparation interrompue

En tant que Marceau,
je veux qu'une réparation coupée reprenne où elle s'est arrêtée,
afin de ne pas tout recommencer parce que mon poste s'est mis en veille.

**Exigences :** FR-7

**Acceptance Criteria :**

**Étant donné** une exécution interrompue par `Ctrl-C`, une coupure réseau ou une extinction
**Quand** je relance la commande
**Alors** elle reprend à partir des objets non traités
**Et** aucun objet déjà copié n'est recopié

**Étant donné** une reprise
**Quand** elle se termine
**Alors** le résultat final est identique à celui d'une exécution ininterrompue

### Story 3.3 : Rendre compte de la réparation

En tant que Marceau,
je veux un rapport de ce qui a été fait,
afin de vérifier que rien n'a disparu avant de supprimer quoi que ce soit.

**Exigences :** FR-8

**Acceptance Criteria :**

**Étant donné** une réparation terminée
**Quand** je consulte le rapport
**Alors** il indique les objets copiés, les doublons écartés, l'espace économisé et les
fichiers mis en quarantaine

**Étant donné** le rapport
**Quand** je compare au point de départ
**Alors** le compte des objets à l'arrivée, augmenté des doublons écartés, égale le compte inventorié
**Et** tout écart est signalé comme anomalie, pas comme un détail

**Étant donné** une réparation terminée et vérifiée
**Quand** je consulte le rapport
**Alors** il me rappelle que la suppression des anciens emplacements m'appartient et me
liste précisément lesquels

---

## Epic 4 : La boucle Takeout

Marceau peut archiver un nouvel export Takeout et vider Google Photos en confiance.

### Story 4.1 : Valider une archive Takeout avant traitement

En tant que Marceau,
je veux savoir si l'archive que je viens de télécharger est exploitable,
afin de ne pas lancer une passe de plusieurs heures sur un export incomplet.

**Exigences :** FR-9

**Acceptance Criteria :**

**Étant donné** un chemin vers un export Takeout extrait
**Quand** je lance la validation
**Alors** la présence du dossier `Google Photos` est vérifiée
**Et** le nombre de médias détectés est affiché

**Étant donné** des médias dépourvus de leur fichier JSON d'accompagnement
**Quand** la validation s'exécute
**Alors** leur nombre est signalé explicitement

**Étant donné** un chemin invalide ou une archive non extraite
**Quand** je lance la validation
**Alors** un message en français explique ce qui manque et ce que je dois faire

### Story 4.2 : Dater et identifier chaque média de façon stable

En tant que Marceau,
je veux que chaque photo soit identifiée indépendamment de l'endroit où j'ai extrait l'archive,
afin qu'un second export ne considère pas mes 12 736 photos comme nouvelles.

**Exigences :** FR-10, FR-11

**Acceptance Criteria :**

**Étant donné** un média accompagné de son JSON Takeout
**Quand** la date est déterminée
**Alors** `photoTakenTime` est utilisé en priorité, avant le nom de fichier et avant l'EXIF

**Étant donné** le même média présent dans deux exports Takeout extraits dans des répertoires différents
**Quand** son identité est calculée
**Alors** elle est identique dans les deux cas
**Et** elle ne dépend d'aucun chemin absolu local

**Étant donné** deux médias distincts
**Quand** leurs identités sont calculées
**Alors** elles diffèrent

### Story 4.3 : Archiver uniquement les médias nouveaux

En tant que Marceau,
je veux que seules les photos absentes de l'archive soient envoyées,
afin de ne pas réuploader et repayer ce qui est déjà sauvegardé.

**Exigences :** FR-12, FR-13, FR-15

**Acceptance Criteria :**

**Étant donné** un Takeout dont certains médias sont déjà archivés
**Quand** je lance la passe d'archivage
**Alors** ces médias sont ignorés et comptés comme tels
**Et** seuls les médias absents sont envoyés

**Étant donné** un média à archiver
**Quand** sa destination est calculée
**Alors** elle suit exactement le schéma de chemins produit par l'epic 3

**Étant donné** une passe en cours
**Quand** je regarde la console
**Alors** les compteurs traités, ignorés, en erreur et le volume restant sont visibles

**Étant donné** une passe déjà exécutée sur le même Takeout
**Quand** je la relance
**Alors** aucun média n'est réenvoyé

### Story 4.4 : Reprendre une passe d'archivage interrompue

En tant que Marceau,
je veux qu'une passe coupée reprenne où elle en était,
afin qu'une soirée de travail ne soit pas perdue.

**Exigences :** FR-14

**Acceptance Criteria :**

**Étant donné** une passe interrompue
**Quand** je la relance
**Alors** elle reprend aux médias non traités
**Et** aucun média déjà envoyé n'est réenvoyé

### Story 4.5 : Attester que tout est bien sauvegardé avant que je supprime

En tant que Marceau,
je veux une attestation fichier par fichier avant de vider Google Photos,
afin de ne jamais détruire un original en me fiant à une copie que je n'ai pas vérifiée.

**Exigences :** FR-16, FR-17

**Acceptance Criteria :**

**Étant donné** un Takeout archivé
**Quand** je lance la vérification
**Alors** chaque média est comparé au bucket, présence et taille
**Et** le résultat est rendu fichier par fichier, pas seulement en total

**Étant donné** un média manquant ou de taille divergente
**Quand** la vérification s'exécute
**Alors** l'écart est listé sous une forme qui me dit quoi faire
**Et** aucune attestation n'est délivrée tant qu'un écart subsiste

**Étant donné** une vérification sans aucun écart
**Quand** elle se termine
**Alors** l'attestation est délivrée explicitement
**Et** elle indique le nombre de médias couverts et la date de la vérification

**Étant donné** l'attestation délivrée
**Quand** je la lis
**Alors** elle rappelle que la suppression dans Google Photos m'appartient et que l'outil
n'y touchera jamais

---

## Epic 5 : La marche à suivre

Marceau refait le cycle complet six mois plus tard sans rien demander à personne.

### Story 5.1 : Rédiger le runbook du cycle complet

En tant que Marceau,
je veux une procédure que je peux suivre sans mémoire préalable,
afin de ne pas devoir relire le code pour comprendre comment archiver mes photos.

**Exigences :** FR-19

**Acceptance Criteria :**

**Étant donné** le runbook
**Quand** je le suis étape par étape
**Alors** il couvre le cycle entier : demander l'export à Google Takeout, le récupérer,
le valider, l'archiver, vérifier, puis supprimer côté Google

**Étant donné** chaque étape
**Quand** je la lis
**Alors** la commande exacte est donnée, ainsi que ce que je dois observer avant de continuer

**Étant donné** l'étape de suppression dans Google Photos
**Quand** je l'atteins
**Alors** le runbook impose l'attestation de la story 4.5 comme condition préalable

**Étant donné** une passe qui échoue
**Quand** je cherche quoi faire
**Alors** le runbook traite les cas d'interruption et de reprise

### Story 5.2 : Réécrire le README et le QUICKSTART

En tant que Marceau,
je veux une documentation qui décrit l'outil réel,
afin de ne plus être induit en erreur par des commandes qui n'existent plus.

**Exigences :** FR-20

**Acceptance Criteria :**

**Étant donné** le `README.md` et le `QUICKSTART.md`
**Quand** ils sont réécrits
**Alors** plus aucune mention de `gpb auth login`, `gpb list albums` ni de la Google Photos Library API
**Et** les commandes documentées sont celles qui existent réellement

**Étant donné** la documentation réécrite
**Quand** je cherche pourquoi le projet n'utilise pas l'API Google
**Alors** la raison de l'abandon est consignée, avec sa date

**Étant donné** la documentation réécrite
**Quand** je la parcours
**Alors** elle est en français et renvoie au runbook pour la procédure complète
