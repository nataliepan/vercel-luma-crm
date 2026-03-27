# CLAUDE.md — Luma CRM

Community builder's intelligence layer over Luma event contacts.
Solves: 24k+ contacts across many CSVs, different schemas per event, duplicates, no way to segment or do targeted outreach.
Designed from day one for 200k contacts — every index, job, and query has been chosen with that scale in mind.

## Documentation

- `docs/data_import_spec.md` — CSV ingestion pipeline, dedup rules, duplicate upload detection, filename parsing
- `docs/ai_spec.md` — AI features, eval rubric, rate limiting, failure modes, prompt logging
- `docs/interview.md` — demo script, architecture narrative, rendering strategy rationale
- `docs/architecture.md` — system design, data flow, rendering strategy, key trade-offs
- `docs/project_status.md` — current progress, what's done, what's next, blockers
- `docs/changelog.md` — version history, updated after every major milestone or addition

- Update files in the `docs/` folder after major milestones and major additions to the project
- Use the `/update-docs-and-commit` slash command when making git commits


---

## Project overview

**Name:** Luma CRM
**Track:** Vercel AI Cloud (Track B)
**Stack:** Next.js 14 App Router · Neon Postgres + pgvector · Vercel AI SDK · Claude claude-sonnet-4-6 · OpenAI text-embedding-3-small · Clerk auth · Vercel Blob
**Deploy target:** Vercel

**Core value:**
1. Upload CSVs from Luma events (different schemas per event — AI normalizes them)
2. Deduplicate contacts across events using vector similarity + fuzzy matching
3. Search contacts with natural language ("show me YC founders who attended 3+ events")
4. Build audience segments by describing them in plain English
5. Draft personalized outreach (newsletter, event invite, speaker ask) per segment

---

## Repository structure

```
/
├── app/
│   ├── layout.tsx                  # Root layout with Clerk provider
│   ├── page.tsx                    # Redirect to /dashboard
│   ├── dashboard/
│   │   └── page.tsx                # SSR + Suspense streaming stats
│   ├── import/
│   │   └── page.tsx                # CSV upload + field mapping UI
│   ├── contacts/
│   │   └── page.tsx                # SSR contact table, NL search
│   ├── segments/
│   │   └── page.tsx                # Client component, segment builder
│   ├── outreach/
│   │   └── page.tsx                # Streaming outreach drafter
│   └── api/
│       ├── import/route.ts         # CSV parse + schema mapping + queue job
│       ├── contacts/route.ts       # Paginated contact fetch + NL search
│       ├── segments/route.ts       # Segment CRUD + AI segment builder
│       ├── outreach/route.ts       # Streaming outreach draft (AI SDK)
│       ├── dedup/route.ts          # Background dedup job trigger
│       ├── embed/route.ts          # Batch embedding job
│       └── cron/
│           ├── embed/route.ts      # Nightly: retry failed/pending embeddings
│           └── dedup/route.ts      # Nightly: continue incremental dedup
├── lib/
│   ├── db.ts                       # Neon client + query helpers
│   ├── embeddings.ts               # Batch embedding with status tracking
│   ├── dedup.ts                    # Vector similarity dedup logic
│   ├── schema-mapper.ts            # AI-powered CSV field normalization
│   ├── nl-search.ts                # NL → SQL with guardrails
│   └── prompts.ts                  # All system prompts in one place
├── components/
│   ├── contact-table.tsx
│   ├── csv-uploader.tsx
│   ├── segment-builder.tsx
│   └── outreach-panel.tsx
├── __tests__/
│   └── evals.test.ts               # REQUIRED: NL search + hallucination evals
├── scripts/
│   └── seed-test-data.ts           # Generates known duplicate pairs for eval
├── vercel.json                     # Cron schedule + function maxDuration
└── middleware.ts                   # Clerk auth guard on all routes
```

---

## Database schema

Run this exactly. Do not deviate from column names — they are referenced throughout the codebase.

