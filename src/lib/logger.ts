import { env } from '../config/env';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (shouldLog(level)) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    // In production: JSON to stdout (for log aggregators like Papertrail/Logtail)
    // In development: formatted console output
    if (env.NODE_ENV === 'production') {
      console.log(JSON.stringify(entry));
    } else {
      console.log(`[${entry.timestamp}] ${level.toUpperCase()}: ${message}`,
        meta ? meta : '');
    }
  }
}

function shouldLog(level: LogLevel): boolean {
  const levels = ['debug', 'info', 'warn', 'error'];
  // Default to info if something weird happens with config
  const configuredLevel = env?.LOG_LEVEL || 'info'; 
  return levels.indexOf(level) >= levels.indexOf(configuredLevel);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};
