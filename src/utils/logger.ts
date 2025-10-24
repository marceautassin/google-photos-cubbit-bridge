import * as winston from 'winston';
import * as path from 'path';
import { AppConfig } from '../config/types';

let logger: winston.Logger | null = null;

/**
 * Initialise le logger avec la configuration fournie
 */
export function initLogger(config: AppConfig['logging']): winston.Logger {
  const formats = [
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
  ];

  if (config.console) {
    formats.push(
      winston.format.colorize(),
      winston.format.simple()
    );
  } else {
    formats.push(winston.format.json());
  }

  const transports: winston.transport[] = [];

  // Transport fichier
  transports.push(
    new winston.transports.File({
      filename: config.file,
      level: config.level,
      maxsize: parseSize(config.maxSize),
      maxFiles: config.maxFiles,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  );

  // Transport console en mode développement
  if (config.console) {
    transports.push(
      new winston.transports.Console({
        level: config.level,
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            let log = `${timestamp} [${level}] ${message}`;
            if (Object.keys(meta).length > 0) {
              try {
                log += ` ${JSON.stringify(meta, null, 0)}`;
              } catch (error) {
                // Gestion des références circulaires
                const safeMetadata: Record<string, any> = {};
                Object.keys(meta).forEach(key => {
                  try {
                    JSON.stringify(meta[key]);
                    safeMetadata[key] = meta[key];
                  } catch {
                    safeMetadata[key] = '[Circular Reference]';
                  }
                });
                log += ` ${JSON.stringify(safeMetadata, null, 0)}`;
              }
            }
            return log;
          })
        ),
      })
    );
  }

  logger = winston.createLogger({
    level: config.level,
    format: winston.format.combine(...formats),
    transports,
    exitOnError: false,
  });

  return logger;
}

/**
 * Obtient l'instance du logger
 */
export function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error('Logger non initialisé. Appelez initLogger() d\'abord.');
  }
  return logger;
}

/**
 * Parse une taille de fichier depuis une chaîne (ex: "10m" -> 10485760)
 */
function parseSize(size: string): number {
  const units: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };

  const match = size.toLowerCase().match(/^(\d+)([kmg]?)b?$/);
  if (!match) {
    throw new Error(`Taille de fichier invalide: ${size}`);
  }

  const [, number, unit] = match;
  const numValue = parseInt(number || '0', 10);
  const multiplier = unit ? (units[unit] || 1) : 1;
  return numValue * multiplier;
}

/**
 * Logger d'erreurs avec stack trace
 */
export function logError(error: Error, context?: Record<string, any>): void {
  const log = getLogger();
  log.error(error.message, {
    stack: error.stack,
    name: error.name,
    ...context,
  });
}

/**
 * Logger de progression
 */
export function logProgress(
  operation: string,
  current: number,
  total: number,
  additionalInfo?: Record<string, any>
): void {
  const log = getLogger();
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  
  log.info(`${operation}: ${current}/${total} (${percentage}%)`, {
    operation,
    current,
    total,
    percentage,
    ...additionalInfo,
  });
}
