import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { validateSQL } from '@/lib/nl-search'

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
