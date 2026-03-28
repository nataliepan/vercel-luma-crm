import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { checkForHallucinations, type ContactRecord } from '@/lib/prompts'
import { rateLimit } from '@/lib/rate-limit'
import { logAICall } from '@/lib/ai-log'

// POST /api/outreach/check — run hallucination detection on a completed draft.
//
// Why a separate endpoint not inline in the streaming route: the outreach route
// streams the draft in real-time. Running a hallucination check inline would
// either (a) block the stream until both calls finish, or (b) require buffering
// the entire response and checking before sending — negating the streaming UX.
//
// Instead, the client calls this endpoint after the stream completes, displaying
// any flags as a warning banner the user can review before copying/sending.

export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Shares the outreach rate limit bucket — this is also an AI call
  const { allowed, resetMs } = rateLimit(`${userId}:outreach`, 20)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests — please wait a moment' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(resetMs / 1000)) } }
    )
  }

  let body: { draft?: string; contact?: ContactRecord }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { draft, contact } = body
  if (!draft?.trim() || !contact) {
    return NextResponse.json({ error: 'draft and contact are required' }, { status: 400 })
  }

  try {
    const startMs = Date.now()
    const result = await checkForHallucinations(draft, contact)

    logAICall({
      userId,
      feature: 'hallucination_check',
      input: draft,
      output: JSON.stringify(result),
      model: 'claude-sonnet-4-6',
      durationMs: Date.now() - startMs,
    })

    return NextResponse.json(result)
  } catch (err) {
    console.error('POST /api/outreach/check error:', err)
    // Hallucination check is non-critical — if it fails, return unflagged
    // so the draft is still usable. The user can re-check manually.
    return NextResponse.json({ flagged: false, issues: [] })
  }
}
