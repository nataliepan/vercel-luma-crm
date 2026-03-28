import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { validateSQL } from '@/lib/nl-search'

// POST /api/segments/[id]/refresh
// Reruns the segment's filter_sql against the current contacts table and
// updates the cached contact_count on the segment row.
//
// Why cache contact_count: avoids running the WHERE clause on every segments
// list page load. Stale by design — the user triggers refresh manually after
// importing new CSVs. At 200k contacts, even a fast indexed query takes ~50ms;
// running it for every segment on every page load multiplies that cost.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    const segmentResult = await db.query(
      `SELECT filter_sql FROM segments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )
    if (segmentResult.rows.length === 0) {
      return NextResponse.json({ error: 'Segment not found' }, { status: 404 })
    }

    const { filter_sql } = segmentResult.rows[0]

    let safeSQL: string
    try {
      safeSQL = validateSQL(filter_sql)
    } catch {
      return NextResponse.json({ error: 'Segment filter is invalid' }, { status: 422 })
    }
    const countResult = await db.query(
      `SELECT COUNT(*) FROM contacts
       WHERE user_id = $1 AND merged_into_id IS NULL AND (${safeSQL})`,
      [userId]
    )
    const newCount = parseInt(countResult.rows[0].count, 10)

    await db.query(
      `UPDATE segments SET contact_count = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
      [newCount, id, userId]
    )

    return NextResponse.json({ contact_count: newCount })
  } catch (err) {
    console.error('POST /api/segments/[id]/refresh error:', err)
    return NextResponse.json({ error: 'Failed to refresh segment count' }, { status: 500 })
  }
}
