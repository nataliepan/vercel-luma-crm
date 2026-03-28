import { NextResponse } from 'next/server'
import { dbDirect } from '@/lib/db'
import { dedupForUser } from '@/lib/dedup'

// Why maxDuration=300: dedup processes contacts in chunks of 2000 with vector
// similarity queries. At scale with multiple users, this can take several minutes.
export const maxDuration = 300

export async function GET(req: Request) {
  // Why verify CRON_SECRET: Vercel sets this header automatically on cron invocations.
  // Without this check, anyone could trigger the dedup cron and cause unnecessary DB load.
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Find all users with pending/running dedup jobs or unchecked contacts.
    // Process each independently so one user's failure doesn't block others.
    const users = await dbDirect.query(`
      SELECT DISTINCT user_id FROM dedup_jobs WHERE status IN ('pending', 'running')
      UNION
      SELECT DISTINCT user_id FROM contacts
      WHERE merged_into_id IS NULL AND embedding IS NOT NULL AND last_dedup_checked_at IS NULL
    `)

    const results: Array<{ userId: string; processed: number; pairsFound: number; done: boolean }> = []

    for (const row of users.rows) {
      try {
        const result = await dedupForUser(row.user_id)
        results.push({ userId: row.user_id, ...result })
      } catch (err) {
        console.error(`Dedup cron failed for user ${row.user_id}:`, err)
        results.push({ userId: row.user_id, processed: 0, pairsFound: 0, done: false })
      }
    }

    return NextResponse.json({ usersProcessed: results.length, results })
  } catch (err) {
    console.error('Dedup cron failed:', err)
    return NextResponse.json(
      { error: 'Cron job failed', detail: (err as Error).message },
      { status: 500 }
    )
  }
}
