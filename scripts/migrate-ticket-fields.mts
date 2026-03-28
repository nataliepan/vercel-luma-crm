/**
 * Migration: promote ticket/payment fields from contact_events.raw_row to proper columns.
 *
 * Why promote: amount, currency, coupon_code etc. are useful for segmentation
 * ("contacts who used coupon codes", "contacts who paid $649+") and contact
 * detail views. Querying raw_row->>'amount' works but is un-indexed and opaque.
 * Promoted columns get proper indexes, show up in the UI, and are queryable
 * by the segment builder and NL search without JSONB gymnastics.
 *
 * Run once: npx tsx scripts/migrate-ticket-fields.mts
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

const lines = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')
for (const line of lines) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('='); if (eq === -1) continue
  const key = t.slice(0, eq).trim()
  const val = t.slice(eq+1).trim().replace(/^(['"])(.*)\1$/, '$2')
  if (!process.env[key]) process.env[key] = val
}

import { Pool, neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
// @ts-ignore
neonConfig.webSocketConstructor = ws
const db = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL })

console.log('Adding ticket/payment columns to contact_events...')

await db.query(`
  ALTER TABLE contact_events
    ADD COLUMN IF NOT EXISTS amount          TEXT,
    ADD COLUMN IF NOT EXISTS amount_tax      TEXT,
    ADD COLUMN IF NOT EXISTS amount_discount TEXT,
    ADD COLUMN IF NOT EXISTS currency        TEXT,
    ADD COLUMN IF NOT EXISTS coupon_code     TEXT,
    ADD COLUMN IF NOT EXISTS ticket_name     TEXT,
    ADD COLUMN IF NOT EXISTS ticket_type_id  TEXT;
`)
console.log('✓ Columns added')

// Index coupon_code — the most common filter ("contacts who used any coupon")
await db.query(`
  CREATE INDEX IF NOT EXISTS idx_contact_events_coupon
    ON contact_events(coupon_code)
    WHERE coupon_code IS NOT NULL;
`)
console.log('✓ Index on coupon_code created')

// Backfill from raw_row for existing rows
console.log('Backfilling from raw_row...')
const result = await db.query(`
  UPDATE contact_events SET
    amount          = NULLIF(TRIM(raw_row->>'amount'), ''),
    amount_tax      = NULLIF(TRIM(raw_row->>'amount_tax'), ''),
    amount_discount = NULLIF(TRIM(raw_row->>'amount_discount'), ''),
    currency        = NULLIF(TRIM(raw_row->>'currency'), ''),
    coupon_code     = NULLIF(TRIM(raw_row->>'coupon_code'), ''),
    ticket_name     = NULLIF(TRIM(raw_row->>'ticket_name'), ''),
    ticket_type_id  = NULLIF(TRIM(raw_row->>'ticket_type_id'), '')
  WHERE raw_row IS NOT NULL
`)
console.log(`✓ Backfilled ${result.rowCount} rows from raw_row`)

// Verify
const check = await db.query(`
  SELECT
    COUNT(*) FILTER (WHERE amount IS NOT NULL)          AS has_amount,
    COUNT(*) FILTER (WHERE coupon_code IS NOT NULL)     AS has_coupon,
    COUNT(*) FILTER (WHERE ticket_name IS NOT NULL)     AS has_ticket_name,
    COUNT(*) FILTER (WHERE currency IS NOT NULL)        AS has_currency
  FROM contact_events
`)
console.log('\nBackfill results:')
console.log('  Rows with amount:     ', check.rows[0].has_amount)
console.log('  Rows with coupon_code:', check.rows[0].has_coupon)
console.log('  Rows with ticket_name:', check.rows[0].has_ticket_name)
console.log('  Rows with currency:   ', check.rows[0].has_currency)

await db.end()
console.log('\n✓ Migration complete')
