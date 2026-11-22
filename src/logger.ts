import type { LogLevel } from './types.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const minPriority = LEVEL_PRIORITY[level];

  const write = (entryLevel: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_PRIORITY[entryLevel] < minPriority) return;
    const timestamp = new Date().toISOString();
    const metaSuffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] ${entryLevel.toUpperCase()} ${msg}${metaSuffix}`;
    if (entryLevel === 'error') {
      console.error(line);
    } else if (entryLevel === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}