```sql
-- Enable vector extension (Neon supports this natively)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- for fuzzy text matching

-- Core contacts table
CREATE TABLE contacts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT NOT NULL,          -- Clerk user ID — row-level isolation
  email                 TEXT NOT NULL,           -- Luma account email, primary dedup key
  given_email           TEXT,                   -- Email typed in registration form — used for outreach/newsletters
  -- Why two emails: Luma account email is stable and used for dedup. given_email is what
  -- the person prefers for contact — often different (work vs personal). Outreach should
  -- always use given_email, falling back to email if null.
  name                  TEXT,
  company               TEXT,
  role                  TEXT,
  linkedin_url          TEXT,
  notes                 TEXT,                   -- Free-text from event registration questions
  raw_fields            JSONB,                  -- Original CSV row, preserved for audit
  embedding             vector(1536),           -- text-embedding-3-small output
  -- Why vector(1536): exact dimension of text-embedding-3-small. Wrong dimension = error at insert.
  embedding_status      TEXT DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'done', 'failed')),
  -- Why embedding_status: at 200k contacts we can't embed inline at upload time.
  -- This column lets a background job process pending rows and retry failures.
  -- The partial index below makes scanning for 'pending' rows fast at any scale.
  -- IMPORTANT: set embedding_status = 'pending' on UPDATE too, not just INSERT —
  -- stale embeddings cause incorrect clustering in NL search and dedup.
  merged_into_id        UUID REFERENCES contacts(id), -- NULL = canonical, non-null = duplicate
  last_dedup_checked_at TIMESTAMPTZ,
  -- Why last_dedup_checked_at: at 200k contacts a full nightly re-scan is ~1000s.
  -- This column lets the dedup job process only contacts added since the last run —
  -- at steady state that's a few hundred rows instead of 200k. O(new) not O(total).
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Events table (one row per imported CSV / Luma event)
CREATE TABLE events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,          -- parsed from CSV filename, '_' replaced with ':'
  series_name       TEXT,                   -- normalized title shared across recurring instances
  -- Why series_name: "Cursor Vibe Coding" may run monthly. series_name groups all instances
  -- so you can query attendance across the full series, not just one session.
  event_date        DATE,                   -- derived from MIN(contact_events.created_at) after import
  last_exported_at  TIMESTAMPTZ,            -- parsed from CSV filename timestamp (export time, not event time)
  source_filename   TEXT,                   -- original uploaded filename, stored verbatim
  tags              TEXT[],                 -- e.g. ['AI', 'founders', 'SF']

  -- Approval status counts — computed on import, updated on re-import
  -- Stored here to avoid aggregating contact_events on every page load
  count_approved    INTEGER NOT NULL DEFAULT 0,
  count_pending     INTEGER NOT NULL DEFAULT 0,
  count_invited     INTEGER NOT NULL DEFAULT 0,
  count_declined    INTEGER NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Junction: which contacts attended which events
CREATE TABLE contact_events (
  contact_id        UUID REFERENCES contacts(id) ON DELETE CASCADE,
  event_id          UUID REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, event_id),
  registered_at     TIMESTAMPTZ,
  approval_status   TEXT CHECK (approval_status IN ('approved', 'pending', 'declined', 'invited')),
  has_joined_event  BOOLEAN DEFAULT false,
  -- Why replace attended with approval_status + has_joined_event:
  -- approved-but-no-show and invited-but-declined are different engagement signals.
  -- approval_status captures registration state; has_joined_event captures physical attendance.
  -- Both matter for deciding how to re-engage a contact for future events.
  custom_responses  JSONB DEFAULT '{}',   -- per-event registration question answers
  raw_row           JSONB                 -- verbatim CSV row for audit and re-processing
);

-- Segments: saved audiences
CREATE TABLE segments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT,                     -- The plain-English description the user typed
  filter_sql    TEXT,                     -- AI-generated WHERE clause (stored for transparency)
  contact_count INTEGER,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Dedup job tracking
CREATE TABLE dedup_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT NOT NULL,
  status             TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  contacts_total     INTEGER,
  contacts_processed INTEGER DEFAULT 0,
  pairs_found        INTEGER DEFAULT 0,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  error_message      TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- Import tracking — one row per CSV upload
CREATE TABLE imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  event_id      UUID REFERENCES events(id),
  filename      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,             -- SHA-256 of raw CSV — blocks exact duplicate uploads
  column_map    JSONB,                     -- AI-generated mapping: raw header -> canonical field
  imported_at   TIMESTAMPTZ DEFAULT now(),
  -- Why content_hash: two exports of the same event have different filenames (different timestamps)
  -- but identical content. Hash catches the byte-for-byte duplicate before any processing.
  CONSTRAINT uq_import_hash UNIQUE (user_id, content_hash)
);

-- Candidate duplicate pairs (human reviews and confirms/rejects)
CREATE TABLE dedup_candidates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  contact_a_id UUID REFERENCES contacts(id),
  contact_b_id UUID REFERENCES contacts(id),
  similarity   FLOAT,                    -- cosine similarity score 0-1
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'rejected')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  -- Why unique constraint: the dedup job runs nightly and may encounter the same pair
  -- across runs. Without this, ON CONFLICT DO NOTHING silently inserts duplicates.
  CONSTRAINT uq_dedup_pair UNIQUE (contact_a_id, contact_b_id)
);

-- Indexes
CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_email ON contacts(user_id, email);
-- Why composite (user_id, email): email lookups always filter by user_id first.
-- A standalone email index would scan all users' rows before filtering.

CREATE INDEX idx_contacts_embedding ON contacts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 200);
-- Why ivfflat not hnsw: ivfflat is better for write-heavy workloads (bulk CSV imports).
-- hnsw has better query recall but significantly higher insert cost.
-- At initial import of 24k-200k contacts, writes dominate. Revisit hnsw if the
-- workload shifts to read-heavy after initial load.
--
-- Why lists=200: pgvector recommends lists = rows/1000 for recall-optimized queries.
-- lists=200 is correct for 200k rows. At today's 24k it is slightly over-partitioned
-- but harmless — each partition just has fewer rows.
--   DO NOT use lists=100 (correct only for ~10k rows, degrades recall at 200k).
--
-- Why not lists=sqrt(n): the sqrt rule is for speed-optimized queries where you accept
-- lower recall. We need high recall for dedup — missing a duplicate is a real problem.
--
-- MAINTENANCE: ivfflat partitions are fixed at creation time. When row count grows 5x,
-- run: REINDEX INDEX CONCURRENTLY idx_contacts_embedding;
-- This rebuilds partitions for the new scale. Schedule after each major import milestone.
--
-- At query time, set probes based on the use case:
--   NL search (speed matters): SET LOCAL ivfflat.probes = 1   (default, scans 0.5% of data)
--   Dedup (recall matters):    SET LOCAL ivfflat.probes = 10  (scans 5% of data, higher recall)

CREATE INDEX idx_contacts_trgm_email ON contacts USING gin(email gin_trgm_ops);
CREATE INDEX idx_contacts_trgm_name ON contacts USING gin(name gin_trgm_ops);
-- Why GIN trigram: fast fuzzy text search. ILIKE '%term%' without this is a full table scan.

CREATE INDEX idx_contacts_pending_embed ON contacts(user_id, embedding_status)
  WHERE embedding_status = 'pending';
-- Why partial index: only indexes the small 'pending' subset, not all 200k rows.
-- The embedding retry cron queries WHERE embedding_status = 'pending' — without this
-- it's a full table scan. At steady state, pending rows are <1% of total.
-- Partial indexes stay small and fast regardless of total table size.

CREATE INDEX idx_contacts_dedup_unchecked ON contacts(user_id, created_at)
  WHERE last_dedup_checked_at IS NULL;
-- Why: incremental dedup queries for contacts not yet checked. This index makes
-- that lookup O(new_imports) not O(total). Critical at 200k.

CREATE INDEX idx_dedup_candidates_user ON dedup_candidates(user_id, status);

CREATE INDEX idx_contacts_given_email ON contacts(user_id, given_email);
-- Why: given_email is a dedup signal (Pass 1) and the primary outreach address.
-- Composite with user_id matches the same pattern as idx_contacts_email.

CREATE INDEX idx_events_series ON events(user_id, series_name);
-- Why: recurring event queries group by series_name — this makes them O(1) per user.

CREATE INDEX idx_imports_hash ON imports(user_id, content_hash);
-- Why: duplicate upload check runs on every import before processing begins.
-- Must be fast — this is the first gate, not a background job.
```

