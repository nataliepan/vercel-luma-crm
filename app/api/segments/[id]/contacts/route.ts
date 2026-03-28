import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { validateSQL, generateWhereClause } from '@/lib/nl-search'

// GET /api/segments/[id]/contacts
// Returns all contacts matching the segment's filter_sql.
//
// Why a dedicated route not reusing /api/contacts: the segment filter is stored
// server-side (filter_sql column). The client should never need to send raw SQL —
// it just sends the segment ID and the server looks up and executes the filter.
// This also means validateSQL() runs on the stored clause at query time, not just
// at segment creation — defense in depth against any SQL that slipped through.
//
// Why no pagination: segments are used for outreach and export, not browsing.
// The caller needs the full list to copy emails or download a CSV. LIMIT 2000
// is a safety ceiling — real communities at this scale are well under that.
const SEGMENT_CONTACT_LIMIT = 2000

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch the segment — also verifies ownership via user_id
  const segmentResult = await db.query(
    `SELECT filter_sql, label FROM segments WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  if (segmentResult.rows.length === 0) {
    return NextResponse.json({ error: 'Segment not found' }, { status: 404 })
  }

  const { filter_sql, label } = segmentResult.rows[0]

  // Re-validate stored SQL on every execution — belt-and-suspenders.
  // Why: filter_sql was validated on creation but defense in depth matters.
  // A future schema change or DB migration could theoretically introduce
  // a row with unvalidated SQL. This ensures the guard always runs.
  let safeSQL: string
  try {
    safeSQL = validateSQL(filter_sql)
  } catch {
    return NextResponse.json({ error: 'Segment filter is invalid' }, { status: 422 })
  }

  const result = await db.query(
    // Phone is not a promoted column — Luma exports it under various raw headers
    // ('phone', 'Phone Number', 'Mobile', etc.) which land in raw_fields JSONB.
    // COALESCE tries common key names in order of likelihood. Returns null if none present.
    `SELECT id, name, email, given_email, company, role, linkedin_url, created_at,
            COALESCE(
              raw_fields->>'phone',
              raw_fields->>'Phone',
              raw_fields->>'Phone Number',
              raw_fields->>'phone_number',
              raw_fields->>'Mobile',
              raw_fields->>'mobile'
            ) AS phone
     FROM contacts
     WHERE user_id = $1
       AND merged_into_id IS NULL
       AND (${safeSQL})
     ORDER BY name NULLS LAST, email
     LIMIT $2`,
    [userId, SEGMENT_CONTACT_LIMIT]
  )

  return NextResponse.json({
    contacts: result.rows,
    label,
    total: result.rows.length,
    capped: result.rows.length === SEGMENT_CONTACT_LIMIT,
  })
}

// POST /api/segments/[id]/contacts
// Body: { description: string }
//
// Refines the segment contact list in-place: generates a new WHERE clause from
// the plain-English description, ANDs it with the segment's stored filter_sql,
// and returns the matching contacts — same shape as GET so the client can swap
// them in directly.
//
// Why a POST on the contacts sub-route rather than re-using /api/segments preview:
// the preview endpoint returns only 3 sample contacts. Here the caller needs the
// full list (for copy-emails and export). A dedicated endpoint keeps the response
// contract identical to GET so the card component has no branching logic.
//
// Why not save this as a new segment automatically: the user is just browsing a
// narrowed view. If they want to persist it they can use the segment builder.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const body = await req.json()
    const description: string = body.description?.trim() ?? ''

    if (!description) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    // Fetch and validate the base segment's stored filter — also confirms ownership.
    const segmentResult = await db.query(
      `SELECT filter_sql, label FROM segments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )
    if (segmentResult.rows.length === 0) {
      return NextResponse.json({ error: 'Segment not found' }, { status: 404 })
    }

    const { filter_sql, label } = segmentResult.rows[0]

    let baseSQL: string
    try {
      baseSQL = validateSQL(filter_sql)
    } catch {
      return NextResponse.json({ error: 'Segment filter is invalid' }, { status: 422 })
    }

    // Ask Claude to generate a WHERE fragment for the refinement description.
    // Why generateWhereClause not a raw prompt: it uses the full NL_SEARCH_PROMPT
    // schema context (contact_events, coupon_code, amount, custom_responses, etc.)
    // so "used coupon" correctly maps to coupon_code IS NOT NULL.
    let extraFilter: string
    try {
      extraFilter = await generateWhereClause(description)
    } catch {
      return NextResponse.json(
        { error: 'Could not generate a filter from that description. Try rephrasing.' },
        { status: 422 }
      )
    }

    let extraSQL: string
    try {
      extraSQL = validateSQL(extraFilter)
    } catch {
      return NextResponse.json(
        { error: 'Generated SQL was unsafe. Try a different description.' },
        { status: 422 }
      )
    }

    // Combine base + refinement. Wrap each in parens to prevent OR precedence bugs.
    const combinedSQL = `(${baseSQL}) AND (${extraSQL})`

    let result
    try {
      result = await db.query(
        `SELECT id, name, email, given_email, company, role, linkedin_url, created_at,
                COALESCE(
                  raw_fields->>'phone',
                  raw_fields->>'Phone',
                  raw_fields->>'Phone Number',
                  raw_fields->>'phone_number',
                  raw_fields->>'Mobile',
                  raw_fields->>'mobile'
                ) AS phone
         FROM contacts
         WHERE user_id = $1
           AND merged_into_id IS NULL
           AND (${combinedSQL})
         ORDER BY name NULLS LAST, email
         LIMIT $2`,
        [userId, SEGMENT_CONTACT_LIMIT]
      )
    } catch (queryErr) {
      console.error('Segment refine query failed:', queryErr)
      return NextResponse.json(
        { error: 'Generated query had a SQL error. Try rephrasing.' },
        { status: 422 }
      )
    }

    return NextResponse.json({
      contacts: result.rows,
      label,
      total: result.rows.length,
      capped: result.rows.length === SEGMENT_CONTACT_LIMIT,
    })
  } catch (err) {
    console.error('POST /api/segments/[id]/contacts failed:', err)
    return NextResponse.json(
      { error: (err as Error).message ?? 'Failed to refine contacts' },
      { status: 500 }
    )
  }
}
