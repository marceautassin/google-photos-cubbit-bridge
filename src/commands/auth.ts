import { Command } from 'commander';
import chalk from 'chalk';
import { AppConfig } from '../config/types';
import { GooglePhotosClient } from '../clients/google-photos';
import { validateConfig } from '../config';

export function register(program: Command, config: AppConfig): void {
  const authCmd = program
    .command('auth')
    .description('Commandes d\'authentification');

  authCmd
    .command('login')
    .description('Se connecter à Google Photos')
    .action(async () => {
      try {
        await loginCommand(config);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la connexion:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  authCmd
    .command('logout')
    .description('Se déconnecter de Google Photos')
    .action(async () => {
      try {
        await logoutCommand(config);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la déconnexion:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  authCmd
    .command('status')
    .description('Vérifier le statut d\'authentification')
    .action(async () => {
      try {
        await statusCommand(config);
      } catch (error) {
        console.error(chalk.red('Erreur lors de la vérification:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

async function loginCommand(config: AppConfig): Promise<void> {
  // Vérifier la configuration
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.log(chalk.red('❌ Configuration incomplète:'));
    errors.forEach(error => console.log(chalk.red(`  • ${error}`)));
    console.log('\n' + chalk.yellow('Lancez ' + chalk.cyan('gpb setup') + ' pour configurer l\'application.'));
    return;
  }

  console.log(chalk.blue('🔐 Authentification Google Photos...\\n'));

  const googlePhotos = new GooglePhotosClient(config.googlePhotos);

  // Vérifier si déjà authentifié
  if (await googlePhotos.isAuthenticated()) {
    console.log(chalk.yellow('⚠️  Vous êtes déjà authentifié.'));
    
    try {
      const userInfo = await googlePhotos.getUserInfo();
      console.log(chalk.green(`Connecté en tant que: ${userInfo.name} (${userInfo.email})`));
    } catch {
      console.log(chalk.green('Authentification Google Photos active'));
    }
    return;
  }

  try {
    await googlePhotos.authenticate();
    
    console.log(chalk.green(`\\n🎉 Authentification réussie!`));
    
    // Essayer d'obtenir les infos utilisateur si les scopes le permettent
    try {
      const userInfo = await googlePhotos.getUserInfo();
      console.log(chalk.green(`Connecté en tant que: ${userInfo.name} (${userInfo.email})`));
    } catch {
      console.log(chalk.blue('Authentification Google Photos réussie'));
    }
    
    console.log('\\n' + chalk.blue('Vous pouvez maintenant utiliser les commandes de synchronisation.'));
    
  } catch (error) {
    console.error(chalk.red('Échec de l\'authentification:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

async function logoutCommand(config: AppConfig): Promise<void> {
  console.log(chalk.blue('👋 Déconnexion de Google Photos...'));

  const googlePhotos = new GooglePhotosClient(config.googlePhotos);

  if (!(await googlePhotos.isAuthenticated())) {
    console.log(chalk.yellow('ℹ️  Vous n\'êtes pas authentifié.'));
    return;
  }

  try {
    await googlePhotos.logout();
    console.log(chalk.green('✅ Déconnexion réussie.'));
  } catch (error) {
    console.error(chalk.red('Erreur lors de la déconnexion:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

async function statusCommand(config: AppConfig): Promise<void> {
  console.log(chalk.blue('📊 Statut d\'authentification\n'));

  const googlePhotos = new GooglePhotosClient(config.googlePhotos);

  try {
    const isAuthenticated = await googlePhotos.isAuthenticated();
    
    if (isAuthenticated) {
      console.log(chalk.green('✅ Google Photos: Authentifié'));
      
      try {
        const userInfo = await googlePhotos.getUserInfo();
        console.log(chalk.blue(`   Utilisateur: ${userInfo.name}`));
        console.log(chalk.blue(`   Email: ${userInfo.email}`));
      } catch (error) {
        console.log(chalk.yellow('   ⚠️  Impossible de récupérer les infos utilisateur'));
        console.log(chalk.yellow('   Les tokens sont peut-être expirés. Reconnectez-vous.'));
      }
    } else {
      console.log(chalk.red('❌ Google Photos: Non authentifié'));
      console.log(chalk.yellow('   Utilisez ' + chalk.cyan('gpb auth login') + ' pour vous connecter.'));
    }

    // Tester la connexion Cubbit
    console.log('\\n' + chalk.blue('🗃️  Test de connexion Cubbit...'));
    try {
      const { CubbitClient } = await import('../clients/cubbit');
      const cubbit = new CubbitClient(config.cubbit);
      
      const connected = await cubbit.testConnection();
      if (connected) {
        console.log(chalk.green('✅ Cubbit: Connexion réussie'));
        
        try {
          const stats = await cubbit.getBucketStats();
          console.log(chalk.blue(`   Fichiers stockés: ${stats.fileCount}`));
          console.log(chalk.blue(`   Taille totale: ${formatBytes(stats.totalSize)}`));
        } catch {
          console.log(chalk.yellow('   ⚠️  Impossible de récupérer les statistiques'));
        }
      } else {
        console.log(chalk.red('❌ Cubbit: Connexion échouée'));
        console.log(chalk.yellow('   Vérifiez votre configuration avec ' + chalk.cyan('gpb setup')));
      }
    } catch (error) {
      console.log(chalk.red('❌ Cubbit: Erreur de configuration'));
      console.log(chalk.yellow('   Vérifiez votre configuration avec ' + chalk.cyan('gpb setup')));
    }

  } catch (error) {
    console.error(chalk.red('Erreur lors de la vérification:'), error instanceof Error ? error.message : error);
    throw error;
  }
}

function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
