import type {
  ArrSource,
  DiscordEmbed,
  DiscordWebhookPayload,
  MediaEventCategory,
  MediaType,
  ParsedMediaUpdate,
  ProviderIds,
} from '../types.js';
import { normalizeTitle } from './favouritesStore.js';

interface RawSonarrRadarrPayload {
  eventType?: string;
  isUpgrade?: boolean;
  series?: {
    title?: string;
    year?: number;
    tvdbId?: number | string;
    tmdbId?: number | string;
    imdbId?: string;
  };
  episodes?: Array<{
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string;
    overview?: string;
  }>;
  episodeFile?: {
    quality?: string;
    relativePath?: string;
  };
  movie?: {
    title?: string;
    year?: number;
    tmdbId?: number | string;
    imdbId?: string;
    overview?: string;
  };
  movieFile?: {
    quality?: string;
    relativePath?: string;
  };
  release?: {
    quality?: string;
    releaseTitle?: string;
  };
  deleteReason?: string;
}

const IMDB_REGEX = /imdb\.com\/title\/(tt\d+)/i;
const TVDB_REGEX =
  /thetvdb\.com\/(?:dereferer\/series\/|series\/|\?tab=series&(?:amp;)?id=)(\d+)/i;
const TMDB_REGEX = /themoviedb\.org\/(tv|movie)\/(\d+)/i;

function extractProviderIdsFromText(text: string): {
  providerIds: ProviderIds;
  tmdbMediaType?: 'series' | 'movie';
} {
  const providerIds: ProviderIds = {};
  let tmdbMediaType: 'series' | 'movie' | undefined;

  const imdbMatch = text.match(IMDB_REGEX);
  if (imdbMatch?.[1]) {
    providerIds.imdb = imdbMatch[1].toLowerCase();
  }

  const tvdbMatch = text.match(TVDB_REGEX);
  if (tvdbMatch?.[1]) {
    providerIds.tvdb = tvdbMatch[1];
  }

  const tmdbMatch = text.match(TMDB_REGEX);
  if (tmdbMatch?.[1] && tmdbMatch?.[2]) {
    providerIds.tmdb = tmdbMatch[2];
    tmdbMediaType = tmdbMatch[1].toLowerCase() === 'movie' ? 'movie' : 'series';
  }

  return { providerIds, tmdbMediaType };
}

function collectEmbedText(payload: DiscordWebhookPayload): string {
  const parts: string[] = [];
  if (payload.content) parts.push(payload.content);
  for (const embed of payload.embeds ?? []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.url) parts.push(embed.url);
    if (embed.author?.name) parts.push(embed.author.name);
    if (embed.author?.url) parts.push(embed.author.url);
    if (embed.footer?.text) parts.push(embed.footer.text);
    for (const field of embed.fields ?? []) {
      parts.push(field.name, field.value);
    }
  }
  return parts.join('\n');
}

function detectSourceFromDiscordPayload(
  payload: DiscordWebhookPayload,
  hint?: ArrSource,
  tmdbMediaType?: 'series' | 'movie',
  hasTvdb?: boolean,
): ArrSource {
  if (hint && hint !== 'unknown') return hint;

  const checkStrings = [
    payload.username ?? '',
    ...(payload.embeds ?? []).map((e) => e.author?.name ?? ''),
    ...(payload.embeds ?? []).map((e) => e.footer?.text ?? ''),
  ]
    .join(' ')
    .toLowerCase();

  if (checkStrings.includes('sonarr')) return 'sonarr';
  if (checkStrings.includes('radarr')) return 'radarr';
  if (hasTvdb || tmdbMediaType === 'series') return 'sonarr';
  if (tmdbMediaType === 'movie') return 'radarr';

  // Check episode patterns like "1x01" or "S01E01" in embed titles
  const titles = (payload.embeds ?? []).map((e) => e.title ?? '').join(' ');
  if (/\b(?:\d+x\d+|S\d{1,2}E\d{1,3})\b/i.test(titles)) {
    return 'sonarr';
  }

  return 'unknown';
}

function classifyDiscordEvent(payload: DiscordWebhookPayload): MediaEventCategory {
  const headerText = [
    payload.content ?? '',
    ...(payload.embeds ?? []).map((e) => e.title ?? ''),
    ...(payload.embeds ?? []).map((e) => e.description ?? ''),
    ...(payload.embeds ?? []).map((e) => e.author?.name ?? ''),
  ]
    .join(' ')
    .toLowerCase();

  if (
    /\b(test message|health issue|health restored|application update|manual interaction)\b/.test(
      headerText,
    )
  ) {
    return 'other';
  }

  if (/\b(deleted|removed|episode deleted|movie deleted|series deleted)\b/.test(headerText)) {
    return 'deleted';
  }

  if (/\b(upgraded|upgrade)\b/.test(headerText)) {
    return 'upgraded';
  }

  if (/\b(grabbed|grab)\b/.test(headerText)) {
    return 'grab';
  }

  if (/\b(imported|downloaded|added|available)\b/.test(headerText)) {
    return 'added';
  }

  // Sonarr/Radarr Discord import embeds often omit the word "Imported" and just have
  // title "Show Name - 1x01 - Ep Title" or "Movie Name (2024)" with Quality/Links fields.
  const hasEmbed = (payload.embeds?.length ?? 0) > 0;
  return hasEmbed ? 'added' : 'other';
}

