import type { DiscordEmbed, DiscordWebhookPayload } from '../types.js';
import type { Logger } from '../logger.js';

const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_RATE_LIMIT_RETRIES = 3;

export interface DiscordWebhookClientOptions {
  fetchImpl?: typeof fetch;
  logger?: Logger;
  sleepImpl?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkEmbeds(embeds: DiscordEmbed[]): DiscordEmbed[][] {
  if (embeds.length === 0) return [];
  const chunks: DiscordEmbed[][] = [];
  for (let i = 0; i < embeds.length; i += DISCORD_MAX_EMBEDS_PER_MESSAGE) {
    chunks.push(embeds.slice(i, i + DISCORD_MAX_EMBEDS_PER_MESSAGE));
  }
  return chunks;
}

export class DiscordWebhookClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: DiscordWebhookClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async send(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void> {
    const embeds = payload.embeds ?? [];
    if (embeds.length <= DISCORD_MAX_EMBEDS_PER_MESSAGE) {
      await this.postWithRetry(webhookUrl, payload);
      return;
    }

    const embedChunks = chunkEmbeds(embeds);
    for (let i = 0; i < embedChunks.length; i++) {
      const isFirst = i === 0;
      const chunkPayload: DiscordWebhookPayload = {
        username: payload.username,
        avatar_url: payload.avatar_url,
        embeds: embedChunks[i],
        ...(isFirst
          ? {
              content: payload.content,
              tts: payload.tts,
              allowed_mentions: payload.allowed_mentions,
            }
          : {}),
      };
      await this.postWithRetry(webhookUrl, chunkPayload);
    }
  }

  private async postWithRetry(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const res = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        return;
      }

      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        let retryAfterMs = 1000;
        const headerVal = res.headers.get('retry-after');
        if (headerVal) {
          const parsed = Number.parseFloat(headerVal);
          if (!Number.isNaN(parsed) && parsed > 0) {
            retryAfterMs = Math.ceil(parsed * 1000);
          }
        } else {
          try {
            const body = (await res.json()) as { retry_after?: number };
            if (typeof body.retry_after === 'number' && body.retry_after > 0) {
              retryAfterMs = Math.ceil(body.retry_after * 1000);
            }
          } catch {
            // Fall back to default retry delay
          }
        }

        this.logger?.warn('Discord webhook rate limited; retrying', {
          attempt: attempt + 1,
          retryAfterMs,
        });
        await this.sleepImpl(retryAfterMs);
        continue;
      }

      const errorText = await res.text().catch(() => '');
      throw new Error(
        `Discord webhook POST failed: ${res.status} ${res.statusText}${errorText ? ` - ${errorText}` : ''}`,
      );
    }
  }
}
