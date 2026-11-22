import { describe, expect, it } from 'vitest';
import { DiscordWebhookClient } from '../src/clients/discord.js';
import { WebhookAggregator } from '../src/services/aggregator.js';
import { PingDebouncer } from '../src/services/debounce.js';
import type { FavouritesStore } from '../src/services/favouritesStore.js';
import { parseIncomingWebhook } from '../src/services/webhookParser.js';
import type { DiscordWebhookPayload } from '../src/types.js';

function createStubStore(mapping: Record<string, string[]>): FavouritesStore {
  return {
    findDiscordUsersForMedia: ({ providerIds, title }) => {
      if (providerIds.tvdb && mapping[`tvdb:${providerIds.tvdb}`]) {
        return mapping[`tvdb:${providerIds.tvdb}`];
      }
      if (title && mapping[title]) {
        return mapping[title];
      }
      return [];
    },
  } as unknown as FavouritesStore;
}

describe('WebhookAggregator', () => {
  it('aggregates a flurry of episode imports, injects pings once, and debounces subsequent flurries for 1 hour', async () => {
    const sentPayloads: DiscordWebhookPayload[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as DiscordWebhookPayload);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    let nowMs = 1_000_000;
    const debouncer = new PingDebouncer({ windowMs: 3_600_000, now: () => nowMs });
    const discord = new DiscordWebhookClient({ fetchImpl: mockFetch });
    const store = createStubStore({
      'tvdb:81189': ['111111', '222222'],
    });

    const aggregator = new WebhookAggregator({
      store,
      debouncer,
      discord,
      aggregationWindowMs: 5_000,
      pingOnEvents: new Set(['added', 'upgraded', 'deleted']),
    });

    // Flurry of 3 episodes imported rapidly
    for (let ep = 1; ep <= 3; ep++) {
      const parsed = parseIncomingWebhook({
        username: 'Sonarr',
        embeds: [
          {
            title: `Breaking Bad - 1x0${ep} - Episode ${ep}`,
            description: 'Episode Imported',
            fields: [
              {
                name: 'Links',
                value: '[TheTVDB](https://thetvdb.com/dereferer/series/81189)',
              },
            ],
          },
        ],
      });
      await aggregator.handle('https://discord.com/api/webhooks/1/tok', parsed);
    }

    await aggregator.flushAll();

    // All 3 episodes combined into 1 Discord message with deduplicated pings
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].embeds).toHaveLength(3);
    expect(sentPayloads[0].content).toBe('<@111111> <@222222>');
    expect(sentPayloads[0].allowed_mentions).toEqual({ users: ['111111', '222222'] });

    // 20 minutes later, episode 4 arrives -> forwarded WITHOUT pings due to 1-hour debounce
    nowMs += 20 * 60 * 1000;
    const ep4 = parseIncomingWebhook({
      username: 'Sonarr',
      embeds: [
        {
          title: 'Breaking Bad - 1x04 - Episode 4',
          description: 'Episode Imported',
          fields: [
            {
              name: 'Links',
              value: '[TheTVDB](https://thetvdb.com/dereferer/series/81189)',
            },
          ],
        },
      ],
    });
    const res4 = await aggregator.handle('https://discord.com/api/webhooks/1/tok', ep4);
    expect(res4.pingedUsers).toEqual([]);
    expect(res4.debouncedUsers).toEqual(['111111', '222222']);
    await aggregator.flushAll();

    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1].embeds).toHaveLength(1);
    expect(sentPayloads[1].content).toBeUndefined();
    expect(sentPayloads[1].allowed_mentions).toBeUndefined();

    // 45 minutes later (65 minutes total since first ping) -> episode 5 pings again!
    nowMs += 45 * 60 * 1000;
    const ep5 = parseIncomingWebhook({
      username: 'Sonarr',
      embeds: [
        {
          title: 'Breaking Bad - 1x05 - Episode 5',
          description: 'Episode Imported',
          fields: [
            {
              name: 'Links',
              value: '[TheTVDB](https://thetvdb.com/dereferer/series/81189)',
            },
          ],
        },
      ],
    });
    await aggregator.handle('https://discord.com/api/webhooks/1/tok', ep5);
    await aggregator.flushAll();

    expect(sentPayloads).toHaveLength(3);
    expect(sentPayloads[2].content).toBe('<@111111> <@222222>');
  });

  it('chunks more than 10 aggregated embeds across multiple Discord webhook posts', async () => {
    const sentPayloads: DiscordWebhookPayload[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as DiscordWebhookPayload);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const aggregator = new WebhookAggregator({
      store: createStubStore({}),
      debouncer: new PingDebouncer({ windowMs: 3_600_000 }),
      discord: new DiscordWebhookClient({ fetchImpl: mockFetch }),
      aggregationWindowMs: 5_000,
      pingOnEvents: new Set(['added', 'upgraded', 'deleted']),
    });

    for (let ep = 1; ep <= 12; ep++) {
      const parsed = parseIncomingWebhook({
        username: 'Sonarr',
        embeds: [{ title: `New Show - 1x${String(ep).padStart(2, '0')}` }],
      });
      await aggregator.handle('https://discord.com/api/webhooks/1/tok', parsed);
    }

    await aggregator.flushAll();

    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[0].embeds).toHaveLength(10);
    expect(sentPayloads[1].embeds).toHaveLength(2);
    expect(sentPayloads[0].content).toBeUndefined();
  });
});