function extractTitleFromEmbed(
  embed: DiscordEmbed | undefined,
  mediaType: MediaType,
): { title?: string; year?: number } {
  const rawTitle = embed?.title?.trim();
  if (!rawTitle) return {};

  let cleaned = rawTitle;

  // Strip common event suffixes like " - Imported", " - Upgraded", " - Deleted", " - Grabbed"
  cleaned = cleaned.replace(
    /\s*[-–—]\s*(?:episode\s+)?(?:imported|downloaded|upgraded|deleted|grabbed|added)\s*$/i,
    '',
  );

  // Strip Sonarr episode suffix: "Show Name - 1x02 - Ep Title" or "Show Name - S01E02..."
  if (mediaType !== 'movie') {
    cleaned = cleaned.replace(/\s*[-–—]\s*(?:\d+x\d+|S\d{1,2}E\d{1,3}).*$/i, '');
  }

  // Extract optional trailing "(YYYY)" year
  let year: number | undefined;
  const yearMatch = cleaned.match(/\s*\((\d{4})\)\s*$/);
  if (yearMatch?.[1]) {
    year = Number.parseInt(yearMatch[1], 10);
    cleaned = cleaned.slice(0, yearMatch.index).trim();
  }

  return { title: cleaned || undefined, year };
}

export function buildMediaKey(
  mediaType: MediaType,
  providerIds: ProviderIds,
  title?: string,
): string | undefined {
  if (providerIds.tvdb) return `tvdb:${providerIds.tvdb}`;
  if (providerIds.tmdb) return `tmdb:${mediaType}:${providerIds.tmdb}`;
  if (providerIds.imdb) return `imdb:${providerIds.imdb.toLowerCase()}`;
  if (title) {
    const norm = normalizeTitle(title);
    if (norm) return `title:${mediaType}:${norm}`;
  }
  return undefined;
}

function isRawArrPayload(body: Record<string, unknown>): body is RawSonarrRadarrPayload & Record<string, unknown> {
  return (
    typeof body.eventType === 'string' &&
    !Array.isArray(body.embeds) &&
    typeof body.content !== 'string'
  );
}

function classifyRawArrEvent(payload: RawSonarrRadarrPayload): MediaEventCategory {
  const event = (payload.eventType ?? '').toLowerCase();
  if (event === 'download') {
    return payload.isUpgrade ? 'upgraded' : 'added';
  }
  if (event === 'upgrade') return 'upgraded';
  if (event === 'seriesadd' || event === 'movieadded') return 'added';
  if (
    event === 'episodefiledelete' ||
    event === 'seriesdelete' ||
    event === 'moviedelete' ||
    event === 'moviefiledelete'
  ) {
    return 'deleted';
  }
  if (event === 'grab') return 'grab';
  return 'other';
}

function formatEpisodeCode(season?: number, episode?: number): string {
  const s = String(season ?? 0).padStart(2, '0');
  const e = String(episode ?? 0).padStart(2, '0');
  return `S${s}E${e}`;
}

