# google-photos-cubbit-bridge

Outil en ligne de commande (TypeScript, usage personnel, exécution locale) qui archive les **exports Google Takeout** de
Google Photos vers un **bucket S3 Cubbit dédié**, classés par date. Il ne supprime jamais rien.

## Ce que fait l'outil

1. Vous déposez les zips d'un export Takeout dans `backups/` du bucket dédié.
2. L'outil les valide, les télécharge, identifie chaque média par son contenu (MD5), le date et détecte les doublons.
3. Il calcule un plan d'archivage que vous relisez, puis dépose les médias nouveaux dans l'archive.
4. Il atteste, média par média, que tout l'export est bien présent dans le bucket. **Vous** pouvez alors supprimer les
   zips et les photos de Google Photos.

Procédure complète, pas à pas : [`docs/RUNBOOK.md`](docs/RUNBOOK.md). Version courte :
[`QUICKSTART.md`](QUICKSTART.md).

## Garanties

- **Un seul point d'écriture** dans le bucket dédié : `gpb takeout archiver --confirmer <empreinte>` (plus
  `gpb reparation executer`, réservée à la réparation de l'ancienne archive, terminée).
- **Aucune suppression**, dans aucun bucket, par aucune commande. L'outil n'expose aucune suppression.
- **Jamais d'écrasement** : si un objet différent existe déjà à la destination, l'exécution s'arrête (arrêt de sûreté).
- **Simulation par défaut** : sans `--confirmer`, `gpb takeout archiver` n'envoie rien.
- **Attestation avant suppression** : `gpb takeout attester` ne donne son accord qu'après avoir revérifié les zips et
  rapproché chaque média de l'export avec le bucket dédié. Pas d'attestation, pas de suppression.
- **Relançable** : une passe interrompue (Ctrl-C, coupure) reprend là où elle s'est arrêtée, sans rien renvoyer.

## Structure de l'archive

Dans le bucket dédié :

| Emplacement | Contenu |
|---|---|
| `photos/AAAA/AAAA-MM/` | Médias classés par année et par mois de prise de vue |
| `albums/<nom>/` | Médias des albums conservés (réglage `takeout.keptAlbums`) |
| `quarantaine/` | Médias dont la date est indéterminée, à dater à la main |
| `backups/` | Zips des exports Takeout déposés par vous |

Format des exports Takeout et règles de datation : [`docs/TAKEOUT_STRUCTURE.md`](docs/TAKEOUT_STRUCTURE.md).

## Installation

Prérequis : Node 24 (minimum 22.16), npm.

```bash
npm ci
npm run build
npm link
```

`npm link` crée la commande `gpb`. Sans lien : `node dist/index.js <commande>`. Après une mise à jour du code, relancez
`npm run build`. Lancez toujours `gpb` depuis le dossier du projet.

## Configuration

Fichier `.env` à la racine du projet (modèle : `config/.env.example`). Ne le versionnez jamais.

| Variable | Rôle |
|---|---|
| `CUBBIT_ENDPOINT` | URL S3 de Cubbit |
| `CUBBIT_ACCESS_KEY_ID`, `CUBBIT_SECRET_ACCESS_KEY` | Identifiants S3 |
| `CUBBIT_REGION` | Région (défaut `us-east-1`) |
| `CUBBIT_BUCKET` | Bucket de la configuration (ancien bucket source) |
| `CUBBIT_DESTINATION_BUCKET` | **Bucket dédié** : archive et `backups/` |
| `CUBBIT_DESTINATION_ACCESS_KEY_ID`, `CUBBIT_DESTINATION_SECRET_ACCESS_KEY` | Optionnelles (les deux ou aucune) : identifiants propres au bucket dédié pour `gpb reparation executer` |
| `LOG_LEVEL`, `NODE_ENV`, `MAX_CONCURRENT_DOWNLOADS` | Réglages généraux, facultatifs |

`config/config.json` est facultatif (ignoré par git) : il surcharge les défauts. Modèle : `config/config.example.json`.
Réglage utile : `takeout.keptAlbums`, la liste des albums conservés dans `albums/`.

Données locales (jamais versionnées) : `data/app.db` (base SQLite, état de l'archivage, à ne pas supprimer),
`data/takeout/<export>/` (copie locale des zips), `logs/`.

## Commandes

`gpb --help` liste les commandes, `gpb <commande> --help` donne leurs options.

### Cycle Takeout

| Commande | Rôle |
|---|---|
| `gpb takeout valider` | Valide un export en ne lisant que la table des matières des zips. Lecture seule |
| `gpb takeout analyser` | Télécharge et vérifie les zips, identifie et date chaque média. Analyse enregistrée en base |
| `gpb takeout planifier` | Calcule le plan d'archivage, relisible en CSV. Aucune écriture dans un bucket |
| `gpb takeout archiver` | Simule le plan, ou le dépose avec `--confirmer <empreinte>`. Seule commande qui écrit des médias |
| `gpb takeout attester` | Attestation avant suppression des zips et des photos. Lecture seule |
| `gpb inventory scan` | Inventorie un bucket (`--bucket <nom>`) dans la base locale. Lecture seule côté S3 |

### Inventaire et ancienne archive

| Commande | Rôle |
|---|---|
| `gpb inventory show` | Affiche le dernier inventaire local, sans réseau |
| `gpb inventory dates` | Date chaque média de l'inventaire (nom, puis EXIF) |
| `gpb inventory doublons` | Doublons et collisions de noms, depuis l'inventaire local |
| `gpb plan generer`, `gpb plan afficher` | Plan de réparation de l'ancienne archive. Aucune écriture S3 |
| `gpb reparation executer` | Copie côté serveur du plan de réparation vers le bucket dédié (simulation par défaut) |
| `gpb reparation rapport` | Rapport de la réparation, depuis la base locale |
| `gpb etat` | État de l'archive depuis l'index local, sans réseau |

La réparation de l'ancienne archive est terminée (2026-09) ; ces commandes restent pour la consulter.

### Autres

| Commande | Rôle |
|---|---|
| `gpb setup` | Saisie interactive de la configuration Cubbit, écrite dans `config/config.json` |

## Pourquoi pas l'API Google Photos

Le 2025-03-31 (en vigueur au 2025-04-01), Google a retiré l'accès en lecture à toute la bibliothèque par la
Google Photos Library API : une application ne peut plus lire que les médias qu'elle a elle-même créés. L'approche
initiale du projet (authentification OAuth2, lecture de la bibliothèque) n'est donc plus possible. Le projet a pivoté
vers **Google Takeout**, qui fournit l'export complet sous forme de zips. Le code lié à cette API a été supprimé.

## Développement

```bash
npm test               # tests Jest
npm run lint           # ESLint
npx tsc --noEmit       # vérification des types (doit passer avant tout commit)
npm run format         # Prettier
npm run build          # compile vers dist/
```

Règles du projet : [`CLAUDE.md`](CLAUDE.md). Planification : `_bmad-output/`.
