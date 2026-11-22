import { describe, expect, it } from 'vitest';
import { parseIncomingWebhook } from '../src/services/webhookParser.js';

describe('parseIncomingWebhook', () => {
  it('parses a Sonarr Discord embed webhook with TVDB/IMDb links', () => {
    const payload = {
      username: 'Sonarr',
      embeds: [
        {
          author: { name: 'Sonarr' },
          title: 'Breaking Bad - 1x01 - Pilot',
          description: 'Episode Imported',
          fields: [
            { name: 'Quality', value: 'Bluray-1080p', inline: true },
            {
              name: 'Links',
              value:
                '[TheTVDB](https://thetvdb.com/dereferer/series/81189) / [IMDb](https://www.imdb.com/title/tt0903747)',
            },
          ],
        },
      ],
    };

    const parsed = parseIncomingWebhook(payload);
    expect(parsed.source).toBe('sonarr');
    expect(parsed.mediaType).toBe('series');
    expect(parsed.eventCategory).toBe('added');
    expect(parsed.title).toBe('Breaking Bad');
    expect(parsed.providerIds).toEqual({
      tvdb: '81189',
      imdb: 'tt0903747',
    });
    expect(parsed.mediaKey).toBe('tvdb:81189');
  });

  it('parses a Radarr Discord embed upgrade webhook with TMDb link', () => {
    const payload = {
      username: 'Radarr',
      embeds: [
        {
          author: { name: 'Radarr' },
          title: 'Inception (2010)',
          description: 'Movie Upgraded',
          fields: [
            {
              name: 'Links',
              value:
                '[TMDb](https://www.themoviedb.org/movie/27205) / [IMDb](https://imdb.com/title/tt1375666)',
            },
          ],
        },
      ],
    };

    const parsed = parseIncomingWebhook(payload);
    expect(parsed.source).toBe('radarr');
    expect(parsed.mediaType).toBe('movie');
    expect(parsed.eventCategory).toBe('upgraded');
    expect(parsed.title).toBe('Inception');
    expect(parsed.year).toBe(2010);
    expect(parsed.providerIds).toEqual({
      tmdb: '27205',
      imdb: 'tt1375666',
    });
    expect(parsed.mediaKey).toBe('tmdb:movie:27205');
  });

  it('classifies deleted and test Discord embeds correctly', () => {
    const deleted = parseIncomingWebhook({
      username: 'Sonarr',
      embeds: [
        {
          title: 'Severance - 2x03 - Who Is Alive?',
          description: 'Episode Deleted',
        },
      ],
    });
    expect(deleted.eventCategory).toBe('deleted');
    expect(deleted.title).toBe('Severance');
    expect(deleted.mediaKey).toBe('title:series:severance');

    const testMsg = parseIncomingWebhook({
      username: 'Sonarr',
      embeds: [
        {
          title: 'Test Message',
          description: 'This is a test message from Sonarr',
        },
      ],
    });
    expect(testMsg.eventCategory).toBe('other');
  });

  it('transforms raw Sonarr Download/Upgrade webhook into Discord embed payload', () => {
    const raw = {
      eventType: 'Download',
      isUpgrade: true,
      series: {
        title: 'Andor',
        year: 2022,
        tvdbId: 393189,
        tmdbId: 83867,
        imdbId: 'tt9253284',
      },
      episodes: [
        {
          seasonNumber: 2,
          episodeNumber: 4,
          title: 'Ever Been to Ghorman?',
        },
      ],
      episodeFile: {
        quality: 'WEBDL-2160p',
      },
    };

    const parsed = parseIncomingWebhook(raw);
    expect(parsed.source).toBe('sonarr');
    expect(parsed.mediaType).toBe('series');
    expect(parsed.eventCategory).toBe('upgraded');
    expect(parsed.providerIds).toEqual({
      tvdb: '393189',
      tmdb: '83867',
      imdb: 'tt9253284',
    });
    expect(parsed.discordPayload.username).toBe('Sonarr');
    expect(parsed.discordPayload.embeds?.[0]?.title).toBe('Andor - S02E04 - Ever Been to Ghorman?');
    expect(parsed.discordPayload.embeds?.[0]?.description).toBe('Episode Upgraded');
  });

  it('transforms raw Radarr MovieFileDelete webhook into Discord embed payload', () => {
    const raw = {
      eventType: 'MovieFileDelete',
      deleteReason: 'manual',
      movie: {
        title: 'Dune: Part Two',
        year: 2024,
        tmdbId: 693134,
        imdbId: 'tt15239678',
      },
    };

    const parsed = parseIncomingWebhook(raw);
    expect(parsed.source).toBe('radarr');
    expect(parsed.mediaType).toBe('movie');
    expect(parsed.eventCategory).toBe('deleted');
    expect(parsed.discordPayload.embeds?.[0]?.title).toBe('Dune: Part Two (2024)');
    expect(parsed.discordPayload.embeds?.[0]?.description).toBe('Movie Deleted');
  });
});
