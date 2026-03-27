# AI Spec

Defines all AI-powered features, prompting approach, and evaluation strategy.

---

## Features

### 1. Header Normalization

Maps raw, inconsistent CSV column headers from different Luma events to the canonical contact schema.

**Input**: Array of raw headers from the uploaded CSV + target canonical schema
**Output**: JSON mapping of `{ "raw header": "canonical_field" | "custom_fields.key" }`

**Examples**:
- `"What's your LinkedIn?"` → `linkedin_url`
- `"LinkedIn"` → `linkedin_url`
- `"Are you hiring?"` → `custom_fields.is_hiring`
- `"Current Company"` → `company`

**Fallback**: If a header can't be mapped with confidence, it is stored under `custom_fields` using a slugified version of the raw header. Nothing is dropped.

---

### 2. Tag Inference

After a contact is imported and merged, AI reads `job_title` + `company` (and any relevant `custom_fields`) to infer contact tags.

**Predefined tags**: `investor`, `founder`, `speaker candidate`, `community member`, `operator`, `press`
**Output**: Array of 1–3 inferred tags with a confidence note

**Example**:
- Input: `{ job_title: "General Partner", company: "Sequoia Capital" }`
- Output: `["investor"]`

---

### 3. Merge Conflict Explainer

When two records conflict on a scalar field (e.g., different companies across two events), AI generates a one-line human-readable explanation of which value was chosen and why.

**Example output**:
> "Company updated from 'Acme Corp' to 'Vercel' — newer event (Mar 2025) used as source of truth."

Surfaced in the contact profile UI as an audit note.

---

### 4. Import Summary

After a CSV is fully processed, AI generates a plain-English summary of the import results.

**Example output**:
> "Imported 142 contacts from 'AI Summit March 2025'. Found 23 duplicates — merged with existing records. 4 contacts flagged for manual review. Top inferred tags: founder (41), investor (18), community member (67)."

Shown immediately after upload completes.

---

## Evaluation Approach

Required for Track B. All three components below are in scope.

### Test Set
A curated set of 3 CSV files with known structure:
- **CSV A**: Clean, standard headers, no duplicates
- **CSV B**: Fuzzy headers, partial overlaps with CSV A contacts
- **CSV C**: Heavy duplicates, conflicting field values, missing emails

Expected outputs are defined for each (correct header mappings, correct tags, correct merge decisions).

### Rubric
Each AI output is scored across three dimensions:

| Dimension | Score | Criteria |
|-----------|-------|----------|
| Accuracy | 1–3 | Did the output match the expected result? |
| Relevance | 1–3 | Was the output useful / not noisy? |
| Tone | 1–3 | Was human-facing text (summaries, explainers) clear and neutral? |

### Hallucination Check
- **Header normalization**: Flag if the AI maps a header to a canonical field that doesn't exist in the schema
- **Tag inference**: Flag if the AI returns a tag not in the predefined tag list
- **Import summary**: Flag if counts in the summary don't match actual database counts post-import

All AI inputs and outputs are logged for regression tracking as prompts evolve.

---

## Open Questions

- [ ] Which model? GPT-4o for accuracy vs. a smaller/faster model for cost on bulk imports.
- [ ] Should header normalization run once per import (on the column map) or per row?
- [ ] Should tag inference be re-run on existing contacts when new data is imported?
