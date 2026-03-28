// All AI prompts live here — never inline prompts in route handlers.

export const SCHEMA_MAPPER_PROMPT = `
You are normalizing CSV column headers from Luma event exports.
Map each column to one of these canonical fields:
- email (required)
- name
- company
- role (job title)
- linkedin_url
- given_email (also matches: "Given email", "Contact email", "Preferred email")
- approval_status (also matches: "Approval Status", "Status")
- has_joined_event (also matches: "Attended", "Joined", "Has Joined Event")
- registered_at (also matches: "Registration Date", "Registered At", "Date Registered")
- notes (catch-all for event-specific questions)

Return ONLY a JSON object mapping original column names to canonical names.
If a column doesn't map to any canonical field, map it to "notes".
Example: {"Email Address": "email", "Full Name": "name", "Company Name": "company"}
`

export const NL_SEARCH_PROMPT = `
You convert natural language contact search queries into PostgreSQL WHERE clauses.

The contacts table has columns: name, email, company, role, notes, created_at.

The contact_events table (alias: ce, join via ce.contact_id = contacts.id) has:
- events.name, events.tags (join events e ON ce.event_id = e.id)
- approval_status TEXT ('approved', 'pending', 'declined', 'invited')
- has_joined_event BOOLEAN
- amount TEXT (e.g. '$649.00' — ticket price paid, NULL if free)
- amount_discount TEXT (discount applied)
- currency TEXT (e.g. 'usd')
- coupon_code TEXT (coupon used at checkout, NULL if none)
- ticket_name TEXT (e.g. 'Women''s Grant', 'Bootstrapped Founder')
- ticket_type_id TEXT
- custom_responses JSONB — registration question answers, keyed by normalized question label.
  Common keys from Luma exports: city, linkedin, industry, funding_stage, product_stage,
  team_size, funding_raised, arr, how_did_you_hear, what_are_you_working_on, company, role.
  Keys are lowercase with underscores (e.g. "What's your city?" → "whats_your_city").
  Access with: ce.custom_responses->>'city'  (returns text, NULL if absent)
- raw_row JSONB — verbatim original CSV row. Use as fallback if custom_responses key not found:
  ce.raw_row->>'What is your city?'  (use the exact original column header as key)

Rules:
- Return ONLY the WHERE clause body, no SELECT/FROM/WHERE keywords
- Use only literal string comparisons with ILIKE or = ANY() — do NOT use $2, $3 parameters.
  The caller wraps your output in a parameterized query where $1 = user_id.
  Any additional values must be inline string literals, not bind parameters.
- Never use subqueries that could be expensive
- If the query references event attendance, ticket/payment, or registration question data,
  use EXISTS with contact_events (alias ce)
- Maximum one JOIN per EXISTS subquery
- Never reference columns that don't exist in the schema above
- For "paid" contacts: amount IS NOT NULL AND amount != '$0.00'
- For coupon users: coupon_code IS NOT NULL
- For JSONB fields: use ->>'key' to extract text, then ILIKE or = for comparison

Example input: "founders who attended AI events"
Example output: role ILIKE '%founder%' AND EXISTS (
  SELECT 1 FROM contact_events ce
  JOIN events e ON ce.event_id = e.id
  WHERE ce.contact_id = contacts.id AND 'AI' = ANY(e.tags)
)

Example input: "contacts who used a coupon code"
Example output: EXISTS (
  SELECT 1 FROM contact_events ce
  WHERE ce.contact_id = contacts.id AND ce.coupon_code IS NOT NULL
)

Example input: "people who paid for a ticket"
Example output: EXISTS (
  SELECT 1 FROM contact_events ce
  WHERE ce.contact_id = contacts.id AND ce.amount IS NOT NULL AND ce.amount != '$0.00'
)

Example input: "people from San Francisco"
Example output: EXISTS (
  SELECT 1 FROM contact_events ce
  WHERE ce.contact_id = contacts.id AND ce.custom_responses->>'city' ILIKE '%san francisco%'
)

Example input: "founders at Series A stage"
Example output: role ILIKE '%founder%' AND EXISTS (
  SELECT 1 FROM contact_events ce
  WHERE ce.contact_id = contacts.id AND ce.custom_responses->>'funding_stage' ILIKE '%series a%'
)
`
// Why inline literals not bind params: the WHERE clause is generated as a string
// fragment and injected into a parameterized query. Bind params inside a fragment
// would require the caller to track and append values — fragile and error-prone.
// Inline literals are safe here because validateSQL() blocks all destructive patterns
// and the query always runs with user_id = $1 enforcing row-level isolation.

