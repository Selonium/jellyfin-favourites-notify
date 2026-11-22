import type {
  ArrSource,
  DiscordEmbed,
  DiscordWebhookPayload,
  EpisodeRef,
  MediaEventCategory,
  MediaType,
  ParsedMediaUpdate,
  ProviderIds,
} from '../types.js';
import { normalizeTitle } from './favouritesStore.js';

interface RawArrImage {
  coverType?: string;
  remoteUrl?: string;
  url?: string;
}

interface RawSonarrRadarrPayload {
  eventType?: string;
  isUpgrade?: boolean;
  series?: {
    title?: string;
    year?: number;
    tvdbId?: number | string;
    tmdbId?: number | string;
    imdbId?: string;
    images?: RawArrImage[];
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
    images?: RawArrImage[];
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

  const hasEmbed = (payload.embeds?.length ?? 0) > 0;
  return hasEmbed ? 'added' : 'other';
}

export function extractEpisodesFromText(text: string): EpisodeRef[] {
  const episodes: EpisodeRef[] = [];
  const seen = new Set<string>();

  const pushEpisode = (season: number, episode: number) => {
    const key = `${season}:${episode}`;
    if (!seen.has(key)) {
      seen.add(key);
      episodes.push({ season, episode });
    }
  };

  // Match S01E01-E03, S01E01-S01E03, S01E01-03, S01E01
  const sePattern = /\bS(\d{1,2})E(\d{1,3})(?:\s*[-–—]\s*(?:S(\d{1,2}))?E?(\d{1,3}))?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = sePattern.exec(text)) !== null) {
    const startSeason = Number.parseInt(match[1], 10);
    const startEp = Number.parseInt(match[2], 10);
    const endSeason = match[3] ? Number.parseInt(match[3], 10) : startSeason;
    const endEp = match[4] ? Number.parseInt(match[4], 10) : startEp;

    if (endSeason === startSeason && endEp >= startEp && endEp - startEp <= 200) {
      for (let ep = startEp; ep <= endEp; ep++) {
        pushEpisode(startSeason, ep);
      }
    } else {
      pushEpisode(startSeason, startEp);
      pushEpisode(endSeason, endEp);
    }
  }

  if (episodes.length > 0) {
    return episodes;
  }

  // Match 1x01-03, 1x01-1x03, 1x01
  const xPattern = /\b(\d{1,2})x(\d{1,3})(?:\s*[-–—]\s*(?:(\d{1,2})x)?(\d{1,3}))?\b/gi;
  while ((match = xPattern.exec(text)) !== null) {
    const startSeason = Number.parseInt(match[1], 10);
    const startEp = Number.parseInt(match[2], 10);
    const endSeason = match[3] ? Number.parseInt(match[3], 10) : startSeason;
    const endEp = match[4] ? Number.parseInt(match[4], 10) : startEp;

    if (endSeason === startSeason && endEp >= startEp && endEp - startEp <= 200) {
      for (let ep = startEp; ep <= endEp; ep++) {
        pushEpisode(startSeason, ep);
      }
    } else {
      pushEpisode(startSeason, startEp);
      pushEpisode(endSeason, endEp);
    }
  }

  return episodes;
}

function extractTitleFromEmbed(
  embed: DiscordEmbed | undefined,
  mediaType: MediaType,
): { title?: string; year?: number } {
  const rawTitle = embed?.title?.trim();
  if (!rawTitle) return {};

  let cleaned = rawTitle;

  cleaned = cleaned.replace(
    /\s*[-–—]\s*(?:episode\s+)?(?:imported|downloaded|upgraded|deleted|grabbed|added)\s*$/i,
    '',
  );

  if (mediaType !== 'movie') {
    cleaned = cleaned.replace(/\s*[-–—]\s*(?:\d+x\d+|S\d{1,2}E\d{1,3}).*$/i, '');
  }

  let year: number | undefined;
  const yearMatch = cleaned.match(/\s*\((\d{4})\)\s*$/);
  if (yearMatch?.[1]) {
    year = Number.parseInt(yearMatch[1], 10);
    cleaned = cleaned.slice(0, yearMatch.index).trim();
  }

  return { title: cleaned || undefined, year };
}

function extractImageFromRawImages(images?: RawArrImage[]): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const poster = images.find(
    (img) => img.coverType?.toLowerCase() === 'poster' && (img.remoteUrl || img.url),
  );
  const candidate = poster ?? images.find((img) => img.remoteUrl || img.url);
  return candidate?.remoteUrl || candidate?.url || undefined;
}

function extractImageFromEmbeds(embeds?: DiscordEmbed[]): string | undefined {
  for (const embed of embeds ?? []) {
    const url = embed.thumbnail?.url || embed.image?.url;
    if (url) return url;
  }
  return undefined;
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

function isRawArrPayload(
  body: Record<string, unknown>,
): body is RawSonarrRadarrPayload & Record<string, unknown> {
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

export function formatEpisodeCode(season: number, episode: number): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `S${s}E${e}`;
}

export function formatEpisodeRange(episodes: EpisodeRef[]): string | undefined {
  if (episodes.length === 0) return undefined;

  const unique = new Map<string, EpisodeRef>();
  for (const ep of episodes) {
    unique.set(`${ep.season}:${ep.episode}`, ep);
  }

  const sorted = [...unique.values()].sort((a, b) =>
    a.season !== b.season ? a.season - b.season : a.episode - b.episode,
  );

  const ranges: string[] = [];
  let runStart = sorted[0];
  let runEnd = sorted[0];

  const flushRun = () => {
    if (runStart.season === runEnd.season && runStart.episode === runEnd.episode) {
      ranges.push(formatEpisodeCode(runStart.season, runStart.episode));
    } else {
      ranges.push(
        `${formatEpisodeCode(runStart.season, runStart.episode)}–${formatEpisodeCode(runEnd.season, runEnd.episode)}`,
      );
    }
  };

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    if (current.season === runEnd.season && current.episode === runEnd.episode + 1) {
      runEnd = current;
    } else {
      flushRun();
      runStart = current;
      runEnd = current;
    }
  }
  flushRun();

  return ranges.join(', ');
}

