# Changelog

All notable changes to the Luma CRM project are documented here.

---

## [Unreleased]

### Fixed
- **Error handling hardening** — consistent try/catch across all API routes and client fetch paths:
  - `GET /api/contacts` and `GET /api/contacts/count` — bare `db.query()` calls now wrapped; return `500` with `{ error }` JSON on failure instead of unhandled exceptions
  - `POST /api/segments/[id]/refresh` — count query and UPDATE wrapped; returns `500` on DB failure
  - `handleDelete` in segment card — previously called `onDelete()` unconditionally even if the DELETE request failed; now only removes from list after server confirms deletion, shows `alert()` on failure
  - `handleToggleContacts` — added `catch` branch that sets `contacts = []` and logs instead of silently swallowing fetch errors
  - `handleRefresh` — added `catch` branch; non-ok responses logged instead of silently ignored
  - `loadSegments` (segments page + outreach page) — non-ok responses now logged; `catch` block added for network errors
  - `fetchContacts` in contacts page — replaced `JSON.parse(res.text())` with `res.json()` in a try/catch; malformed responses (e.g. Clerk HTML redirects) degrade to empty state rather than crashing
  - Outreach stream error display — raw HTML error responses (e.g. auth redirects) are now replaced with a generic status message instead of dumping markup into the error box

### Added
- **Outreach drafter** (`/outreach` page + `POST /api/outreach`) — pick a saved segment, choose outreach type (event invite / newsletter / speaker ask / sponsor ask / general), describe your goal, and get a streaming AI draft word-by-word; Regenerate and Copy buttons appear on completion
- `POST /api/outreach` — fetches segment metadata + runs filter to sample up to 10 contacts (name/role/company only — email/phone/linkedin never sent to AI); streams response via `@anthropic-ai/sdk` messages.stream → plain-text ReadableStream; errors encoded inline so the client always sees feedback
- Outreach link added to sidebar nav
- `@ai-sdk/react` installed (available for future use; outreach route uses `@anthropic-ai/sdk` directly due to `@ai-sdk/anthropic` v3 hitting wrong API base URL)

### Fixed
- `@ai-sdk/anthropic` v3 hits `https://api.anthropic.com/messages` (missing `/v1/` prefix) returning 404 — outreach route bypasses this by using `@anthropic-ai/sdk` directly with a manual ReadableStream

### Added
- **Segment card contact drill-through** — "View contacts" expands lazily-loaded list inside each saved segment card; shows name, role, email, phone, and LinkedIn with per-field copy buttons (name, email, LinkedIn URL each have independent 2s flash copy)
- `GET /api/segments/[id]/contacts` — returns up to 2,000 matching contacts with phone extracted from `raw_fields` JSONB (tries `phone`, `Phone`, `Phone Number`, `phone_number`, `Mobile`, `mobile`)
- `POST /api/segments/[id]/contacts` — AI-powered in-place refinement: takes a plain-English description, generates a WHERE clause via `generateWhereClause`, ANDs it with the segment's stored `filter_sql`, returns the narrowed contact list; used by the refine bar in the segment card
- `POST /api/segments/[id]/refresh` — reruns filter and updates cached `contact_count`; invalidates client-side contact cache so next expand fetches fresh data
- **Export CSV** from segment — downloads `{label}-contacts.csv` with name, email, given_email, company, role, linkedin_url, phone; generated client-side from already-loaded data (no extra round-trip); respects active refinement
- **Copy emails** with separator picker — `,` comma, `↵` newline, or free-form custom separator; separator input sanitized (strips control chars, formula-injection prefixes `=+-@|\``, max 10 chars); uses `given_email` over `email` when available; respects active refinement
- **Refresh count** button on each segment card — spinner icon, updates badge live, invalidates contact cache
- `CopyButton` component — self-contained copy + 2s green checkmark flash, one per field so clicks don't affect other rows
- **AI-powered segment refine bar** — always visible when contacts panel is open; plain-English input (e.g. "used coupon", "from SF") ANDs a new AI-generated filter with the base segment server-side; shows "X of Y contacts" count; ✕ to clear restores original list without re-fetch
- **Save refined segment as new** — "Save as new segment" button appears in the refine bar once results are ready; calls `POST /api/segments` with `base_segment_id`; new segment appears at top of list

### Changed
- Segment toolbar redesigned: `Export CSV` separated from `Copy emails + Separator` group by a vertical divider; "Separator" label added so the `,` `↵` custom controls are clearly associated with copy not export
- `SEGMENT_BUILDER_PROMPT` updated with explicit guidance to combine multiple `contact_events` conditions in a single `EXISTS` subquery (prevents cross-event false matches when ANDing coupon + amount conditions)
- `SEGMENT_BUILDER_PROMPT` extended with a combined coupon+paid example to guide correct SQL generation for compound ticket queries

- **Segment builder** (`/segments` page + `GET|POST|DELETE /api/segments`) — plain-English audience segments with AI-generated WHERE clause, 600ms debounced live preview showing contact count + 3 sample matches, 10 example query chips to solve the cold-start blank-textarea problem, saved segment list with collapsible SQL view and delete
- Ticket/payment fields promoted from `raw_row` to proper `contact_events` columns: `amount`, `amount_tax`, `amount_discount`, `currency`, `coupon_code`, `ticket_name`, `ticket_type_id` — enables segment queries like "contacts who used a coupon" or "people who paid for a ticket" without JSONB gymnastics
- `scripts/migrate-ticket-fields.mts` — one-time migration to backfill ticket columns from existing `raw_row` data + partial index on `coupon_code`
- `normalizeCustomKey()` in import pipeline — normalizes raw CSV headers to consistent snake_case keys for `custom_responses` JSONB (e.g. `"What's your city? *"` → `"whats_your_city"`)
- Segments link added to sidebar nav

### Changed
- `extractFields()` in `app/api/import/route.ts` — unmapped and `notes`-mapped fields now go to `custom_responses` (keyed by normalized header) instead of `contacts.notes`; novel headers not in the schema mapper output are also captured so no registration data is silently lost
- `NL_SEARCH_PROMPT` expanded with full `contact_events` schema: ticket fields, `custom_responses` JSONB access patterns, `raw_row` fallback, and 4 new examples (coupon, paid ticket, city, funding stage)
- `SEGMENT_BUILDER_PROMPT` rewritten with full schema context, structured JSON output format, filter_sql rules, and 2 examples

### Added
- `lib/nl-search.ts` — `generateWhereClause` (Claude → WHERE fragment), `validateSQL` (blocks DROP/DELETE/UPDATE/INSERT/semicolons/comments), and `searchContacts` with GIN trigram fallback
- `checkForHallucinations` helper in `lib/prompts.ts` — used by evals and the outreach pipeline; lazy Anthropic client init so env vars are read at call time not import time
- `__tests__/evals.test.ts` — 16 tests: 6 NL search cases, 6 `validateSQL` unit tests, 4 hallucination checks; all passing
- Jest test harness: `jest.config.ts` + `jest.setup.ts` with ts-jest, `--runInBand`, and a custom `.env.local` parser (bypasses Node `--env-file` bug that silently drops lines after a >128-byte value)
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
