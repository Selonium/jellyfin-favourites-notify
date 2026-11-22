import type { SeerrNotificationSettings, SeerrUser, SeerrUsersResponse } from '../types.js';

export interface SeerrClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function collectDiscordIds(
  source?: { discordId?: string | null; discordIds?: string[] | null } | null,
): string[] {
  if (!source) return [];
  const ids = new Set<string>();

  if (typeof source.discordId === 'string') {
    const trimmed = source.discordId.trim();
    if (trimmed) ids.add(trimmed);
  }

  if (Array.isArray(source.discordIds)) {
    for (const entry of source.discordIds) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed) ids.add(trimmed);
      }
    }
  }

  return [...ids];
}

export class SeerrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SeerrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'X-Api-Key': this.apiKey,
    };
  }

  async getAllUsers(): Promise<SeerrUser[]> {
    const users: SeerrUser[] = [];
    const pageSize = 100;
    let skip = 0;

    while (true) {
      const url = `${this.baseUrl}/api/v1/user?take=${pageSize}&skip=${skip}`;
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers,
      });

      if (!res.ok) {
        throw new Error(`Seerr GET /api/v1/user failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as SeerrUsersResponse;
      const batch = Array.isArray(data.results) ? data.results : [];
      users.push(...batch);

      const totalPages = data.pageInfo?.pages ?? 1;
      const currentPage = data.pageInfo?.page ?? 1;
      if (batch.length < pageSize || currentPage >= totalPages) {
        break;
      }
      skip += pageSize;
    }

    return users;
  }

  async getUserNotificationSettings(seerrUserId: number): Promise<SeerrNotificationSettings> {
    const url = `${this.baseUrl}/api/v1/user/${seerrUserId}/settings/notifications`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(
        `Seerr GET /api/v1/user/${seerrUserId}/settings/notifications failed: ${res.status} ${res.statusText}`,
      );
    }

    return (await res.json()) as SeerrNotificationSettings;
  }

  async getDiscordUserIdsForSeerrUser(user: SeerrUser): Promise<string[]> {
    const ids = new Set<string>(collectDiscordIds(user.settings));

    const settings = await this.getUserNotificationSettings(user.id);
    for (const id of collectDiscordIds(settings)) {
      ids.add(id);
    }

    return [...ids];
  }
}
