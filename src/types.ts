export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type MediaType = 'series' | 'movie' | 'unknown';

export type MediaEventCategory = 'added' | 'upgraded' | 'deleted' | 'grab' | 'other';

export type ArrSource = 'sonarr' | 'radarr' | 'unknown';

export interface ProviderIds {
  tvdb?: string;
  tmdb?: string;
  imdb?: string;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy?: {
    IsDisabled?: boolean;
  };
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: 'Series' | 'Season' | 'Episode' | 'Movie' | string;
  ProductionYear?: number;
  SeriesId?: string;
  SeriesName?: string;
  ProviderIds?: Record<string, string | undefined>;
}

export interface JellyfinItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount?: number;
}

export interface SeerrUser {
  id: number;
  email?: string;
  username?: string;
  jellyfinUsername?: string | null;
  jellyfinUserId?: string | null;
  settings?: {
    discordId?: string | null;
    discordIds?: string[] | null;
  } | null;
}

export interface SeerrUsersResponse {
  pageInfo?: {
    pages: number;
    pageSize: number;
    results: number;
    page: number;
  };
  results: SeerrUser[];
}

export interface SeerrNotificationSettings {
  discordId?: string | null;
  discordIds?: string[] | null;
  discordEnabled?: boolean;
  notificationTypes?: {
    discord?: number;
  };
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: {
    text: string;
    icon_url?: string;
  };
  image?: {
    url: string;
  };
  thumbnail?: {
    url: string;
  };
  author?: {
    name?: string;
    url?: string;
    icon_url?: string;
  };
  fields?: DiscordEmbedField[];
}

export interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  tts?: boolean;
  embeds?: DiscordEmbed[];
  allowed_mentions?: {
    parse?: Array<'roles' | 'users' | 'everyone'>;
    users?: string[];
    roles?: string[];
  };
}

export interface EpisodeRef {
  season: number;
  episode: number;
  title?: string;
}

export interface ParsedMediaUpdate {
  source: ArrSource;
  mediaType: MediaType;
  eventCategory: MediaEventCategory;
  title?: string;
  year?: number;
  episodes: EpisodeRef[];
  imageUrl?: string;
  url?: string;
  providerIds: ProviderIds;
  /** Stable key used for per-media debounce tracking */
  mediaKey?: string;
  /** Normalized Discord webhook payload to forward */
  discordPayload: DiscordWebhookPayload;
}

export interface TrackedFavourite {
  jellyfinItemId: string;
  name: string;
  mediaType: 'series' | 'movie';
  year?: number;
  providerIds: ProviderIds;
}

export interface MappedUser {
  jellyfinUserId: string;
  jellyfinUsername: string;
  seerrUserId?: number;
  discordUserIds: string[];
  favouritesCount: number;
}

export interface SyncStatus {
  lastSyncAt: string | null;
  lastError: string | null;
  jellyfinUsersCount: number;
  mappedDiscordUsersCount: number;
  totalFavouritesTracked: number;
}
