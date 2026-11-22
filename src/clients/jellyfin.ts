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
      IncludeItemTypes: 'Series,Movie',
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
    const favourites: TrackedFavourite[] = [];

    for (const item of items) {
      const mapped = mapItemToFavourite(item);
      if (mapped) favourites.push(mapped);
    }

    return favourites;
  }
}
