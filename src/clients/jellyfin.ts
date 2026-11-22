import type {
  JellyfinItem,
  JellyfinItemsResponse,
  JellyfinUser,
  ProviderIds,
  TrackedFavourite,
} from '../types.js';

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function extractProviderIds(raw?: Record<string, string | undefined>): ProviderIds {
  if (!raw) return {};
  const result: ProviderIds = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const lower = key.toLowerCase();
    if (lower === 'tvdb') result.tvdb = trimmed;
    else if (lower === 'tmdb') result.tmdb = trimmed;
    else if (lower === 'imdb') result.imdb = trimmed.toLowerCase();
  }
  return result;
}

function mapItemToFavourite(item: JellyfinItem): TrackedFavourite | null {
  const typeLower = item.Type?.toLowerCase();
  if (typeLower !== 'series' && typeLower !== 'movie') {
    return null;
  }
  return {
    jellyfinItemId: item.Id,
    name: item.Name,
    mediaType: typeLower,
    year: item.ProductionYear,
    providerIds: extractProviderIds(item.ProviderIds),
  };
}

export class JellyfinClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JellyfinClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `MediaBrowser Token="${this.apiKey}"`,
    };
  }

  async getUsers(): Promise<JellyfinUser[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/Users`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Jellyfin GET /Users failed: ${res.status} ${res.statusText}`);
    }

    const users = (await res.json()) as JellyfinUser[];
    return users.filter((user) => !user.Policy?.IsDisabled);
  }

  async getUserFavorites(userId: string): Promise<TrackedFavourite[]> {
    const params = new URLSearchParams({
      Filters: 'IsFavorite',
      Recursive: 'true',
      IncludeItemTypes: 'Series,Season,Episode,Movie',
      Fields: 'ProviderIds',
    });

    const url = `${this.baseUrl}/Users/${encodeURIComponent(userId)}/Items?${params.toString()}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(
        `Jellyfin GET /Users/${userId}/Items failed: ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as JellyfinItemsResponse;
    const items = Array.isArray(data.Items) ? data.Items : [];
    const favouritesById = new Map<string, TrackedFavourite>();
    const missingSeriesNames = new Map<string, string>();

    for (const item of items) {
      const typeLower = item.Type?.toLowerCase();
      if (typeLower === 'series' || typeLower === 'movie') {
        const mapped = mapItemToFavourite(item);
        if (mapped) {
          favouritesById.set(mapped.jellyfinItemId, mapped);
        }
      } else if ((typeLower === 'episode' || typeLower === 'season') && item.SeriesId) {
        if (!favouritesById.has(item.SeriesId) && !missingSeriesNames.has(item.SeriesId)) {
          missingSeriesNames.set(item.SeriesId, item.SeriesName ?? '');
        }
      }
    }

    // Remove any SeriesIds that were also directly favourited later in the list
    for (const id of favouritesById.keys()) {
      missingSeriesNames.delete(id);
    }

    if (missingSeriesNames.size > 0) {
      const parentSeries = await this.getItemsByIds(userId, [...missingSeriesNames.keys()]);
      for (const seriesItem of parentSeries) {
        const mapped = mapItemToFavourite(seriesItem);
        if (mapped) {
          favouritesById.set(mapped.jellyfinItemId, mapped);
          missingSeriesNames.delete(mapped.jellyfinItemId);
        }
      }

      // Fallback to SeriesName if Jellyfin didn't return a parent Series item
      for (const [seriesId, seriesName] of missingSeriesNames.entries()) {
        if (seriesName.trim()) {
          favouritesById.set(seriesId, {
            jellyfinItemId: seriesId,
            name: seriesName.trim(),
            mediaType: 'series',
            providerIds: {},
          });
        }
      }
    }

    return [...favouritesById.values()];
  }

  private async getItemsByIds(userId: string, itemIds: string[]): Promise<JellyfinItem[]> {
    const results: JellyfinItem[] = [];
    const batchSize = 100;

    for (let i = 0; i < itemIds.length; i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);
      const params = new URLSearchParams({
        Ids: batch.join(','),
        Fields: 'ProviderIds',
      });
      const url = `${this.baseUrl}/Users/${encodeURIComponent(userId)}/Items?${params.toString()}`;
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers,
      });

      if (!res.ok) {
        throw new Error(
          `Jellyfin GET /Users/${userId}/Items?Ids=... failed: ${res.status} ${res.statusText}`,
        );
      }

      const data = (await res.json()) as JellyfinItemsResponse;
      if (Array.isArray(data.Items)) {
        results.push(...data.Items);
      }
    }

    return results;
  }
}
