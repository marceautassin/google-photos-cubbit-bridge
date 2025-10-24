# Google Photos to Cubbit Bridge

Une application CLI TypeScript pour synchroniser vos photos Google Photos vers votre stockage Cubbit.

## 🚀 Fonctionnalités

- ✅ Synchronisation manuelle déclenchable
- 📚 Support des albums Google Photos
- 📅 Filtrage par dates
- 🎥 Support des photos et vidéos
- 🔄 Reprise automatique en cas d'interruption
- 📊 Suivi détaillé de la progression
- 🗃️ Stockage organisé avec structure de dossiers
- 🔐 Authentification sécurisée OAuth2
- 💾 Base de données SQLite pour le suivi
- 🎯 Interface CLI intuitive

## 📋 Prérequis

- Node.js 18+ 
- npm 8+
- Compte Google avec Google Photos
- Compte Cubbit avec API S3-compatible

## 🛠️ Installation

1. **Cloner le projet**
   ```bash
   git clone <repository-url>
   cd google-photos-cubbit-bridge
   ```

2. **Installer les dépendances**
   ```bash
   npm install
   ```

3. **Compiler le projet**
   ```bash
   npm run build
   ```

4. **Lien global (optionnel)**
   ```bash
   npm link
   # Ou utiliser directement : node dist/index.js
   ```

## ⚙️ Configuration

### 1. Configuration Google Cloud Console

1. Allez sur [Google Cloud Console](https://console.cloud.google.com/)
2. Créez un nouveau projet ou sélectionnez-en un existant
3. Activez l'API "Google Photos Library API"
4. Créez des identifiants OAuth 2.0 :
   - Type d'application : Application de bureau
   - Ou ajoutez `http://localhost:3000/auth/callback` comme URI de redirection
5. Téléchargez le fichier JSON des identifiants

### 2. Configuration Cubbit

Récupérez vos identifiants Cubbit S3-compatibles :
- Endpoint de votre instance Cubbit 
- Access Key ID 
- Secret Access Key 
- Nom du bucket marceau

### 3. Configuration de l'application

**Option 1: Configuration interactive**
```bash
gpb setup
```

**Option 2: Variables d'environnement**
```bash
# Copiez le fichier d'exemple
cp config/.env.example .env

# Éditez avec vos valeurs
nano .env
```

**Option 3: Fichier de configuration**
```bash
# Copiez et éditez le fichier de config
cp config/config.example.json config/config.json
```

## 🎯 Utilisation

### Configuration initiale
```bash
# Configuration interactive
gpb setup

# Authentification Google Photos
gpb auth login

# Vérifier le statut
gpb auth status
```

### Listing du contenu
```bash
# Lister les albums
gpb list albums

# Lister les photos d'un album
gpb list photos --album "Vacances 2024"

# Lister les photos par période
gpb list photos --from "2024-01-01" --to "2024-12-31"
```

### Synchronisation
```bash
# Synchroniser un album complet
gpb sync --album "Vacances 2024"

# Synchroniser par période
gpb sync --from "2024-01-01" --to "2024-12-31"

# Synchroniser seulement les photos
gpb sync --album "Album" --type photo

# Synchroniser toutes les photos
gpb sync --all

# Mode simulation (sans téléchargement)
gpb sync --album "Test" --dry-run

# Forcer la resynchronisation
gpb sync --album "Test" --force
```

### Suivi et maintenance
```bash
# Afficher le statut
gpb status

# Historique des synchronisations
gpb history

# Reprendre une sync interrompue
gpb resume

# Nettoyer les fichiers temporaires
gpb cleanup
```

## 📁 Structure des dossiers Cubbit

Les fichiers sont organisés automatiquement :

```
backup_google_photos/
├── albums/
│   ├── Vacances_2024/
│   │   ├── IMG_001.jpg
│   │   └── VID_002.mp4
│   └── Famille/
│       └── photo.jpg
└── photos/
    ├── 2024/
    │   ├── IMG_001.jpg
    │   ├── IMG_002.jpg
    │   └── VID_003.mp4
    └── 2023/
        ├── photo1.jpg
        └── video1.mp4
```

## 🔧 Options de commande

### Commandes principales

| Commande | Description |
|----------|-------------|
| `gpb setup` | Configuration initiale |
| `gpb auth login` | Authentification Google |
| `gpb list albums` | Lister les albums |
| `gpb sync` | Synchroniser les photos |
| `gpb status` | Statut des synchronisations |
| `gpb history` | Historique |
| `gpb resume` | Reprendre une sync |
| `gpb cleanup` | Nettoyer les fichiers temp |

### Options de synchronisation

| Option | Description | Exemple |
|--------|-------------|---------|
| `--album <name>` | Synchroniser un album | `--album "Vacances"` |
| `--from <date>` | Date de début | `--from "2024-01-01"` |
| `--to <date>` | Date de fin | `--to "2024-12-31"` |
| `--type <type>` | Type de média | `--type photo` |
| `--all` | Tout synchroniser | `--all` |
| `--force` | Forcer la resync | `--force` |
| `--dry-run` | Mode simulation | `--dry-run` |
| `--concurrent <n>` | Téléchargements parallèles | `--concurrent 5` |

## 📊 Monitoring et logs

- **Base de données SQLite** : `./data/app.db`
- **Logs** : `./logs/app.log`
- **Fichiers temporaires** : `./temp_downloads/`

```bash
# Voir les statistiques détaillées
gpb status --detailed

# Voir plus d'historique
gpb history --limit 20
```

## 🔒 Sécurité

- Les tokens OAuth2 sont chiffrés localement
- Aucun mot de passe stocké en clair
- Authentification sécurisée avec refresh tokens
- Révocation automatique des tokens à la déconnexion

## 🚨 Dépannage

### Erreurs courantes

**"Non authentifié sur Google Photos"**
```bash
gpb auth login
```

**"Impossible de se connecter à Cubbit"**
```bash
# Vérifier la configuration
gpb setup
# Ou tester la connexion
gpb auth status
```

**"Module open non disponible"**
```bash
npm install open
```

**Synchronisation bloquée**
```bash
# Nettoyer et reprendre
gpb cleanup
gpb resume
```

### Logs de débogage

```bash
# Augmenter le niveau de log
export LOG_LEVEL=debug
gpb sync --album "Test"

# Consulter les logs
tail -f logs/app.log
```

## 🔄 Développement

```bash
# Mode développement
npm run dev

# Tests
npm test

# Linting
npm run lint

# Formatage
npm run format
```

## 🏗️ Architecture

```
src/
├── index.ts              # Point d'entrée CLI
├── config/              # Configuration
├── auth/                # Authentification OAuth2
├── clients/             # Clients Google Photos & Cubbit
├── database/            # Base de données SQLite
├── sync/                # Gestionnaire de synchronisation
├── utils/               # Utilitaires (logging, crypto, fichiers)
└── commands/            # Commandes CLI
```

## 🤝 Contribution

Les contributions sont les bienvenues ! 

1. Fork le projet
2. Créez une branche feature
3. Committez vos changements
4. Poussez vers la branche
5. Ouvrez une Pull Request

## 📄 License

MIT License - voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 🙏 Remerciements

- Google Photos Library API
- AWS S3 SDK pour la compatibilité Cubbit
- Toute la communauté open source TypeScript/Node.js

---

**⚠️ Note importante** : Cette application accède à vos photos Google Photos en lecture seule. Aucune donnée n'est supprimée ou modifiée sur Google Photos. Les fichiers sont uniquement copiés vers votre stockage Cubbit.
