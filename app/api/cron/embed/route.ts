import { NextResponse } from 'next/server'
import { dbDirect } from '@/lib/db'
import { embedPendingContacts } from '@/lib/embeddings'

// Why maxDuration=300: nightly cron processes all users' pending embeddings.
// At scale, multiple users with bulk imports could take several minutes.
export const maxDuration = 300

export async function GET(req: Request) {
  // Why verify CRON_SECRET: Vercel sets this header automatically on cron invocations.
  // Without this check, anyone could trigger the cron endpoint manually and run up
  // OpenAI costs or cause unnecessary DB load.
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Find all users with pending embeddings — process each independently
    // so one user's failure doesn't block others.
    const users = await dbDirect.query(
      `SELECT DISTINCT user_id FROM contacts WHERE embedding_status = 'pending'`
    )

    const results: Array<{ userId: string; processed: number; failed: number; total: number }> = []

    for (const row of users.rows) {
      try {
        const result = await embedPendingContacts(row.user_id)
        results.push({ userId: row.user_id, ...result })
      } catch (err) {
        console.error(`Embedding cron failed for user ${row.user_id}:`, err)
        results.push({ userId: row.user_id, processed: 0, failed: -1, total: 0 })
      }
    }

    return NextResponse.json({ usersProcessed: results.length, results })
  } catch (err) {
    console.error('Embedding cron failed:', err)
    return NextResponse.json(
      { error: 'Cron job failed', detail: (err as Error).message },
      { status: 500 }
    )
  }
}
