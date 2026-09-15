/**
 * Formate un nombre d'octets en format lisible
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Formate une durée en secondes en format lisible
 */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return '∞';
  }
  
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainingSeconds = Math.round(seconds % 60);
    return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
  }
  
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  
  return remainingHours > 0 ? `${days}j${remainingHours}h` : `${days}j`;
}

/**
 * Formate un nombre pour l'affichage avec séparateurs de milliers
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Formate une date en format français
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Formate une vitesse de transfert
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Crée une barre de progression textuelle
 */
export function createProgressBar(current: number, total: number, width: number = 20): string {
  const percentage = total > 0 ? current / total : 0;
  const filled = Math.round(width * percentage);
  const empty = width - filled;
  
  return `[${'█'.repeat(filled)}${' '.repeat(empty)}] ${Math.round(percentage * 100)}%`;
}

/**
 * Décrit une erreur par `name: message` uniquement. L'objet d'erreur du SDK S3 peut embarquer l'identifiant de
 * clé (`AWSAccessKeyId`) : il n'est jamais journalisé ni affiché en entier.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
