# Structure des exports Google Takeout (Google Photos)

Format constaté le 2026-09-16 sur des exports réels d'août 2026, par lecture de la table des matières des zips (sans
téléchargement). C'est ce format que reconnaît `gpb takeout valider` (story 4.1). L'ancien format documenté ici
auparavant (`Photos from YYYY` seul, `<média>.json`, dossier `Albums/`) ne correspond plus à ce que Google produit.

## Faits constatés sur les exports réels

Relevés dans la table des matières des zips de l'export du 6 août 2026 (4 812 entrées) :

- **Aucune troncature de nom** : noms de JSON jusqu'à 131 caractères, toujours `<nom complet du média>.supplemental-metadata.json`.
- **Aucun suffixe de doublon `(n)`**, aucun fichier `-modifié` / `-edited`.
- **452 noms en Unicode décomposé (NFD)**.
- **1 198 couples média/JSON répartis sur deux parties** ; les JSON sont surtout en tête d'export (partie 001 : 1 856,
  puis 439, 96, 11).
- **JSON sans extension de média** pour des noms UUID : `00000000-….jpg` a pour métadonnées
  `00000000-….supplemental-metadata.json`.
- **Vidéos de Live Photo** : 7 `IMG_00xx.MP4` sans JSON, chacune à côté de `IMG_00xx.JPG` et de
  `IMG_00xx.JPG.supplemental-metadata.json`.

Troncatures des noms et suffixes `(n)` : **non observés**, hérités de formats Takeout antérieurs. La troncature du nom du
média n'est pas gérée ; la troncature du seul suffixe (`.supplemental-metada.json`, nom du média intact) et les `(n)`
sont tolérés par précaution.

## Les zips

- Un export est livré en **plusieurs parties** : `takeout-<horodatage>-<n>-<nnn>.zip`, par exemple
  `takeout-20260806T062636Z-1-001.zip`, `-002.zip`… Chaque partie est un **zip complet et autonome** (pas un zip
  découpé en volumes), de quelques Go au plus.
- Un média et son fichier de métadonnées peuvent se trouver dans **deux parties différentes** : l'appariement se fait à
  l'échelle de l'export, pas de la partie.
- Entrées stockées ou compressées en deflate ; zip64 possible sur les grosses parties.
- Rien, dans les zips, ne dit combien de parties compte un export : une partie manquante au milieu de la numérotation
  est détectée, une dernière partie manquante ne l'est pas. Le nombre de parties annoncé par Google se passe à
  `--parties` ; sans lui, le verdict précise « nombre de parties non confirmé » (l'attestation de la story 4.5
  l'exigera). Avertissements : JSON sans média (partie possiblement manquante), dernière partie de taille pleine
  (au moins 90 % de la plus grosse, exports de plusieurs parties).

## Arborescence

```
Takeout/
└── Google␣Photos/                         ␣ = espace insécable (U+00A0)
    ├── Photos de␣2020/                    dossier d'année (export anglais : « Photos from 2020 »)
    │   ├── IMG_20200104_154653.jpg
    │   ├── IMG_20200104_154653.jpg.supplemental-metadata.json
    │   ├── IMG_0043.JPG                   Live Photo : image…
    │   ├── IMG_0043.JPG.supplemental-metadata.json
    │   ├── IMG_0043.MP4                   … et sa vidéo, sans JSON propre
    │   ├── 00000000-aaaa-bbbb-cccc-000000000000.jpg
    │   └── 00000000-aaaa-bbbb-cccc-000000000000.supplemental-metadata.json   JSON sans extension de média
    ├── Vacances à la mer/                 dossier d'album : espaces normaux, accents
    │   ├── métadonnées.json               métadonnées de l'album (export anglais : « metadata.json »)
    │   ├── IMG_20240601_101010.jpg
    │   └── IMG_20240601_101010.jpg.supplemental-metadata.json
    └── …
```

Pièges :

- **Espaces insécables** (U+00A0) dans `Google Photos` et dans `Photos de AAAA` ; les noms d'albums ont des espaces
  normaux. Les noms peuvent aussi arriver en Unicode décomposé (NFD). L'outil compare les noms après normalisation NFC
  et remplacement des espaces insécables par des espaces normaux.
- Un dossier est un **dossier d'année** s'il s'appelle exactement `Photos de AAAA` ou `Photos from AAAA` ; tout autre
  dossier est un **album**. Un même média peut apparaître dans un dossier d'année et dans un album (entrées distinctes,
  même contenu : la déduplication par contenu relève de la story 4.2).
