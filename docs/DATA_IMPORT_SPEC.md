# Data Import Spec

Covers the CSV ingestion pipeline — from raw Luma export to merged contact record.

---

## CSV Ingestion Flow

1. User uploads a Luma CSV export
2. **Duplicate file check** runs before any processing (see below)
3. AI maps raw column headers to canonical schema (see `AI_SPEC.md`)
4. Each row is upserted against existing contacts using deduplication rules below
5. **Contact overlap check** runs after parsing, before committing (see below)
6. Full raw row is stored in `contact_events` for auditability
7. Import metadata (filename, event name, column map) is saved to `imports` table
8. AI generates an import summary (see `AI_SPEC.md`)

---

## Duplicate Upload Detection (Option C)

Two-gate approach to catch re-uploads of the same event, whether exact or re-exported.

### Gate 1 — Fast path: normalized filename match

On upload, derive `series_name` from the filename by stripping the trailing export timestamp:

```
"How to Validate Your MVP_ ... - Guests - 2026-03-12-04-06-28.csv"
                                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^ strip this
→ series_name = "How to Validate Your MVP: ..."
```

Check if `series_name` already exists in the `events` table.

**If matched**: surface a prompt before processing begins asking the user to clarify intent:

> **"[series_name]" already exists.**
> Last imported: [last_exported_at date]
>
> Is this file a new session of this event, or a re-export of the same one?
>
> [ New session ] — creates a new event record under the same series
> [ Re-export / update ] — upserts into the existing event, no new event record created

**New session**: a new row is inserted into `events` with the same `series_name`, and all contacts are linked to the new event record.

**Re-export / update**: no new event row is created; existing `contact_events` rows are upserted, new contacts are added, and approval status counts are recomputed.

### Gate 2 — Slow path: contact overlap check

After parsing the CSV rows (but before writing to the database), compute:

```
overlap_pct = (rows whose email already exists in contact_events for this event) / (total rows) * 100
new_rows    = total rows - matched rows
```

**If `overlap_pct > 70%` and `new_rows < 5% of total`**: escalate to a stronger warning requiring explicit confirmation:
> "95% of contacts in this file already exist and fewer than 5% are new. This may be a duplicate upload. Proceed anyway?"

User must explicitly confirm to continue. This prevents silent double-imports from cluttering the contact history.

### Decision matrix

| Gate 1 match | Gate 2 overlap | Behavior |
|---|---|---|
| No | — | Normal import, no warning |
| Yes | Low overlap | Soft warning — one-click proceed |
| Yes | High overlap + few new | Hard warning — requires explicit confirm |
| No | High overlap + few new | Hard warning (same event, renamed file?) |

---

## Filename Parsing

CSV filenames follow the pattern:
```
{title} - Guests - {YYYY-MM-DD-HH-MM-SS}.csv
```

Example:
```
How to Validate Your MVP_ Strategic Product Frameworks for Solo & Non-technical Founders - Guests - 2026-03-12-04-06-28.csv
```

Parsed result:
- `events.name` → `How to Validate Your MVP: Strategic Product Frameworks for Solo & Non-technical Founders`
- `events.series_name` → same as `name` (set on creation, used for grouping recurring instances)
- `events.last_exported_at` → `2026-03-12 04:06:28 UTC`
- `events.event_date` → derived from `MIN(contact_events.created_at)` after rows are imported

Rules:
1. Strip everything from ` - Guests - ` onward to get `name`
2. Replace `_` with `:` in the title
3. Parse the trailing `YYYY-MM-DD-HH-MM-SS` as `last_exported_at`

---

## Luma CSV Fields

Fields available in a Luma guest list CSV export. Event history (invited/registered/attended counts) is **not** included in the CSV — it is derived by this CRM across imports.

| Field | Maps to | Notes |
|-------|---------|-------|
| Name | `contacts.first_name` + `last_name` | Split on first space |
| Email | `contacts.email` | Primary dedup key |
| Approval status | `contact_events.approval_status` | `approved` / `pending` / `declined` / `invited` |
| Created at | `contact_events.created_at` | Registration timestamp; used to derive `event_date` |
| Ticket name | `contact_events.ticket_name` | |
| Has joined event | `contact_events.has_joined_event` | Whether they actually attended |
| Custom question answers | `contact_events.custom_responses` | Vary per event; promoted to contacts where applicable |

---

## Deduplication Rules

### Match signals (evaluated in order)

| Priority | Signal | Behavior |
|---|---|---|
| 1 | Incoming `email` matches existing `email` | Auto-merge |
| 2 | Incoming `given_email` matches existing `email` | Auto-merge |
| 3 | Incoming `email` matches existing `given_email` | Auto-merge |
| 4 | Incoming `given_email` matches existing `given_email` | Auto-merge |
| 5 | Incoming `linkedin_url` matches existing `linkedin_url` | Auto-merge |
| 6 | No match on any signal | Create new contact |

### Merge behavior (auto-merge)

- Scalar fields: newer import wins (by `imported_at`)
- Array fields (`tags`): unioned, no duplicates
- `given_email`: updated if incoming value differs and is non-empty
- `linkedin_url`: updated if existing is empty; flagged for review if both are present and differ
- New `custom_fields` keys are added; existing keys only overwritten if import is newer

### LinkedIn conflict resolution

When a merge is triggered (by any signal) and both records have a **non-null, differing `linkedin_url`**, queue a review item. The review UI must:

- Show both URLs as **clickable links**, each labeled with the contact's `created_at` date — append **(newer)** next to whichever was created more recently
- Present two options, one per URL — user picks which to keep
- Once a choice is made, show an **"Apply to all remaining conflicts"** option that describes the rule, not the value:
  - If they picked the newer record → "Always use the newer LinkedIn for remaining conflicts"
  - If they picked the older record → "Always use the older LinkedIn for remaining conflicts"

If only one side has a LinkedIn URL, take the non-null value automatically with no prompt.

### Idempotency

Re-importing the same event does not create duplicate `contact_events` rows (enforced by the unique index on `contact_id, event_id`).

---

## Import Summary

After every import, display a summary broken down as follows:

| Category | Description |
|---|---|
| **New contacts** | Emails not seen in any previous import — new rows created in `contacts` |
| **Updated contacts** | Existing contacts where at least one field changed (e.g. new LinkedIn, company, given_email) |
| **Already existed** | Existing contacts with no field changes — event attendance recorded but profile unchanged |
| **Pending review** | LinkedIn soft-matches that need manual resolution before merging |

Example:
> 42 new contacts · 18 updated · 31 already existed · 2 need review

Pending review items are surfaced immediately after the summary so they can be resolved in the same flow.

---

## Raw Row Storage

Every imported CSV row is stored verbatim as `raw_row JSONB` in `contact_events`. This ensures:
- No data is ever lost due to a bad AI mapping
- Incorrect mappings can be corrected and re-processed without re-uploading the file
- Full audit trail of what came from which event

---

## Open Questions

- [ ] Should contacts be importable from sources other than Luma (e.g., manual CSV upload)?
- [ ] What tags are predefined vs. freeform?
