import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '../src/clients/jellyfin.js';
import { SeerrClient } from '../src/clients/seerr.js';
import { FavouritesStore } from '../src/services/favouritesStore.js';

function createMockFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: `Unmocked URL: ${url}` }), { status: 404 });
  }) as typeof fetch;
}

describe('FavouritesStore', () => {
  it('syncs Jellyfin users + favourites and resolves Discord user IDs via Seerr', async () => {
    const mockFetch = createMockFetch({
      '/Users/aaaabbbb-cccc-dddd-eeee-ffffffffffff/Items': {
        Items: [
          {
            Id: 'item-1',
            Name: 'Breaking Bad',
            Type: 'Series',
            ProductionYear: 2008,
            ProviderIds: { Tvdb: '81189', Imdb: 'tt0903747', Tmdb: '1396' },
          },
          {
            Id: 'item-2',
            Name: 'Inception',
            Type: 'Movie',
            ProductionYear: 2010,
            ProviderIds: { Tmdb: '27205', Imdb: 'tt1375666' },
          },
        ],
      },
      '/Users/11112222333344445555666677778888/Items': {
        Items: [
          {
            Id: 'item-1',
            Name: 'Breaking Bad',
            Type: 'Series',
            ProductionYear: 2008,
            ProviderIds: { Tvdb: '81189' },
          },
        ],
      },
      '/Users': [
        { Id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff', Name: 'Alice' },
        { Id: '11112222333344445555666677778888', Name: 'Bob' },
        { Id: 'disabled-user', Name: 'Disabled', Policy: { IsDisabled: true } },
      ],
      '/api/v1/user/10/settings/notifications': {
        discordId: '100000000000000001',
      },
      '/api/v1/user/20/settings/notifications': {
        discordIds: ['200000000000000002'],
      },
      '/api/v1/user?': {
        pageInfo: { pages: 1, pageSize: 100, results: 2, page: 1 },
        results: [
          {
            id: 10,
            username: 'alice',
            // Without hyphens to verify UUID normalization
            jellyfinUserId: 'aaaabbbbccccddddeeeeffffffffffff',
          },
          {
            id: 20,
            username: 'bob',
            jellyfinUserId: '11112222-3333-4444-5555-666677778888',
          },
        ],
      },
    });

    const jellyfin = new JellyfinClient({
      baseUrl: 'http://jellyfin.local:8096',
      apiKey: 'jf-key',
      fetchImpl: mockFetch,
    });
    const seerr = new SeerrClient({
      baseUrl: 'http://seerr.local:5055',
      apiKey: 'seerr-key',
      fetchImpl: mockFetch,
    });

    const store = new FavouritesStore({ jellyfin, seerr });
    const status = await store.sync();

    expect(status.jellyfinUsersCount).toBe(2);
    expect(status.mappedDiscordUsersCount).toBe(2);
    expect(status.totalFavouritesTracked).toBe(3);

    // Lookup by TVDB ID -> both Alice and Bob
    expect(
      store
        .findDiscordUsersForMedia({
          mediaType: 'series',
          providerIds: { tvdb: '81189' },
        })
        .sort(),
    ).toEqual(['100000000000000001', '200000000000000002']);

    // Lookup by TMDB Movie ID -> only Alice
    expect(
      store.findDiscordUsersForMedia({
        mediaType: 'movie',
        providerIds: { tmdb: '27205' },
      }),
    ).toEqual(['100000000000000001']);

    // Fallback lookup by title when no provider IDs exist
    expect(
      store
        .findDiscordUsersForMedia({
          mediaType: 'series',
          providerIds: {},
          title: 'Breaking Bad',
        })
        .sort(),
    ).toEqual(['100000000000000001', '200000000000000002']);

    // Unfavourited show -> empty
    expect(
      store.findDiscordUsersForMedia({
        mediaType: 'series',
        providerIds: { tvdb: '999999' },
        title: 'Brand New Show',
      }),
    ).toEqual([]);
  });

  it('resolves parent series when a user only favourites a single episode or season', async () => {
    const mockFetch = createMockFetch({
      '/Users/user-ep-only/Items?Ids=series-severance': {
        Items: [
          {
            Id: 'series-severance',
            Name: 'Severance',
            Type: 'Series',
            ProductionYear: 2022,
            ProviderIds: { Tvdb: '371980', Tmdb: '95396', Imdb: 'tt11280740' },
          },
        ],
      },
      '/Users/user-ep-only/Items?Filters=IsFavorite': {
        Items: [
          {
            Id: 'ep-s01e01',
            Name: 'Good News About Hell',
            Type: 'Episode',
            SeriesId: 'series-severance',
            SeriesName: 'Severance',
            ProviderIds: { Tvdb: '9000001' }, // Episode TVDB ID, not Series TVDB ID
          },
          {
            Id: 'ep-s01e02',
            Name: 'Half Loop',
            Type: 'Episode',
            SeriesId: 'series-severance',
            SeriesName: 'Severance',
          },
        ],
      },
      '/Users': [{ Id: 'user-ep-only', Name: 'Charlie' }],
      '/api/v1/user/30/settings/notifications': {
        discordId: '300000000000000003',
      },
      '/api/v1/user?': {
        pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 },
        results: [
          {
            id: 30,
            username: 'charlie',
            jellyfinUserId: 'user-ep-only',
          },
        ],
      },
    });

    const jellyfin = new JellyfinClient({
      baseUrl: 'http://jellyfin.local:8096',
      apiKey: 'jf-key',
      fetchImpl: mockFetch,
    });
    const seerr = new SeerrClient({
      baseUrl: 'http://seerr.local:5055',
      apiKey: 'seerr-key',
      fetchImpl: mockFetch,
    });

    const store = new FavouritesStore({ jellyfin, seerr });
    const status = await store.sync();

    // Multiple favourited episodes of the same show deduplicate to 1 tracked series
    expect(status.totalFavouritesTracked).toBe(1);

    // Matches parent show by Series TVDB ID even though user only favourited episodes
    expect(
      store.findDiscordUsersForMedia({
        mediaType: 'series',
        providerIds: { tvdb: '371980' },
      }),
    ).toEqual(['300000000000000003']);
  });
});
