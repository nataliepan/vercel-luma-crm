import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { SCHEMA_MAPPER_PROMPT } from '@/lib/prompts'

// Why generateText not streamText: schema mapping returns a single JSON object.
// Streaming adds no value here — we need the full response before processing rows.

const CANONICAL_FIELDS = ['email', 'name', 'company', 'role', 'linkedin_url', 'given_email', 'notes', 'approval_status', 'has_joined_event', 'registered_at']

// Fallback heuristic lookup — used when AI is unavailable.
// Why: the "nothing is dropped" guarantee must hold even during AI outages.
const HEURISTIC_MAP: Record<string, string> = {
  'email': 'email', 'email address': 'email', 'e-mail': 'email',
  'name': 'name', 'full name': 'name', 'attendee name': 'name', 'guest name': 'name',
  'company': 'company', 'company name': 'company', 'organization': 'company', 'where do you work': 'company',
  'role': 'role', 'job title': 'role', 'title': 'role', 'position': 'role',
  'linkedin': 'linkedin_url', 'linkedin url': 'linkedin_url', "what's your linkedin": 'linkedin_url', 'linkedin profile': 'linkedin_url',
  'given email': 'given_email', 'contact email': 'given_email', 'preferred email': 'given_email',
  'approval status': 'approval_status', 'status': 'approval_status',
  'attended': 'has_joined_event', 'joined': 'has_joined_event', 'has joined event': 'has_joined_event',
  'registration date': 'registered_at', 'registered at': 'registered_at', 'date registered': 'registered_at',
}

export async function mapSchema(headers: string[]): Promise<Record<string, string>> {
  try {
    const result = await generateText({
      model: anthropic('claude-sonnet-4-6'),
      system: SCHEMA_MAPPER_PROMPT,
      messages: [{
        role: 'user',
        content: `Map these CSV headers to canonical fields:\n${JSON.stringify(headers)}\n\nCanonical fields: ${CANONICAL_FIELDS.join(', ')}`
      }],
      maxOutputTokens: 500,
    })

    // Strip markdown code fences if the model wraps the response in ```json ... ```
    const cleaned = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const json = JSON.parse(cleaned)

    // Validate: only allow known canonical field values
    const validated: Record<string, string> = {}
    for (const [rawHeader, canonical] of Object.entries(json)) {
      validated[rawHeader] = CANONICAL_FIELDS.includes(canonical as string)
        ? (canonical as string)
        : 'notes'
    }
    return validated

  } catch (err) {
    // Fallback: heuristic match, then default to 'notes'
    // Why: AI may be unavailable (rate limit, outage). Import must not fail — data
    // loss is worse than imperfect mapping. User can re-import after AI recovers.
    console.error('Schema mapper AI failed, using heuristic fallback:', err)
    const fallback: Record<string, string> = {}
    for (const header of headers) {
      fallback[header] = HEURISTIC_MAP[header.toLowerCase().trim()] ?? 'notes'
    }
    return fallback
  }
}
