import type { DiscordWebhookClient } from '../clients/discord.js';
import type { Logger } from '../logger.js';
import type {
  DiscordEmbed,
  DiscordWebhookPayload,
  MediaEventCategory,
  ParsedMediaUpdate,
} from '../types.js';
import type { PingDebouncer } from './debounce.js';
import type { FavouritesStore } from './favouritesStore.js';

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

interface PendingBatch {
  webhookUrl: string;
  username?: string;
  avatarUrl?: string;
  contents: string[];
  embeds: DiscordEmbed[];
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
      const payload = this.buildFinalPayload(
        update.discordPayload.username,
        update.discordPayload.avatar_url,
        update.discordPayload.content ? [update.discordPayload.content] : [],
        update.discordPayload.embeds ?? [],
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
        embeds: [],
        mentionsToInject: new Set(),
        timer,
      };
      this.pendingBatches.set(batchKey, batch);
    }

    if (update.discordPayload.content) {
      batch.contents.push(update.discordPayload.content);
    }
    if (update.discordPayload.embeds?.length) {
      batch.embeds.push(...update.discordPayload.embeds);
    }
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

    const payload = this.buildFinalPayload(
      batch.username,
      batch.avatarUrl,
      batch.contents,
      batch.embeds,
      [...batch.mentionsToInject],
    );

    try {
      await this.discord.send(batch.webhookUrl, payload);
    } catch (err) {
      this.logger?.error('Failed to forward aggregated Discord webhook', {
        error: err instanceof Error ? err.message : String(err),
        embedCount: batch.embeds.length,
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
