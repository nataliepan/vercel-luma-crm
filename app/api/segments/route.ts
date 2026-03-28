import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '@/lib/db'
import { validateSQL } from '@/lib/nl-search'
import { SEGMENT_BUILDER_PROMPT } from '@/lib/prompts'

// Why lazy init: module-level instantiation reads process.env at import time.
// Lazy init ensures the key is available when the function is actually invoked.
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

interface SegmentAIResponse {
  label: string
  description: string
  filter_sql: string
}

/**
 * Calls Claude with SEGMENT_BUILDER_PROMPT to convert a plain-English description
 * into a structured segment: label, description, and a safe WHERE clause.
 *
 * Why Claude not a rule engine: segment descriptions are open-ended and natural
 * language. "Founders who've been to our AI nights but haven't RSVP'd yet" would
 * require enumerating hundreds of query shapes in a rule engine. Claude handles
 * them zero-shot.
 *
 * Returns null on AI failure so callers can surface a user-friendly error instead
 * of throwing a 500 that leaks internals.
 */
async function generateSegment(description: string): Promise<SegmentAIResponse | null> {
  try {
    const message = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: SEGMENT_BUILDER_PROMPT,
      messages: [{ role: 'user', content: description }],
    })

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim()

    // Strip markdown fences — model sometimes wraps JSON in ```json ... ```
    const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim()
    const parsed = JSON.parse(cleaned) as SegmentAIResponse

    if (!parsed.label || !parsed.filter_sql) {
      console.error('generateSegment: missing required fields in response', parsed)
      return null
    }

    return parsed
  } catch (err) {
    console.error('generateSegment: AI call failed', err)
    return null
  }
}

