import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LogLevel, MediaEventCategory } from './types.js';

export interface AppConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  seerrUrl: string;
  seerrApiKey: string;
  discordWebhookUrl?: string;
  allowedDiscordWebhookIds: Set<string>;
  pollIntervalMs: number;
  pingDebounceMs: number;
  aggregationWindowMs: number;
  pingOnEvents: Set<MediaEventCategory>;
  pingPrefix: string;
}

function loadDotEnvIfPresent(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parsePositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  allowZero = false,
): number {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`Invalid integer for ${key}: "${raw}"`);
  }
  return parsed;
}

function parseLogLevel(raw?: string): LogLevel {
  const normalized = (raw?.trim().toLowerCase() || 'info') as LogLevel;
  if (['debug', 'info', 'warn', 'error'].includes(normalized)) {
    return normalized;
  }
  return 'info';
}

function parsePingEvents(raw?: string): Set<MediaEventCategory> {
  const valid = new Set<MediaEventCategory>(['added', 'upgraded', 'deleted', 'grab']);
  const source = raw?.trim() ? raw.split(',') : ['added', 'upgraded', 'deleted'];
  const result = new Set<MediaEventCategory>();
  for (const item of source) {
    const normalized = item.trim().toLowerCase() as MediaEventCategory;
    if (valid.has(normalized)) {
      result.add(normalized);
    }
  }
  return result;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadDotEnvIfPresent();
  }

  const allowedIdsRaw = env.ALLOWED_DISCORD_WEBHOOK_IDS?.trim() ?? '';
  const allowedDiscordWebhookIds = new Set(
    allowedIdsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return {
    port: parsePositiveInt(env, 'PORT', 3000),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    jellyfinUrl: stripTrailingSlash(requireEnv(env, 'JELLYFIN_URL')),
    jellyfinApiKey: requireEnv(env, 'JELLYFIN_API_KEY'),
    seerrUrl: stripTrailingSlash(requireEnv(env, 'SEERR_URL')),
    seerrApiKey: requireEnv(env, 'SEERR_API_KEY'),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL?.trim() || undefined,
    allowedDiscordWebhookIds,
    pollIntervalMs: parsePositiveInt(env, 'POLL_INTERVAL_SECONDS', 300) * 1000,
    pingDebounceMs: parsePositiveInt(env, 'PING_DEBOUNCE_SECONDS', 3600, true) * 1000,
    aggregationWindowMs: parsePositiveInt(env, 'AGGREGATION_WINDOW_SECONDS', 10, true) * 1000,
    pingOnEvents: parsePingEvents(env.PING_ON_EVENTS),
    pingPrefix: env.PING_PREFIX?.trim() ?? '',
  };
}
