import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { DiscordWebhookClient } from '../src/clients/discord.js';
import type { AppConfig } from '../src/config.js';
import { createAppServer } from '../src/server.js';
import { WebhookAggregator } from '../src/services/aggregator.js';
import { PingDebouncer } from '../src/services/debounce.js';
import type { FavouritesStore } from '../src/services/favouritesStore.js';
import type { DiscordWebhookPayload } from '../src/types.js';

describe('HTTP Server', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('handles /health, /webhook, and drop-in Discord proxy /api/webhooks/:id/:token', async () => {
    const forwarded: Array<{ url: string; payload: DiscordWebhookPayload }> = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      forwarded.push({
        url,
        payload: JSON.parse(String(init?.body)) as DiscordWebhookPayload,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const store = {
      findDiscordUsersForMedia: ({ providerIds }: { providerIds: { tvdb?: string } }) =>
        providerIds.tvdb === '81189' ? ['9988776655'] : [],
      getStatus: () => ({
        lastSyncAt: '2026-11-22T12:00:00.000Z',
        lastError: null,
        jellyfinUsersCount: 1,
        mappedDiscordUsersCount: 1,
        totalFavouritesTracked: 1,
      }),
      getMappedUsers: () => [],
      sync: async () => ({
        lastSyncAt: '2026-11-22T12:00:00.000Z',
        lastError: null,
        jellyfinUsersCount: 1,
        mappedDiscordUsersCount: 1,
        totalFavouritesTracked: 1,
      }),
    } as unknown as FavouritesStore;

    const config: AppConfig = {
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      jellyfinUrl: 'http://jellyfin',
      jellyfinApiKey: 'key',
      seerrUrl: 'http://seerr',
      seerrApiKey: 'key',
      discordWebhookUrl: 'https://discord.com/api/webhooks/111111111111111111/default_token_1234567890',
      allowedDiscordWebhookIds: new Set(),
      pollIntervalMs: 300_000,
      pingDebounceMs: 3_600_000,
      aggregationWindowMs: 0, // immediate forwarding for HTTP test
      pingOnEvents: new Set(['added', 'upgraded', 'deleted']),
      pingPrefix: '',
    };

    const aggregator = new WebhookAggregator({
      store,
      debouncer: new PingDebouncer({ windowMs: config.pingDebounceMs }),
      discord: new DiscordWebhookClient({ fetchImpl: mockFetch }),
      aggregationWindowMs: config.aggregationWindowMs,
      pingOnEvents: config.pingOnEvents,
    });

    server = createAppServer({ config, store, aggregator });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string };
    expect(healthJson.status).toBe('ok');

    // 2. Standard /webhook route -> forwards to configured DISCORD_WEBHOOK_URL with injected ping
    const webhookRes = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Sonarr',
        embeds: [
          {
            title: 'Breaking Bad - 1x01 - Pilot',
            description: 'Episode Imported',
            fields: [
              { name: 'Links', value: '[TheTVDB](https://thetvdb.com/dereferer/series/81189)' },
            ],
          },
        ],
      }),
    });
    expect(webhookRes.status).toBe(200);
    const webhookJson = (await webhookRes.json()) as { pingedUsers: number };
    expect(webhookJson.pingedUsers).toBe(1);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe(config.discordWebhookUrl);
    expect(forwarded[0].payload.content).toBe('<@9988776655>');

    // 3. Drop-in Discord proxy route -> forwards to the exact Discord webhook ID/token
    const proxyRes = await fetch(
      `${baseUrl}/api/webhooks/222222222222222222/proxy_token_abcdefghijklmnopqrstuvwxyz?thread_id=555`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Radarr',
          embeds: [{ title: 'Unfavourited Movie (2025)', description: 'Movie Downloaded' }],
        }),
      },
    );
    expect(proxyRes.status).toBe(200);
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1].url).toBe(
      'https://discord.com/api/webhooks/222222222222222222/proxy_token_abcdefghijklmnopqrstuvwxyz?thread_id=555',
    );
    expect(forwarded[1].payload.content).toBeUndefined();
  });
});
