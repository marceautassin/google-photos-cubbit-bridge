# 🚀 Guide de démarrage rapide

## Installation rapide

```bash
# 1. Installer les dépendances
npm install

# 2. Compiler le projet
npm run build

# 3. Lancement de la configuration
node dist/index.js setup
```

## Configuration minimale

### 1. Google Cloud Console

1. Allez sur [Google Cloud Console](https://console.cloud.google.com/)
2. Créez un nouveau projet
3. Activez l'API "Google Photos Library API"
4. Créez des identifiants OAuth 2.0 (Application de bureau)
5. Téléchargez le fichier JSON

### 2. Credentials Cubbit

Récupérez depuis votre interface Cubbit :
- **Endpoint** : URL de votre instance Cubbit
- **Access Key ID** : Clé d'accès S3
- **Secret Access Key** : Clé secrète S3
- **Bucket** : Nom du bucket de destination

### 3. Configuration rapide

```bash
# Variables d'environnement (créez un fichier .env)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
CUBBIT_ENDPOINT=https://your-cubbit-endpoint.com
CUBBIT_ACCESS_KEY_ID=your_access_key
CUBBIT_SECRET_ACCESS_KEY=your_secret_key
```

## Premiers pas

```bash
# 1. Configuration interactive
node dist/index.js setup

# 2. Authentification Google Photos
node dist/index.js auth login

# 3. Lister vos albums
node dist/index.js list albums

# 4. Synchroniser un album
node dist/index.js sync --album "Mon Album"

# 5. Vérifier le statut
node dist/index.js status
```

## Commandes essentielles

| Commande | Description |
|----------|-------------|
| `setup` | Configuration initiale |
| `auth login` | Connexion Google Photos |
| `list albums` | Voir les albums |
| `sync --album "Name"` | Sync un album |
| `sync --all` | Sync tout |
| `status` | Voir le statut |
| `history` | Historique des syncs |

## Dépannage rapide

### Problème d'authentification
```bash
node dist/index.js auth logout
node dist/index.js auth login
```

### Problème de connexion Cubbit
```bash
node dist/index.js auth status  # Teste les connexions
```

### Synchronisation bloquée
```bash
node dist/index.js cleanup
node dist/index.js resume
```

## Structure des données

Les photos sont organisées dans Cubbit comme suit :
```
your-bucket/
├── albums/
│   ├── Vacances_2024/
│   └── Famille/
└── photos/
    ├── 2024/2024-01/
    └── 2024/2024-02/
```

## Exemples d'utilisation

```bash
# Sync des photos de 2024
node dist/index.js sync --from "2024-01-01" --to "2024-12-31"

# Sync seulement les vidéos d'un album
node dist/index.js sync --album "Vacances" --type video

# Mode simulation (sans téléchargement)
node dist/index.js sync --album "Test" --dry-run

# Forcer la resynchronisation
node dist/index.js sync --album "Album" --force
```

## Support

- 📖 Documentation complète : voir `README.md`
- 🐛 Problèmes : vérifier les logs dans `logs/app.log`
- 🔧 Configuration : fichier `config/config.json` généré après setup

---

**🎯 Objectif** : Sauvegarder vos photos Google Photos vers Cubbit en quelques commandes !
