import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'

export async function GET(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const cursor = searchParams.get('cursor') // last seen id for keyset pagination
  const query = searchParams.get('q')?.trim() ?? ''

  // Why keyset pagination (cursor) not OFFSET: OFFSET N forces Postgres to scan
  // and discard N rows before returning results — O(n) per page. At 25k contacts
  // OFFSET 24950 scans nearly the whole table. Keyset (id > cursor) is O(1)
  // regardless of depth because it uses the primary key index.
  //
  // Why filter merged_into_id IS NULL: deduped contacts are soft-deleted by
  // pointing to their canonical record. Never expose merged rows in the UI.

  let rows
  if (query) {
    // Trigram search — GIN index makes ILIKE fast at scale.
    // This is the basic search; NL search (step 6) will replace/augment it.
    rows = await db.query(
      `SELECT id, name, email, company, role, embedding_status, created_at
       FROM contacts
       WHERE user_id = $1
         AND merged_into_id IS NULL
         AND (
           name    ILIKE $2 OR
           email   ILIKE $2 OR
           company ILIKE $2 OR
           role    ILIKE $2
         )
       ORDER BY id
       LIMIT 50`,
      [userId, `%${query}%`]
    )
  } else {
    rows = await db.query(
      `SELECT id, name, email, company, role, embedding_status, created_at
       FROM contacts
       WHERE user_id = $1
         AND merged_into_id IS NULL
         AND id > $2
       ORDER BY id
       LIMIT 50`,
      [userId, cursor ?? '00000000-0000-0000-0000-000000000000']
    )
  }

  const contacts = rows.rows
  const nextCursor = contacts.length === 50 ? contacts[contacts.length - 1].id : null

  return NextResponse.json({ contacts, nextCursor })
}
