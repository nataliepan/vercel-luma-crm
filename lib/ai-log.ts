import { db } from './db'

// Lightweight AI call logging for audit trail and cost observability.
//
// Why log to DB not console: serverless function logs are ephemeral and hard
// to query. A DB table lets us answer "which user triggered the most AI calls
// this week?" or "did model output quality change after an upgrade?"
//
// Why fire-and-forget (no await): logging must never block or fail the user's
// request. If the DB insert fails, we log to console as a fallback — the
// user's action still succeeds.
//
// The ai_logs table is created lazily (see ensureTable). In production,
// run the migration; in dev, the table auto-creates on first log.

let tableChecked = false

async function ensureTable() {
  if (tableChecked) return
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     TEXT NOT NULL,
        feature     TEXT NOT NULL,
        input       TEXT,
        output      TEXT,
        model       TEXT,
        tokens_in   INTEGER,
        tokens_out  INTEGER,
        duration_ms INTEGER,
        error       TEXT,
        created_at  TIMESTAMPTZ DEFAULT now()
      )
    `)
    // Why no index on (user_id, feature, created_at) here: CREATE INDEX IF NOT
    // EXISTS inside a hot path risks lock contention. Add the index in a migration.
    tableChecked = true
  } catch (err) {
    console.error('ai_logs: failed to ensure table:', err)
  }
}

export type AILogEntry = {
  userId: string
  feature: 'outreach' | 'segment' | 'nl_search' | 'schema_map' | 'hallucination_check'
  input: string
  output?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  durationMs?: number
  error?: string
}

/**
 * Log an AI call. Fire-and-forget — never throws, never blocks the caller.
 */
export function logAICall(entry: AILogEntry): void {
  // Truncate input/output to prevent bloating the table.
  // Why 2000 chars: enough to reproduce the call for debugging,
  // small enough that 100k rows stay under 500MB.
  const truncate = (s: string | undefined, max: number) =>
    s && s.length > max ? s.slice(0, max) + '…[truncated]' : s

  void (async () => {
    try {
      await ensureTable()
      await db.query(
        `INSERT INTO ai_logs (user_id, feature, input, output, model, tokens_in, tokens_out, duration_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.userId,
          entry.feature,
          truncate(entry.input, 2000),
          truncate(entry.output, 2000),
          entry.model ?? null,
          entry.tokensIn ?? null,
          entry.tokensOut ?? null,
          entry.durationMs ?? null,
          truncate(entry.error, 500),
        ]
      )
    } catch (err) {
      // Fallback: console.error so the log isn't silently lost
      console.error('ai_logs: failed to insert:', err)
    }
  })()
}