function buildEmbedForRawArrPayload(
  payload: RawSonarrRadarrPayload,
  source: ArrSource,
  category: MediaEventCategory,
): DiscordWebhookPayload {
  const colors: Record<MediaEventCategory, number> = {
    added: 0x2ecc71,
    upgraded: 0x3498db,
    deleted: 0xe74c3c,
    grab: 0xf1c40f,
    other: 0x95a5a6,
  };

  const actionLabels: Record<MediaEventCategory, string> = {
    added: 'Imported',
    upgraded: 'Upgraded',
    deleted: 'Deleted',
    grab: 'Grabbed',
    other: payload.eventType ?? 'Notification',
  };

  if (payload.series) {
    const seriesTitle = payload.series.title ?? 'Unknown Series';
    const episodes = payload.episodes ?? [];
    let title = seriesTitle;
    if (episodes.length === 1) {
      const ep = episodes[0];
      title = `${seriesTitle} - ${formatEpisodeCode(ep.seasonNumber, ep.episodeNumber)}${ep.title ? ` - ${ep.title}` : ''}`;
    } else if (episodes.length > 1) {
      const first = episodes[0];
      const last = episodes[episodes.length - 1];
      title = `${seriesTitle} - ${formatEpisodeCode(first.seasonNumber, first.episodeNumber)}-${formatEpisodeCode(last.seasonNumber, last.episodeNumber)} (${episodes.length} episodes)`;
    }

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    const quality = payload.episodeFile?.quality ?? payload.release?.quality;
    if (quality) {
      fields.push({ name: 'Quality', value: quality, inline: true });
    }
    if (payload.deleteReason) {
      fields.push({ name: 'Reason', value: payload.deleteReason, inline: true });
    }

    const links: string[] = [];
    if (payload.series.tvdbId) {
      links.push(`[TheTVDB](https://thetvdb.com/dereferer/series/${payload.series.tvdbId})`);
    }
    if (payload.series.imdbId) {
      links.push(`[IMDb](https://www.imdb.com/title/${payload.series.imdbId})`);
    }
    if (payload.series.tmdbId) {
      links.push(`[TMDb](https://www.themoviedb.org/tv/${payload.series.tmdbId})`);
    }
    if (links.length > 0) {
      fields.push({ name: 'Links', value: links.join(' / '), inline: false });
    }

    return {
      username: source === 'radarr' ? 'Radarr' : 'Sonarr',
      embeds: [
        {
          author: { name: 'Sonarr' },
          title,
          description: `Episode ${actionLabels[category]}`,
          color: colors[category],
          fields: fields.length > 0 ? fields : undefined,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  if (payload.movie) {
    const movieTitle = payload.movie.title ?? 'Unknown Movie';
    const title = payload.movie.year ? `${movieTitle} (${payload.movie.year})` : movieTitle;
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    const quality = payload.movieFile?.quality ?? payload.release?.quality;
    if (quality) {
      fields.push({ name: 'Quality', value: quality, inline: true });
    }
    if (payload.deleteReason) {
      fields.push({ name: 'Reason', value: payload.deleteReason, inline: true });
    }

    const links: string[] = [];
    if (payload.movie.tmdbId) {
      links.push(`[TMDb](https://www.themoviedb.org/movie/${payload.movie.tmdbId})`);
    }
    if (payload.movie.imdbId) {
      links.push(`[IMDb](https://www.imdb.com/title/${payload.movie.imdbId})`);
    }
    if (links.length > 0) {
      fields.push({ name: 'Links', value: links.join(' / '), inline: false });
    }

    return {
      username: 'Radarr',
      embeds: [
        {
          author: { name: 'Radarr' },
          title,
          description: `Movie ${actionLabels[category]}`,
          color: colors[category],
          fields: fields.length > 0 ? fields : undefined,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  return {
    username: source === 'radarr' ? 'Radarr' : source === 'sonarr' ? 'Sonarr' : 'Arr Notify',
    embeds: [
      {
        title: payload.eventType ?? 'Notification',
        color: colors[category],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function parseIncomingWebhook(
  body: unknown,
  sourceHint: ArrSource = 'unknown',
): ParsedMediaUpdate {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Webhook body must be a JSON object');
  }

  const record = body as Record<string, unknown>;

  if (isRawArrPayload(record)) {
    const providerIds: ProviderIds = {};
    let mediaType: MediaType = 'unknown';
    let source: ArrSource = sourceHint;
    let title: string | undefined;
    let year: number | undefined;

    if (record.series) {
      mediaType = 'series';
      source = 'sonarr';
      title = record.series.title;
      year = record.series.year;
      if (record.series.tvdbId != null) providerIds.tvdb = String(record.series.tvdbId);
      if (record.series.tmdbId != null) providerIds.tmdb = String(record.series.tmdbId);
      if (record.series.imdbId) providerIds.imdb = record.series.imdbId.toLowerCase();
    } else if (record.movie) {
      mediaType = 'movie';
      source = 'radarr';
      title = record.movie.title;
      year = record.movie.year;
      if (record.movie.tmdbId != null) providerIds.tmdb = String(record.movie.tmdbId);
      if (record.movie.imdbId) providerIds.imdb = record.movie.imdbId.toLowerCase();
    }

    const eventCategory = classifyRawArrEvent(record);
    const discordPayload = buildEmbedForRawArrPayload(record, source, eventCategory);
    const mediaKey = buildMediaKey(mediaType, providerIds, title);

    return {
      source,
      mediaType,
      eventCategory,
      title,
      year,
      providerIds,
      mediaKey,
      discordPayload,
    };
  }

  // Discord-formatted webhook payload (e.g. from Sonarr / Radarr Discord connector)
  const discordPayload = record as DiscordWebhookPayload;
  const fullText = collectEmbedText(discordPayload);
  const { providerIds, tmdbMediaType } = extractProviderIdsFromText(fullText);

  const source = detectSourceFromDiscordPayload(
    discordPayload,
    sourceHint,
    tmdbMediaType,
    Boolean(providerIds.tvdb),
  );

  const mediaType: MediaType =
    tmdbMediaType ?? (source === 'sonarr' ? 'series' : source === 'radarr' ? 'movie' : 'unknown');

  const eventCategory = classifyDiscordEvent(discordPayload);
  const { title, year } = extractTitleFromEmbed(discordPayload.embeds?.[0], mediaType);
  const mediaKey = buildMediaKey(mediaType, providerIds, title);

  return {
    source,
    mediaType,
    eventCategory,
    title,
    year,
    providerIds,
    mediaKey,
    discordPayload: {
      ...discordPayload,
      embeds: discordPayload.embeds ? [...discordPayload.embeds] : undefined,
    },
  };
}