export const SEGMENT_BUILDER_PROMPT = `
You build audience segments from plain-English descriptions for a startup community builder.
Return ONLY a JSON object (no markdown fences) with exactly these fields:
- label: short segment name (max 4 words, title case)
- description: one sentence explaining who's in this segment
- filter_sql: a safe PostgreSQL WHERE clause fragment (see rules below)

The contacts table has columns: name, email, company, role, notes, created_at.

The contact_events table (alias: ce, join via ce.contact_id = contacts.id) has:
- events.name, events.tags (join events e ON ce.event_id = e.id)
- approval_status TEXT ('approved', 'pending', 'declined', 'invited')
- has_joined_event BOOLEAN
- amount TEXT (ticket price, NULL if free)
- coupon_code TEXT (NULL if none)
- ticket_name TEXT
- custom_responses JSONB — registration question answers keyed by normalized label.
  Common keys: city, linkedin, industry, funding_stage, product_stage, team_size,
  funding_raised, arr, how_did_you_hear, what_are_you_working_on.
  Access with: ce.custom_responses->>'city'

filter_sql rules:
- Return ONLY the WHERE clause body, no SELECT/FROM/WHERE keywords
- Use only inline literal string comparisons — no $2, $3 bind parameters
  (the caller already provides $1 = user_id and appends AND merged_into_id IS NULL)
- Use EXISTS with contact_events when filtering by event, ticket, or registration data
- Maximum one JOIN per EXISTS subquery
- Never reference non-existent columns
- For JSONB: use ->>'key' ILIKE '%value%'
- For "paid": amount IS NOT NULL AND amount != '$0.00'

Segments are for newsletters, event invites, and speaker outreach.

Example input: "Founders who attended 3+ events"
Example output: {"label": "Active Founders", "description": "Founders who attended three or more events.", "filter_sql": "role ILIKE '%founder%' AND (SELECT COUNT(DISTINCT ce.event_id) FROM contact_events ce WHERE ce.contact_id = contacts.id) >= 3"}

Example input: "VCs in San Francisco"
Example output: {"label": "SF VCs", "description": "Investors based in San Francisco.", "filter_sql": "role ILIKE '%VC%' OR role ILIKE '%venture%' OR role ILIKE '%investor%'"}
`

export const OUTREACH_SYSTEM_PROMPT = `
You are drafting outreach messages for a startup community builder.
You will receive a segment description and a sample of contacts in that segment.

Rules:
- Write in first person from the community builder's perspective
- Reference specific details from the contact's background when available
- Never invent facts not present in the contact data
- Never include placeholder text like [YOUR NAME] — write as if from the builder
- Keep to 150-200 words
- Return only the message body, no subject line unless asked

If contact data is sparse, write a warm but general message appropriate for the segment.
`

export const HALLUCINATION_CHECK_PROMPT = `
Review this outreach draft for factual claims about the recipient.
The only facts you may use are those explicitly present in the contact record provided.

Flag any sentence that:
1. States a specific fact about the person not in their contact record
2. Assumes their current role, company, or projects without evidence
3. References an event they didn't attend per the data

Return JSON: { "flagged": boolean, "issues": string[] }
If no issues found: { "flagged": false, "issues": [] }
`

// ---------------------------------------------------------------------------
// Runtime helper — used by evals and the outreach pipeline
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'

// Why lazy init: same reason as nl-search.ts — module-level instantiation reads
// process.env at import time, before setupFiles can inject the key in tests.
function _getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

export interface ContactRecord {
  name: string
  role: string
  company: string
  events: string[]
}

export interface HallucinationResult {
  flagged: boolean
  issues: string[]
}

/**
 * Checks an outreach draft for invented facts about the contact.
 *
 * Why a separate function not inline in the route: evals import this directly
 * so the same logic runs in tests and production — no drift between eval
 * harness and live code.
 */
export async function checkForHallucinations(
  draft: string,
  contact: ContactRecord
): Promise<HallucinationResult> {
  const message = await _getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: HALLUCINATION_CHECK_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Contact record: ${JSON.stringify(contact)}\n\nDraft: ${draft}`,
      },
    ],
  })

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim()
    return JSON.parse(cleaned) as HallucinationResult
  } catch {
    // If Claude returns malformed JSON, treat as not flagged but log it
    console.error('checkForHallucinations: could not parse response', text)
    return { flagged: false, issues: [] }
  }
}
