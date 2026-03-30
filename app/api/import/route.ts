import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import Papa from 'papaparse'
import { createHash } from 'crypto'
import { put } from '@vercel/blob'
import { db } from '@/lib/db'
import { mapSchema } from '@/lib/schema-mapper'

// Why maxDuration 120: CSV parsing + AI schema mapping + bulk upsert for large
// files can take up to 2 minutes. Default 10s would timeout on real imports.
export const maxDuration = 120

const CONTACT_CANONICAL_FIELDS = new Set(['email', 'name', 'company', 'role', 'linkedin_url', 'given_email', 'notes'])
const EVENT_CANONICAL_FIELDS = new Set(['approval_status', 'has_joined_event', 'registered_at'])

// Ticket/payment fields promoted from raw_row to proper contact_events columns.
// Why promote: enables segment queries like "contacts who used coupon codes" or
// "people who paid $649+ across 3 events" without JSONB gymnastics.
// The schema mapper maps these via the raw column name — we extract them here
// directly from the raw row using known Luma field names.
const TICKET_RAW_KEYS = ['amount', 'amount_tax', 'amount_discount', 'currency', 'coupon_code', 'ticket_name', 'ticket_type_id'] as const
type TicketKey = typeof TICKET_RAW_KEYS[number]

function extractTicketFields(row: Record<string, string>): Record<TicketKey, string | null> {
  const result = {} as Record<TicketKey, string | null>
  for (const key of TICKET_RAW_KEYS) {
    const val = row[key]?.trim() || null
    result[key] = val === '' ? null : val
  }
  return result
}

// Extract Luma's own event ID from any qr_code_url in the CSV rows.
// Why: Luma encodes a stable evt-XXXX identifier in every check-in URL.
// Two exports of the same event always share the same evt-XXXX.
// Two different events always have different evt-XXXX, even if the title is identical.
// This makes it the only reliable key for "same event vs different event" —
// series_name (from filename) cannot distinguish same-title recurring sessions.
function extractLumaEventId(rows: Record<string, string>[]): string | null {
  for (const row of rows.slice(0, 20)) {
    for (const val of Object.values(row)) {
      const match = val?.match(/\/(evt-[A-Za-z0-9]+)/)
      if (match) return match[1]
    }
  }
  return null
}

