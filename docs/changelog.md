# Changelog

All notable changes to the Luma CRM project are documented here.

---

## [Unreleased]

### Added
- Smart same-event detection using Luma's `qr_code_url` `evt-XXXX` ID as the primary key — two exports of the same event always match, two different events with the same name never collide
- Email subset check as fallback when no `qr_code_url` is present — if one file's contacts are a strict subset of the other's, they're the same event
- Merge-not-replace logic for same-event re-imports: newer export fields win per-contact, contacts only in the older export are preserved, new contacts are added; event row and series count are never incremented
- Different events sharing a name auto-create as new series entries (no user prompt)
- `next.config.ts` now loads `.env.local` from the main repo root in any git worktree using `git rev-parse --git-common-dir` — worktrees no longer need a symlinked or duplicated `.env.local`
- Added `/contacts` page with keyset cursor pagination (O(1) at any depth), debounced trigram search, embed status badge, and load-more
- Added `GET /api/contacts` and `GET /api/contacts/count` endpoints
- Root `/` now redirects to `/contacts`
- Added minimal nav bar (Contacts, Import) to root layout

### Performance
- Replaced row-by-row contact upsert with `unnest()` bulk upsert — imports 25k contacts in ~2s instead of 4+ minutes (50k round-trips → 2 queries)

### Fixed
- Increased schema mapper `maxOutputTokens` 500→1024 to prevent JSON truncation on wide CSVs
- Reverted `dev` script to plain `next dev` (turbopack flag doesn't exist in this Next.js version)
- Env vars from `.env.local` now correctly resolve in git worktrees (previously Clerk ran in keyless mode and DB connections failed)

### Chore
- Added post-commit hook to auto-update changelog after every commit
- Fixed changelog filename case in `/update-docs-and-commit` command
- Added `.claude/settings.json` with shared permissions and hooks
- Added `docs/.env.example` with required environment variables
- Ignored `.windsurf/`, `.cursor/`, `.agents/` in `.gitignore`
- Cleaned up duplicate `skills/` and `.windsurf/` directories

### Spec & Planning
- Defined full database schema: `contacts`, `events`, `contact_events`, `imports`, `segments`, `dedup_jobs`, `dedup_candidates`
- Specced CSV import pipeline with duplicate file detection (content hash + contact overlap gates)
- Defined deduplication rules: email/given_email/LinkedIn match signals + pgvector cosine similarity
- Specced LinkedIn conflict resolution UI with newer/older record labeling
- Specced import summary (new / updated / existed / pending review counts)
- Specced filename parsing for `series_name`, `last_exported_at`, and `event_date` derivation
- Specced segment builder as plain-English audience query interface
- Specced outreach drafter with streaming via Vercel AI SDK
- Defined AI eval rubric (accuracy, relevance, tone) with hallucination checks
- Defined build order prioritizing demoable features before infrastructure
- Added design style guide (Shadcn UI, Tailwind, clean/minimal)
- Added constraints & policies (security, code quality, dependencies)
