import OpenAI from 'openai'
import { dbDirect } from './db'

// Why Vercel AI Gateway: routes embedding requests through Vercel's gateway,
// which handles billing, rate limiting, and model routing. Credits are managed
// via Vercel billing instead of a separate OpenAI account.
// Why OpenAI's model: Anthropic has no embedding API. text-embedding-3-small
// is the industry standard — cheap ($0.02/M tokens), fast, 1536 dimensions.
const openai = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: 'https://ai-gateway.vercel.sh/v1',
})

// Why 2048: OpenAI's embedding API accepts up to 2048 inputs per call.
// Batching ~24k contacts = ~12 API calls instead of 24k individual calls.
// At 200k contacts: ~98 calls, one-time cost ~$4, then negligible on updates.
const CHUNK_SIZE = 2048

/**
 * Embed a specific set of contacts by ID.
 * Uses dbDirect (unpooled) because this is a long-running background job —
 * PgBouncer can't hold transactions open for minutes.
 */
export async function embedContactsBatch(contactIds: string[], userId: string) {
  const contacts = await dbDirect.query(
    `SELECT id, name, company, role, notes
     FROM contacts
     WHERE id = ANY($1) AND user_id = $2 AND embedding_status IN ('pending', 'failed')`,
    [contactIds, userId]
  )
  // Why omit email from embedding text: email isn't semantically meaningful
  // for similarity ("john@gmail.com" vs "john@company.com" — different strings,
  // same person). Embedding name+role+company+notes gives better clustering.

  if (contacts.rows.length === 0) return { processed: 0, failed: 0 }

  let totalProcessed = 0
  let totalFailed = 0

  const texts = contacts.rows.map((c: { name: string; role: string; company: string; notes: string }) => {
    const text = [c.name, c.role, c.company, c.notes].filter(Boolean).join(' ')
    // Why fallback to 'unknown': empty strings cause Azure OpenAI (via AI Gateway)
    // to reject the entire batch with '$.input is invalid'. A placeholder ensures
    // every input is non-empty while still producing a low-information embedding.
    return text || 'unknown'
  })

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE)
    const ids = contacts.rows.slice(i, i + CHUNK_SIZE).map((c: { id: string }) => c.id)

    try {
      const response = await openai.embeddings.create({
        model: 'openai/text-embedding-3-small',
        input: chunk,
      })

      // Why unnest bulk update: replaces 2048 sequential round-trips with 1 query.
      // At 200k contacts (~98 chunks), N+1 updates add ~3 minutes of pure DB write
      // time. The unnest approach does the same work in seconds.
      const vectors = response.data.map(d => `[${d.embedding.join(',')}]`)
      await dbDirect.query(`
        UPDATE contacts SET
          embedding = data.vec::vector,
          embedding_status = 'done',
          updated_at = now()
        FROM unnest($1::uuid[], $2::text[]) AS data(id, vec)
        WHERE contacts.id = data.id
      `, [ids, vectors])

      totalProcessed += ids.length
    } catch (err) {
      // Mark as failed — cron will retry. Why not throw: one failed chunk
      // shouldn't abort processing of the remaining chunks in this batch.
      await dbDirect.query(
        `UPDATE contacts SET embedding_status = 'failed' WHERE id = ANY($1)`,
        [ids]
      )
      totalFailed += ids.length
      console.error('Embedding chunk failed, marked for retry:', err)
    }
  }

  return { processed: totalProcessed, failed: totalFailed }
}

/**
 * Embed all pending contacts for a given user.
 * Queries pending IDs then delegates to embedContactsBatch.
 */
export async function embedPendingContacts(userId: string) {
  // Why also retry 'failed': failed embeddings would otherwise be stuck until
  // manually reset. The button and cron should retry them automatically.
  const pending = await dbDirect.query(
    `SELECT id FROM contacts
     WHERE user_id = $1 AND embedding_status IN ('pending', 'failed')
     ORDER BY created_at`,
    [userId]
  )

  if (pending.rows.length === 0) return { processed: 0, failed: 0, total: 0 }

  const ids = pending.rows.map((r: { id: string }) => r.id)
  const result = await embedContactsBatch(ids, userId)

  return { ...result, total: pending.rows.length }
}