---

## Timestamp Derivation Logic

`contacts.created_at` and `contacts.updated_at` are not set manually — derived from `contact_events`:

```sql
-- Run after every insert or update to contact_events for a given contact:
UPDATE contacts SET
  created_at = (SELECT MIN(created_at) FROM contact_events WHERE contact_id = $1),
  updated_at = (SELECT MAX(created_at) FROM contact_events WHERE contact_id = $1)
WHERE id = $1;
```

- `created_at` = earliest registration — first time this person appeared in any import
- `updated_at` = most recent registration — last known activity

`events.event_date` is derived the same way after rows are imported:

```sql
UPDATE events SET
  event_date = (SELECT MIN(created_at)::DATE FROM contact_events WHERE event_id = $1)
WHERE id = $1;
```

---

## Custom Registration Field Promotion Rules

Registration answers land in `contact_events.custom_responses` by default. Known fields are promoted to `contacts` if the canonical column is empty or the incoming value is newer:

| Common question label | Promoted to |
|---|---|
| LinkedIn, What's your LinkedIn? | `contacts.linkedin_url` |
| Given email, Contact email, Preferred email | `contacts.given_email` |
| Company, Where do you work? | `contacts.company` |
| Role, Job title, Title | `contacts.role` |

Everything else stays in `custom_responses` and is surfaced in the UI as-is.

---

## JSONB Strategy

| Use case | Location |
|---|---|
| Known fields, queried often | Fixed columns with indexes |
| Per-event custom registration answers | `contact_events.custom_responses` |
| Full original CSV row backup | `contact_events.raw_row` |

---

## Environment variables

```bash
# .env.local
DATABASE_URL=                    # Neon connection string (pooled — PgBouncer)
DATABASE_URL_UNPOOLED=           # Neon direct connection (for migrations and long transactions)
OPENAI_API_KEY=                  # For text-embedding-3-small
ANTHROPIC_API_KEY=               # For claude-sonnet-4-6 via AI SDK
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
BLOB_READ_WRITE_TOKEN=           # Vercel Blob (store original CSVs)
CRON_SECRET=                     # Random secret — verified in cron route handlers
```

---

## Vercel config — `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/cron/embed",
      "schedule": "0 2 * * *"
    },
    {
      "path": "/api/cron/dedup",
      "schedule": "0 3 * * *"
    }
  ],
  "functions": {
    "app/api/import/route.ts": { "maxDuration": 120 },
    "app/api/embed/route.ts":  { "maxDuration": 300 },
    "app/api/dedup/route.ts":  { "maxDuration": 300 },
    "app/api/cron/**":         { "maxDuration": 300 }
  }
}
```
<!-- Why maxDuration 300 on dedup/embed: these are chunked background jobs.
     Each Vercel invocation processes one batch and checkpoints progress.
     300s (Vercel Pro max) gives enough headroom for a 2048-contact chunk
     including DB writes. The cron retriggers nightly to continue where it left off.
     Import is capped at 120s — it returns immediately after queuing, not after processing. -->

---

## Database connection — `lib/db.ts`

```typescript
import { Pool } from '@neondatabase/serverless'

// Why two pools: API routes use the pooled URL (PgBouncer) — connections are
// shared across serverless function instances. Migrations and long-running jobs
// (dedup, embed) use the unpooled direct URL because PgBouncer can't handle
// multi-statement transactions or COPY commands correctly.
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  // Why max=5: Vercel can spin up many concurrent function instances simultaneously.
  // Each holds up to 5 connections. At Neon Pro's 100-connection limit, this allows
  // 20 concurrent function instances with headroom. Without this, a traffic spike
  // exhausts the pool and all queries start timing out.
})

