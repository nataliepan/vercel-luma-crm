# Project Status

Current progress against the build order defined in CLAUDE.md.

---

## Status: Building — steps 1–4 complete, step 5 next

---

## Completed

- [x] Database schema designed (contacts, events, contact_events, imports, segments, dedup_jobs, dedup_candidates)
- [x] CSV import pipeline specced (dedup rules, duplicate detection, filename parsing, import summary)
- [x] AI features specced (header normalization, tag inference, segment builder, outreach drafter, eval rubric)
- [x] Build order defined and prioritized for demo
- [x] CLAUDE.md, docs structure, and slash commands set up
- [x] Next.js 14 scaffolded (App Router, TypeScript, Tailwind, Shadcn UI)
- [x] All dependencies installed (Neon, Clerk, AI SDK, Vercel Blob, papaparse)
- [x] **Step 1:** `lib/db.ts` — two pool connections (pooled + direct), migration SQL run against Neon
- [x] **Step 2:** Clerk auth — middleware, ClerkProvider in layout, sign-in/sign-up pages
- [x] **Step 3:** CSV upload + schema mapper (`/import` page + `/api/import`)
  - AI-powered column normalization via `lib/schema-mapper.ts`
  - `unnest()` bulk upsert (25k contacts in ~2s)
  - Smart same-event detection: `evt-XXXX` from `qr_code_url` is primary key; email subset check as fallback
  - Merge-not-replace for same-event re-imports (newer fields win, old contacts preserved, series count unchanged)
  - Different events with same name auto-created as new series entries
  - Content hash blocks exact duplicate file uploads before any processing
- [x] **Step 4:** Contact table (`/contacts`) — keyset pagination, debounced trigram search, embed status badge
- [x] `next.config.ts` loads `.env.local` from main repo root in any git worktree (`--git-common-dir`)

---

## In Progress

- Nothing currently blocked

---

## Up Next (following build order)

5. **NL search evals** (`__tests__/evals.test.ts`) ← next — write contract before implementation
6. **NL search** (`lib/nl-search.ts` + guardrails + trigram fallback)
7. **Segment builder** (`/segments` page) — demo moment #2
8. **Outreach drafter** (`/outreach` page with streaming) — demo moment #3
9. **Dashboard** (SSR + Suspense streaming stats)
10. **Embedding pipeline** (`lib/embeddings.ts` + batch job with `unnest()`)
11. **`vercel.json` + cron routes** (`/api/cron/embed`, `/api/cron/dedup`)
12. **Dedup job** (`lib/dedup.ts` — incremental + chunked)
13. **Hallucination + dedup evals** (complete eval suite, `npm test`)
14. **README + deploy to Vercel**

---

## Blocked / Decisions Needed

- None currently
