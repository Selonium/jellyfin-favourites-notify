import type { JellyfinClient } from '../clients/jellyfin.js';
import type { SeerrClient } from '../clients/seerr.js';
import type { Logger } from '../logger.js';
import type {
  MappedUser,
  MediaType,
  ProviderIds,
  SeerrUser,
  SyncStatus,
  TrackedFavourite,
} from '../types.js';

export function normalizeJellyfinId(id: string): string {
  return id.replace(/-/g, '').trim().toLowerCase();
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface FavouritesIndex {
  byTvdb: Map<string, Set<string>>;
  byTmdbSeries: Map<string, Set<string>>;
  byTmdbMovie: Map<string, Set<string>>;
  byImdb: Map<string, Set<string>>;
  byTitleSeries: Map<string, Set<string>>;
  byTitleMovie: Map<string, Set<string>>;
}

function createEmptyIndex(): FavouritesIndex {
  return {
    byTvdb: new Map(),
    byTmdbSeries: new Map(),
    byTmdbMovie: new Map(),
    byImdb: new Map(),
    byTitleSeries: new Map(),
    byTitleMovie: new Map(),
  };
}

function addToMapSet(map: Map<string, Set<string>>, key: string, values: string[]): void {
  if (!key || values.length === 0) return;
  let existing = map.get(key);
  if (!existing) {
    existing = new Set<string>();
    map.set(key, existing);
  }
  for (const val of values) {
    existing.add(val);
  }
}

export interface MediaLookupQuery {
  mediaType: MediaType;
  providerIds: ProviderIds;
  title?: string;
}

export class FavouritesStore {
  private readonly jellyfin: JellyfinClient;
  private readonly seerr: SeerrClient;
  private readonly logger?: Logger;

  private index: FavouritesIndex = createEmptyIndex();
  private mappedUsers: MappedUser[] = [];
  private status: SyncStatus = {
    lastSyncAt: null,
    lastError: null,
    jellyfinUsersCount: 0,
    mappedDiscordUsersCount: 0,
    totalFavouritesTracked: 0,
  };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight: Promise<SyncStatus> | null = null;

  constructor(options: { jellyfin: JellyfinClient; seerr: SeerrClient; logger?: Logger }) {
    this.jellyfin = options.jellyfin;
    this.seerr = options.seerr;
    this.logger = options.logger;
  }

  async sync(): Promise<SyncStatus> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    this.syncInFlight = this.performSync().finally(() => {
      this.syncInFlight = null;
    });

    return this.syncInFlight;
  }

  private async performSync(): Promise<SyncStatus> {
    try {
      const [jellyfinUsers, seerrUsers] = await Promise.all([
        this.jellyfin.getUsers(),
        this.seerr.getAllUsers(),
      ]);

      const seerrByJellyfinId = new Map<string, SeerrUser>();
      const seerrByUsername = new Map<string, SeerrUser>();

      for (const sUser of seerrUsers) {
        if (sUser.jellyfinUserId) {
          seerrByJellyfinId.set(normalizeJellyfinId(sUser.jellyfinUserId), sUser);
        }
        const jfName = sUser.jellyfinUsername?.trim().toLowerCase();
        if (jfName) {
          seerrByUsername.set(jfName, sUser);
        }
        const uName = sUser.username?.trim().toLowerCase();
        if (uName && !seerrByUsername.has(uName)) {
          seerrByUsername.set(uName, sUser);
        }
      }

      const nextIndex = createEmptyIndex();
      const nextMappedUsers: MappedUser[] = [];
      let totalFavourites = 0;

      for (const jfUser of jellyfinUsers) {
        const normalizedId = normalizeJellyfinId(jfUser.Id);
        const matchedSeerr =
          seerrByJellyfinId.get(normalizedId) ??
          seerrByUsername.get(jfUser.Name.trim().toLowerCase());

        let discordUserIds: string[] = [];
        if (matchedSeerr) {
          try {
            discordUserIds = await this.seerr.getDiscordUserIdsForSeerrUser(matchedSeerr);
          } catch (err) {
            this.logger?.warn('Failed to fetch Seerr notification settings for user', {
              jellyfinUser: jfUser.Name,
              seerrUserId: matchedSeerr.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        let favourites: TrackedFavourite[] = [];
        try {
          favourites = await this.jellyfin.getUserFavorites(jfUser.Id);
        } catch (err) {
          this.logger?.warn('Failed to fetch Jellyfin favourites for user', {
            jellyfinUser: jfUser.Name,
            jellyfinUserId: jfUser.Id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        totalFavourites += favourites.length;
        nextMappedUsers.push({
          jellyfinUserId: jfUser.Id,
          jellyfinUsername: jfUser.Name,
          seerrUserId: matchedSeerr?.id,
          discordUserIds,
          favouritesCount: favourites.length,
        });

        if (discordUserIds.length === 0) {
          continue;
        }

        for (const fav of favourites) {
          if (fav.providerIds.tvdb) {
            addToMapSet(nextIndex.byTvdb, fav.providerIds.tvdb, discordUserIds);
          }
          if (fav.providerIds.tmdb) {
            if (fav.mediaType === 'series') {
              addToMapSet(nextIndex.byTmdbSeries, fav.providerIds.tmdb, discordUserIds);
            } else {
              addToMapSet(nextIndex.byTmdbMovie, fav.providerIds.tmdb, discordUserIds);
            }
          }
          if (fav.providerIds.imdb) {
            addToMapSet(nextIndex.byImdb, fav.providerIds.imdb.toLowerCase(), discordUserIds);
          }

          const normTitle = normalizeTitle(fav.name);
          if (normTitle) {
            if (fav.mediaType === 'series') {
              addToMapSet(nextIndex.byTitleSeries, normTitle, discordUserIds);
            } else {
              addToMapSet(nextIndex.byTitleMovie, normTitle, discordUserIds);
            }
          }
        }
      }

      this.index = nextIndex;
      this.mappedUsers = nextMappedUsers;
      this.status = {
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        jellyfinUsersCount: jellyfinUsers.length,
        mappedDiscordUsersCount: nextMappedUsers.filter((u) => u.discordUserIds.length > 0).length,
        totalFavouritesTracked: totalFavourites,
      };

      this.logger?.info('Synchronized Jellyfin favourites and Seerr Discord mappings', {
        ...this.status,
      });

      return this.status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = {
        ...this.status,
        lastError: message,
      };
      this.logger?.error('Failed to sync Jellyfin/Seerr state', { error: message });
      throw err;
    }
  }

  startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.sync().catch(() => {
        // Error already logged in performSync
      });
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  findDiscordUsersForMedia(query: MediaLookupQuery): string[] {
    const matched = new Set<string>();
    const { providerIds, mediaType, title } = query;

    if (providerIds.tvdb) {
      for (const id of this.index.byTvdb.get(providerIds.tvdb) ?? []) {
        matched.add(id);
      }
    }

    if (providerIds.tmdb) {
      if (mediaType === 'series' || mediaType === 'unknown') {
        for (const id of this.index.byTmdbSeries.get(providerIds.tmdb) ?? []) {
          matched.add(id);
        }
      }
      if (mediaType === 'movie' || mediaType === 'unknown') {
        for (const id of this.index.byTmdbMovie.get(providerIds.tmdb) ?? []) {
          matched.add(id);
        }
      }
    }

    if (providerIds.imdb) {
      for (const id of this.index.byImdb.get(providerIds.imdb.toLowerCase()) ?? []) {
        matched.add(id);
      }
    }

    // Fallback to normalized title matching if no provider IDs matched
    if (matched.size === 0 && title) {
      const normTitle = normalizeTitle(title);
      if (normTitle) {
        if (mediaType === 'series' || mediaType === 'unknown') {
          for (const id of this.index.byTitleSeries.get(normTitle) ?? []) {
            matched.add(id);
          }
        }
        if (mediaType === 'movie' || mediaType === 'unknown') {
          for (const id of this.index.byTitleMovie.get(normTitle) ?? []) {
            matched.add(id);
          }
        }
      }
    }

    return [...matched];
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  getMappedUsers(): MappedUser[] {
    return this.mappedUsers.map((u) => ({ ...u, discordUserIds: [...u.discordUserIds] }));
  }
}
