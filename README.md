# Luma CRM

**Community builder's intelligence layer over Luma event contacts.**

I run 50+ community events a year on Luma. After each event I get a CSV export with different columns, different schemas, different quirks. Over time I've accumulated 24,000+ contacts across dozens of files with no way to search, segment, or do targeted outreach. Luma CRM solves this: upload your CSVs, let AI normalize and deduplicate them, then search with plain English, build audience segments by describing them, and draft personalized outreach — all in one place.

## What it does

1. **Upload CSVs** from Luma events — AI normalizes different column schemas automatically
2. **Deduplicate contacts** across events using exact email matching + vector similarity for fuzzy identity matching
3. **Search contacts** with natural language ("show me YC founders who attended 3+ events") — AI generates safe SQL
4. **Build audience segments** by describing them in plain English ("people from San Francisco in AI")
5. **Draft personalized outreach** (newsletter, event invite, speaker ask) per segment with streaming AI

## How AI is used

| Feature | What AI does | Model |
|---------|-------------|-------|
| **Schema mapping** | Normalizes messy CSV column headers ("What's your LinkedIn?" -> `linkedin_url`) at import time | Claude Sonnet 4.6 |
| **NL Search** | Translates plain English queries into safe PostgreSQL WHERE clauses | Claude Sonnet 4.6 |
| **Segment builder** | Converts segment descriptions into SQL filters against contacts and registration data | Claude Sonnet 4.6 |
| **Outreach drafting** | Generates personalized messages with streaming, based on contact profile + segment context | Claude Sonnet 4.6 |
| **Hallucination check** | Reviews outreach drafts for invented facts not in the contact record | Claude Sonnet 4.6 |
| **Embeddings** | Converts contact profiles into vectors for fuzzy dedup (catching "Jon" vs "Jonathan") | OpenAI text-embedding-3-small via Vercel AI Gateway |

Key design choice: NL search and segments use **AI-generated SQL**, not vector search. Structured data (name, company, role, registration answers) is best queried with SQL. Embeddings are used specifically for the **identity matching** problem in dedup, where exact string matching fails.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, React 19) |
| Database | Neon Postgres + pgvector |
| Auth | Clerk |
| AI (generation) | Claude Sonnet 4.6 via Anthropic SDK |
| AI (embeddings) | OpenAI text-embedding-3-small via Vercel AI Gateway |
| Storage | Vercel Blob (CSV audit trail) |
| Styling | Tailwind CSS + Shadcn UI |
| Deploy | Vercel |

## Architecture

```
CSV Upload  -->  AI Schema Mapper  -->  Bulk Upsert (unnest)
                (Claude normalizes       (25k rows in ~2s,
                 column headers)          ON CONFLICT = idempotent)
                                            |
                                    embedding_status = 'pending'
                                            |
                              Nightly Cron (2am UTC) ──── Vercel AI Gateway
                                            |                    |
                                    Batch Embeddings      openai/text-embedding-3-small
                                    (chunks of 2048)      (1536 dimensions)
                                            |
                              Nightly Cron (3am UTC)
                                            |
                                  Two-pass Dedup
                          Pass 1: exact email match (~80% of dupes)
                          Pass 2: vector cosine similarity (0.92 threshold)
                                            |
                                  dedup_candidates table
                                  (human reviews + confirms)
```

**NL Search pipeline:** User query -> Claude generates WHERE clause (not full SQL) -> `validateSQL()` blocks injection -> query runs with `user_id` isolation + `LIMIT 500` -> trigram fallback if AI fails.

**Segment builder pipeline:** Plain English description -> Claude generates WHERE clause + label + description -> `validateSQL()` gates execution -> live preview (count + 3 sample contacts) before saving.

**Outreach pipeline:** Select segment -> Claude drafts personalized message (only name/role/company sent to AI, never emails) -> hallucination check flags invented facts -> user edits template -> per-contact personalization with `[name]`/`[company]` substitution.

## Data privacy

Contact data is stored in your private Neon database. Only non-identifying fields (name, role, company, events attended) are sent to the AI model for drafting. Email addresses never leave your database. Uploaded CSVs are stored as private blobs (not public URLs).

## Setup

### Prerequisites

- Node.js 18+
- Neon Postgres database with pgvector extension
- Clerk account
- Vercel AI Gateway key (for embeddings)
- Anthropic API key (for AI features)

### Environment variables

See `.env.example` for the full list:

```bash
# .env.local
DATABASE_URL=                    # Neon pooled connection string (PgBouncer)
DATABASE_URL_UNPOOLED=           # Neon direct connection (migrations, background jobs)
AI_GATEWAY_API_KEY=              # Vercel AI Gateway (routes to OpenAI for embeddings)
ANTHROPIC_API_KEY=               # Claude Sonnet 4.6
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
BLOB_READ_WRITE_TOKEN=           # Vercel Blob (optional for local dev)
CRON_SECRET=                     # Random secret for cron route auth
```

### Run locally

```bash
npm install

# Run database migration against your Neon DB
# (execute the SQL in scripts/migrate.sql)

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — sign in via Clerk, then you'll land on the dashboard.

### Run tests

```bash
# NL search + hallucination evals (16 tests, requires Anthropic API key)
npm test

# For dedup evals (optional — requires seeded test data + embeddings):
npx tsx scripts/seed-test-data.ts
# Embed test contacts via dashboard "Embed contacts" button, then:
npm test
```

## Evals

Three evaluation approaches, all in `__tests__/evals.test.ts`:

1. **NL Search contract tests** — 6 queries verified for safe SQL generation (no DROP/DELETE/semicolons) and relevant content (correct tables and terms referenced)
2. **Hallucination regression checks** — 4 tests ensuring outreach drafts don't invent company names, event attendance, or facts not in the contact record
3. **Dedup precision/recall** — 10 seeded duplicate pairs with realistic variations (name casing, nicknames, different emails). Target: precision >= 0.8, recall >= 0.8

Plus 6 unit tests for `validateSQL()` — the SQL injection defense layer that gates all AI-generated queries.

## Scale design

Every design choice targets 200k contacts — not just today's 24k:

- **ivfflat index** with `lists=200` (tuned for 200k rows per pgvector recommendation; `REINDEX CONCURRENTLY` when row count grows 5x)
- **Incremental dedup** via `last_dedup_checked_at` — O(new imports) not O(total contacts) per nightly run
- **Chunked background jobs** — 2000 contacts per dedup batch, checkpointed, resumable across cron invocations
- **Partial indexes** on `embedding_status = 'pending'` and `last_dedup_checked_at IS NULL` — stay small regardless of table size
- **Keyset pagination** — O(1) per page vs OFFSET's O(n) at depth
- **Batch embeddings** — 2048 inputs per API call via Vercel AI Gateway, `unnest()` bulk DB writes
- **Two connection pools** — pooled (PgBouncer) for API routes, direct (unpooled) for background jobs that need long transactions

## Known limitations

- Dedup merge UI not yet built — candidates are flagged but merge is manual via DB
- Custom registration field keys vary per event — prompts include known keys but new events may introduce unrecognized ones
- No dark mode
- No real-time sync with Luma API (CSV upload only)

## What's next

- Normalize `custom_responses` keys at import time (AI maps all variations to canonical keys like `city`, `industry`)
- Dedup review UI with side-by-side comparison and one-click merge
- Import history with original file download
- Luma API integration for automatic contact sync
