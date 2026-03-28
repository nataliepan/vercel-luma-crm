/**
 * seed-test-data.ts — Creates known duplicate pairs for dedup eval.
 *
 * Run: npx tsx scripts/seed-test-data.ts
 *
 * Creates 10 known duplicate pairs with realistic variations:
 * - Same email, different name casing
 * - Same person, different email (work vs personal)
 * - Nickname variations ("Jonathan" vs "Jon")
 * - Similar profiles that should NOT be flagged (true negatives)
 *
 * After seeding, run the embedding pipeline to generate vectors,
 * then run dedup evals: npm test
 */

import { Pool } from '@neondatabase/serverless'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load env from project root
config({ path: resolve(__dirname, '..', '.env.local') })

const db = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 2,
})

const TEST_USER_ID = 'test_dedup_eval_user'

// Each pair: [contactA, contactB] — these should be detected as duplicates
const KNOWN_PAIRS = [
  // Pair 1: Same email, different name casing
  [
    { email: 'john.smith@techcorp.com', name: 'John Smith', company: 'TechCorp', role: 'Engineer', notes: 'Full-stack developer' },
    { email: 'john.smith@techcorp.com', name: 'JOHN SMITH', company: 'TechCorp', role: 'Engineer', notes: 'Full-stack developer' },
  ],
  // Pair 2: Same person, work vs personal email
  [
    { email: 'sarah.chen@bigco.com', name: 'Sarah Chen', company: 'BigCo', role: 'Product Manager', notes: 'PM for growth team, interested in AI tools' },
    { email: 'sarahchen92@gmail.com', name: 'Sarah Chen', company: 'BigCo', role: 'Product Manager', notes: 'Product manager at BigCo growth team, loves AI tools' },
  ],
  // Pair 3: Nickname variation
  [
    { email: 'jonathan.r@startup.io', name: 'Jonathan Rodriguez', company: 'Startup Inc', role: 'Founder', notes: 'Founded Startup Inc in 2022' },
    { email: 'jon.rodriguez@gmail.com', name: 'Jon Rodriguez', company: 'Startup Inc', role: 'Founder & CEO', notes: 'Founder of Startup Inc, serial entrepreneur' },
  ],
  // Pair 4: Different email, same person slightly different info
  [
    { email: 'emily.w@venture.vc', name: 'Emily Wang', company: 'Venture Capital Partners', role: 'Partner', notes: 'Investing in early-stage B2B SaaS' },
    { email: 'ewang@vcpartners.com', name: 'Emily Wang', company: 'VC Partners', role: 'General Partner', notes: 'Early-stage B2B SaaS investor, former engineer' },
  ],
  // Pair 5: Same email, minor name typo
  [
    { email: 'alex.kim@design.co', name: 'Alex Kim', company: 'DesignCo', role: 'Head of Design', notes: 'Design leadership' },
    { email: 'alex.kim@design.co', name: 'Alex Km', company: 'DesignCo', role: 'Head of Design', notes: 'Design leadership, UX focus' },
  ],
  // Pair 6: Same person, company name variation
  [
    { email: 'mike.j@amazon.com', name: 'Mike Johnson', company: 'Amazon', role: 'Senior SDE', notes: 'AWS team, distributed systems' },
    { email: 'mikej.personal@outlook.com', name: 'Michael Johnson', company: 'Amazon Web Services', role: 'Senior Software Dev Engineer', notes: 'Distributed systems at AWS' },
  ],
  // Pair 7: Same email, different role (promotion)
  [
    { email: 'priya.p@fintech.io', name: 'Priya Patel', company: 'FinTech Co', role: 'Data Scientist', notes: 'ML for fraud detection' },
    { email: 'priya.p@fintech.io', name: 'Priya Patel', company: 'FinTech Co', role: 'Lead Data Scientist', notes: 'ML for fraud detection, recently promoted' },
  ],
  // Pair 8: Different email domains, same person
  [
    { email: 'tom.lee@acmecorp.com', name: 'Tom Lee', company: 'Acme Corp', role: 'CTO', notes: 'Technical leadership, ex-Google' },
    { email: 'tomlee.dev@proton.me', name: 'Thomas Lee', company: 'Acme Corp', role: 'CTO', notes: 'CTO at Acme Corp, former Google engineer' },
  ],
  // Pair 9: Same email, slightly different formatting
  [
    { email: 'lisa.ng@agency.com', name: 'Lisa Ng', company: 'Creative Agency', role: 'Director', notes: 'Creative director' },
    { email: 'lisa.ng@agency.com', name: 'Lisa Ng', company: 'Creative Agency', role: 'Creative Director', notes: 'Creative director' },
  ],
  // Pair 10: Different emails, very similar profiles
  [
    { email: 'carlos.m@startup.co', name: 'Carlos Martinez', company: 'GreenTech', role: 'Co-founder', notes: 'Climate tech startup, YC W23' },
    { email: 'carlos.martinez@yahoo.com', name: 'Carlos Martinez', company: 'GreenTech', role: 'Co-Founder', notes: 'YC W23 co-founder, climate tech' },
  ],
]

