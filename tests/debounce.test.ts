import { describe, expect, it } from 'vitest';
import { PingDebouncer } from '../src/services/debounce.js';

describe('PingDebouncer', () => {
  it('suppresses repeat pings for the same media and user for 1 hour', () => {
    let nowMs = 1_000_000;
    const debouncer = new PingDebouncer({
      windowMs: 3_600_000, // 1 hour
      now: () => nowMs,
    });

    // First episode import -> both users pinged
    expect(debouncer.filterAndRecord('tvdb:81189', ['111', '222'])).toEqual(['111', '222']);

    // 10 minutes later -> flurry of episodes -> both suppressed
    nowMs += 10 * 60 * 1000;
    expect(debouncer.filterAndRecord('tvdb:81189', ['111', '222'])).toEqual([]);

    // New user 333 favourites the show 15 minutes in -> only 333 gets pinged
    nowMs += 5 * 60 * 1000;
    expect(debouncer.filterAndRecord('tvdb:81189', ['111', '222', '333'])).toEqual(['333']);

    // Different show -> 111 is NOT debounced
    expect(debouncer.filterAndRecord('tvdb:99999', ['111'])).toEqual(['111']);

    // 45 minutes later (total 60 min since first ping for 111/222, 45 min since 333)
    nowMs += 45 * 60 * 1000;
    expect(debouncer.filterAndRecord('tvdb:81189', ['111', '222', '333'])).toEqual(['111', '222']);
  });

  it('prunes expired entries automatically', () => {
    let nowMs = 0;
    const debouncer = new PingDebouncer({
      windowMs: 60_000,
      now: () => nowMs,
    });

    debouncer.filterAndRecord('tvdb:1', ['u1', 'u2']);
    expect(debouncer.size).toBe(2);

    nowMs = 60_000;
    expect(debouncer.prune()).toBe(2);
    expect(debouncer.size).toBe(0);
  });
});