- Les médias sont reconnus par leur extension, selon `sync.supportedFormats` (règle unique `isSupportedFormat`).
- Tout autre fichier (hors `Takeout/Google Photos/<dossier>/`, sous-dossier, extension inconnue, JSON sans média) est
  compté et listé comme **non reconnu**.

## Nom des métadonnées d'un média

| Média | JSON | Statut | Appariement |
|---|---|---|---|
| `IMG_20200104_154653.jpg` | `IMG_20200104_154653.jpg.supplemental-metadata.json` | observé (noms jusqu'à 131 caractères) | complet |
| `00000000-….jpg` | `00000000-….supplemental-metadata.json` | observé (noms UUID) | sans extension, dernier recours |
| `IMG_0043.MP4` à côté de `IMG_0043.JPG` apparié | aucun | observé (Live Photo) | aucun : vidéo de Live Photo, compagnon `IMG_0043.JPG` |
| `IMG_1234.jpg` | `IMG_1234.jpg.json` | ancien format | complet |
| `IMG_1.jpg` | `IMG_1.jpg.supplemental-metada.json` | non observé | complet (suffixe tronqué, nom intact) |
| `IMG_1234(1).jpg` | `IMG_1234.jpg.supplemental-metadata(1).json` | non observé | complet |
| `Screenshot_…_Samsung Internet_B.jpg` | `Screenshot_…_Samsung Intern.json` | non observé | **aucun** (troncature du nom non gérée) |

Règles (`src/takeout/takeout-layout.ts`, fonctions pures testées) :

1. **Nom complet** : le radical du JSON (sans `.json`, `(n)` final extrait) est égal au nom du média, ou commence par
   `<média>.` et est un début de `<média>.supplemental-metadata`, avec le même numéro de doublon. Appariement un pour
   un au sein d'un dossier, toutes parties confondues ; un JSON qui désigne plusieurs médias est **ambigu**.
2. **Dernier recours, sans extension** : JSON de forme complète `<S>.supplemental-metadata.json` ; `S` doit être le nom
   sans extension d'**exactement un fichier du dossier**, tous fichiers comptés (non reconnus, extensions non prises en
   charge, médias déjà appariés), et ce fichier doit être un média sans métadonnées. Sinon, JSON **ambigu** : verdict
   non exploitable. Sans aucun fichier porteur : JSON orphelin.
3. **Vidéo de Live Photo** : vidéo `.mp4`/`.mov` sans JSON dont le nom sans extension est porté par exactement un autre
   fichier du dossier, une image appariée. Elle n'est pas appariée au JSON de l'image ; elle est listée à part, et la
   décision de date revient à la story 4.2.
4. Tout autre média sans JSON est listé **sans métadonnées** ; un JSON sans média est listé non reconnu et déclenche
   l'avertissement « partie possiblement manquante ». La casse compte (Google la préserve).

## Contenu des métadonnées

Le contenu des JSON n'est pas lu par la validation (story 4.1). La date de prise de vue attendue est
`photoTakenTime.timestamp` (secondes Unix, UTC), lue en tête de cascade par la story 4.2, qui confirmera la structure
réelle sur les exports.

## Validation

```
gpb takeout valider                               # zips de marceau-photos/backups/, lus par plages
gpb takeout valider --export 20260806T062636Z --parties 4   # un seul export, nombre de parties confirmé
gpb takeout valider --zip ./takeout-…-001.zip …   # zips locaux
```

Pour chaque partie, seuls la fin du fichier et le répertoire central sont lus (quelques centaines de Ko pour un zip de
plusieurs Go). Contrôles : fin de répertoire central (EOCD) trouvée, zip64 lu, zip non découpé, nombre d'entrées annoncé
égal au nombre lu, taille du répertoire cohérente, entrées dans les bornes du fichier, méthode stockée ou deflate, pas
de chiffrement, noms UTF-8 valides.

Contrôles supplémentaires : le répertoire central se termine exactement au début des enregistrements de fin (écarte une
fin factice), sa taille est plausible pour le nombre d'entrées (plafond 64 Mio), et les entrées ne se chevauchent pas
(borne minimale : en-tête local de 30 octets, nom, données compressées ; l'extra local n'est pas lu).

Verdict **non exploitable** si : une partie est illisible, vide ou sans aucun média, une partie manque dans la
numérotation, le nombre de parties diffère de `--parties`, un même chemin est présent deux fois, un JSON est ambigu, ou
aucun média n'est reconnu. Les médias sans métadonnées et les fichiers non reconnus sont listés
sans bloquer. Code de sortie 1 si un export est non exploitable. Rien n'est écrit, ni dans un bucket ni en base.
