import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'

// Why a dedicated stats endpoint instead of inline queries in the page:
// the dashboard page uses Suspense with independent async RSC components.
// Each component fetches its own stat. But for the API-level fallback
// (e.g. client polling or SWR revalidation), a single endpoint that
// returns all stats in one round-trip is more efficient than 5 separate calls.

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Why parallel queries: these 5 counts hit different tables/indexes and don't
    // depend on each other. Running them concurrently cuts latency to the slowest
    // single query (~50ms) rather than summing all 5 (~250ms).
    const [contactsRes, eventsRes, segmentsRes, dedupRes, recentRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM contacts WHERE user_id = $1 AND merged_into_id IS NULL`,
        [userId]
      ),
      db.query(
        `SELECT COUNT(*) FROM events WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT COUNT(*) FROM segments WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT COUNT(*) FROM dedup_candidates WHERE user_id = $1 AND status = 'pending'`,
        [userId]
      ),
      // Why LIMIT 5: dashboard only shows a few recent contacts for a quick glance.
      // No need to fetch more — the full list lives at /contacts.
      db.query(
        `SELECT id, name, email, company, role, created_at
         FROM contacts
         WHERE user_id = $1 AND merged_into_id IS NULL
         ORDER BY created_at DESC
         LIMIT 5`,
        [userId]
      ),
    ])

    return NextResponse.json({
      contacts: parseInt(contactsRes.rows[0]?.count ?? '0', 10),
      events: parseInt(eventsRes.rows[0]?.count ?? '0', 10),
      segments: parseInt(segmentsRes.rows[0]?.count ?? '0', 10),
      dedupPending: parseInt(dedupRes.rows[0]?.count ?? '0', 10),
      recentContacts: recentRes.rows,
    })
  } catch (err) {
    console.error('GET /api/dashboard/stats error:', err)
    return NextResponse.json({ error: 'Failed to fetch dashboard stats' }, { status: 500 })
  }
}
