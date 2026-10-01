---
baseline_commit: f7e6204
---

# Story 4.5 : Attester que tout est bien sauvegardé avant que je supprime

Status: done

## Story

En tant que Marceau,
je veux une attestation fichier par fichier avant de supprimer les zips et les photos dans Google Photos,
afin de ne jamais détruire un original en me fiant à une copie que je n'ai pas vérifiée.

**Exigences :** FR-16, FR-17.

## Contexte

- L'export du 6 août (`20260806T062636Z-1`, 4 parties, 2 407 médias) a été archivé pour de vrai le 2026-10-01 :
  315 dépôts vérifiés, 0 restant. Plan exécuté : celui enregistré pour l'export (`TakeoutPlanModel`).
- **Les zips de `backups/` sont l'unique exemplaire d'une partie des photos** (Marceau en a déjà supprimé de Google
  Photos). L'attestation est le seul feu vert pour les supprimer : elle doit être difficile à obtenir à tort.
- Modèle à suivre : l'attestation de la réparation (`src/inventory/repair-report.ts`,
  `src/commands/reparation-rapport.ts`, story 3.3) — calcul pur, inventaire dédié exigé postérieur à l'exécution et
  de moins de `MAX_INVENTORY_AGE_HOURS`, fichier exporté écrit **avant** l'affichage de l'attestation, raisons de
  refus listées. Réutiliser ce qui est générique (fraîcheur d'inventaire, écriture du fichier, format CSV) plutôt que
  le dupliquer ; ne pas forcer une abstraction commune si elle complique la lecture (KISS).
- Engagements pris en 4.1 pour cette story : exiger `--parties` confirmé, et refuser l'attestation en présence de
  fichiers non reconnus, de JSON orphelins ou ambigus, ou de médias sans métadonnées inexpliqués (une vidéo de Live
  Photo rattachée à son image compagnon est expliquée).

## Acceptance Criteria

1. **Commande.** `gpb takeout attester --export <id> --parties <n> [--dossier <chemin>] [--export-liste <fichier.csv>]`.
   Lecture seule partout : aucun appel d'écriture, aucun point d'accès en écriture construit. Code de sortie 0
   seulement si l'attestation est accordée. Refus clair (code 1, sans appel réseau) si analyse ou plan absents pour
   l'export, ou bucket dédié non configuré.
2. **Entrées revérifiées.**
   - Les zips distants de l'export (`backups/`, listés en lecture seule) sont exactement ceux de l'analyse (même
     nombre = `--parties`, mêmes noms, tailles, ETag). Sinon refus : l'attestation ne porterait pas sur les octets
     analysés.
   - Validation 4.1 rejouée sur les zips **locaux** vérifiés (lecture des répertoires centraux, sans téléchargement
     si les marqueurs correspondent — `ensureLocalZip`) : export exploitable, nombre de parties confirmé, **0** fichier
     non reconnu, **0** JSON orphelin, **0** JSON ambigu, **0** média sans métadonnées autre qu'une vidéo de Live Photo
     avec image compagnon. Chaque cas est une raison de refus listée (chemin dans le zip).
   - L'ensemble des médias de la validation rejouée est identique (partie, chemin, taille) à celui de l'analyse.
3. **Exécution terminée.** Toutes les lignes à déposer du plan (`linesToSend`) sont « faites » dans le journal
   (`isArchiveLineDone`) ; aucun verrou d'exécution posé. Sinon refus avec le nombre de lignes restantes et la
   commande de reprise.
4. **Inventaire du bucket dédié.** Exige un inventaire de `destinationBucket` terminé **après** la dernière écriture du
   journal pour ce plan et âgé de moins de `MAX_INVENTORY_AGE_HOURS` ; sinon refus avec la commande à lancer
   (`gpb inventory scan --bucket <dédié>`). Aucun listing implicite : c'est l'inventaire enregistré qui fait foi.
5. **Rapprochement fichier par fichier.** Pour **chaque** média de l'analyse (y compris doublons internes) :
   - destination attendue = `destination` de sa ligne de plan ; pour un doublon interne, celle de son représentant
     (`keptOf`) ;
   - **conforme** si l'inventaire contient cette clé avec la même taille ET une preuve d'identité : ETag MD5 simple égal
     au MD5 du média, ou (ligne `ignorer_deja_archive` à preuve multipart) ETag égal à l'`archivedEtag` enregistré ;
   - sinon **écart** typé : `manquant` (clé absente), `taille_differente`, `non_confirmable` (ETag multipart sans
     preuve enregistrée, ou absent), `sans_destination` (ligne sans destination) — chacun avec partie, chemin, clé
     attendue, attendu vs trouvé, et l'action à mener (relancer l'archivage, réinventorier, examiner).
   - Un média en `quarantaine/` conforme est couvert mais signalé « sans date fiable, rangé en quarantaine ».
