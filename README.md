# jellyfin-favourites-notify

A lightweight Node.js / TypeScript middleware transformer that intercepts and aggregates incoming **Sonarr** and **Radarr** webhook POST requests targeted at **Discord**, monitors every **Jellyfin** user's favourite shows and movies, resolves their Discord user IDs via **Seerr** (Jellyseerr / Overseerr), and injects `<@userId>` mentions whenever a favourited show or movie is added, upgraded, or deleted.

## Features

- **Drop-in Discord Webhook Middleware**: Works as a transparent proxy for Sonarr/Radarr's built-in **Discord** connector (preserving all embeds, fields, and formatting), and also supports raw Sonarr/Radarr **Webhook** payloads by converting them into Discord embeds automatically.
- **Jellyfin Favourites Monitoring**: Periodically polls Jellyfin's `/Users` and `/Users/{userId}/Items?Filters=IsFavorite` endpoints using your API key, indexing favourite shows and movies by TVDB, TMDb, IMDb IDs, and normalized title fallback.
- **Seerr → Discord User Mapping**: Queries Seerr's `/api/v1/user` and `/api/v1/user/{id}/settings/notifications` endpoints to map each Jellyfin user to their linked Discord user ID(s) (`discordId` / `discordIds`).
- **Burst Aggregation**: Batches rapid flurries of incoming episode webhooks over a short configurable window (`AGGREGATION_WINDOW_SECONDS`, default `10s`) into combined Discord messages (automatically chunked at Discord's 10-embed limit).
- **1-Hour Ping Debounce**: Tracks `(media, discordUserId)` over a configurable 1-hour window (`PING_DEBOUNCE_SECONDS=3600`) so bulk episode imports won't repeatedly ping the same user for the same show—while still forwarding the embeds cleanly to Discord.
- **Zero Runtime Dependencies**: Runs directly on Node.js 22+ using native `http`, `fetch`, and `.env` loading.

## Quick Start

### 1. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `JELLYFIN_URL` — Base URL of your Jellyfin server (e.g. `http://jellyfin:8096`)
- `JELLYFIN_API_KEY` — Jellyfin API key (Dashboard → API Keys)
- `SEERR_URL` — Base URL of your Seerr / Jellyseerr instance (e.g. `http://seerr:5055`)
- `SEERR_API_KEY` — Seerr API key (Settings → General → API Key)
- `DISCORD_WEBHOOK_URL` — Default Discord webhook URL (required when using `/webhook`, `/webhook/sonarr`, or `/webhook/radarr`; optional if using the drop-in proxy route)

### 2. Run Locally

```bash
pnpm install
pnpm dev
```

Or build and run production JS:

```bash
pnpm build
pnpm start
```

### 3. Run with Docker Compose

```bash
docker compose up -d --build
```

## Connecting Sonarr & Radarr

You have two options in **Sonarr / Radarr → Settings → Connect → Discord**:

### Option A: Single Middleware Endpoint (Recommended)
Set `DISCORD_WEBHOOK_URL` in `.env`, then set the **Webhook URL** in Sonarr/Radarr's Discord connector to:
- Sonarr: `http://jellyfin-favourites-notify:3000/webhook/sonarr`
- Radarr: `http://jellyfin-favourites-notify:3000/webhook/radarr`

*(You can also point Sonarr/Radarr's generic **Webhook** connector to these same URLs.)*

### Option B: Drop-in Discord Proxy URL
Take your existing Discord webhook URL:
```
https://discord.com/api/webhooks/<WEBHOOK_ID>/<WEBHOOK_TOKEN>
```
and replace the host with this middleware:
```
http://jellyfin-favourites-notify:3000/api/webhooks/<WEBHOOK_ID>/<WEBHOOK_TOKEN>
```
Optionally set `ALLOWED_DISCORD_WEBHOOK_IDS` in `.env` to restrict which Discord webhook IDs can be proxied.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/webhook` | Receive Sonarr/Radarr webhook and forward to `DISCORD_WEBHOOK_URL` |
| `POST` | `/webhook/sonarr` | Same as `/webhook` with explicit Sonarr source hint |
| `POST` | `/webhook/radarr` | Same as `/webhook` with explicit Radarr source hint |
| `POST` | `/api/webhooks/:id/:token` | Drop-in Discord webhook proxy |
| `GET` | `/health` | Health check and latest Jellyfin/Seerr sync statistics |
| `GET` | `/users` | Inspect mapped Jellyfin users, Discord IDs, and favourite counts |
| `POST` | `/sync` | Trigger an immediate Jellyfin + Seerr refresh |

## Development & Testing

```bash
pnpm typecheck
pnpm test
pnpm build
```
