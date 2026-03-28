import { NextResponse } from 'next/server'

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

  // TODO: step 12 will wire in runDedupJob() here.
  // Pattern will mirror /api/cron/embed: query all users with unchecked contacts,
  // create/resume dedup_jobs for each, run incrementally in chunks of 2000.
  return NextResponse.json({ message: 'Dedup cron placeholder — not yet implemented' })
}