async function seed() {
  console.log('Cleaning up any existing test data...')
  await db.query(`DELETE FROM dedup_candidates WHERE user_id = $1`, [TEST_USER_ID])
  await db.query(`DELETE FROM contact_events WHERE contact_id IN (SELECT id FROM contacts WHERE user_id = $1)`, [TEST_USER_ID])
  await db.query(`DELETE FROM contacts WHERE user_id = $1`, [TEST_USER_ID])
  await db.query(`DELETE FROM dedup_jobs WHERE user_id = $1`, [TEST_USER_ID])

  // Create test_known_pairs table if it doesn't exist
  await db.query(`
    CREATE TABLE IF NOT EXISTS test_known_pairs (
      user_id TEXT NOT NULL,
      contact_a_id UUID NOT NULL,
      contact_b_id UUID NOT NULL,
      PRIMARY KEY (contact_a_id, contact_b_id)
    )
  `)
  await db.query(`DELETE FROM test_known_pairs WHERE user_id = $1`, [TEST_USER_ID])

  console.log(`Seeding ${KNOWN_PAIRS.length} duplicate pairs...`)

  for (let i = 0; i < KNOWN_PAIRS.length; i++) {
    const [a, b] = KNOWN_PAIRS[i]

    // Insert contact A
    const resA = await db.query(
      `INSERT INTO contacts (user_id, email, name, company, role, notes, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [TEST_USER_ID, a.email, a.name, a.company, a.role, a.notes]
    )

    // Insert contact B — use a different email suffix to avoid unique constraint
    // for pairs that share the same email (the dedup should still catch them)
    let emailB = b.email
    if (a.email === b.email) {
      // For same-email pairs, we can't insert a duplicate email for the same user.
      // Add a suffix to make it unique — Pass 1 (exact email) won't catch this,
      // but Pass 2 (vector similarity) should.
      emailB = b.email.replace('@', '+dup@')
    }

    const resB = await db.query(
      `INSERT INTO contacts (user_id, email, name, company, role, notes, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [TEST_USER_ID, emailB, b.name, b.company, b.role, b.notes]
    )

    const idA = resA.rows[0].id
    const idB = resB.rows[0].id

    // Store with consistent ordering (smaller UUID first)
    const [first, second] = idA < idB ? [idA, idB] : [idB, idA]
    await db.query(
      `INSERT INTO test_known_pairs (user_id, contact_a_id, contact_b_id) VALUES ($1, $2, $3)`,
      [TEST_USER_ID, first, second]
    )

    console.log(`  Pair ${i + 1}: ${a.name} / ${b.name} (${first.slice(0, 8)}..${second.slice(0, 8)})`)
  }

  // Also add some non-duplicate contacts (true negatives)
  const NON_DUPES = [
    { email: 'unique1@example.com', name: 'Alice Wonder', company: 'WonderCo', role: 'CEO', notes: 'Biotech startup' },
    { email: 'unique2@example.com', name: 'Bob Builder', company: 'BuildIt', role: 'Architect', notes: 'Construction tech' },
    { email: 'unique3@example.com', name: 'Carol Danvers', company: 'AeroCorp', role: 'Pilot', notes: 'Aerospace engineering' },
    { email: 'unique4@example.com', name: 'Dave Grohl', company: 'MusicTech', role: 'Sound Engineer', notes: 'Audio processing ML' },
    { email: 'unique5@example.com', name: 'Eve Torres', company: 'SecureTech', role: 'CISO', notes: 'Cybersecurity leadership' },
  ]

  for (const c of NON_DUPES) {
    await db.query(
      `INSERT INTO contacts (user_id, email, name, company, role, notes, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [TEST_USER_ID, c.email, c.name, c.company, c.role, c.notes]
    )
  }

  console.log(`  + ${NON_DUPES.length} unique contacts (true negatives)`)

  const total = KNOWN_PAIRS.length * 2 + NON_DUPES.length
  console.log(`\nDone. Seeded ${total} contacts with ${KNOWN_PAIRS.length} known duplicate pairs.`)
  console.log('\nNext steps:')
  console.log('  1. Run embedding pipeline: POST /api/embed (or use the dashboard button)')
  console.log('  2. Run dedup evals: npm test')

  await db.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
