import Anthropic from '@anthropic-ai/sdk'
import { db } from './db'
import { NL_SEARCH_PROMPT } from './prompts'
import { logAICall } from './ai-log'

// Why lazy init: instantiating at module load reads process.env at import time.
// In tests, setupFiles sets env vars before tests run but after module evaluation.
// A getter ensures the key is read when the function is actually called.
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// Patterns that must never appear in AI-generated WHERE clauses.
// Why this list: the AI generates a SQL fragment that gets injected into a
// parameterized query. Even though the caller enforces user_id = $1, a
// malicious or hallucinated clause could mutate or exfiltrate data.
// These keywords cover all destructive SQL operations.
const FORBIDDEN_PATTERNS = [
  /\bDROP\b/i,
  /\bDELETE\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\b/i,
  /\bEXEC\b/i,
  /\bEXECUTE\b/i,
  /;/,           // statement terminator — blocks multi-statement injection
  /--/,          // line comment — blocks comment-based injection
  /\/\*/,        // block comment open
]

/**
 * Validates an AI-generated WHERE clause fragment.
 * Throws if any forbidden pattern is found.
 * Returns the clause unchanged if safe.
 *
 * Why throw not return null: callers must handle the error explicitly.
 * Silent failure (returning an empty clause) could expose all contacts.
 */
export function validateSQL(clause: string): string {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(clause)) {
      throw new Error(
        `Generated SQL contains forbidden pattern: ${pattern.toString()}`
      )
    }
  }
  return clause
}

/**
 * Sends a natural language query to Claude and returns a safe WHERE clause
 * fragment for the contacts table.
 *
 * Why Claude not a regex/rule engine: contact queries are open-ended
 * ("YC founders who came to 3+ events" involves JOIN + COUNT logic).
 * A rule engine would need to enumerate all possible query shapes up front.
 * Claude handles novel phrasings zero-shot.
 *
 * Why we return only the WHERE body (not full SQL): never let AI write
 * full queries. The caller owns the SELECT, FROM, LIMIT, and user_id filter.
 * Restricting the AI to a WHERE fragment limits its blast radius.
 */
export async function generateWhereClause(query: string): Promise<string> {
  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: NL_SEARCH_PROMPT,
    messages: [{ role: 'user', content: query }],
  })

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  // Strip markdown code fences if the model wrapped the SQL in them
  const cleaned = text.replace(/^```(?:sql)?\n?/i, '').replace(/\n?```$/, '').trim()

  return cleaned
}

/**
 * Full NL search pipeline: generate → validate → query, with trigram fallback.
 *
 * Why fallback to trigram search: if the AI fails or produces invalid SQL,
 * the user still gets results — just less precise. Never show a search error;
 * degrade gracefully. The GIN trigram indexes make the fallback fast at 200k.
 */
export async function searchContacts(query: string, userId: string) {
  try {
    const startMs = Date.now()
    const whereClause = await generateWhereClause(query)
    const validated = validateSQL(whereClause)

    logAICall({
      userId, feature: 'nl_search', input: query, output: validated,
      model: 'claude-sonnet-4-6', durationMs: Date.now() - startMs,
    })

    // Why SET LOCAL probes=1: interactive search prioritises speed over recall.
    // Dedup uses probes=10 for higher recall; search users tolerate a few misses.
    return await db.query(
      `SET LOCAL ivfflat.probes = 1;
       SELECT id, name, email, company, role, embedding_status, created_at
       FROM contacts
       WHERE user_id = $1
         AND merged_into_id IS NULL
         AND (${validated})
       LIMIT 500`,
      [userId]
    )
  } catch (err) {
    console.error('NL search failed, falling back to trigram search:', err)
    logAICall({
      userId, feature: 'nl_search', input: query,
      model: 'claude-sonnet-4-6', error: (err as Error).message,
    })

    return await db.query(
      `SELECT id, name, email, company, role, embedding_status, created_at
       FROM contacts
       WHERE user_id = $1
         AND merged_into_id IS NULL
         AND (
           name    ILIKE $2 OR
           email   ILIKE $2 OR
           company ILIKE $2 OR
           role    ILIKE $2
         )
       LIMIT 500`,
      [userId, `%${query}%`]
    )
  }
}
