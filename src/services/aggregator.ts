import type { DiscordWebhookClient } from '../clients/discord.js';
import type { Logger } from '../logger.js';
import type {
  DiscordEmbed,
  DiscordWebhookPayload,
  EpisodeRef,
  MediaEventCategory,
  MediaType,
  ParsedMediaUpdate,
} from '../types.js';
import type { PingDebouncer } from './debounce.js';
import type { FavouritesStore } from './favouritesStore.js';
import { buildSeerrStyleEmbed } from './webhookParser.js';

const DISCORD_MAX_CONTENT_LENGTH = 2000;

export interface WebhookAggregatorOptions {
  store: FavouritesStore;
  debouncer: PingDebouncer;
  discord: DiscordWebhookClient;
  aggregationWindowMs: number;
  pingOnEvents: Set<MediaEventCategory>;
  pingPrefix?: string;
  logger?: Logger;
}

interface MediaEmbedGroup {
  title: string;
  year?: number;
  mediaType: MediaType;
  eventCategory: MediaEventCategory;
  episodes: EpisodeRef[];
  imageUrl?: string;
  url?: string;
}

interface PendingBatch {
  webhookUrl: string;
  username?: string;
  avatarUrl?: string;
  contents: string[];
  mediaGroups: Map<string, MediaEmbedGroup>;
  passthroughEmbeds: DiscordEmbed[];
  mentionsToInject: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

export interface HandleWebhookResult {
  queued: boolean;
  matchedUsers: string[];
  pingedUsers: string[];
  debouncedUsers: string[];
}

function buildContentWithMentions(
  existingContents: string[],
  mentionUserIds: string[],
  pingPrefix: string,
): string | undefined {
  const parts: string[] = [];

  if (mentionUserIds.length > 0) {
    const mentions = mentionUserIds.map((id) => `<@${id}>`).join(' ');
    parts.push(pingPrefix ? `${pingPrefix} ${mentions}` : mentions);
  }

  for (const content of existingContents) {
    const trimmed = content.trim();
    if (trimmed) parts.push(trimmed);
  }

  if (parts.length === 0) return undefined;

  const combined = parts.join('\n');
  if (combined.length <= DISCORD_MAX_CONTENT_LENGTH) {
    return combined;
  }
  return `${combined.slice(0, DISCORD_MAX_CONTENT_LENGTH - 1)}…`;
}

function addUpdateToMediaGroups(
  mediaGroups: Map<string, MediaEmbedGroup>,
  passthroughEmbeds: DiscordEmbed[],
  update: ParsedMediaUpdate,
): void {
  if (update.eventCategory === 'other' || !update.title) {
    if (update.discordPayload.embeds?.length) {
      passthroughEmbeds.push(...update.discordPayload.embeds);
    }
    return;
  }

  const groupKey = `${update.mediaKey ?? update.title.toLowerCase()}::${update.eventCategory}`;
  let group = mediaGroups.get(groupKey);
  if (!group) {
    group = {
      title: update.title,
      year: update.year,
      mediaType: update.mediaType,
      eventCategory: update.eventCategory,
      episodes: [],
      imageUrl: update.imageUrl,
      url: update.url,
    };
    mediaGroups.set(groupKey, group);
  } else {
    if (!group.year && update.year) group.year = update.year;
    if (!group.imageUrl && update.imageUrl) group.imageUrl = update.imageUrl;
    if (!group.url && update.url) group.url = update.url;
  }

  if (update.episodes.length > 0) {
    group.episodes.push(...update.episodes);
  }
}

function materializeEmbeds(
  mediaGroups: Map<string, MediaEmbedGroup>,
  passthroughEmbeds: DiscordEmbed[],
): DiscordEmbed[] {
  const embeds: DiscordEmbed[] = [];
  for (const group of mediaGroups.values()) {
    embeds.push(
      buildSeerrStyleEmbed({
        title: group.title,
        year: group.year,
        mediaType: group.mediaType,
        eventCategory: group.eventCategory,
        episodes: group.episodes,
        imageUrl: group.imageUrl,
        url: group.url,
      }),
    );
  }
  embeds.push(...passthroughEmbeds);
  return embeds;
}

export class WebhookAggregator {
  private readonly store: FavouritesStore;
  private readonly debouncer: PingDebouncer;
  private readonly discord: DiscordWebhookClient;
  private readonly aggregationWindowMs: number;
  private readonly pingOnEvents: Set<MediaEventCategory>;
  private readonly pingPrefix: string;
  private readonly logger?: Logger;

  private readonly pendingBatches = new Map<string, PendingBatch>();

  constructor(options: WebhookAggregatorOptions) {
    this.store = options.store;
    this.debouncer = options.debouncer;
    this.discord = options.discord;
    this.aggregationWindowMs = options.aggregationWindowMs;
    this.pingOnEvents = options.pingOnEvents;
    this.pingPrefix = options.pingPrefix?.trim() ?? '';
    this.logger = options.logger;
  }

