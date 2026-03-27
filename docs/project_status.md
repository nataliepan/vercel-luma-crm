# Project Status

Current progress against the build order defined in CLAUDE.md.

---

## Status: Building — steps 1 and 2 complete

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
- [x] **Step 2:** Clerk auth — `proxy.ts` middleware, ClerkProvider in layout, sign-in/sign-up pages

---

## In Progress

- [ ] Fixing `MIDDLEWARE_INVOCATION_FAILED` error (Next.js 16 proxy.ts rename in progress)

---

## Up Next (following build order)

3. CSV upload + schema mapper (`/import` page + `/api/import`) ← next
4. Contact table with basic search (`/contacts`)
5. NL search evals (`__tests__/evals.test.ts`)
6. NL search (`lib/nl-search.ts`)
7. Segment builder (`/segments`)
8. Outreach drafter (`/outreach`)
9. Dashboard
10. Embedding pipeline
11. `vercel.json` + cron routes
12. Dedup job
13. Hallucination + dedup evals
14. README + deploy

---

## Blocked / Decisions Needed

- None currently
