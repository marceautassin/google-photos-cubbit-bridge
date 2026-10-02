---
baseline_commit: 0be5bfc
---

# Story 5.1 : Rédiger le runbook du cycle complet

Status: done

## Story

En tant que Marceau,
je veux une procédure que je peux suivre sans mémoire préalable,
afin de ne pas devoir relire le code pour comprendre comment archiver mes photos.

**Exigences :** FR-19.

## Acceptance Criteria

1. **Fichier** `docs/RUNBOOK.md`, en français, lisible six mois plus tard sans contexte.
2. **Cycle entier**, une section par étape, chacune avec la **commande exacte** (copiable) et **ce qu'il faut observer
   avant de continuer** (verdict, compteurs, code de sortie) :
   0. Prérequis et installation : Node 24, `npm ci`, `npm run build`, `npm link` (commande `gpb` ; sans lien,
      `node dist/index.js …`) ; toujours lancer depuis le dossier du projet (`.env`, `data/app.db`) ; noms des
      variables `.env` (jamais de valeurs) ; après une mise à jour du code, `npm run build`.
   1. Demander l'export à Google Takeout (Google Photos seul, format zip, taille de partie) et noter le nombre de parties.
   2. Déposer les zips dans `<bucket dédié>/backups/` (client S3 au choix) ; avertir qu'un envoi multipart interrompu
      laisse des parties facturées invisibles et comment les lister / purger (Cubbit n'a pas de règle de cycle de vie
      `AbortIncompleteMultipartUpload`).
   3. `gpb takeout valider` → export « exploitable », parties confirmées avec `--parties`.
   4. `gpb inventory scan --bucket <dédié>` (inventaire du bucket dédié, exigé par l'analyse).
   5. `gpb takeout analyser --export … --parties …` (télécharge et vérifie les zips dans `data/takeout/<export>/`).
   6. `gpb takeout planifier --export …` → plan relu (CSV), « exécutable », 0 invariant en échec.
   7. `gpb takeout archiver --export …` en simulation, puis avec `--confirmer <empreinte>`.
   8. `gpb inventory scan --bucket <dédié>` à nouveau, puis `gpb takeout attester --export … --parties …
      --export-liste data/medias-couverts-<export>.csv` → attestation accordée.
   9. Suppressions (par Marceau, jamais par l'outil) : les zips exacts listés par l'attestation, **dans les 24 h** ;
      **versioning** activé sur le bucket dédié → supprimer aussi les anciennes versions pour libérer l'espace ;
      Google Photos (pas de suppression par liste : par période si l'export couvrait toute la bibliothèque, sinon d'après
      le CSV ; ce qui est postérieur à l'export n'est pas couvert) ; dossier local `data/takeout/<export>/` en dernier.
3. **Condition impérative** : l'étape 9 commence par « ne rien supprimer sans attestation accordée (étape 8) », en
   évidence.
4. **Interruption et reprise** : section dédiée — Ctrl-C (fin du média en cours), terminal fermé (arrêt propre ; pour
   une passe détachée `tmux`/`screen`, `nohup` neutralisé), coupure ou plantage → relancer la même commande, avec
   `--lever-verrou` (immédiat si le processus n'existe plus sur ce poste, sinon après 60 min) ; arrêt de sûreté (objet
   différent en destination, à examiner, jamais écrasé) ; attestation refusée → lire les raisons, actions associées ;
   téléchargement des zips interrompu → relancer, reprise sans retéléchargement.
5. **Exactitude** : chaque commande et option citée existe (vérifiée par `--help` dans une copie du projet sous un
   dossier temporaire, sans `.env` ni `data/`), libellés d'écran cités tels que le code les affiche.
6. Annexe courte : la réparation de l'archive historique (epics 2-3, `gpb inventory`, `gpb plan`, `gpb reparation`)
   est faite (2026-09) ; état restant : suppression manuelle des anciens emplacements listés dans
   `data/suppression-2026-09-16.csv`. Ne pas détailler davantage.

## Dev Notes

- Lire les commandes réelles : `src/commands/*.ts` (options, libellés), pas l'ancien README.
- Exemple réel à citer (sans secret) : export `20260806T062636Z-1`, 4 parties, 2 407 médias, 315 déposés,
  attestation accordée le 2026-10-02.
- Ne jamais toucher `data/`, `.env` ni un bucket ; aucun commit.

## Dev Agent Record

### Agent Model Used

claude-sonnet-5-5 (Sonnet 5.5)

### Completion Notes List

- Toutes les commandes et options citées vérifiées par `--help` dans une copie temporaire du projet (`dist/`, `package.json`,
  lien vers `node_modules`, sans `.env` ni `data/`), copie supprimée ensuite : `takeout valider|analyser|planifier|archiver|attester`,
  `takeout import` (désactivée), `inventory scan|show|dates|doublons`, `plan`, `etat`, `reparation`, `history`, `setup`, `sync`,
  `resume`, `status`, `archive`. Libellés d'écran relus dans `src/commands/takeout*.ts` et `execution-control.ts`.
- Le message multipart d'`archiver` a depuis été aligné (purge manuelle, NFR-1) ; le runbook donne la purge par `aws s3api` (non testée contre Cubbit), avec garde-fous (rien en cours, `Initiated` antérieure à la dernière passe, clés par profil ou variables).
- Écart : `package.json` exige Node >= 22.16.0, la spec dit Node 24 ; le runbook mentionne les deux.
- Le nom de dossier local est l'identifiant complet de l'export (`data/takeout/20260806T062636Z-1/`), pas l'horodatage seul.
- `--help` d'une sous-commande applique les migrations SQLite : fait uniquement dans la copie temporaire.
- Aucun commit, aucun accès à `.env`, `data/` ni bucket.

- Corrections de revue : suppression Google Photos réécrite (période sûre seulement si rien d'ajouté, sinon nouvel export ou CSV, corbeille 60 jours), « Tous les albums photo inclus », refaire l'étape 8 après 24 h, versioning (`get-bucket-versioning`, clés exactes), `<id>` distinct de `<export>`, `--parties` absent ou en écart, verrou et Ctrl-C limités à `archiver`/`reparation executer`, libellé réel du refus de verrou, définition de `<dédié>`.
- `npx tsc --noEmit` : OK ; `npm test` : 34 suites, 802 tests passés.

### File List

- docs/RUNBOOK.md (créé)
- src/clients/types.ts (commentaires : purge manuelle, NFR-1)

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` (Opus) en 2 passes, commune aux stories 5.1 et 5.2 : APPROUVER. Commandes, options et libellés vérifiés par `--help` dans une copie temporaire.
- BLOQUANT corrigé : la suppression « par période » dans Google Photos trie sur la date de prise de vue, alors que ce qui n'est pas couvert est ce qui a été ajouté à la bibliothèque après l'export (scans anciens, photos partagées). Réécrit : par période seulement si rien n'a été ajouté depuis l'export, sinon nouvel export ou suppression d'après le CSV ; corbeille de 60 jours ; « Tous les albums » à l'étape 1. Le conseil donné oralement à Marceau le 2026-10-02 a été corrigé auprès de lui.
- IMPORTANTS corrigés : délai de 24 h (refaire l'étape 8 au-delà) ; détection du versioning et suppression limitée aux clés exactes ; purge multipart seulement quand rien ne tourne, dépôts antérieurs à la dernière passe, identifiants de l'AWS CLI.
- Corrigé dans le code par l'orchestrateur : le message de fin d'archivage et les commentaires renvoyaient à une règle de cycle de vie que Cubbit n'offre pas → purge manuelle (`takeout-archive.ts`, `archive-writer.ts`, `types.ts`, `NFR-1`).
- Mineurs de la seconde passe corrigés (`<upload-id>`, code de sortie de `--parties`, phrase du README).
- Vérifications : tsc 0, `npm test` 0 (34 suites, 802 tests), build 0.