  async handle(webhookUrl: string, update: ParsedMediaUpdate): Promise<HandleWebhookResult> {
    let matchedUsers: string[] = [];
    let pingedUsers: string[] = [];
    let debouncedUsers: string[] = [];

    if (this.pingOnEvents.has(update.eventCategory)) {
      matchedUsers = this.store.findDiscordUsersForMedia({
        mediaType: update.mediaType,
        providerIds: update.providerIds,
        title: update.title,
      });

      if (matchedUsers.length > 0) {
        const mediaKey = update.mediaKey ?? `unknown:${update.source}:${update.title ?? 'media'}`;
        pingedUsers = this.debouncer.filterAndRecord(mediaKey, matchedUsers);
        const pingedSet = new Set(pingedUsers);
        debouncedUsers = matchedUsers.filter((id) => !pingedSet.has(id));

        this.logger?.info('Processed favourite media update', {
          source: update.source,
          title: update.title,
          mediaKey,
          eventCategory: update.eventCategory,
          matchedCount: matchedUsers.length,
          pingedCount: pingedUsers.length,
          debouncedCount: debouncedUsers.length,
        });
      } else {
        this.logger?.debug('No users have favourited media; forwarding without pings', {
          source: update.source,
          title: update.title,
          eventCategory: update.eventCategory,
        });
      }
    }

    if (this.aggregationWindowMs <= 0) {
      const mediaGroups = new Map<string, MediaEmbedGroup>();
      const passthroughEmbeds: DiscordEmbed[] = [];
      addUpdateToMediaGroups(mediaGroups, passthroughEmbeds, update);

      const payload = this.buildFinalPayload(
        update.discordPayload.username,
        update.discordPayload.avatar_url,
        update.discordPayload.content ? [update.discordPayload.content] : [],
        materializeEmbeds(mediaGroups, passthroughEmbeds),
        pingedUsers,
      );
      await this.discord.send(webhookUrl, payload);
      return {
        queued: false,
        matchedUsers,
        pingedUsers,
        debouncedUsers,
      };
    }

    const batchKey = `${webhookUrl}::${update.discordPayload.username ?? update.source}`;
    let batch = this.pendingBatches.get(batchKey);

    if (!batch) {
      const timer = setTimeout(() => {
        void this.flushBatch(batchKey);
      }, this.aggregationWindowMs);
      timer.unref?.();

      batch = {
        webhookUrl,
        username: update.discordPayload.username,
        avatarUrl: update.discordPayload.avatar_url,
        contents: [],
        mediaGroups: new Map(),
        passthroughEmbeds: [],
        mentionsToInject: new Set(),
        timer,
      };
      this.pendingBatches.set(batchKey, batch);
    }

    if (update.discordPayload.content) {
      batch.contents.push(update.discordPayload.content);
    }
    addUpdateToMediaGroups(batch.mediaGroups, batch.passthroughEmbeds, update);
    if (!batch.avatarUrl && update.discordPayload.avatar_url) {
      batch.avatarUrl = update.discordPayload.avatar_url;
    }
    for (const userId of pingedUsers) {
      batch.mentionsToInject.add(userId);
    }

    return {
      queued: true,
      matchedUsers,
      pingedUsers,
      debouncedUsers,
    };
  }

  private buildFinalPayload(
    username: string | undefined,
    avatarUrl: string | undefined,
    existingContents: string[],
    embeds: DiscordEmbed[],
    mentionUserIds: string[],
  ): DiscordWebhookPayload {
    const content = buildContentWithMentions(existingContents, mentionUserIds, this.pingPrefix);
    const payload: DiscordWebhookPayload = {};

    if (username) payload.username = username;
    if (avatarUrl) payload.avatar_url = avatarUrl;
    if (content) payload.content = content;
    if (embeds.length > 0) payload.embeds = embeds;
    if (mentionUserIds.length > 0) {
      payload.allowed_mentions = {
        users: mentionUserIds,
      };
    }

    return payload;
  }

  async flushBatch(batchKey: string): Promise<void> {
    const batch = this.pendingBatches.get(batchKey);
    if (!batch) return;

    clearTimeout(batch.timer);
    this.pendingBatches.delete(batchKey);

    const embeds = materializeEmbeds(batch.mediaGroups, batch.passthroughEmbeds);
    const payload = this.buildFinalPayload(
      batch.username,
      batch.avatarUrl,
      batch.contents,
      embeds,
      [...batch.mentionsToInject],
    );

    try {
      await this.discord.send(batch.webhookUrl, payload);
    } catch (err) {
      this.logger?.error('Failed to forward aggregated Discord webhook', {
        error: err instanceof Error ? err.message : String(err),
        embedCount: embeds.length,
      });
    }
  }

  async flushAll(): Promise<void> {
    const keys = [...this.pendingBatches.keys()];
    await Promise.all(keys.map((key) => this.flushBatch(key)));
  }

  get pendingCount(): number {
    return this.pendingBatches.size;
  }
}
