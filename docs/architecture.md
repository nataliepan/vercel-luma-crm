# Architecture

System design and data flow for Luma CRM.

---

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 App Router | SSR, streaming, RSC — all needed for this app |
| Database | Neon Postgres + pgvector | Relational + vector similarity in one DB, no separate vector store |
| Auth | Clerk | Built-in App Router support, managed token rotation, no session table |
| AI | Vercel AI SDK + Claude claude-sonnet-4-6 | Streaming primitives, provider-agnostic, clean RSC integration |
| Embeddings | OpenAI text-embedding-3-small | Best cost/quality ratio for contact profile similarity |
| Storage | Vercel Blob | CSV audit trail, private access, no DB overhead |
| Styling | Tailwind CSS + Shadcn UI | Consistent components, no new UI libraries |

---

## Data Flow

### CSV Import
```
User uploads CSV
  → content_hash checked against imports table (exact duplicate gate)
  → series_name derived from filename (recurring event gate)
  → AI maps column headers to canonical schema
  → rows parsed, contact overlap computed (>70% = warning)
  → contacts upserted via match signals (email → given_email → linkedin_url)
  → LinkedIn conflicts queued for manual review
  → contact_events rows inserted
  → approval status counts computed on events row
  → event_date derived from MIN(contact_events.created_at)
  → embedding_status = 'pending' set on new/updated contacts
  → import summary returned
```

### Embedding Pipeline (nightly cron, 2am UTC)
```
Query contacts WHERE embedding_status = 'pending'
  → batch in chunks of 2048
  → send to OpenAI text-embedding-3-small
  → bulk update via unnest() — one query per chunk
  → set embedding_status = 'done'
  → failures marked 'failed', retried next run
```

### Dedup Job (nightly cron, 3am UTC)
```
Query contacts WHERE last_dedup_checked_at IS NULL
  → Pass 1: exact email match → auto-merge
  → Pass 2: vector cosine similarity (probes=10 for recall)
  → pairs above 0.92 threshold → insert into dedup_candidates
  → set last_dedup_checked_at = now()
  → user reviews candidates, confirms merge or rejects
```

### NL Search / Segment Builder
```
User types plain-English query
  → Claude generates WHERE clause (not full SQL)
  → validateSQL() blocks dangerous patterns
  → user_id = $1 enforced as outer condition
  → LIMIT 500 appended
  → results returned
```

### Outreach Drafter
```
User selects segment + provides context
  → contact sample prepared (name, role, company, events — no email)
  → streamText via Claude claude-sonnet-4-6
  → tokens stream to client via useChat
  → hallucination check runs on completed draft
```

---

## Rendering Strategy

| Page | Strategy | Reason |
|---|---|---|
| `/dashboard` | SSR + Suspense streaming | 3 independent DB queries stream in progressively |
| `/contacts` | SSR + keyset pagination | User-specific, changes frequently, no cache benefit |
| `/segments` | Client component + SWR | Highly interactive — live count preview as user types |
| `/outreach` | Client component + useChat | Streaming AI response requires client-side subscription |
| `/import` | Client component | File upload + multi-step flow with inline conflict resolution |

---

## Multi-tenancy

Every table has `user_id TEXT NOT NULL` (Clerk user ID). All queries enforce `WHERE user_id = $1` as a non-optional outer condition — never derived from the request body, always from the authenticated session.

---

## Key Trade-offs

- **ivfflat over hnsw**: better for write-heavy bulk imports; revisit at 500k+ contacts when reads dominate
- **No Redis/KV**: Neon with proper indexes handles all query patterns at 200k rows; would add cache invalidation complexity with no measurable gain
- **No Edge Runtime**: Neon requires TCP; Edge Runtime has no native TCP support — standard Node.js serverless functions used instead
- **Dedup at import time**: more expensive upfront, but dirty data fed to LLMs produces confident-sounding wrong answers — catching duplicates early is a quality and safety concern