const EVENT_COLORS: Record<MediaEventCategory, number> = {
  added: 0x2ecc71,
  upgraded: 0x3498db,
  deleted: 0xe74c3c,
  grab: 0xf1c40f,
  other: 0x95a5a6,
};

const EVENT_LABELS: Record<MediaEventCategory, string> = {
  added: 'Added',
  upgraded: 'Upgraded',
  deleted: 'Deleted',
  grab: 'Grabbed',
  other: 'Updated',
};

export function buildSeerrStyleEmbed(params: {
  title: string;
  year?: number;
  mediaType: MediaType;
  eventCategory: MediaEventCategory;
  episodes: EpisodeRef[];
  imageUrl?: string;
  url?: string;
  timestamp?: string;
}): DiscordEmbed {
  const displayTitle = params.year ? `${params.title} (${params.year})` : params.title;
  const actionLabel = EVENT_LABELS[params.eventCategory];
  const episodeRange = formatEpisodeRange(params.episodes);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: 'Modification',
      value: actionLabel,
      inline: true,
    },
  ];

  if (episodeRange) {
    fields.push({
      name: params.episodes.length === 1 ? 'Episode' : 'Episodes',
      value: episodeRange,
      inline: true,
    });
  }

  const embed: DiscordEmbed = {
    title: displayTitle,
    color: EVENT_COLORS[params.eventCategory],
    fields,
    timestamp: params.timestamp ?? new Date().toISOString(),
  };

  if (params.url) {
    embed.url = params.url;
  }

  if (params.imageUrl) {
    embed.thumbnail = { url: params.imageUrl };
  }

  return embed;
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
    let imageUrl: string | undefined;
    const episodes: EpisodeRef[] = [];

    if (record.series) {
      mediaType = 'series';
      source = 'sonarr';
      title = record.series.title;
      year = record.series.year;
      imageUrl = extractImageFromRawImages(record.series.images);
      if (record.series.tvdbId != null) providerIds.tvdb = String(record.series.tvdbId);
      if (record.series.tmdbId != null) providerIds.tmdb = String(record.series.tmdbId);
      if (record.series.imdbId) providerIds.imdb = record.series.imdbId.toLowerCase();

      for (const ep of record.episodes ?? []) {
        if (typeof ep.seasonNumber === 'number' && typeof ep.episodeNumber === 'number') {
          episodes.push({
            season: ep.seasonNumber,
            episode: ep.episodeNumber,
            title: ep.title,
          });
        }
      }
    } else if (record.movie) {
      mediaType = 'movie';
      source = 'radarr';
      title = record.movie.title;
      year = record.movie.year;
      imageUrl = extractImageFromRawImages(record.movie.images);
      if (record.movie.tmdbId != null) providerIds.tmdb = String(record.movie.tmdbId);
      if (record.movie.imdbId) providerIds.imdb = record.movie.imdbId.toLowerCase();
    }

    const eventCategory = classifyRawArrEvent(record);
    const mediaKey = buildMediaKey(mediaType, providerIds, title);
    const username = source === 'radarr' ? 'Radarr' : source === 'sonarr' ? 'Sonarr' : 'Arr Notify';

    const embed =
      eventCategory !== 'other' && title
        ? buildSeerrStyleEmbed({
            title,
            year,
            mediaType,
            eventCategory,
            episodes,
            imageUrl,
          })
        : {
            title: record.eventType ?? 'Notification',
            color: EVENT_COLORS[eventCategory],
            timestamp: new Date().toISOString(),
          };

    return {
      source,
      mediaType,
      eventCategory,
      title,
      year,
      episodes,
      imageUrl,
      providerIds,
      mediaKey,
      discordPayload: {
        username,
        embeds: [embed],
      },
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
  const firstEmbed = discordPayload.embeds?.[0];
  const { title, year } = extractTitleFromEmbed(firstEmbed, mediaType);
  const imageUrl = extractImageFromEmbeds(discordPayload.embeds);
  const url = firstEmbed?.url;
  const episodes =
    mediaType !== 'movie'
      ? (discordPayload.embeds ?? []).flatMap((e) => extractEpisodesFromText(e.title ?? ''))
      : [];
  const mediaKey = buildMediaKey(mediaType, providerIds, title);

  return {
    source,
    mediaType,
    eventCategory,
    title,
    year,
    episodes,
    imageUrl,
    url,
    providerIds,
    mediaKey,
    discordPayload: {
      ...discordPayload,
      embeds: discordPayload.embeds ? [...discordPayload.embeds] : undefined,
    },
  };
}
