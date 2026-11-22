export interface PingDebouncerOptions {
  windowMs: number;
  now?: () => number;
}

export class PingDebouncer {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly lastPinged = new Map<string, number>();

  constructor(options: PingDebouncerOptions) {
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Filters the candidate Discord user IDs for a given media key,
   * returning only users who have not been pinged for this media within `windowMs`,
   * and records the ping timestamp for each returned user.
   */
  filterAndRecord(mediaKey: string, discordUserIds: Iterable<string>): string[] {
    const currentTime = this.now();
    this.prune(currentTime);

    const eligible: string[] = [];
    const seen = new Set<string>();

    for (const userId of discordUserIds) {
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);

      if (this.windowMs <= 0) {
        eligible.push(userId);
        continue;
      }

      const key = `${mediaKey}::${userId}`;
      const previous = this.lastPinged.get(key);
      if (previous === undefined || currentTime - previous >= this.windowMs) {
        this.lastPinged.set(key, currentTime);
        eligible.push(userId);
      }
    }

    return eligible;
  }

  /**
   * Checks whether a user is currently suppressed (debounced) for a given media key
   * without mutating state.
   */
  isDebounced(mediaKey: string, discordUserId: string): boolean {
    if (this.windowMs <= 0) return false;
    const previous = this.lastPinged.get(`${mediaKey}::${discordUserId}`);
    if (previous === undefined) return false;
    return this.now() - previous < this.windowMs;
  }

  prune(referenceTime: number = this.now()): number {
    if (this.windowMs <= 0) {
      const count = this.lastPinged.size;
      this.lastPinged.clear();
      return count;
    }

    let removed = 0;
    for (const [key, timestamp] of this.lastPinged.entries()) {
      if (referenceTime - timestamp >= this.windowMs) {
        this.lastPinged.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.lastPinged.size;
  }
}
