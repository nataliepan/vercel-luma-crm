# Changelog

All notable changes to the Luma CRM project are documented here.

---

## [Unreleased]

### Performance
- Replaced row-by-row contact upsert with `unnest()` bulk upsert — imports 25k contacts in ~2s instead of 4+ minutes (50k round-trips → 2 queries)

### Fix
- Increased schema mapper `maxOutputTokens` 500→1024 to prevent JSON truncation on wide CSVs
- Reverted `dev` script to plain `next dev` (turbopack flag doesn't exist in this Next.js version)

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
