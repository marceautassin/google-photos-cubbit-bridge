# Runbook : archiver un export Google Takeout

Ce document décrit le cycle complet, de la demande d'export à la suppression des originaux. Il suppose que vous avez
tout oublié. Chaque étape donne la commande à copier, puis ce que vous devez voir avant de passer à la suivante.

Principes de l'outil à garder en tête :

- Un seul endroit écrit dans le bucket dédié : `gpb takeout archiver --confirmer …` (et `gpb reparation executer`,
  réservée à l'ancienne archive).
- **L'outil ne supprime jamais rien**, ni dans un bucket, ni dans Google Photos. Les suppressions sont les vôtres
  (étape 9).
- Toutes les commandes `gpb` se lancent **depuis le dossier du projet** : c'est là que se trouvent `.env`, `config/` et
  `data/app.db`.
- `<export>` désigne l'horodatage de l'export, par exemple `20260806T062636Z`. Les zips s'appellent
  `takeout-20260806T062636Z-1-001.zip`, `-002.zip`, etc. L'horodatage seul suffit dans les options `--export`.
- `<id>` désigne l'identifiant complet de l'export, par exemple `20260806T062636Z-1`. C'est le nom du dossier local
  des zips : `data/takeout/<id>/`.
- `<dédié>` désigne le nom du bucket dédié : la valeur de `CUBBIT_DESTINATION_BUCKET`, ou `repair.destinationBucket` de
  `config/config.json` s'il la surcharge.
- `<n>` désigne le nombre de parties de l'export, noté à l'étape 1.

Exemple réel suivi dans ce document : export `20260806T062636Z-1`, 4 parties, 2 407 médias, 315 déposés, attestation
accordée le 2026-10-02.

## Table des matières

0. Prérequis et installation
1. Demander l'export à Google Takeout
2. Déposer les zips dans `backups/`
3. Valider l'export
4. Inventorier le bucket dédié
5. Analyser l'export
6. Planifier l'archivage
7. Archiver (simulation, puis réel)
8. Réinventorier et attester
9. Supprimer (vous seul)
10. Interruption et reprise
11. Annexe : réparation de l'archive historique

---

## 0. Prérequis et installation

**Prérequis :** Node 24 (le projet exige au minimum Node 22.16, voir `package.json`), npm, un bucket Cubbit dédié et
ses identifiants S3.

À faire une fois, depuis le dossier du projet :

```bash
npm ci
npm run build
npm link
```

`npm link` crée la commande `gpb`. Sans lien, remplacez `gpb` par `node dist/index.js` (par exemple
`node dist/index.js takeout valider`). **Après toute mise à jour du code, relancez `npm run build`** : `gpb` exécute le
dossier `dist/`, pas les sources.

Vérifier : `gpb --version` affiche `1.0.0`, et `gpb --help` liste les commandes.

**Fichier `.env`** à la racine du projet (modèle : `config/.env.example`). Noms des variables, jamais de valeurs ici :

| Variable | Rôle |
|---|---|
| `CUBBIT_ENDPOINT` | URL S3 de Cubbit |
| `CUBBIT_ACCESS_KEY_ID` | Clé d'accès S3 |
| `CUBBIT_SECRET_ACCESS_KEY` | Clé secrète S3 |
| `CUBBIT_REGION` | Région (défaut `us-east-1`) |
| `CUBBIT_BUCKET` | Bucket de la configuration (ancien bucket source, défaut `photos-backup`) |
| `CUBBIT_DESTINATION_BUCKET` | **Bucket dédié** : destination de l'archive et emplacement de `backups/` |
| `CUBBIT_DESTINATION_ACCESS_KEY_ID`, `CUBBIT_DESTINATION_SECRET_ACCESS_KEY` | Optionnelles, les deux ou aucune : paire d'identifiants propre au bucket dédié pour la copie de `gpb reparation executer` |
| `LOG_LEVEL`, `NODE_ENV`, `MAX_CONCURRENT_DOWNLOADS` | Réglages généraux, facultatifs |

Les albums conservés (`takeout.keptAlbums`) se règlent, si besoin, dans `config/config.json` (voir
`config/config.example.json`). Défaut : `Baptême Raphaëlle` et `tenerife 2026`.

Où vit quoi (tout est local, jamais versionné) :

- `data/app.db` : base SQLite (inventaire, analyses, plans, journal d'archivage). **Ne la supprimez pas** : elle porte
  l'état de l'archivage.
- `data/takeout/<id>/` : copie locale des zips.
- `logs/` : journaux.

---

## 1. Demander l'export à Google Takeout

1. Ouvrez Google Takeout (`takeout.google.com`).
2. Désélectionnez tout, puis cochez **Google Photos** seul.
3. Laissez coché « Tous les albums photo inclus ».
4. Format de fichier : **.zip**.
5. Choisissez la taille de partie : plus elle est grande, moins il y a de parties à gérer.
6. Lancez l'export, puis téléchargez les zips quand Google les annonce prêts.
7. **Notez le nombre de parties** annoncé par Google. Il sert d'argument `--parties` à trois commandes, et c'est la seule
   façon de détecter une dernière partie manquante : rien dans les zips ne dit combien il y en a.

Ce que vous devez avoir : N fichiers `takeout-<horodatage>-<n>-001.zip` à `-00N.zip`, et le nombre N écrit quelque
part.

---

## 2. Déposer les zips dans `backups/`

Déposez les zips dans le dossier `backups/` du bucket dédié, avec le client S3 de votre choix (Cubbit web, `aws s3 cp`,
rclone…). Ne renommez pas les fichiers : l'outil reconnaît `takeout-<horodatage>-<n>-<nnn>.zip`.

Ce que vous devez voir : les N zips listés sous `backups/` dans le bucket dédié.

**Attention aux envois multipart interrompus.** Un gros envoi coupé en cours laisse des **parties facturées mais
invisibles** dans le bucket (elles n'apparaissent pas dans la liste des objets). Cubbit n'offre pas de règle de cycle de
vie `AbortIncompleteMultipartUpload` pour les nettoyer, et l'outil ne supprime rien. Pour les lister et les purger, avec le client AWS CLI :

```bash
aws s3api list-multipart-uploads --bucket <dédié> --endpoint-url <CUBBIT_ENDPOINT>
aws s3api abort-multipart-upload --bucket <dédié> --key <clé> --upload-id <upload-id> --endpoint-url <CUBBIT_ENDPOINT>
```

La première commande liste les dépôts inachevés (clé, `UploadId`, date d'initiation `Initiated`), la seconde en abandonne
un et libère ses parties. Ces commandes sont de l'API S3 standard : elles ne font pas partie de `gpb`.

- **Clés d'accès :** fournissez-les à l'AWS CLI par un profil (`--profile <nom>`) ou par les variables d'environnement
  `AWS_ACCESS_KEY_ID` et `AWS_SECRET_ACCESS_KEY`, avec toujours `--endpoint-url`. N'écrivez aucune valeur dans un fichier
  du dépôt ni dans ce document.
- **Purgez seulement quand rien ne tourne** : aucun envoi de zip en cours, aucune passe `gpb` en cours. Sinon vous
  abandonneriez un dépôt vivant.
- **N'abandonnez que les dépôts dont `Initiated` est antérieure à la fin de la dernière passe terminée** (envoi de zip ou
  `gpb`). Un dépôt plus récent peut appartenir à un envoi légitime.

---

## 3. Valider l'export

```bash
gpb takeout valider --export <export> --parties <n>
```

Lecture seule : l'outil ne lit que la table des matières de chaque zip.

Ce que vous devez voir :

- Le titre `📦 Validation des exports Takeout (lecture seule, table des matières uniquement)`.
- Une ligne par partie, puis les dossiers (année ou album), le total de médias, les médias sans métadonnées, les vidéos
  de Live Photo et les fichiers non reconnus.
- Le verdict final : `Verdict : exploitable, nombre de parties confirmé (<n>). Rien n'a été écrit.` et `✅ exploitable`
  en tête de l'export.
- Code de sortie `0`.

Si vous voyez `❌ non exploitable`, **arrêtez-vous** : les raisons sont listées sous
le verdict (partie manquante, zip illisible, nombre de parties différent). Corrigez (étape 2) avant de continuer. Le
code de sortie est alors `1`.

Sans `--parties`, le verdict reste `exploitable` (code `0`) mais indique `nombre de parties non confirmé (--parties)` :
relancez avec `--parties <n>` avant de continuer. Avec `--parties` et un écart de nombre, le verdict est
`non exploitable` (code `1`).

Sans `--export`, tous les exports de `backups/` sont validés ; `--parties` exige alors `--export`. L'option
`--zip <chemins...>` valide des zips locaux au lieu de `backups/`.

---

## 4. Inventorier le bucket dédié

```bash
gpb inventory scan --bucket <dédié>
```

L'analyse a besoin de savoir ce qui est déjà archivé : elle s'appuie sur cet inventaire local. **Sans `--bucket`, la
commande inventorie le bucket de la configuration (`CUBBIT_BUCKET`), pas le bucket dédié.**

Ce que vous devez voir : la liste des objets comptés par emplacement, sans message d'erreur. Une commande ultérieure
sans inventaire répondrait `aucun inventaire local du bucket dédié « <dédié> »`.

---

## 5. Analyser l'export

```bash
gpb takeout analyser --export <export> --parties <n>
```

Options utiles : `--sortie analyse.csv` (analyse détaillée média par média, `.csv` et/ou `.json`),
`--dossier <chemin>` (dossier local des zips), `--fuseau <iana>` (fuseau de la date de prise de vue, défaut
`Europe/Paris`).

L'outil télécharge les zips dans `data/takeout/<id>/` (`<id>`, par exemple
`data/takeout/20260806T062636Z-1/`), vérifie leur intégrité, puis identifie et date chaque média. Prévoyez de la place
disque pour tous les zips.

Ce que vous devez voir :

- `🔎 Analyse d'un export Takeout (lecture seule côté S3)`.
- Une ligne par zip : `téléchargé` (ou `déjà présent et vérifié, réutilisé`), avec sa vérification.
- Une progression par paliers de 10 %.
- Un bilan `═══ Analyse de l'export <id>` : nombre de médias, dates par source, dates suspectes ou indéterminées,
  doublons internes, et le bloc `Déjà archivé` avec la ligne `À envoyer`.
- La dernière ligne : `Analyse enregistrée en base (<N> médias). Rien n'a été écrit dans aucun bucket.`

Si le téléchargement s'interrompt, relancez la même commande : voir la section 10.

---

## 6. Planifier l'archivage

```bash
gpb takeout planifier --export <export> --sortie plan.csv
```

`--sortie plan.csv` écrit le plan ligne à ligne ; ouvrez-le et relisez-le avant de continuer. Aucune écriture dans un
bucket.

Ce que vous devez voir :

- `Empreinte du plan : <empreinte>` : **notez-la**, elle sert à l'étape 7.
- Le décompte par action : `À envoyer`, `Déjà archivés (ignorés)`, `Doublons internes (ignorés)`,
  `À reclasser (actuellement en quarantaine)`, `En quarantaine (date indéterminée)`, puis `Volume à envoyer` et
  `À déposer (envois + reclassements + quarantaine)`.
- `✅ Invariants : OK`
- `✅ Plan exécutable : oui`
- Code de sortie `0`.

Si vous voyez `❌ Invariants : KO` ou `❌ Plan exécutable : non`, ou un refus (`❌ aucune analyse valide…`,
`❌ inventaire du bucket dédié … antérieur à celui utilisé par l'analyse`), le code de sortie est `1` : suivez la
commande indiquée dans le message (relancer l'analyse ou l'inventaire), puis replanifiez. Ne passez pas à l'étape 7.

Les médias dont la date est indéterminée partent dans `quarantaine/` : ils sont archivés, à dater à la main plus tard.

---

## 7. Archiver

D'abord en simulation (c'est le défaut, rien n'est envoyé) :

```bash
gpb takeout archiver --export <export>
```

Ce que vous devez voir : `Plan : <empreinte>`, `À déposer (envois + reclassements + quarantaine)`,
`Restant d'après le journal`, puis `🔎 Simulation : rien n'a été envoyé.` et la commande à lancer pour exécuter.
Code de sortie `0`.

Puis en réel, avec l'empreinte du plan (complète, ou ses 12 premiers caractères au moins) :

```bash
gpb takeout archiver --export <export> --confirmer <empreinte>
```

L'outil prépare les zips locaux (téléchargement et revérification si besoin), puis envoie chaque média depuis son zip,
jamais en écrasant un objet existant, et vérifie chaque dépôt.

Ce que vous devez voir :

- `▶️  Exécution confirmée du plan <empreinte>`.
- Une ligne de progression qui se met à jour : `Envoyés … , reprises vérifiées …, déjà présents …, restants …`.
- Le bilan `📋 Bilan :` avec `Restants : 0`.
- `✅ Terminé. Aucune suppression, nulle part.` et le code de sortie `0`.

Si le bilan se termine par `⏸️  Interrompu` ou `❌ Arrêt de sûreté`, code de sortie `1` : lisez la section 10.

Si `⚠️ … dépôt(s) multipart inachevé(s)` apparaît après le bilan, des parties facturées traînent sur le bucket dédié.
L'outil ne peut pas les purger (voir la purge manuelle à l'étape 2). Cela ne concerne que les médias de plus de
200 Mio ; en dessous, le dépôt se fait en une seule requête et ne laisse rien derrière lui.

---

## 8. Réinventorier et attester

L'attestation compare l'export au contenu réel du bucket : elle exige un inventaire **refait après l'archivage** et de
moins de 24 h.

```bash
gpb inventory scan --bucket <dédié>
gpb takeout attester --export <export> --parties <n> --export-liste data/medias-couverts-<export>.csv
```

`--export-liste` écrit la liste des médias couverts, seulement si l'attestation est accordée. Un fichier existant n'est
jamais écrasé : choisissez un nouveau nom si le premier existe. L'option `--export-ecarts <fichier.csv>` écrit la liste
complète des écarts en cas de refus.

L'outil revérifie les zips locaux, le journal d'archivage et l'inventaire, média par média.

Ce que vous devez voir si tout va bien :

- `Médias couverts : <N> sur <N> rapprochés`.
- `✅ Export attesté : chaque média de l'export est présent et conforme dans le bucket dédié.`
- La répartition : déposés, déjà archivés, doublons internes (par exemple pour l'export réel : 2 407 médias couverts,
  dont 315 déposés).
- `Zips de backups/ supprimables (ceux revérifiés, clé exacte)` : la liste exacte à supprimer.
- `📄 Liste des médias couverts (…) : data/medias-couverts-<export>.csv`.
- Code de sortie `0`.

**Si vous voyez `🛑 NE SUPPRIMEZ RIEN. L'export n'est pas attesté :`**, code de sortie `1`. Les raisons sont listées
dessous (inventaire trop ancien ou absent, zip différent de celui analysé, médias non couverts, écart de taille ou
d'ETag…). Chaque écart indique `à faire`. Les cas fréquents :

| Raison | Action |
|---|---|
| Inventaire trop ancien ou absent | `gpb inventory scan --bucket <dédié>` puis relancer l'attestation |
| Média `manquant` | Réinventorier ; si l'objet reste absent, `gpb takeout planifier --export <export>` puis relancer l'archivage |
| `taille_differente`, `contenu_different` | Examiner : l'objet du bucket n'est pas celui de l'export. Ne rien supprimer avant de comprendre |
| `non_confirmable` | Réinventorier ; si l'ETag reste non confirmable, examiner à la main avant toute suppression |
| `sans_destination` | Régénérer le plan (`gpb takeout planifier`) |
| Zip différent de celui analysé | Relancer `gpb takeout analyser` |

---

## 9. Supprimer (vous seul)

> **Ne rien supprimer sans attestation accordée (étape 8).** Pas de `✅ Export attesté`, pas de suppression.

Faites les suppressions **dans les 24 h** qui suivent l'attestation : elle ne vaut que pour l'état des inventaires du
moment. **Au-delà de 24 h, refaites l'étape 8** (inventaire puis attestation) avant toute suppression. L'ordre
ci-dessous est volontaire.

1. **Les zips de `backups/`** : exactement ceux listés par l'attestation (clé exacte), avec votre client S3.
2. **Versioning du bucket dédié.** Vérifiez s'il est actif :

   ```bash
   aws s3api get-bucket-versioning --bucket <dédié> --endpoint-url <CUBBIT_ENDPOINT>
   ```

   `"Status": "Enabled"` : supprimer un objet ne libère pas l'espace, il ne fait que le masquer. Supprimez alors aussi
   les anciennes versions **des clés exactes listées par l'attestation**, jamais par préfixe large (un préfixe large
   toucherait l'archive).
3. **Google Photos.** L'interface ne permet pas de supprimer par liste de fichiers. L'export ne couvre pas ce qui a été
   **ajouté à la bibliothèque après la date de l'export**, quelle que soit sa date de prise de vue (scan ancien, photo
   partagée enregistrée). Le tri par période est un tri sur la date de **prise de vue** : il ne fait pas la différence.
   - **La suppression par période n'est sûre que si rien n'a été ajouté à la bibliothèque depuis l'export.**
   - Sinon, deux voies : **refaire un export juste avant de supprimer** (puis reprendre le cycle), ou **supprimer
     seulement d'après la liste** `data/medias-couverts-<export>.csv`.
   - Filet : la corbeille de Google Photos conserve les éléments **60 jours**. Une erreur se rattrape pendant ce délai.
4. **Le dossier local `data/takeout/<id>/`**, en dernier. Une fois supprimé, une nouvelle attestation devrait
   retélécharger tout l'export.

---

## 10. Interruption et reprise

`gpb takeout archiver` (et `gpb reparation executer`) se relancent avec **la même commande**. Rien n'est renvoyé
inutilement. Le tableau, le verrou et `--lever-verrou` ne valent que pour elles.

`gpb takeout analyser` n'a ni verrou ni arrêt propre : un Ctrl-C le tue au premier appui. Relancez la même commande : les
zips déjà complets sont revérifiés sans retéléchargement, et le fichier `.partiel` d'un zip interrompu est remplacé.

| Situation | Ce qui se passe | Que faire |
|---|---|---|
| **Ctrl-C** (une fois) | `⏸️  Arrêt demandé : fin du média en cours … puis arrêt.` L'outil termine le média en cours, puis s'arrête (code `1`, `⏸️  Interrompu`). | Relancer la même commande |
| **Ctrl-C une seconde fois** | Sortie immédiate (code `130`), verrou libéré. La ligne en cours reste à refaire. | Relancer la même commande : elle est reprise par une vérification, sans doublon |
| **Terminal fermé** | Traité comme un Ctrl-C : arrêt propre, verrou libéré. | Relancer |
| **Passe détachée** | `nohup` est neutralisé par l'outil. Utilisez `tmux` ou `screen`. | `tmux new -s archive` puis la commande dedans |
| **Coupure de courant, plantage** | Le verrou d'exécution reste posé. Une relance simple est refusée : `❌ Exécution refusée, rien n'a été envoyé — verrou d'exécution périmé (plan …, processus … sur …) : cette exécution s'est arrêtée sans le libérer. Vérifiez qu'aucune exécution ne tourne, puis relancez avec --lever-verrou (…)`. Si le processus semble encore actif, le message commence par `une exécution est déjà en cours ou son verrou n'a pas été libéré`. | Relancer avec `--lever-verrou` (ci-dessous) |
| **Zips en cours de téléchargement** (pendant `archiver`) | Les zips déjà complets sont revérifiés, pas retéléchargés. | Relancer `archiver` |

**Lever le verrou :**

```bash
gpb takeout archiver --export <export> --confirmer <empreinte> --lever-verrou
```

- **Immédiat** si le processus qui tenait le verrou n'existe plus sur ce poste (coupure, extinction).
- **Sinon refusé** tant que sa dernière activité date de moins de **60 minutes**. Si vous êtes sûr qu'aucune autre passe
  ne tourne, attendez que les 60 minutes soient passées.
- L'outil affiche `🔓 Verrou levé (…)` avec le plan, le processus et les horodatages.

Le verrou est **global** : il est partagé avec `gpb reparation executer`. Une seule passe d'écriture à la fois.

**Arrêt de sûreté** (`❌ Arrêt de sûreté sur <partie>:<chemin> → <destination>`, code `1`) : un objet **différent** existe
déjà à la destination prévue. L'outil ne l'écrase jamais. Lisez la raison affichée dessous, examinez l'objet à la
main, ne supprimez et n'écrasez rien à l'aveugle. Puis relancez la même commande, ou régénérez le plan
(`gpb takeout planifier`) si le plan doit changer.

**Attestation refusée :** lisez les raisons (étape 8, tableau), appliquez l'action indiquée pour chaque écart, puis
relancez l'attestation.

---

## 11. Annexe : réparation de l'archive historique

L'archive précédente (anciens emplacements `backup_google_photos/photos/` et `2_Personnel/Photos/google_photos/`) a été
réparée en 2026-09 avec `gpb inventory`, `gpb plan` et `gpb reparation` (epics 2 et 3). C'est terminé.

État restant : suppression manuelle, par Marceau, des anciens emplacements listés dans
`data/suppression-2026-09-16.csv`.