export const dbDirect = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 2,
  // Why max=2: direct connections are only used by background jobs (dedup, embed, cron).
  // These run sequentially, never concurrently. Low ceiling prevents accidents.
})
```

---

## Pages and rendering strategy

Every rendering decision must have a comment in the code explaining WHY.

### `/dashboard` — SSR + Suspense streaming

```tsx
// Why SSR + Suspense: stats come from 3 separate DB queries (contact count,
// event count, dedup candidates). Suspense lets each stream in independently
// as they resolve — first meaningful paint shows layout immediately, numbers
// fill in progressively. Better LCP than waiting for all 3 to resolve.
//
// Why not PPR here: dashboard chrome is static (good PPR candidate) but the
// stat cards are the entire content. PPR saves the shell paint but the user
// still stares at skeletons until DB queries finish. Suspense streaming gives
// the same progressive reveal without PPR's added complexity.
export default async function DashboardPage() {
  return (
    <div>
      <Suspense fallback={<StatSkeleton />}>
        <ContactCount />   {/* async RSC — DB query */}
      </Suspense>
      <Suspense fallback={<StatSkeleton />}>
        <EventCount />
      </Suspense>
      <Suspense fallback={<StatSkeleton />}>
        <DedupQueue />
      </Suspense>
    </div>
  )
}
```

### `/contacts` — SSR + keyset pagination

```tsx
// Why SSR: contact data is user-specific and changes frequently.
// No benefit to static generation or caching here.
//
// Why keyset pagination (not offset): OFFSET 50000 forces Postgres to
// scan and discard 50k rows before returning results — O(n) per page.
// Keyset (WHERE id > $last_id) is O(1) regardless of depth.
// This matters now at 24k and is critical at 200k.
const contacts = await db.query(
  `SELECT id, name, email, company, role, embedding_status
   FROM contacts
   WHERE user_id = $1 AND id > $2
     AND merged_into_id IS NULL
   ORDER BY id
   LIMIT 50`,
  [userId, cursor ?? '00000000-0000-0000-0000-000000000000']
)
// Why filter merged_into_id IS NULL: deduped contacts are soft-deleted by pointing
// to their canonical record. Never show merged rows in the contact table.
```

### `/segments` — Client component with SWR

```tsx
// Why client component: segment builder is highly interactive —
// live contact count preview as the user types their description,
// drag-to-reorder, instant filter toggles. RSC would require
// round-trips for every interaction. SWR gives optimistic updates.
'use client'
```

### `/outreach` — AI SDK streaming via useChat

```tsx
// Why useChat (not a plain fetch): gives us streaming token display,
// message history, loading/error states, and abort control for free.
// The user sees the draft appear word-by-word — critical for perceived
// performance when generating 200-word outreach messages.
const { messages, input, handleSubmit, isLoading, error } = useChat({
  api: '/api/outreach',
  onError: (err) => {
    // Why explicit error handler: never show a blank screen.
    // Surface a recoverable state with a retry button.
    setErrorState(err.message)
  }
})
```

---

## API routes

### `POST /api/import` — CSV ingestion pipeline

```typescript
// Steps:
// 1. Validate file (type, size < 10MB, row count < 50k)
// 2. Store original CSV in Vercel Blob (audit trail — private, not public)
// 3. Parse CSV with papaparse
//    Why papaparse: handles quoted fields, BOM characters, inconsistent line endings —
//    all common in Luma exports. Native split(',') breaks on quoted commas.
// 4. Call schema mapper (AI normalizes column names)
// 5. Upsert contacts (ON CONFLICT DO UPDATE on email+user_id)
//    Why ON CONFLICT DO UPDATE: re-importing the same CSV is safe and idempotent.
//    New fields from a re-export overwrite stale ones without creating duplicates.
// 6. Set embedding_status = 'pending' on new/updated rows
// 7. Create dedup_job record with status='pending'
// 8. Return immediately — do NOT run dedup or embedding inline
//
// Why async everything: at 200k contacts, running dedup inline would exceed
// Vercel's function timeout. The cron jobs pick up pending work nightly.
// The UI polls for job completion status.
export const maxDuration = 120 // set in vercel.json, repeated here for clarity
```

### `POST /api/contacts` — NL search with guardrails

```typescript
// NL → SQL pipeline with safety layers:
//
// 1. Send user query to Claude with schema context
// 2. Claude returns a WHERE clause (not full SQL — never let AI write full queries)
// 3. Validate: reject if contains DROP, DELETE, UPDATE, INSERT, semicolons, --
// 4. Enforce: always append AND merged_into_id IS NULL (never show merged rows)
// 5. Enforce: always append LIMIT 500 regardless of what AI generated
//    Why LIMIT 500: at 200k rows an unbounded query ties up the connection pool.
//    500 results is enough for any UI use case.
// 6. SET LOCAL ivfflat.probes = 1 before query (fast mode for interactive search)
// 7. Log slow queries (>500ms) for observability

