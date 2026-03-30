import { streamText } from 'ai'
import { anthropic } from '@/lib/ai'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { validateSQL } from '@/lib/nl-search'
import { OUTREACH_SYSTEM_PROMPT } from '@/lib/prompts'
import { rateLimit } from '@/lib/rate-limit'
import { logAICall } from '@/lib/ai-log'

// Why streamText not generateText: outreach drafts are 150-300 words.
// With generateText the user stares at a spinner for 3-5 seconds.
// Streaming shows the first words in ~300ms — dramatically better UX.
export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  // Rate limit: max 20 outreach drafts per minute per user.
  // Why 20/min: each draft costs ~$0.02 in Claude tokens. 20/min caps the
  // worst case at $0.40/min per user — enough for normal use, prevents abuse.
  const { allowed, remaining, resetMs } = rateLimit(`${userId}:outreach`, 20)
  if (!allowed) {
    return new Response('Too many requests — please wait a moment', {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil(resetMs / 1000)),
        'X-RateLimit-Remaining': '0',
      },
    })
  }

  let body: { segmentId?: string; context?: string; type?: string }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }
  const { segmentId, context, type } = body

  if (!segmentId || !context?.trim()) {
    return new Response('segmentId and context are required', { status: 400 })
  }

  // Fetch segment metadata + filter — also verifies ownership
  const segmentResult = await db.query(
    `SELECT label, description, filter_sql FROM segments WHERE id = $1 AND user_id = $2`,
    [segmentId, userId]
  )
  if (segmentResult.rows.length === 0) {
    return new Response('Segment not found', { status: 404 })
  }
  const { label, description, filter_sql } = segmentResult.rows[0]

  let safeSQL: string
  try {
    safeSQL = validateSQL(filter_sql)
  } catch {
    return new Response('Segment filter is invalid', { status: 422 })
  }

  // Fetch up to 10 contacts — only name/role/company, never email/phone/linkedin.
  // Why server-fetched not client-sent: we control exactly what PII reaches the model.
  const contactsResult = await db.query(
    `SELECT name, role, company
     FROM contacts
     WHERE user_id = $1
       AND merged_into_id IS NULL
       AND (${safeSQL})
     LIMIT 10`,
    [userId]
  )

  const contactSample = contactsResult.rows.map((c: { name: string | null; role: string | null; company: string | null }) => ({
    name: c.name ?? 'Unknown',
    role: c.role ?? null,
    company: c.company ?? null,
  }))

  const userMessage = [
    `Segment: ${label}`,
    `Segment description: ${description}`,
    `Outreach type: ${type ?? 'general'}`,
    `Context / goal: ${context.trim()}`,
    `Sample contacts (${contactSample.length} of segment):`,
    JSON.stringify(contactSample, null, 2),
  ].join('\n')

  const startMs = Date.now()

  // Why streamText: AI SDK handles streaming, error recovery, and response
  // formatting. toTextStreamResponse() returns a standard Response that
  // the client reads as a text stream — same UX as before but less code.
  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: OUTREACH_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxOutputTokens: 1000,
    onFinish: async ({ text, usage }) => {
      logAICall({
        userId,
        feature: 'outreach',
        input: userMessage,
        output: text,
        model: 'claude-sonnet-4-6',
        tokensIn: usage?.inputTokens,
        tokensOut: usage?.outputTokens,
        durationMs: Date.now() - startMs,
      })
    },
    onError: async ({ error }) => {
      console.error('Outreach stream error:', error)
      logAICall({
        userId,
        feature: 'outreach',
        input: userMessage,
        model: 'claude-sonnet-4-6',
        durationMs: Date.now() - startMs,
        error: (error as Error).message,
      })
    },
  })

  return result.toTextStreamResponse()
}
