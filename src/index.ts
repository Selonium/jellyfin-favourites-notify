import { DiscordWebhookClient } from './clients/discord.js';
import { JellyfinClient } from './clients/jellyfin.js';
import { SeerrClient } from './clients/seerr.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createAppServer } from './server.js';
import { WebhookAggregator } from './services/aggregator.js';
import { PingDebouncer } from './services/debounce.js';
import { FavouritesStore } from './services/favouritesStore.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const jellyfin = new JellyfinClient({
    baseUrl: config.jellyfinUrl,
    apiKey: config.jellyfinApiKey,
  });

  const seerr = new SeerrClient({
    baseUrl: config.seerrUrl,
    apiKey: config.seerrApiKey,
  });

  const discord = new DiscordWebhookClient({ logger });

  const store = new FavouritesStore({
    jellyfin,
    seerr,
    logger,
  });

  const debouncer = new PingDebouncer({
    windowMs: config.pingDebounceMs,
  });

  const aggregator = new WebhookAggregator({
    store,
    debouncer,
    discord,
    aggregationWindowMs: config.aggregationWindowMs,
    pingOnEvents: config.pingOnEvents,
    pingPrefix: config.pingPrefix,
    logger,
  });

  // Initial sync (non-fatal if upstream services are still booting)
  try {
    await store.sync();
  } catch {
    logger.warn('Initial Jellyfin/Seerr sync failed; will retry on polling interval', {
      pollIntervalSeconds: config.pollIntervalMs / 1000,
    });
  }

  store.startPolling(config.pollIntervalMs);

  const server = createAppServer({
    config,
    store,
    aggregator,
    logger,
  });

  server.listen(config.port, config.host, () => {
    logger.info('jellyfin-favourites-notify middleware started', {
      host: config.host,
      port: config.port,
      pollIntervalSeconds: config.pollIntervalMs / 1000,
      pingDebounceSeconds: config.pingDebounceMs / 1000,
      aggregationWindowSeconds: config.aggregationWindowMs / 1000,
      pingOnEvents: [...config.pingOnEvents],
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}; shutting down gracefully`);
    store.stopPolling();
    await aggregator.flushAll();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
