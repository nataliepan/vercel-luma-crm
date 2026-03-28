// In-memory sliding window rate limiter for AI endpoints.
//
// Why in-memory not Redis: avoids adding a dependency for MVP. This works
// correctly on a single Vercel function instance. In production with multiple
// concurrent instances, each instance tracks its own window — the effective
// limit is (limit × instances), which is looser but still prevents runaway
// costs from a single user. Swap to @vercel/ratelimit (Redis-backed) for
// strict enforcement at scale.
//
// Why sliding window not fixed window: fixed windows allow burst at the
// boundary (e.g. 20 requests at 0:59 + 20 at 1:00 = 40 in 2 seconds).
// Sliding window spreads the limit evenly.

type WindowEntry = {
  timestamps: number[]
}

const windows = new Map<string, WindowEntry>()

// Prune stale entries every 5 minutes to prevent unbounded memory growth.
// Why 5 min not 1 min: the map grows by O(active users) not O(requests).
// With <100 concurrent users, pruning every 5 min keeps it under ~100 entries.
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

let lastPruned = Date.now()
function pruneStale(windowMs: number) {
  const now = Date.now()
  if (now - lastPruned < PRUNE_INTERVAL_MS) return
  lastPruned = now
  const cutoff = now - windowMs
  for (const [key, entry] of windows) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff)
    if (entry.timestamps.length === 0) windows.delete(key)
  }
}

/**
 * Check if a request should be rate-limited.
 *
 * @param key    Unique identifier (typically `userId:endpoint`)
 * @param limit  Max requests allowed in the window
 * @param windowMs  Window duration in milliseconds (default 60s)
 * @returns { allowed: boolean, remaining: number, resetMs: number }
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number = 60_000
): { allowed: boolean; remaining: number; resetMs: number } {
  pruneStale(windowMs)

  const now = Date.now()
  const cutoff = now - windowMs
  let entry = windows.get(key)

  if (!entry) {
    entry = { timestamps: [] }
    windows.set(key, entry)
  }

  // Drop timestamps outside the current window
  entry.timestamps = entry.timestamps.filter(t => t > cutoff)

  if (entry.timestamps.length >= limit) {
    // Over limit — calculate when the oldest request in the window expires
    const resetMs = entry.timestamps[0] + windowMs - now
    return { allowed: false, remaining: 0, resetMs }
  }

  entry.timestamps.push(now)
  return {
    allowed: true,
    remaining: limit - entry.timestamps.length,
    resetMs: windowMs,
  }
}
