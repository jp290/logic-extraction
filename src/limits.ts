// Rate limits and the concurrent-job cap. All in-memory except the extraction limit,
// which counts rows so it survives restarts.

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;
export const MAX_EXTRACTIONS_PER_WINDOW = 6;
const MAX_CONCURRENT_JOBS = 5;

export type Limiter = (key: string) => boolean;

export function makeSlidingWindowLimiter(maxPerHour: number): Limiter {
  const buckets = new Map<string, number[]>();
  return (key) => {
    const now = Date.now();
    let timestamps = buckets.get(key) || [];
    timestamps = timestamps.filter((t) => now - t < HOUR_MS);
    if (timestamps.length === 0) buckets.delete(key);
    if (timestamps.length >= maxPerHour) return false;
    timestamps.push(now);
    buckets.set(key, timestamps);
    return true;
  };
}

export interface RateLimits {
  ask: Limiter;
  flag: Limiter;
  test: Limiter;
  merge: Limiter;
  upgrade: Limiter;
  interviewMessage: Limiter;
  interviewCreate: Limiter;
  packCreate: Limiter;
}

export function createRateLimits(): RateLimits {
  return {
    ask: makeSlidingWindowLimiter(30),
    flag: makeSlidingWindowLimiter(5),
    test: makeSlidingWindowLimiter(10),
    merge: makeSlidingWindowLimiter(3),
    upgrade: makeSlidingWindowLimiter(3),
    interviewMessage: makeSlidingWindowLimiter(60),
    interviewCreate: makeSlidingWindowLimiter(5),
    packCreate: makeSlidingWindowLimiter(10),
  };
}

export function checkExtractionRateLimit(db: Database, ipHash: string, windowMinutes: number): boolean {
  const row = db
    .query<{ cnt: number }, [string, number]>(
      `SELECT COUNT(*) as cnt FROM extractions
       WHERE ip_hash = ? AND created_at > datetime('now', '-' || ? || ' minutes')
       AND status != 'failed'`
    )
    .get(ipHash, windowMinutes);
  return !row || row.cnt < MAX_EXTRACTIONS_PER_WINDOW;
}

export class JobSlots {
  private active = 0;

  acquire(): boolean {
    if (this.active >= MAX_CONCURRENT_JOBS) return false;
    this.active++;
    return true;
  }

  release = (): void => {
    this.active = Math.max(0, this.active - 1);
  };
}

const VIEW_DEDUP_MS = 300_000;
const VIEW_EXPIRY_MS = 600_000;

/** Counts a lens view at most once per viewer per five minutes. */
export class ViewTracker {
  private recent = new Map<string, number>();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.recent) if (now - ts > VIEW_EXPIRY_MS) this.recent.delete(key);
    }, VIEW_DEDUP_MS).unref();
  }

  shouldCount(key: string): boolean {
    const now = Date.now();
    if (now - (this.recent.get(key) || 0) <= VIEW_DEDUP_MS) return false;
    this.recent.set(key, now);
    return true;
  }
}
