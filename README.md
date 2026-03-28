# Luma CRM

**Community builder's intelligence layer over Luma event contacts.**

I run 50+ community events a year on Luma. After each event I get a CSV export with different columns, different schemas, different quirks. Over time I've accumulated 24,000+ contacts across dozens of files with no way to search, segment, or do targeted outreach. Luma CRM solves this: upload your CSVs, let AI normalize and deduplicate them, then search with plain English, build audience segments by describing them, and draft personalized outreach — all in one place.

## What it does

1. **Upload CSVs** from Luma events — AI normalizes different schemas automatically
2. **Deduplicate contacts** across events using vector similarity + fuzzy matching
3. **Search contacts** with natural language ("show me YC founders who attended 3+ events")
4. **Build audience segments** by describing them in plain English
5. **Draft personalized outreach** (newsletter, event invite, speaker ask) per segment with streaming AI

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, React 19) |
| Database | Neon Postgres + pgvector |
| Auth | Clerk |
| AI | Claude Sonnet 4.6 via Anthropic SDK |
| Embeddings | OpenAI text-embedding-3-small |
| Storage | Vercel Blob (CSV audit trail) |
| Styling | Tailwind CSS + Shadcn UI |
| Deploy | Vercel |

## Architecture

```
CSV Upload  -->  AI Schema Mapper  -->  Bulk Upsert (unnest)
                                            |
                                    embedding_status = 'pending'
                                            |
                              Nightly Cron (2am UTC)
                                            |
                                    OpenAI Embeddings
                                    (batch of 2048)
                                            |
                              Nightly Cron (3am UTC)
                                            |
                                  Two-pass Dedup
                          Pass 1: exact email match
                          Pass 2: vector cosine similarity (0.92 threshold)
                                            |
                                  dedup_candidates table
                                  (human reviews + confirms)
```

**NL Search pipeline:** User query -> Claude generates WHERE clause -> `validateSQL()` blocks injection -> query runs with `user_id` isolation -> trigram fallback if AI fails.

**Outreach pipeline:** Select segment -> Claude drafts personalized message -> hallucination check flags invented facts -> user edits and sends.

## Data privacy

Contact data is stored in your private Neon database. Only non-identifying fields (name, role, company, events attended) are sent to the AI model for drafting. Email addresses never leave your database.

## Setup

### Prerequisites

- Node.js 18+
- Neon Postgres database with pgvector extension
- Clerk account
- OpenAI API key (embeddings)
- Anthropic API key (AI features)

### Environment variables

```bash
# .env.local
DATABASE_URL=              # Neon pooled connection string
DATABASE_URL_UNPOOLED=     # Neon direct connection (migrations, background jobs)
OPENAI_API_KEY=            # text-embedding-3-small
ANTHROPIC_API_KEY=         # Claude Sonnet 4.6
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
BLOB_READ_WRITE_TOKEN=     # Vercel Blob (optional for local dev)
CRON_SECRET=               # Random secret for cron route auth
```

### Run locally

```bash
npm install

# Run database migration
npx tsx scripts/migrate.sql  # or run the SQL in scripts/migrate.sql against your Neon DB

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you'll be redirected to sign in via Clerk, then to the dashboard.

### Run tests

```bash
# Run NL search + hallucination evals (requires API keys)
npm test

# For dedup evals, seed test data first:
npx tsx scripts/seed-test-data.ts
# Then embed the test contacts via the dashboard "Embed contacts" button
# Then run tests again
npm test
```

## Scale design

Every design choice targets 200k contacts — not just today's 24k:

- **ivfflat index** with `lists=200` (tuned for 200k rows; `REINDEX CONCURRENTLY` when row count grows 5x)
- **Incremental dedup** via `last_dedup_checked_at` — O(new imports) not O(total contacts) per nightly run
- **Chunked background jobs** — 2000 contacts per batch, checkpointed, resumable across cron invocations
- **Partial indexes** on `embedding_status = 'pending'` and `last_dedup_checked_at IS NULL` — stay small regardless of table size
- **Keyset pagination** — O(1) per page vs OFFSET's O(n)
- **Batch embeddings** — 2048 inputs per OpenAI call, `unnest()` bulk DB writes
- **Two connection pools** — pooled (PgBouncer) for API routes, direct for background jobs

## Known limitations

- Dedup merge UI not yet built — candidates are flagged but merge is manual via DB
- No dark mode
- No real-time sync with Luma API (CSV upload only)
- Cron jobs require Vercel Pro for schedules longer than daily

## What's next

- Import history with original file download
- Inline segment editing (rename, update description)
- Dedup review UI with side-by-side comparison and one-click merge
- Luma API integration for automatic contact sync