6. **Attestation.** Accordée seulement si les AC 2 à 5 ne laissent aucune raison de refus. Elle affiche :
   - la **liste exacte des zips** supprimables de `backups/` : clé, taille, ETag (ceux revérifiés en AC 2) ;
   - les décomptes : médias couverts, dont déposés par la passe, déjà archivés, doublons internes, en quarantaine ;
   - le rappel que ces suppressions (zips et photos dans Google Photos) appartiennent à Marceau et que l'outil n'y
     touchera jamais, et que l'attestation ne vaut que pour l'état des inventaires affiché ;
   - les dossiers locaux de zips (`data/takeout/<export>/`) qu'il peut supprimer aussi, présentés comme facultatifs.
7. **Liste des médias couverts.** `--export-liste <fichier.csv>` (seulement si l'attestation est accordée, écrit avant
   l'affichage de l'attestation, refus d'écraser un fichier existant) : une ligne par média de l'export, colonnes
   `nom`, `date_prise_de_vue`, `source_date`, `album` (vide pour un dossier d'année), `dossier_takeout`, `cle_archive`,
   `taille`, `md5`. Format et échappement CSV identiques aux exports existants (fonction partagée).
8. **Restitution.** Bilan lisible en français : verdict, raisons de refus (toutes, pas seulement la première), écarts
   regroupés par type avec au plus 20 exemples affichés et le total (la liste complète dans le CSV d'écarts écrit avec
   `--export-ecarts <fichier.csv>`, facultatif). Ligne de journal `getLogger().info` récapitulative.
9. **Garanties.** Aucune nouvelle importation `@aws-sdk/*` hors du point d'accès et des clients en lecture existants
   (analyse statique inchangée ou étendue explicitement en lecture seule) ; aucune suppression nulle part.

## Tasks / Subtasks

- [x] `src/takeout/takeout-attestation.ts` : calcul pur (entrées : analyse, plan, états du journal, fin d'exécution,
  inventaire dédié + date, rapport de validation rejoué, zips distants) → rapport `{ rows, gaps, reasons, attestation }`.
- [x] `src/commands/takeout-attest.ts` (enregistré dans `takeout.ts` comme `planifier`/`archiver`) : collecte des entrées,
  écriture des CSV, affichage.
- [x] Tests unitaires du calcul : cas conforme complet ; chaque type d'écart ; chaque raison de refus (zips changés,
  partie manquante, non reconnu, orphelin, ambigu, sans métadonnées, exécution incomplète, verrou, inventaire
  antérieur à l'exécution, inventaire trop vieux) ; doublon interne couvert via représentant ; Live Photo expliquée ;
  quarantaine signalée.
- [x] Tests de commande : refus sans analyse/plan ; attestation accordée → CSV écrit puis affichage, code 0 ; refus →
  aucun CSV, code 1 ; fichier existant non écrasé.
- [x] Contre-épreuves : neutraliser (a) le contrôle de taille, (b) l'exigence d'inventaire postérieur, (c) le refus des
  JSON orphelins → tests en échec, puis restaurer (`cmp`).

## Dev Notes

### Règles impératives

- Ne **jamais** toucher `data/app.db` ni un bucket réel. Tests sur SQLite temporaires, faux clients. CLI (même
  `--help`) dans une copie du projet sous un dossier temporaire, sans `.env` ni `data/`. sha256 de `data/app.db` avant
  et après, noté.
- Aucune migration modifiée ; en ajouter une seulement si indispensable (normalement inutile : tout est déjà stocké).
- Lecture seule : ne pas construire `S3ArchiveWriter` dans cette commande.
- Français partout. Aucun commit.
- La date de fin d'exécution : la plus récente `updated_at` des lignes du journal du plan (exposer une méthode de
  lecture dans `RepairExecutionModel` si elle n'existe pas ; vérifier ce que fait déjà la 3.3 et le réutiliser).

### Fichiers à lire (parties utiles seulement)

`src/inventory/repair-report.ts`, `src/commands/reparation-rapport.ts` (modèle) ; `src/takeout/archive-plan.ts`,
`src/takeout/archive-execution.ts` (`linesToSend`, `isArchiveLineDone`) ; `src/takeout/takeout-validation.ts` ;
`src/database/takeout-analysis-model.ts`, `src/database/takeout-plan-model.ts`,
`src/database/repair-execution-model.ts` ; `src/commands/takeout-archive.ts` (collecte des zips, `buildMediaReader`) ;
`src/commands/takeout.ts`.

### Vérifications attendues

`npx tsc --noEmit`, `npm test`, `npm run lint` (0 erreur), `npm run build` : sorties réelles dans le Dev Agent Record.

## Dev Agent Record

### Agent Model Used

claude-sonnet-5-5 (Sonnet 5.5)

### Debug Log References

- `data/app.db` : sha256 `20b20900bd73fb3c0590950c4603538c9cc14eeff61f1f200ada365d70a5a248` avant et après (identique). Aucune
  exécution de la CLI dans le projet : `--help` et l'appel sans argument ont tourné dans une copie temporaire (sans `.env` ni `data/`), supprimée ensuite.
- `npx tsc --noEmit` : « TypeScript: No errors found ». `npm test` : 34 suites, 801 tests, tous verts (dont 20 + 8 nouveaux).
  `eslint 'src/**/*.ts'` (binaire local v8.57.1) : 0 erreur, 24 avertissements, identique à la base de départ (`npm run lint` via le proxy RTK
  appelle un autre eslint v9 sans `eslint.config.js` : défaut d'environnement préexistant). `npm run build` : OK.
- Contre-épreuves (copie de sauvegarde, modification, tests en échec, restauration, `cmp` identique à chaque fois) :
  (a) contrôle de taille retiré → 2 tests en échec (`taille_differente`, refus de la commande) ;
  (b) exigence d'inventaire postérieur neutralisée → 3 en échec (calcul, cas sans journal, commande) ;
  (c) refus des JSON orphelins neutralisé → 1 en échec (raisons de validation). Après restauration : 28/28 verts.

### Completion Notes List

- Calcul pur `src/takeout/takeout-attestation.ts` (`buildAttestation`, `coveredMediaCsv`, `gapsCsv`) ; commande `gpb takeout attester`
  (`src/commands/takeout-attest.ts`, enregistrée dans `takeout.ts`). Lecture seule : ni `S3ArchiveWriter`, ni `createS3Client`, aucun import `@aws-sdk/*`.
- Raisons de refus (toutes listées) : zips distants différents de l'analyse (nombre = `--parties`, noms, tailles, ETag) ; validation 4.1 rejouée sur les
  zips locaux (non exploitable, parties non confirmées, fichier non reconnu, JSON orphelin, JSON ambigu, média sans métadonnées hors Live Photo avec image
  compagnon, ensemble de médias différent de l'analyse) ; plan périmé/altéré (`storedArchivePlanProblems` réutilisé, destinations « déjà archivées au plan »
  tirées des lignes) ; exécution incomplète (avec commande de reprise) ou verrou ; inventaire absent, non postérieur à la dernière écriture du journal, trop vieux
  ou dans le futur ; écarts de rapprochement.
- Rapprochement par clé exacte : taille égale, puis ETag MD5 simple = MD5 du média, ou (ligne déjà archivée) ETag = `archivedEtag` enregistré. Doublon interne couvert
  par la destination de son représentant (`keptOf`), qui porte aussi la preuve multipart.
- Réutilisations (DRY) : `csvDocument`, `MAX_INVENTORY_AGE_HOURS`, `storedArchivePlanProblems`, `isArchiveLineDone`/`linesToSend`, `RepairExecutionModel.lastUpdate`.
  Extractions : `inventoryAgeReason` + `ageHours` (repair-report), `writeNewFile` (file-utils, ex-fonction privée de `reparation-rapport`), `ensureLocalZips` /
  `localExportGroup` / `localZipsDirectory` (takeout.ts, utilisés par `analyser`, `archiver` et `attester`), constantes `ORPHAN_JSON_REASON`/`AMBIGUOUS_JSON_REASON`.
- Écarts à la story : (1) un cinquième type d'écart `contenu_different` (MD5 simple différent à taille égale, ou ETag multipart différent de la preuve) : le ranger en
  `non_confirmable` aurait masqué qu'il s'agit d'un autre contenu ; (2) l'export est résolu depuis la base locale (identifiant complet ou horodatage seul), ce qui
  permet de refuser sans réseau si analyse ou plan manquent ; (3) `ensureLocalZips` affiche désormais aussi le détail/la note de revérification pour `archiver`.
- Sans inventaire du bucket dédié, aucun rapprochement n'est tenté (tout paraîtrait « manquant ») : la raison de refus est l'inventaire.
- Fichiers de sortie : `--export-liste` seulement si accordée ; `--export-ecarts` à la demande ; refus d'écraser et de viser le même fichier contrôlé avant tout réseau, puis
  écriture exclusive (`wx`) avant l'affichage.

### File List

- src/takeout/takeout-attestation.ts (nouveau)
- src/commands/takeout-attest.ts (nouveau)
- tests/takeout/takeout-attestation.test.ts (nouveau)
- tests/commands/takeout-attest.test.ts (nouveau)
- src/commands/takeout.ts (enregistrement, `ensureLocalZips`, `localExportGroup`, `localZipsDirectory`)
- src/commands/takeout-archive.ts (utilise `ensureLocalZips`)
- src/commands/reparation-rapport.ts (utilise `writeNewFile`)
- src/utils/file-utils.ts (`writeNewFile`)
- src/inventory/repair-report.ts (`inventoryAgeReason`, `ageHours` exportés)
- src/takeout/takeout-validation.ts (constantes de raisons JSON)
- src/database/takeout-analysis-model.ts (`exportIds`)

### Change Log

- 2026-10-01 : implémentation de la story 4.5 (commande `gpb takeout attester`), passage en review.

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` (Opus) : APPROUVER, aucun BLOQUANT. Neuf scénarios d'attestation à tort écrits et éprouvés par le relecteur (casse de clé, ETag multipart, ETag de zip changé, zip homonyme sous un autre préfixe, plan altéré, journal vers une autre destination, média sans métadonnées, inventaire égal à celui du plan avec dépôts restants) : tous refusés ; Live Photo expliquée accordée comme prévu.
- Choix du développeur arbitrés et retenus : écart `contenu_different` ; `storedArchivePlanProblems` avec les destinations déclarées déjà archivées (le rapprochement sur l'inventaire frais fait foi) ; inventaire « ≥ » quand rien n'était à déposer.
- Corrigé par l'orchestrateur après approbation : zip sans ETag (analysé ou distant) désormais refusé au lieu d'être comparé sur son seul nom et sa taille (test ajouté) ; l'écran prévient qu'une fois le dossier local des zips supprimé, une nouvelle attestation retéléchargerait tout l'export ; limite multipart documentée dans le code.
- Non traité, assumé : un média déposé par la passe au-delà de 200 Mio resterait « non confirmable » et bloquerait l'attestation (refus, jamais une attestation à tort ; 0 cas dans l'export du 6 août) ; JSON ambigu listé deux fois dans les raisons (cosmétique) ; libellé « déposés par la passe » inclut les lignes trouvées déjà présentes.
- Vérifications après corrections : tsc 0, `npm test` 0 (34 suites, 802 tests), eslint 0 erreur (24 avertissements préexistants), build 0. `data/app.db` inchangé (sha256 `20b20900…`) ; aucune écriture S3.
