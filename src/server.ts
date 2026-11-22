import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { WebhookAggregator } from './services/aggregator.js';
import type { FavouritesStore } from './services/favouritesStore.js';
import { parseIncomingWebhook } from './services/webhookParser.js';
import type { ArrSource } from './types.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const DISCORD_PROXY_ROUTE = /^\/api\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,120})$/;

export interface ServerDependencies {
  config: AppConfig;
  store: FavouritesStore;
  aggregator: WebhookAggregator;
  logger?: Logger;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        reject(new Error('Empty request body'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

export function createAppServer(deps: ServerDependencies): Server {
  const { config, store, aggregator, logger } = deps;

  return createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    try {
      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          sync: store.getStatus(),
          pendingBatches: aggregator.pendingCount,
        });
        return;
      }

      if (method === 'GET' && pathname === '/users') {
        sendJson(res, 200, {
          users: store.getMappedUsers(),
        });
        return;
      }

      if (method === 'POST' && pathname === '/sync') {
        const status = await store.sync();
        sendJson(res, 200, { status: 'synced', sync: status });
        return;
      }

      if (method === 'POST') {
        let targetDiscordUrl: string | undefined;
        let sourceHint: ArrSource = 'unknown';

        if (pathname === '/webhook') {
          targetDiscordUrl = config.discordWebhookUrl;
        } else if (pathname === '/webhook/sonarr') {
          targetDiscordUrl = config.discordWebhookUrl;
          sourceHint = 'sonarr';
        } else if (pathname === '/webhook/radarr') {
          targetDiscordUrl = config.discordWebhookUrl;
          sourceHint = 'radarr';
        } else {
          const proxyMatch = pathname.match(DISCORD_PROXY_ROUTE);
          if (proxyMatch) {
            const [, webhookId, webhookToken] = proxyMatch;
            if (
              config.allowedDiscordWebhookIds.size > 0 &&
              !config.allowedDiscordWebhookIds.has(webhookId)
            ) {
              sendJson(res, 403, { error: 'Discord webhook ID is not allowed' });
              return;
            }
            const query = parsedUrl.search || '';
            targetDiscordUrl = `https://discord.com/api/webhooks/${webhookId}/${webhookToken}${query}`;
          }
        }

        if (targetDiscordUrl !== undefined || pathname.startsWith('/webhook')) {
          if (!targetDiscordUrl) {
            sendJson(res, 500, {
              error: 'DISCORD_WEBHOOK_URL is not configured on this server',
            });
            return;
          }

          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Invalid request body';
            const statusCode = message === 'Payload too large' ? 413 : 400;
            sendJson(res, statusCode, { error: message });
            return;
          }

          const parsed = parseIncomingWebhook(body, sourceHint);
          const result = await aggregator.handle(targetDiscordUrl, parsed);

          sendJson(res, result.queued ? 202 : 200, {
            ok: true,
            source: parsed.source,
            mediaType: parsed.mediaType,
            eventCategory: parsed.eventCategory,
            title: parsed.title,
            queued: result.queued,
            pingedUsers: result.pingedUsers.length,
            debouncedUsers: result.debouncedUsers.length,
          });
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error('Unhandled request error', { method, pathname, error: message });
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      }
    }
  });
}