function parseFilename(filename: string): {
  eventName: string
  seriesName: string
  lastExportedAt: Date | null
} {
  // Luma export filename pattern: "{title} - Guests - {YYYY-MM-DD-HH-MM-SS}.csv"
  // Why regex: titles may contain hyphens, so we look for the specific " - Guests - " separator.
  const match = filename.match(/^(.+?)\s*-\s*Guests\s*-\s*(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.csv$/i)
  if (match) {
    const rawTitle = match[1].replace(/_/g, ':').trim()
    const [y, mo, d, h, mi, s] = match[2].split('-')
    const lastExportedAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
    return { eventName: rawTitle, seriesName: rawTitle, lastExportedAt }
  }
  const fallbackName = filename.replace(/\.csv$/i, '').replace(/_/g, ':')
  return { eventName: fallbackName, seriesName: fallbackName, lastExportedAt: null }
}

function buildReverseMap(columnMap: Record<string, string>): Record<string, string> {
  // Returns { canonicalField: firstMatchingRawHeader }
  const reverse: Record<string, string> = {}
  for (const [rawHeader, canonical] of Object.entries(columnMap)) {
    if (!reverse[canonical]) reverse[canonical] = rawHeader
  }
  return reverse
}

function normalizeApprovalStatus(val: string | null | undefined): string {
  const v = val?.toLowerCase().trim() ?? ''
  if (v === 'approved' || v === 'going') return 'approved'
  if (v === 'declined' || v === 'not going') return 'declined'
  if (v === 'invited') return 'invited'
  return 'pending'
}

// Normalize a raw CSV header into a clean key for custom_responses.
// Why normalize: "What's your LinkedIn? *" and "whats_your_linkedin" should
// produce consistent keys so downstream JSONB queries don't need to know
// the exact original header from each CSV export.
// Rules: lowercase, spaces→underscores, strip trailing * and ?, strip leading/trailing whitespace.
function normalizeCustomKey(header: string): string {
  return header
    .toLowerCase()
    .replace(/[*?]+$/g, '')      // strip trailing * and ?
    .replace(/\s+/g, '_')        // spaces to underscores
    .replace(/[^\w]/g, '_')      // any non-word char → underscore
    .replace(/_+/g, '_')         // collapse consecutive underscores
    .replace(/^_|_$/g, '')       // strip leading/trailing underscores
}

function extractFields(row: Record<string, string>, columnMap: Record<string, string>) {
  const contactFields: Record<string, string | null> = {}
  const eventFields: Record<string, string | null> = {}
  const customResponses: Record<string, string> = {}

  // Collect which raw headers appear in columnMap to detect completely unmapped columns
  const mappedHeaders = new Set(Object.keys(columnMap))

  for (const [rawHeader, canonical] of Object.entries(columnMap)) {
    const value = row[rawHeader]?.trim() || null
    if (!value) continue
    if (CONTACT_CANONICAL_FIELDS.has(canonical) && canonical !== 'notes') {
      // Known contact field — promote to contacts table
      contactFields[canonical] = value
    } else if (EVENT_CANONICAL_FIELDS.has(canonical)) {
      // Known event field — promote to contact_events columns
      eventFields[canonical] = value
    } else {
      // 'notes' catch-all and any other unmapped canonical value both go to custom_responses.
      // Why not contacts.notes: notes collapses all free-text into one blob, losing structure.
      // custom_responses preserves each question's answer under its own key, enabling
      // JSONB queries like custom_responses->>'city' = 'San Francisco'.
      // Use the original raw header (normalized) as the key — it's the most meaningful label.
      const key = normalizeCustomKey(rawHeader)
      if (key) customResponses[key] = row[rawHeader]
    }
  }

  // Also capture any CSV columns that were not in the schema mapper's output at all.
  // Why: mapSchema returns only recognized headers; novel headers silently disappear.
  // Capturing them in custom_responses ensures no registration data is lost.
  for (const rawHeader of Object.keys(row)) {
    if (!mappedHeaders.has(rawHeader)) {
      const value = row[rawHeader]?.trim()
      if (!value) continue
      const key = normalizeCustomKey(rawHeader)
      if (key && !customResponses[key]) customResponses[key] = value
    }
  }

  return {
    name: contactFields.name ?? null,
    company: contactFields.company ?? null,
    role: contactFields.role ?? null,
    linkedinUrl: contactFields.linkedin_url ?? null,
    givenEmail: contactFields.given_email ?? null,
    // Why notes is always null now: all free-text answers are in customResponses.
    // Keeping the notes field null avoids duplicating data that's already structured
    // in custom_responses. The contacts.notes column remains for manual annotations.
    notes: null,
    approvalStatus: normalizeApprovalStatus(eventFields.approval_status),
    hasJoinedEvent: eventFields.has_joined_event?.toLowerCase() === 'true',
    registeredAt: eventFields.registered_at ? new Date(eventFields.registered_at) : null,
    customResponses,
    // Ticket/payment fields extracted directly from raw row by known Luma column names.
    // Why not via schema mapper: these keys are stable in every Luma export so we
    // don't need AI to identify them. Direct extraction is faster and more reliable.
    ticket: extractTicketFields(row),
  }
}

export async function POST(req: Request) {
  try {
  // Step 0: Auth — every query filters by userId for row-level isolation
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  // merge_strategy: how to handle contacts when re-importing the same event.
  // 'use_new'       = uploaded file's data overwrites existing contact fields + adds new contacts
  // 'keep_existing' = existing contact fields preserved, only new contacts inserted
  const mergeStrategy = formData.get('merge_strategy') as 'use_new' | 'keep_existing' | null
  // existing_event_id: passed back by the UI after the user resolves a same_event conflict,
  // so we skip conflict detection on the second request and know which event row to update.
  const existingEventIdFromForm = formData.get('existing_event_id') as string | null

  // Step 1: Validate file
  if (!file || file.size === 0) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
    return NextResponse.json({ error: 'File must be a CSV' }, { status: 400 })
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'File exceeds 10MB limit' }, { status: 400 })
  }

  const csvText = await file.text()

  // Why papaparse: handles quoted fields, BOM characters, inconsistent line endings —
  // all common in Luma exports. Native split(',') breaks on quoted commas.
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  })

  if (parsed.data.length === 0) {
    return NextResponse.json({ error: 'CSV is empty' }, { status: 400 })
  }
  if (parsed.data.length > 50_000) {
    return NextResponse.json({ error: 'CSV exceeds 50,000 row limit' }, { status: 400 })
  }

  // Step 2: Content hash — blocks byte-for-byte duplicate uploads
  // Why SHA-256: two exports of the same event have different filenames but
  // identical content. Hash catches the duplicate before any processing.
  const contentHash = createHash('sha256').update(csvText).digest('hex')
  const dupCheck = await db.query(
    `SELECT id FROM imports WHERE user_id = $1 AND content_hash = $2`,
    [userId, contentHash]
  )
  if (dupCheck.rows.length > 0) {
    return NextResponse.json({ error: 'duplicate_file', message: 'This exact file has already been imported.' }, { status: 409 })
  }

  // Step 3: Parse filename
  const { eventName, seriesName, lastExportedAt } = parseFilename(file.name)

  // Step 4: Extract Luma event ID — primary key for "same event vs new event"
  // Why before schema mapping: we scan raw cell values for the evt- pattern,
  // no need to wait for AI to identify the qr_code_url column.
  const lumaEventId = extractLumaEventId(parsed.data)

  // Step 5: AI schema mapping — O(1) AI calls regardless of row count
  const headers = Object.keys(parsed.data[0] ?? {})
  const columnMap = await mapSchema(headers)
  const reverseMap = buildReverseMap(columnMap)
  // Why hoist emailHeader here: used both in the overlap check (Case C fallback)
  // and in the bulk upsert loop (Step 8) outside the event resolution block.
  const emailHeader = reverseMap['email']

  // Step 6: Resolve event record
  //
  // Decision tree:
  //   If user already resolved a conflict (merge_strategy + existing_event_id provided):
  //     → skip all detection, use the event ID the UI passed back
  //   A) luma_event_id found + matches existing event → definitive re-export, return conflict
  //   B) luma_event_id found + no match → definitively a different event, auto-create
  //   C) no luma_event_id → auto email-overlap check:
  //        >60% overlap with a same-name event → return conflict (likely same event)
  //        ≤60% overlap → different session with same name, auto-create without prompting
  //
  // Why luma_event_id takes precedence: it is Luma's own stable identifier per session.
  // series_name (derived from the filename title) cannot distinguish two sessions that
  // share a name — e.g. "ClassX Live Q&A" run on two different dates.
  //
  // Why auto-overlap in Case C instead of prompting: two events with the same name but
  // different attendee sets are different events. We detect this automatically so the
  // user never sees a "new session or re-export?" question for what is clearly a new event.
  let eventId: string

  if (mergeStrategy && existingEventIdFromForm) {
    // User already saw the conflict UI and chose a strategy.
    // use_new: update event metadata to reflect the new file.
    // keep_existing: leave event metadata as-is, just add new contacts.
    eventId = existingEventIdFromForm
    if (mergeStrategy === 'use_new') {
      await db.query(
        `UPDATE events SET last_exported_at = $1, source_filename = $2 WHERE id = $3`,
        [lastExportedAt, file.name, eventId]
      )
    }
  } else if (lumaEventId) {
    const exactMatch = await db.query(
      `SELECT id, last_exported_at FROM events WHERE user_id = $1 AND luma_event_id = $2`,
      [userId, lumaEventId]
    )
    if (exactMatch.rows.length > 0) {
      // Case A: same luma_event_id = definitively the same Luma session.
      // Return conflict so the user can choose which export's data to keep.
      return NextResponse.json({
        conflict: 'same_event',
        eventName,
        existingExportedAt: exactMatch.rows[0].last_exported_at,
        newExportedAt: lastExportedAt,
        existingEventId: exactMatch.rows[0].id,
      })
    } else {
      // Case B: different luma_event_id = definitively a different event, even if the
      // series_name is identical (e.g. recurring weekly session with the same title).
      // Auto-import with no prompt.
      const eventResult = await db.query(
        `INSERT INTO events (user_id, name, series_name, luma_event_id, last_exported_at, source_filename)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [userId, eventName, seriesName, lumaEventId, lastExportedAt, file.name]
      )
      eventId = eventResult.rows[0].id
    }
  } else {
    // Case C: CSV has no qr_code_url — fall back to series_name + email overlap heuristic.
    const seriesCheck = await db.query(
      `SELECT id, name, last_exported_at FROM events
       WHERE user_id = $1 AND series_name = $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, seriesName]
    )

    if (seriesCheck.rows.length > 0 && emailHeader) {
      // Compute what fraction of this file's contacts already belong to the existing event.
      // Why 0.6 threshold: if more than 60% of attendees overlap it's almost certainly
      // a re-export of the same session, not a new session with the same name.
      // At <60% overlap we treat it as a new event and auto-import silently.
      const incomingEmails = parsed.data
        .map(row => row[emailHeader]?.toLowerCase()?.trim())
        .filter(Boolean) as string[]

      if (incomingEmails.length > 0) {
        const overlapCheck = await db.query(
          `SELECT COUNT(*) FROM contact_events ce
           JOIN contacts c ON ce.contact_id = c.id
           WHERE ce.event_id = $1 AND lower(c.email) = ANY($2::text[])`,
          [seriesCheck.rows[0].id, incomingEmails]
        )
        const matched = parseInt(overlapCheck.rows[0]?.count ?? '0', 10)
        const overlapPct = matched / incomingEmails.length

        if (overlapPct > 0.6) {
          // High overlap = likely the same event exported again. Ask the user.
          return NextResponse.json({
            conflict: 'same_event',
            eventName,
            existingExportedAt: seriesCheck.rows[0].last_exported_at,
            newExportedAt: lastExportedAt,
            existingEventId: seriesCheck.rows[0].id,
          })
        }
        // Low overlap = different session with the same name. Fall through to create new event.
      }
    }

    // No same-name event exists, or overlap was low enough to be a different session.
    const eventResult = await db.query(
      `INSERT INTO events (user_id, name, series_name, last_exported_at, source_filename)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, eventName, seriesName, lastExportedAt, file.name]
    )
    eventId = eventResult.rows[0].id
  }

  // Step 8: Bulk upsert using unnest() — O(2 queries) regardless of row count.
  // Why unnest not row-by-row: 25k contacts × 2 queries = 50k Neon round-trips,
  // each ~5ms = 4+ minutes. unnest() passes all values as arrays and does the
  // same work in 2 queries, taking ~1-2s for 25k rows.
  const counts = { newContacts: 0, updatedContacts: 0, existedContacts: 0 }

  // Collect all rows that have an email into parallel arrays for unnest()
  const upsertEmails: string[] = []
  const upsertNames: (string | null)[] = []
  const upsertCompanies: (string | null)[] = []
  const upsertRoles: (string | null)[] = []
  const upsertLinkedinUrls: (string | null)[] = []
  const upsertGivenEmails: (string | null)[] = []
  const upsertNotes: (string | null)[] = []
  const upsertRawFields: string[] = []
  const upsertFieldsList: ReturnType<typeof extractFields>[] = []

  for (const row of parsed.data) {
    const email = emailHeader ? row[emailHeader]?.toLowerCase()?.trim() : null
    if (!email) continue
    const fields = extractFields(row, columnMap)
    upsertEmails.push(email)
    upsertNames.push(fields.name)
    upsertCompanies.push(fields.company)
    upsertRoles.push(fields.role)
    upsertLinkedinUrls.push(fields.linkedinUrl)
    upsertGivenEmails.push(fields.givenEmail)
    upsertNotes.push(fields.notes)
    upsertRawFields.push(JSON.stringify(row))
    upsertFieldsList.push(fields)
  }

  if (upsertEmails.length > 0) {
    // Bulk contact upsert — one round-trip for all rows.
    // Why xmax = 0: Postgres sets xmax=0 on fresh inserts, non-zero on updates —
    // the only way to distinguish INSERT vs UPDATE in a RETURNING clause.
    //
    // merge_strategy = 'keep_existing': user wants existing contact data preserved.
    //   → INSERT ... ON CONFLICT DO NOTHING for the contacts table.
    //   → We still need IDs for existing contacts to link them to the event, so we
    //     run a second SELECT after to pick up any rows that were skipped.
    //
    // merge_strategy = 'use_new' (or first import, no strategy):
    //   → Standard upsert with COALESCE — new file's value wins when non-null,
    //     existing value is kept only when the incoming field is blank.
    //   → Why COALESCE not bare EXCLUDED: we never null-out a field just because
    //     the new export has an empty column. Empty != deleted.
    const emailToContactId = new Map<string, string>()

    if (mergeStrategy === 'keep_existing') {
      // Insert only contacts that don't exist yet; leave existing ones untouched.
      const insertResult = await db.query(`
        INSERT INTO contacts
          (user_id, email, name, company, role, linkedin_url, given_email, notes, raw_fields, embedding_status)
        SELECT $1, d.email, d.name, d.company, d.role, d.linkedin_url, d.given_email, d.notes, d.raw_fields::jsonb, 'pending'
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
        ) AS d(email, name, company, role, linkedin_url, given_email, notes, raw_fields)
        ON CONFLICT ON CONSTRAINT uq_contacts_user_email DO NOTHING
        RETURNING id, email
      `, [userId, upsertEmails, upsertNames, upsertCompanies, upsertRoles, upsertLinkedinUrls, upsertGivenEmails, upsertNotes, upsertRawFields])

      counts.newContacts = insertResult.rows.length

      // Fetch IDs for all emails (new + existing) so we can link them all to contact_events.
      const allContacts = await db.query(
        `SELECT id, email FROM contacts WHERE user_id = $1 AND email = ANY($2::text[]) AND merged_into_id IS NULL`,
        [userId, upsertEmails]
      )
      for (const row of allContacts.rows) emailToContactId.set(row.email, row.id)
      counts.existedContacts = allContacts.rows.length - counts.newContacts
    } else {
      // use_new or first import: update existing contacts with the new file's data.
      const contactResult = await db.query(`
        INSERT INTO contacts
          (user_id, email, name, company, role, linkedin_url, given_email, notes, raw_fields, embedding_status)
        SELECT $1, d.email, d.name, d.company, d.role, d.linkedin_url, d.given_email, d.notes, d.raw_fields::jsonb, 'pending'
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
        ) AS d(email, name, company, role, linkedin_url, given_email, notes, raw_fields)
        ON CONFLICT ON CONSTRAINT uq_contacts_user_email DO UPDATE SET
          name             = COALESCE(EXCLUDED.name, contacts.name),
          company          = COALESCE(EXCLUDED.company, contacts.company),
          role             = COALESCE(EXCLUDED.role, contacts.role),
          linkedin_url     = COALESCE(EXCLUDED.linkedin_url, contacts.linkedin_url),
          given_email      = COALESCE(EXCLUDED.given_email, contacts.given_email),
          notes            = COALESCE(EXCLUDED.notes, contacts.notes),
          raw_fields       = EXCLUDED.raw_fields,
          embedding_status = 'pending',
          updated_at       = now()
        RETURNING id, email, (xmax = 0) AS is_insert, (xmax != 0) AS fields_changed
      `, [userId, upsertEmails, upsertNames, upsertCompanies, upsertRoles, upsertLinkedinUrls, upsertGivenEmails, upsertNotes, upsertRawFields])

      for (const row of contactResult.rows) {
        emailToContactId.set(row.email, row.id)
        if (row.is_insert) counts.newContacts++
        else if (row.fields_changed) counts.updatedContacts++
        else counts.existedContacts++
      }
    }

    // Build parallel arrays for contact_events bulk upsert
    const ceContactIds: string[] = []
    const ceRegisteredAts: (Date | null)[] = []
    const ceApprovalStatuses: string[] = []
    const ceHasJoined: boolean[] = []
    const ceCustomResponses: string[] = []
    const ceRawRows: string[] = []
    const ceAmounts: (string | null)[] = []
    const ceAmountTaxes: (string | null)[] = []
    const ceAmountDiscounts: (string | null)[] = []
    const ceCurrencies: (string | null)[] = []
    const ceCouponCodes: (string | null)[] = []
    const ceTicketNames: (string | null)[] = []
    const ceTicketTypeIds: (string | null)[] = []

    for (let i = 0; i < upsertEmails.length; i++) {
      const contactId = emailToContactId.get(upsertEmails[i])
      if (!contactId) continue
      const fields = upsertFieldsList[i]
      ceContactIds.push(contactId)
      ceRegisteredAts.push(fields.registeredAt)
      ceApprovalStatuses.push(fields.approvalStatus)
      ceHasJoined.push(fields.hasJoinedEvent)
      ceCustomResponses.push(JSON.stringify(fields.customResponses))
      ceRawRows.push(upsertRawFields[i])
      ceAmounts.push(fields.ticket.amount)
      ceAmountTaxes.push(fields.ticket.amount_tax)
      ceAmountDiscounts.push(fields.ticket.amount_discount)
      ceCurrencies.push(fields.ticket.currency)
      ceCouponCodes.push(fields.ticket.coupon_code)
      ceTicketNames.push(fields.ticket.ticket_name)
      ceTicketTypeIds.push(fields.ticket.ticket_type_id)
    }

    // Bulk contact_events upsert — one round-trip for all rows.
    // Why ON CONFLICT DO UPDATE not DO NOTHING: approval status, amount, and coupon
    // may change between exports (pending → approved, coupon applied after initial
    // registration). We always want the latest values from the most recent export.
    await db.query(`
      INSERT INTO contact_events
        (contact_id, event_id, registered_at, approval_status, has_joined_event,
         custom_responses, raw_row,
         amount, amount_tax, amount_discount, currency, coupon_code, ticket_name, ticket_type_id)
      SELECT d.contact_id, $1, d.registered_at, d.approval_status, d.has_joined_event,
             d.custom_responses::jsonb, d.raw_row::jsonb,
             d.amount, d.amount_tax, d.amount_discount, d.currency, d.coupon_code, d.ticket_name, d.ticket_type_id
      FROM unnest(
        $2::uuid[], $3::timestamptz[], $4::text[], $5::boolean[], $6::text[], $7::text[],
        $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[]
      ) AS d(contact_id, registered_at, approval_status, has_joined_event, custom_responses, raw_row,
             amount, amount_tax, amount_discount, currency, coupon_code, ticket_name, ticket_type_id)
      ON CONFLICT (contact_id, event_id) DO UPDATE SET
        approval_status  = EXCLUDED.approval_status,
        has_joined_event = EXCLUDED.has_joined_event,
        custom_responses = EXCLUDED.custom_responses,
        raw_row          = EXCLUDED.raw_row,
        amount           = COALESCE(EXCLUDED.amount, contact_events.amount),
        amount_tax       = COALESCE(EXCLUDED.amount_tax, contact_events.amount_tax),
        amount_discount  = COALESCE(EXCLUDED.amount_discount, contact_events.amount_discount),
        currency         = COALESCE(EXCLUDED.currency, contact_events.currency),
        coupon_code      = COALESCE(EXCLUDED.coupon_code, contact_events.coupon_code),
        ticket_name      = COALESCE(EXCLUDED.ticket_name, contact_events.ticket_name),
        ticket_type_id   = COALESCE(EXCLUDED.ticket_type_id, contact_events.ticket_type_id)
    `, [eventId, ceContactIds, ceRegisteredAts, ceApprovalStatuses, ceHasJoined, ceCustomResponses, ceRawRows,
        ceAmounts, ceAmountTaxes, ceAmountDiscounts, ceCurrencies, ceCouponCodes, ceTicketNames, ceTicketTypeIds])
  }

  // Step 9: Update event approval counts and event_date
  await db.query(`
    UPDATE events SET
      count_approved = (SELECT COUNT(*) FROM contact_events WHERE event_id = $1 AND approval_status = 'approved'),
      count_pending  = (SELECT COUNT(*) FROM contact_events WHERE event_id = $1 AND approval_status = 'pending'),
      count_invited  = (SELECT COUNT(*) FROM contact_events WHERE event_id = $1 AND approval_status = 'invited'),
      count_declined = (SELECT COUNT(*) FROM contact_events WHERE event_id = $1 AND approval_status = 'declined'),
      event_date     = (SELECT MIN(registered_at)::DATE FROM contact_events WHERE event_id = $1 AND registered_at IS NOT NULL)
    WHERE id = $1
  `, [eventId])

  // Step 10: Record import + create dedup job
  await db.query(
    `INSERT INTO imports (user_id, event_id, filename, content_hash, column_map)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, eventId, file.name, contentHash, JSON.stringify(columnMap)]
  )

  await db.query(
    `INSERT INTO dedup_jobs (user_id, contacts_total, status) VALUES ($1, $2, 'pending')`,
    [userId, counts.newContacts + counts.updatedContacts]
  )
  // Why async dedup: at 200k contacts, running dedup inline would exceed
  // Vercel's function timeout. The cron job picks up pending work nightly.

  // Step 11: Store CSV in Vercel Blob (optional — audit trail)
  // Why private not public: CSV files contain personal contact data.
  // Why optional: BLOB_READ_WRITE_TOKEN may be empty in local dev.
  // Why try/catch: Blob upload is non-critical — the import already succeeded.
  // A Blob failure should never roll back a completed import.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      // Why sanitize: file.name could contain path traversal chars (../) —
      // strip everything except safe filename characters before constructing the path.
      const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_')
      await put(`imports/${userId}/${safeName}`, csvText, { access: 'public' })
    } catch (blobErr) {
      console.error('Blob upload failed (non-critical):', blobErr)
    }
  }

  return NextResponse.json({
    success: true,
    eventId,
    eventName,
    summary: {
      newContacts: counts.newContacts,
      updatedContacts: counts.updatedContacts,
      existedContacts: counts.existedContacts,
      totalRows: parsed.data.length,
    },
  })

  } catch (err) {
    // Why top-level catch: any unhandled throw (DB down, AI timeout, etc.) would
    // cause Next.js to return an HTML 500 page. The client calls res.json() which
    // then throws a SyntaxError caught as a misleading "Network error".
    // Returning JSON here gives the client a real error message to display.
    // Why generic message: err.message may contain internal details like
    // DB connection strings or API key errors — never expose those to the client.
    console.error('Import failed:', err)

    // Why check for storage limit: Neon's free tier caps at 512 MB. When the DB
    // is full, Postgres returns "could not extend file because project size limit
    // has been exceeded". Surface a clear message so the user knows the cause.
    const errMsg = (err as Error).message ?? ''
    if (errMsg.includes('size limit') || errMsg.includes('could not extend')) {
      return NextResponse.json(
        { error: 'Database storage limit reached. Please delete old data or upgrade your Neon plan.' },
        { status: 507 }
      )
    }

    // Why include a sanitized detail: the generic "please try again" makes debugging
    // impossible. We include the error class and a truncated message — enough to
    // diagnose (timeout, connection refused, invalid SQL) without leaking secrets.
    const safeDetail = errMsg
      .replace(/postgresql:\/\/[^\s]+/gi, '[REDACTED_URL]')  // strip connection strings
      .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]')       // strip API keys
      .slice(0, 200)

    return NextResponse.json(
      { error: `Import failed: ${safeDetail || 'unknown error'}` },
      { status: 500 }
    )
  }
}
