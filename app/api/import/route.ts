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

function extractFields(row: Record<string, string>, columnMap: Record<string, string>) {
  const contactFields: Record<string, string | null> = {}
  const eventFields: Record<string, string | null> = {}
  const customResponses: Record<string, string> = {}

  for (const [rawHeader, canonical] of Object.entries(columnMap)) {
    const value = row[rawHeader]?.trim() || null
    if (!value) continue
    if (CONTACT_CANONICAL_FIELDS.has(canonical)) {
      contactFields[canonical] = value
    } else if (EVENT_CANONICAL_FIELDS.has(canonical)) {
      eventFields[canonical] = value
    } else {
      // 'notes' and unmapped fields go into custom_responses
      customResponses[rawHeader] = row[rawHeader]
    }
  }

  return {
    name: contactFields.name ?? null,
    company: contactFields.company ?? null,
    role: contactFields.role ?? null,
    linkedinUrl: contactFields.linkedin_url ?? null,
    givenEmail: contactFields.given_email ?? null,
    notes: contactFields.notes ?? null,
    approvalStatus: normalizeApprovalStatus(eventFields.approval_status),
    hasJoinedEvent: eventFields.has_joined_event?.toLowerCase() === 'true',
    registeredAt: eventFields.registered_at ? new Date(eventFields.registered_at) : null,
    customResponses,
  }
}

export async function POST(req: Request) {
  try {
  // Step 0: Auth — every query filters by userId for row-level isolation
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const intent = formData.get('intent') as 'new_session' | 'reexport' | null
  const forceOverlap = formData.get('force_overlap') === 'true'

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

  // Step 4: Gate 1 — series conflict check
  const seriesCheck = await db.query(
    `SELECT id, name, last_exported_at FROM events
     WHERE user_id = $1 AND series_name = $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, seriesName]
  )
  if (seriesCheck.rows.length > 0 && !intent) {
    return NextResponse.json({
      conflict: 'series_exists',
      seriesName,
      lastImportedAt: seriesCheck.rows[0].last_exported_at,
      existingEventId: seriesCheck.rows[0].id,
    })
  }

  // Step 5: AI schema mapping — O(1) AI calls regardless of row count
  const headers = Object.keys(parsed.data[0] ?? {})
  const columnMap = await mapSchema(headers)
  const reverseMap = buildReverseMap(columnMap)

  // Step 6: Gate 2 — high overlap check (only on reexport)
  const emailHeader = reverseMap['email']
  const incomingEmails = emailHeader
    ? parsed.data.map(row => row[emailHeader]?.toLowerCase()?.trim()).filter(Boolean) as string[]
    : []

  if (intent === 'reexport' && incomingEmails.length > 0 && !forceOverlap) {
    const existingEventId = seriesCheck.rows[0]?.id
    if (existingEventId) {
      const overlapCheck = await db.query(
        `SELECT COUNT(*) FROM contact_events ce
         JOIN contacts c ON ce.contact_id = c.id
         WHERE ce.event_id = $1 AND lower(c.email) = ANY($2::text[])`,
        [existingEventId, incomingEmails]
      )
      const matched = parseInt(overlapCheck.rows[0].count)
      const overlapPct = matched / incomingEmails.length
      const newRows = incomingEmails.length - matched
      if (overlapPct > 0.7 && newRows < incomingEmails.length * 0.05) {
        return NextResponse.json({
          conflict: 'high_overlap',
          overlapPct: Math.round(overlapPct * 100),
          newRows,
        })
      }
    }
  }

  // Step 7: Upsert event record
  let eventId: string
  if (intent === 'reexport' && seriesCheck.rows.length > 0) {
    eventId = seriesCheck.rows[0].id
    await db.query(
      `UPDATE events SET last_exported_at = $1, source_filename = $2 WHERE id = $3`,
      [lastExportedAt, file.name, eventId]
    )
  } else {
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
    // Why COALESCE: never overwrite an existing value with null — only update when
    // the incoming row has a value.
    // Why xmax = 0: Postgres sets xmax=0 on fresh inserts, non-zero on updates —
    // the only way to distinguish INSERT vs UPDATE in a RETURNING clause.
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

    // Build email → contactId lookup and tally counts
    const emailToContactId = new Map<string, string>()
    for (const row of contactResult.rows) {
      emailToContactId.set(row.email, row.id)
      if (row.is_insert) counts.newContacts++
      else if (row.fields_changed) counts.updatedContacts++
      else counts.existedContacts++
    }

    // Build parallel arrays for contact_events bulk upsert
    const ceContactIds: string[] = []
    const ceRegisteredAts: (Date | null)[] = []
    const ceApprovalStatuses: string[] = []
    const ceHasJoined: boolean[] = []
    const ceCustomResponses: string[] = []
    const ceRawRows: string[] = []

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
    }

    // Bulk contact_events upsert — one round-trip for all rows.
    // Why ON CONFLICT DO UPDATE not DO NOTHING: approval status may change
    // between exports (pending → approved). We always want the latest state.
    await db.query(`
      INSERT INTO contact_events
        (contact_id, event_id, registered_at, approval_status, has_joined_event, custom_responses, raw_row)
      SELECT d.contact_id, $1, d.registered_at, d.approval_status, d.has_joined_event, d.custom_responses::jsonb, d.raw_row::jsonb
      FROM unnest(
        $2::uuid[], $3::timestamptz[], $4::text[], $5::boolean[], $6::text[], $7::text[]
      ) AS d(contact_id, registered_at, approval_status, has_joined_event, custom_responses, raw_row)
      ON CONFLICT (contact_id, event_id) DO UPDATE SET
        approval_status  = EXCLUDED.approval_status,
        has_joined_event = EXCLUDED.has_joined_event,
        custom_responses = EXCLUDED.custom_responses,
        raw_row          = EXCLUDED.raw_row
    `, [eventId, ceContactIds, ceRegisteredAts, ceApprovalStatuses, ceHasJoined, ceCustomResponses, ceRawRows])
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
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await put(`imports/${userId}/${file.name}`, csvText, { access: 'public' })
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
    console.error('Import failed:', err)
    return NextResponse.json(
      { error: (err as Error).message ?? 'Import failed' },
      { status: 500 }
    )
  }
}
