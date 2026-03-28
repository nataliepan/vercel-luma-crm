import Anthropic from '@anthropic-ai/sdk'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { validateSQL } from '@/lib/nl-search'
import { OUTREACH_SYSTEM_PROMPT } from '@/lib/prompts'

// Why @anthropic-ai/sdk not @ai-sdk/anthropic: the @ai-sdk/anthropic v3 package
// hits https://api.anthropic.com/messages (missing /v1/ prefix) and returns 404.
// @anthropic-ai/sdk is already used throughout the codebase and works correctly.
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// Why streamText via raw ReadableStream not AI SDK streamText: same reason above.
// We stream the Anthropic response directly to the client as plain text chunks.
// The page reads this with a fetch + ReadableStream reader — no SDK needed client-side.
export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const { segmentId, context, type } = await req.json()

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

  // Stream the Anthropic response as plain text chunks.
  // The client reads this with a fetch + ReadableStream reader.
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const anthropicStream = await getClient().messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: OUTREACH_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        })

        for await (const chunk of anthropicStream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text))
          }
        }
      } catch (err) {
        console.error('Outreach stream error:', err)
        controller.enqueue(encoder.encode('\n[Error generating draft. Please try again.]'))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Why no-cache: ensure the browser doesn't buffer the stream
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