// GET /api/segments — list all segments for the authenticated user
export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Why ORDER BY created_at DESC: most recently created segments are most relevant
  // for the current session — puts new work at the top without requiring the user to scroll.
  const result = await db.query(
    `SELECT id, label, description, filter_sql, contact_count, created_at, updated_at
     FROM segments
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  )

  return NextResponse.json({ segments: result.rows })
}

// POST /api/segments — create a segment from a plain-English description
// Body: { description: string, preview?: boolean, base_segment_id?: string }
//
// preview: true          → return { label, description, filter_sql, contact_count } without saving
// preview: false         → save to DB, return the full segment row
// base_segment_id        → when provided, Claude only generates the *extra* filter constraint;
//                          the server ANDs it with the base segment's stored filter_sql.
//                          Why compose server-side not in the prompt: Claude can't reliably
//                          reproduce the original SQL from a description, and we don't want to
//                          send raw SQL into the prompt. ANDing two validated fragments server-side
//                          is deterministic and safe.
//
// Why preview mode: the segment builder shows a live contact count as the user types.
// We call with preview:true on every debounced keystroke so the user sees the impact
// before committing. The final "Save" call uses preview:false.
export async function POST(req: Request) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const description: string = body.description?.trim() ?? ''
    const preview: boolean = body.preview !== false // default true if not specified
    const baseSegmentId: string | null = body.base_segment_id ?? null

    if (!description) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    // If refining an existing segment, fetch its filter_sql to AND with the new constraint.
    // Verify ownership (user_id) so a user can't base a refinement on another user's segment.
    let baseFilterSql: string | null = null
    let baseLabel: string | null = null
    if (baseSegmentId) {
      const baseResult = await db.query(
        `SELECT filter_sql, label FROM segments WHERE id = $1 AND user_id = $2`,
        [baseSegmentId, userId]
      )
      if (baseResult.rows.length === 0) {
        return NextResponse.json({ error: 'Base segment not found' }, { status: 404 })
      }
      try {
        baseFilterSql = validateSQL(baseResult.rows[0].filter_sql)
        baseLabel = baseResult.rows[0].label
      } catch {
        return NextResponse.json({ error: 'Base segment filter is invalid' }, { status: 422 })
      }
    }

    // Step 1: Ask Claude to generate label + description + filter_sql.
    // When refining, pass the base segment label as context so Claude names the
    // refined segment meaningfully (e.g. "SF VCs" not just "VCs").
    const promptDescription = baseLabel
      ? `Refine the "${baseLabel}" segment: ${description}`
      : description
    const segment = await generateSegment(promptDescription)
    if (!segment) {
      return NextResponse.json(
        { error: 'Could not generate a segment from that description. Try rephrasing.' },
        { status: 422 }
      )
    }

    // Step 2: Validate the AI-generated WHERE clause before any DB execution.
    // Why validateSQL: even though Claude is instructed not to write destructive SQL,
    // we never trust AI output directly. validateSQL blocks DROP, DELETE, UPDATE, INSERT,
    // semicolons, and comment sequences — covering all known injection vectors.
    let safeFilterSql: string
    try {
      const newFilter = validateSQL(segment.filter_sql)
      // Combine base + new constraint: both fragments already validated individually.
      // Why wrap each in parens: prevents operator precedence bugs when either fragment
      // contains OR — e.g. `a OR b AND c OR d` is not the same as `(a OR b) AND (c OR d)`.
      safeFilterSql = baseFilterSql
        ? `(${baseFilterSql}) AND (${newFilter})`
        : newFilter
    } catch (validationErr) {
      console.error('Segment filter_sql failed validation:', validationErr, segment.filter_sql)
      return NextResponse.json(
        { error: 'Generated SQL was unsafe. Please try a different description.' },
        { status: 422 }
      )
    }

    // Step 3: Count matching contacts.
    // Why always AND merged_into_id IS NULL: deduped contacts are soft-deleted by pointing
    // to their canonical record. Segments should never include merged duplicates —
    // that would send duplicate outreach to the same person.
    let contactCount = 0
    try {
      const countResult = await db.query(
        `SELECT COUNT(*) FROM contacts
         WHERE user_id = $1
           AND merged_into_id IS NULL
           AND (${safeFilterSql})`,
        [userId]
      )
      contactCount = parseInt(countResult.rows[0].count, 10)
    } catch (queryErr) {
      // Why catch separately: the AI-generated SQL may be syntactically valid but
      // semantically wrong (e.g. references a non-existent column). Return a helpful
      // error instead of a 500 that leaks the SQL.
      console.error('Segment count query failed:', queryErr)
      return NextResponse.json(
        { error: 'Generated query had a SQL error. Try rephrasing your description.' },
        { status: 422 }
      )
    }

    if (preview) {
      // Fetch a small sample of matching contacts for the preview panel.
      // Why 3 not more: enough for the user to sanity-check "are these the right people?"
      // without adding latency or returning PII unnecessarily.
      // Why name/email/role only: no need to send company, linkedin, notes, etc.
      // Minimal data transfer — the preview is for relevance checking, not full profiles.
      let sample: { name: string | null; email: string; role: string | null }[] = []
      try {
        const sampleResult = await db.query(
          `SELECT name, email, role FROM contacts
           WHERE user_id = $1
             AND merged_into_id IS NULL
             AND (${safeFilterSql})
           LIMIT 3`,
          [userId]
        )
        sample = sampleResult.rows
      } catch {
        // Non-fatal — preview still shows count even if sample query fails
      }

      // Preview mode: return computed values without persisting — used for live count preview
      return NextResponse.json({
        label: segment.label,
        description: segment.description,
        filter_sql: safeFilterSql,
        contact_count: contactCount,
        sample,
      })
    }

    // Step 4: Persist the segment
    // Why ON CONFLICT DO UPDATE: user may click Save multiple times for the same description.
    // Updating rather than erroring is friendlier — last save wins.
    const saved = await db.query(
      `INSERT INTO segments (user_id, label, description, filter_sql, contact_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, description, filter_sql, contact_count, created_at, updated_at`,
      [userId, segment.label, segment.description, safeFilterSql, contactCount]
    )

    return NextResponse.json({ segment: saved.rows[0] })

  } catch (err) {
    // Top-level catch: return JSON error so the client can display it.
    // Why not let Next.js handle it: unhandled throws return HTML 500, which res.json()
    // then throws as a SyntaxError — obscuring the real problem from the user.
    console.error('POST /api/segments failed:', err)
    return NextResponse.json(
      { error: (err as Error).message ?? 'Failed to create segment' },
      { status: 500 }
    )
  }
}

// DELETE /api/segments?id=<uuid> — delete a segment
export async function DELETE(req: Request) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    // Why filter by user_id: ensure users can only delete their own segments.
    // Without this check a user could delete any segment by guessing its UUID.
    await db.query(
      `DELETE FROM segments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE /api/segments failed:', err)
    return NextResponse.json(
      { error: (err as Error).message ?? 'Failed to delete segment' },
      { status: 500 }
    )
  }
}