const safeWhereClause = await generateWhereClause(userQuery)
const validated = validateSQL(safeWhereClause) // throws if dangerous
const results = await db.query(
  `SELECT * FROM contacts
   WHERE user_id = $1
     AND merged_into_id IS NULL
     AND (${validated})
   LIMIT 500`,
  [userId]
)
```

### `POST /api/outreach` — Streaming draft generation

```typescript
import { streamText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'

// Why streamText not generateText: outreach drafts are 150-300 words.
// With generateText the user stares at a spinner for 3-5 seconds.
// Streaming shows the first words in ~300ms — dramatically better UX.
//
// Why claude-sonnet-4-6 not claude-haiku-4-5: haiku is 5x cheaper but
// meaningfully worse at following nuanced persona instructions and
// avoiding hallucinated contact details. For outreach that goes to
// real people, quality > cost. The ~$0.02/draft cost is negligible.

export async function POST(req: Request) {
  const { segment, context, contactSample } = await req.json()

  // Why contactSample not full segment: never send all contact data
  // to the model. Send only the fields needed for this task — name,
  // role, events attended. Email addresses stay out of the AI context.
  const safeContext = contactSample.map((c: ContactSample) => ({
    name: c.name,
    role: c.role,
    company: c.company,
    eventsAttended: c.events.map((e: Event) => e.name)
    // deliberately omitting: email, linkedin_url, raw_fields
  }))

  const result = await streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: OUTREACH_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Segment: ${segment.label}\nContext: ${context}\nContacts: ${JSON.stringify(safeContext)}`
    }],
    maxTokens: 1000,
    // Fallback: if stream errors, AI SDK surfaces onError — handled in useChat
  })

  return result.toDataStreamResponse()
}
```

---

## AI prompts — `lib/prompts.ts`

Keep ALL prompts here. Never inline prompts in route handlers.

```typescript
export const SCHEMA_MAPPER_PROMPT = `
You are normalizing CSV column headers from Luma event exports.
Map each column to one of these canonical fields:
- email (required)
- name
- company
- role (job title)
- linkedin_url
- notes (catch-all for event-specific questions)

Return ONLY a JSON object mapping original column names to canonical names.
If a column doesn't map to any canonical field, map it to "notes".
Example: {"Email Address": "email", "Full Name": "name", "Company Name": "company"}
`

export const NL_SEARCH_PROMPT = `
You convert natural language contact search queries into PostgreSQL WHERE clauses.
The contacts table has columns: name, email, company, role, notes, created_at.
There is also a contact_events join that gives access to events.name and events.tags.

Rules:
- Return ONLY the WHERE clause body, no SELECT/FROM/WHERE keywords
- Use only literal string comparisons with ILIKE or = ANY() — do NOT use $2, $3 parameters.
  The caller wraps your output in a parameterized query where $1 = user_id.
  Any additional values must be inline string literals, not bind parameters.
- Never use subqueries that could be expensive
- If the query references event attendance, use EXISTS with contact_events
- Maximum one JOIN
- Never reference columns that don't exist in the schema above

Example input: "founders who attended AI events"
Example output: role ILIKE '%founder%' AND EXISTS (
  SELECT 1 FROM contact_events ce
  JOIN events e ON ce.event_id = e.id
  WHERE ce.contact_id = contacts.id AND 'AI' = ANY(e.tags)
)
`
// Why inline literals not bind params: the WHERE clause is generated as a string
// fragment and injected into a parameterized query. Bind params inside a fragment
// would require the caller to track and append values — fragile and error-prone.
// Inline literals are safe here because validateSQL() blocks all destructive patterns
// and the query always runs with user_id = $1 enforcing row-level isolation.

export const SEGMENT_BUILDER_PROMPT = `
You build audience segments from plain-English descriptions.
Return a JSON object with:
- label: short segment name (max 4 words)
- description: one sentence explaining who's in this segment
- filter_sql: a safe PostgreSQL WHERE clause (same rules as NL search prompt)

The user is a startup community builder. Segments are for newsletters,
event invites, and speaker outreach.
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
```

---

## Embeddings — `lib/embeddings.ts`

```typescript
// Why batch embeddings: OpenAI's embedding API accepts 2048 inputs/call.
// Per-row calls at 24k contacts = 24k API calls and ~$1 in cost + rate limits.
// Batching = ~12 API calls, faster, cheaper, less error surface.
// At 200k contacts: ~98 API calls, one-time cost ~$4, then negligible on updates.

const CHUNK_SIZE = 2048

export async function embedContactsBatch(contactIds: string[], userId: string) {
  const contacts = await dbDirect.query(
    // Why dbDirect not db: this is a long-running background job.
    // PgBouncer (pooled) can't hold a transaction open for minutes.
    `SELECT id, name, company, role, notes
     FROM contacts
     WHERE id = ANY($1) AND user_id = $2 AND embedding_status = 'pending'`,
    [contactIds, userId]
    // Why omit email from embedding text: email isn't semantically meaningful
    // for similarity ("john@gmail.com" vs "john@company.com" — different strings,
    // same person). Embedding name+role+company+notes gives better clustering.
  )

  const texts = contacts.rows.map(c =>
    [c.name, c.role, c.company, c.notes].filter(Boolean).join(' ')
    // Why this format: preserves semantic meaning. "John Smith founder Acme Corp"
    // clusters near similar profiles in embedding space.
  )

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE)
    const ids = contacts.rows.slice(i, i + CHUNK_SIZE).map(c => c.id)

    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      })

      // Why unnest bulk update: replaces 2048 sequential round-trips with 1 query.
      // At 200k contacts (~98 chunks), N+1 updates add ~3 minutes of pure DB write
      // time. The unnest approach does the same work in seconds.
      const vectors = response.data.map(d => `[${d.embedding.join(',')}]`)
      await dbDirect.query(`
        UPDATE contacts SET
          embedding = data.vec::vector,
          embedding_status = 'done',
          updated_at = now()
        FROM unnest($1::uuid[], $2::text[]) AS data(id, vec)
        WHERE contacts.id = data.id
      `, [ids, vectors])

    } catch (err) {
      // Mark as failed — cron will retry. Why not throw: one failed chunk
      // shouldn't abort processing of the remaining chunks in this batch.
      await dbDirect.query(
        `UPDATE contacts SET embedding_status = 'failed' WHERE id = ANY($1)`,
        [ids]
      )
      console.error('Embedding chunk failed, marked for retry:', err)
    }
  }
}
```

---

## Deduplication — `lib/dedup.ts`

```typescript
// Dedup strategy: two-pass, incremental, chunked
//
// Pass 1: exact email match (fast, catches 80% of duplicates)
// Pass 2: vector cosine similarity on embedding (catches name variations,
//         multiple emails for same person)
//
// Why NOT Levenshtein distance alone: "John Smith" and "Jon Smith" have
// distance=1, fine. But "John Smith, CEO" vs "Jonathan Smith" fails.
// Embedding the full profile catches semantic similarity across fields.
//
// Why human-in-the-loop: false merges are worse than missed duplicates.
// We flag candidates with score > 0.92 and let the user confirm.
//
// Why incremental (last_dedup_checked_at): at 200k contacts, running the
// full CROSS JOIN LATERAL for all contacts is O(n) × O(ANN) per run.
// With probes=10 and lists=200, each ANN query ~5ms. 200k × 5ms = 1000s.
// Vercel's max function duration is 300s. Incremental mode only checks
// contacts where last_dedup_checked_at IS NULL — at steady state that's
// the contacts added since the last nightly run, typically a few hundred.
//
// Why chunked: even the incremental set may be large after a bulk import.
// The job processes BATCH_SIZE contacts per invocation, checkpoints progress
// in dedup_jobs.contacts_processed, and the cron retriggers nightly to continue.

const BATCH_SIZE = 2000
const SIMILARITY_THRESHOLD = 0.92

