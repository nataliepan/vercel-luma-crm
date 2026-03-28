# Project Status

Current progress against the build order defined in CLAUDE.md.

---

## Status: Building — steps 1–9 complete, step 10 next

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
- [x] **Step 5:** NL search evals (`__tests__/evals.test.ts`) — 16/16 passing: 6 NL search cases, 6 `validateSQL` unit tests, 4 hallucination checks
- [x] **Step 6:** NL search (`lib/nl-search.ts`) — `generateWhereClause`, `validateSQL` guardrails, trigram fallback; `checkForHallucinations` in `lib/prompts.ts`
- [x] Jest harness (`jest.config.ts`, `jest.setup.ts`) — ts-jest, `--runInBand`, custom env loader (works around Node `--env-file` bug with long lines)
- [x] **Step 7:** Segment builder (`/segments` page + `/api/segments`)
  - Plain-English → AI-generated PostgreSQL WHERE clause via `SEGMENT_BUILDER_PROMPT`
  - `validateSQL()` gates all AI-generated SQL before execution
  - 600ms debounced live preview: contact count + 3 sample matches before saving
  - 10 example query chips (founders, coupon users, paid tickets, VCs, city, funding stage, etc.)
  - Saved segments list with collapsible SQL view and delete
  - Ticket/payment fields (`amount`, `coupon_code`, etc.) promoted to proper columns + migration script
  - `custom_responses` now correctly populated from all unmapped CSV fields (normalized snake_case keys)
- [x] **Segment card enhancements** (post step 7 quality-of-life)
  - Contact drill-through: lazy-loaded list with name/role/email/phone/LinkedIn + per-field copy buttons
  - Export CSV (client-side, includes phone + LinkedIn, respects active refinement)
  - Copy emails with separator picker (comma / newline / custom, injection-safe)
  - Refresh count button (live badge update, invalidates contact cache)
  - AI-powered refine bar: plain-English narrowing within a saved segment, "X of Y contacts" count, ✕ to restore
  - Save refined view as new segment (`base_segment_id` ANDs filters server-side)
- [x] **Step 8:** Outreach drafter (`/outreach` page + `POST /api/outreach`)
  - Segment picker + outreach type chips (event invite, newsletter, speaker ask, sponsor ask, general)
  - Context textarea with type-aware placeholder
  - Word-by-word streaming via `@anthropic-ai/sdk` messages.stream → plain ReadableStream
  - Only name/role/company sent to AI — email/phone/linkedin never leave the DB
  - Regenerate and Copy on completion; errors surface inline in red box
  - Note: `@ai-sdk/anthropic` v3 has wrong base URL bug; route uses `@anthropic-ai/sdk` directly
- [x] **Step 9:** Dashboard + production-grade error handling & AI safety
  - SSR dashboard with React Suspense streaming 4 stat cards + recent contacts + quick actions
  - Each async RSC wrapped in try/catch with graceful `StatErrorCard` fallback
  - `error.tsx` for every route + `global-error.tsx` for root layout failures
  - Rate limiting on all AI endpoints (`lib/rate-limit.ts` — outreach 20/min, segments 30/min)
  - AI call audit logging (`lib/ai-log.ts` — fire-and-forget to DB with input/output/tokens/duration)
  - Hallucination check endpoint (`POST /api/outreach/check`) — auto-runs after outreach stream, amber warning UI
  - Hardened error handling: generic error messages, req.json() guards, safe parseInt, Blob path sanitization, useEffect cleanup

---

## In Progress

- Nothing currently blocked

---

## Up Next (following build order)

10. **Embedding pipeline** (`lib/embeddings.ts` + batch job with `unnest()`) ← next
11. **`vercel.json` + cron routes** (`/api/cron/embed`, `/api/cron/dedup`)
12. **Dedup job** (`lib/dedup.ts` — incremental + chunked)
13. **Hallucination + dedup evals** (complete eval suite, `npm test`)
14. **README + deploy to Vercel**

## Future Features

15. **Imports history** (ability to download original file)
16. **Edit segment** — rename label/description inline on the saved segment card (small QoL fix)

---

## Blocked / Decisions Needed

- None currently