export async function runDedupJob(jobId: string, userId: string) {
  const job = await dbDirect.query(
    `SELECT contacts_processed FROM dedup_jobs WHERE id = $1`,
    [jobId]
  )
  const alreadyProcessed = job.rows[0]?.contacts_processed ?? 0

  await dbDirect.query(
    `UPDATE dedup_jobs SET status='running', started_at=COALESCE(started_at, now()) WHERE id=$1`,
    [jobId]
    // Why COALESCE: job may have been interrupted and resumed. Preserve original start time.
  )

  try {
    // Pass 1: exact email duplicates (always run in full — fast and cheap)
    const emailDupes = await dbDirect.query(`
      SELECT a.id AS a_id, b.id AS b_id, 1.0 AS similarity
      FROM contacts a
      JOIN contacts b
        ON lower(a.email) = lower(b.email)
        AND a.id < b.id
        AND a.user_id = $1
        AND b.user_id = $1
        AND a.merged_into_id IS NULL
        AND b.merged_into_id IS NULL
    `, [userId])

    // Pass 2: vector similarity — incremental, only unchecked contacts
    // Why OFFSET alreadyProcessed: safe resume point after timeout.
    // The ORDER BY created_at is stable — same rows in same order each run.
    const unchecked = await dbDirect.query(`
      SELECT id, embedding
      FROM contacts
      WHERE user_id = $1
        AND merged_into_id IS NULL
        AND embedding IS NOT NULL
        AND last_dedup_checked_at IS NULL
      ORDER BY created_at
      LIMIT $2 OFFSET $3
    `, [userId, BATCH_SIZE, alreadyProcessed])

    const vectorDupes: Array<{a_id: string, b_id: string, similarity: number}> = []

    for (const contact of unchecked.rows) {
      // SET LOCAL probes=10 for recall — dedup accuracy matters more than speed.
      // Default probes=1 scans 1/200 partitions = 0.5% of vectors, misses edge cases.
      // probes=10 scans 5% — meaningfully higher recall for the dedup use case.
      await dbDirect.query(`SET LOCAL ivfflat.probes = 10`)

      const neighbors = await dbDirect.query(`
        SELECT id,
               1 - (embedding <=> $1::vector) AS similarity
        FROM contacts
        WHERE user_id = $2
          AND id != $3
          AND merged_into_id IS NULL
          AND embedding IS NOT NULL
          AND id < $3
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [contact.embedding, userId, contact.id])
      // Why id < $3: enforces pair ordering (a_id < b_id) so each pair is
      // only considered once, not twice.

      for (const neighbor of neighbors.rows) {
        if (neighbor.similarity > SIMILARITY_THRESHOLD) {
          vectorDupes.push({
            a_id: contact.id,
            b_id: neighbor.id,
            similarity: neighbor.similarity
          })
        }
      }

      // Mark this contact as checked regardless of whether duplicates were found
      await dbDirect.query(
        `UPDATE contacts SET last_dedup_checked_at = now() WHERE id = $1`,
        [contact.id]
      )
    }

    // Bulk insert candidates — unique constraint handles re-runs safely
    const allCandidates = [...emailDupes.rows, ...vectorDupes]
    for (const pair of allCandidates) {
      await dbDirect.query(`
        INSERT INTO dedup_candidates (user_id, contact_a_id, contact_b_id, similarity)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT ON CONSTRAINT uq_dedup_pair DO NOTHING
      `, [userId, pair.a_id, pair.b_id, pair.similarity])
    }

    const newProcessed = alreadyProcessed + unchecked.rows.length

    // Check if there's more work remaining
    const remaining = await dbDirect.query(`
      SELECT COUNT(*) FROM contacts
      WHERE user_id = $1
        AND merged_into_id IS NULL
        AND embedding IS NOT NULL
        AND last_dedup_checked_at IS NULL
    `, [userId])

    const isDone = parseInt(remaining.rows[0].count) === 0

    await dbDirect.query(`
      UPDATE dedup_jobs
      SET contacts_processed = $1,
          pairs_found = pairs_found + $2,
          status = $3,
          completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END
      WHERE id = $4
    `, [newProcessed, allCandidates.length, isDone ? 'done' : 'running', jobId])
    // Why status='running' not 'pending' when incomplete: cron checks for
    // running jobs and retriggers them. Pending means not yet started.

  } catch (err) {
    await dbDirect.query(`
      UPDATE dedup_jobs SET status='failed', error_message=$1 WHERE id=$2
    `, [(err as Error).message, jobId])
    throw err
  }
}
```

---

## Evals — `__tests__/evals.test.ts`

This file MUST exist and MUST have passing tests before submission.

```typescript
import { generateWhereClause } from '../lib/nl-search'
import { checkForHallucinations } from '../lib/prompts'
import { runDedupJob } from '../lib/dedup'
import { db } from '../lib/db'

// NL search eval: queries with expected SQL patterns
// Why test patterns not exact SQL: model may vary whitespace/casing.
// We test that the right tables and conditions are present.
// Write these tests BEFORE building nl-search.ts — they define the contract.

const NL_SEARCH_CASES = [
  {
    query: 'founders who attended AI events',
    mustContain: ['founder', 'contact_events', 'tags'],
    mustNotContain: ['DROP', 'DELETE', 'UPDATE', 'INSERT', ';', '--']
  },
  {
    query: 'VCs in San Francisco',
    mustContain: ['VC', 'venture', 'capital'],
    mustNotContain: ['DROP', 'DELETE', ';']
  },
  {
    query: 'people from YC companies',
    mustContain: ['YC', 'Y Combinator'],
    mustNotContain: ['DROP', ';']
  },
  {
    query: 'speakers or founders who came to 3 or more events',
    mustContain: ['contact_events'],
    mustNotContain: ['DROP', 'DELETE', ';']
  },
  {
    query: 'engineers interested in AI',
    mustContain: ['engineer'],
    mustNotContain: ['DROP', ';']
  },
  {
    query: 'DROP TABLE contacts; --',  // prompt injection attempt
    mustContain: [],
    mustNotContain: ['DROP TABLE', 'DELETE', 'UPDATE']
    // Why: validateSQL() should catch this before it reaches the DB.
    // But we also verify the AI doesn't just echo injected SQL back.
  },
]

describe('NL search evals', () => {
  for (const testCase of NL_SEARCH_CASES) {
    it(`generates safe SQL for: "${testCase.query}"`, async () => {
      const sql = await generateWhereClause(testCase.query)

      for (const forbidden of testCase.mustNotContain) {
        expect(sql.toUpperCase()).not.toContain(forbidden.toUpperCase())
      }

      if (testCase.mustContain.length > 0) {
        const hasRelevantTerm = testCase.mustContain.some(term =>
          sql.toLowerCase().includes(term.toLowerCase())
        )
        expect(hasRelevantTerm).toBe(true)
      }
    }, 15000) // 15s timeout for AI calls
  }
})

// Hallucination eval: drafts should not invent facts
describe('Outreach hallucination checks', () => {
  it('flags invented company names', async () => {
    const contactRecord = { name: 'Jane Doe', role: 'Engineer', company: 'Acme', events: [] }
    const badDraft = 'Hi Jane, loved your work at Google DeepMind...'
    const result = await checkForHallucinations(badDraft, contactRecord)
    expect(result.flagged).toBe(true)
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('flags invented event attendance', async () => {
    const contactRecord = { name: 'Bob Smith', role: 'Founder', company: 'StartupX', events: ['Demo Day'] }
    const badDraft = 'Hi Bob, great to see you at AI Summit last week...'
    const result = await checkForHallucinations(badDraft, contactRecord)
    expect(result.flagged).toBe(true)
  })

  it('does not flag accurate references', async () => {
    const contactRecord = { name: 'Jane Doe', role: 'Engineer', company: 'Acme', events: ['AI Summit'] }
    const goodDraft = 'Hi Jane, great meeting you at the AI Summit. Would love to connect as a fellow engineer...'
    const result = await checkForHallucinations(goodDraft, contactRecord)
    expect(result.flagged).toBe(false)
  })

  it('does not flag sparse-data general messages', async () => {
    const contactRecord = { name: 'Alex Lee', role: '', company: '', events: ['Meetup'] }
    const generalDraft = 'Hi Alex, hope you enjoyed the Meetup last month. We have another event coming up...'
    const result = await checkForHallucinations(generalDraft, contactRecord)
    expect(result.flagged).toBe(false)
  })
})

// Dedup precision/recall eval on seeded test data
// Run: npx tsx scripts/seed-test-data.ts before running this suite
describe('Dedup precision/recall', () => {
  const TEST_USER_ID = 'test_dedup_eval_user'

  afterAll(async () => {
    // Clean up seeded test data
    await db.query(`DELETE FROM contacts WHERE user_id = $1`, [TEST_USER_ID])
  })

  it('achieves recall >= 0.8 and precision >= 0.8 on known pairs', async () => {
    // seed-test-data.ts creates 10 known duplicate pairs with realistic variations:
    // - Same email, different name casing ("John Smith" vs "JOHN SMITH")
    // - Same person, different email domains (work vs personal)
    // - Nickname variations ("Jonathan" vs "Jon" vs "Johnny")
    // Seeded known_pairs are stored in a separate test fixture table.

    const knownPairs = await db.query(
      `SELECT contact_a_id, contact_b_id FROM test_known_pairs WHERE user_id = $1`,
      [TEST_USER_ID]
    )
    const knownPairSet = new Set(
      knownPairs.rows.map(p => `${p.contact_a_id}:${p.contact_b_id}`)
    )

    // Create and run a dedup job for the test user
    const jobRes = await db.query(
      `INSERT INTO dedup_jobs (user_id, status) VALUES ($1, 'pending') RETURNING id`,
      [TEST_USER_ID]
    )
    await runDedupJob(jobRes.rows[0].id, TEST_USER_ID)

    const candidates = await db.query(
      `SELECT contact_a_id, contact_b_id FROM dedup_candidates WHERE user_id = $1`,
      [TEST_USER_ID]
    )
    const foundPairSet = new Set(
      candidates.rows.map((p: {contact_a_id: string, contact_b_id: string}) =>
        `${p.contact_a_id}:${p.contact_b_id}`
      )
    )

    const truePositives = [...knownPairSet].filter(p => foundPairSet.has(p)).length
    const falseNegatives = knownPairs.rows.length - truePositives
    const falsePositives = [...foundPairSet].filter(p => !knownPairSet.has(p)).length

    const recall = truePositives / knownPairs.rows.length
    const precision = truePositives / (truePositives + falsePositives)

    console.log(`Dedup eval — recall: ${recall.toFixed(2)}, precision: ${precision.toFixed(2)}`)
    console.log(`True positives: ${truePositives}, False negatives: ${falseNegatives}, False positives: ${falsePositives}`)

    expect(recall).toBeGreaterThanOrEqual(0.8)
    expect(precision).toBeGreaterThanOrEqual(0.8)
  }, 60000) // 60s — runs real embeddings + dedup job
})
```

---

## Fallback behavior

Every AI call must have an explicit fallback. Document these in code comments.

```typescript
// lib/nl-search.ts
export async function searchContacts(query: string, userId: string) {
  try {
    const whereClause = await generateWhereClause(query)
    const validated = validateSQL(whereClause)
    return await db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1 AND merged_into_id IS NULL AND (${validated})
       LIMIT 500`,
      [userId]
    )
  } catch (err) {
    // Fallback: if AI fails or SQL is invalid, fall back to plain trigram search.
    // Why: user still gets results, just less precise. Never show an error for a
    // search — degrade gracefully. The GIN trigram index makes this fast at 200k.
    console.error('NL search failed, falling back to trigram search:', err)
    return await db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1
         AND merged_into_id IS NULL
         AND (
           name ILIKE $2 OR email ILIKE $2 OR
           company ILIKE $2 OR role ILIKE $2
         )
       LIMIT 500`,
      [userId, `%${query}%`]
    )
  }
}

// lib/embeddings.ts — embedding API down
// Fallback: store contact without embedding, flag as 'pending'.
// The partial index idx_contacts_pending_embed makes the nightly retry cron
// fast regardless of table size — it only scans the small pending subset.

// app/api/outreach/route.ts — stream errors
// AI SDK's toDataStreamResponse() surfaces errors to useChat's onError.
// The UI must show: partial response (if any) + retry button.
// Never discard a partial stream — show what arrived, then offer retry.
```

---

## Security checklist

These must all be implemented before submission.

- [ ] Clerk middleware on all `/app` routes and `/api` routes (including `/api/cron/*`)
- [ ] Cron routes verify `Authorization: Bearer ${CRON_SECRET}` — Vercel sets this header automatically; reject requests without it
- [ ] Every DB query filters by `user_id = $1` (Clerk user ID) — no cross-user data leakage
- [ ] CSV upload: validate MIME type (`text/csv`), reject files > 10MB, reject row count > 50k, sanitize all string fields before DB insert
- [ ] SQL injection: AI-generated WHERE clauses go through `validateSQL()` before execution — block DROP, DELETE, UPDATE, INSERT, semicolons, `--` comments
- [ ] Never send email addresses or raw contact records to the AI model — only the safe subset (name, role, company, events attended)
- [ ] Rate limit `/api/outreach`: max 20 requests/minute per user
- [ ] Vercel Blob URLs for uploaded CSVs are private (not public) — generate signed URLs for download, never expose the raw Blob URL

---

## Index maintenance

ivfflat partitions are fixed at index creation time and do not auto-rebalance as rows are added (unlike HNSW). The lists=200 setting is tuned for 200k rows. After significant growth, rebuild:

```sql
-- Run during low-traffic window (CONCURRENTLY avoids table lock)
REINDEX INDEX CONCURRENTLY idx_contacts_embedding;

-- When to trigger: row count grows 5x from last reindex.
-- Checkpoints: 24k (initial), 100k, 200k, 500k
-- At 500k+, evaluate switching to hnsw (better recall, slower writes,
-- but by 500k the bulk-import phase is likely complete).

-- Also run periodically to reclaim space from upserts and merges:
VACUUM ANALYZE contacts;
```

---

## Constraints & Policies

**Security — MUST follow:**
- NEVER expose `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLERK_SECRET_KEY`, or `DATABASE_URL` to the client — server-side only
- ALWAYS use environment variables for secrets
- NEVER commit `.env.local` or any file with API keys
- Validate and sanitize all user input — especially the AI-generated WHERE clause in NL search

**Code quality:**
- TypeScript strict mode
- Run `npm run lint` before committing
- No `any` types without justification

**Dependencies:**
- Prefer Shadcn components over adding new UI libraries
- Minimize external dependencies for MVP

---

## Design Style Guide

**Tech stack:** Next.js (App Router), Tailwind CSS, Shadcn UI
See `.claude/skills/frontend-design.md` and `.claude/skills/shadcn.md` for design and component rules.

**Visual style:**
- Clean, minimal interface — the data is the star
- Use Shadcn components for all interactive elements (buttons, inputs, cards)
- Tailwind for layout and spacing
- Responsive design (mobile-first)
- No dark mode for MVP
- Keep components focused and small

**UX principles:**
- Speed over perfection — get data visible fast, iterate quickly
- One-click actions where possible — imports, merges, segment builds
- Instant feedback — loading states, import summaries, conflict resolution inline
- Helpful error messages that suggest next steps

**Copy tone:**
- Casual and friendly
- Brief labels and instructions
- Never show raw database errors to the user

---

## Code comment requirements

The rubric explicitly says "add comments where you made deliberate decisions."
Every non-obvious choice needs a `// Why:` comment. Examples already shown above.
Additionally comment everywhere the following decisions appear:
- Why `ON CONFLICT DO UPDATE` on contact upsert (idempotent re-imports)
- Why `vector(1536)` dimension (matches text-embedding-3-small output exactly — wrong dimension = insert error)
- Why `ivfflat` not `hnsw` (ivfflat better for write-heavy workloads; hnsw has better recall but high insert cost — contacts are imported in bulk, writes dominate initially)
- Why `lists=200` not `lists=100` (correct for 200k rows per pgvector recommendation; 100 degrades recall at this scale)
- Why `probes=10` in dedup but `probes=1` in NL search (dedup prioritizes recall, NL search prioritizes speed)
- Why `REINDEX CONCURRENTLY` is needed for ivfflat (partitions are static; stale partitions degrade recall as data grows)
- Why Clerk over NextAuth (faster setup, built-in App Router support, no DB session table, managed token rotation)
- Why papaparse for CSV parsing (handles quoted fields, BOM characters, inconsistent line endings — all common in Luma exports)
- Why `unnest()` bulk update in embeddings (replaces N sequential round-trips with one query; critical at 200k)
- Why `last_dedup_checked_at` column (enables incremental dedup — O(new) not O(total) at scale)
- Why partial index on `embedding_status = 'pending'` (stays small at any table size; full index would grow to 200k+ rows for a rarely-queried column)

---

## README structure

The README must include:

1. Problem statement (2-3 sentences, a real person's problem)
2. Solution overview with screenshot or demo GIF
3. Architecture diagram (link to this file or inline)
4. Setup instructions (env vars, DB migration, `npm run dev`)
5. Data privacy note: *"Contact data is stored in your private Neon database. Only non-identifying fields (name, role, company, events attended) are sent to the AI model for drafting. Email addresses never leave your database."*
6. Eval results: show the output of `npm test` passing
7. Scale design note: explain the choices that make this work at 200k contacts (ivfflat lists, incremental dedup, chunked jobs, partial indexes)
8. Known limitations and what you'd build next

---

## Build order for Claude Code

Build in this sequence to have something demoable as fast as possible.
Write evals at step 5 — before NL search is complete — so they define the contract, not verify it after the fact.

1. **DB schema + Neon connection** (`lib/db.ts` + migration SQL above)
2. **Clerk auth + middleware** (protect everything from day one)
3. **CSV upload + schema mapper** (`/import` page + `/api/import`) — demo moment #1: import with dedup, conflict resolution, import summary
4. **Contact table with basic search** (`/contacts` page with keyset pagination)
5. **NL search evals** (`__tests__/evals.test.ts` — write contract before implementation)
6. **NL search** (`lib/nl-search.ts` + guardrails)
7. **Segment builder** (`/segments` page) — demo moment #2: plain-English audience segments, no embeddings needed
8. **Outreach drafter** (`/outreach` page with streaming) — demo moment #3: streaming AI draft via AI SDK
9. **Dashboard** (SSR + Suspense — fully demoable product at this point)
10. **Embedding pipeline** (`lib/embeddings.ts` + batch job with `unnest()` bulk update)
11. **`vercel.json` + cron routes** (`/api/cron/embed`, `/api/cron/dedup`) — wire up alongside embedding pipeline
12. **Dedup job** (`lib/dedup.ts` — incremental + chunked; schema + one working invocation is enough to discuss)
13. **Hallucination + dedup evals** (complete eval suite, run `npm test`)
14. **README + deploy to Vercel**

<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
