import { dbDirect } from './db'

// Why two-pass: Pass 1 (email match) is fast and catches ~80% of duplicates.
// Pass 2 (vector similarity) catches the rest — name variations, multiple emails
// for the same person. Both passes are needed for high recall.
//
// Why incremental (last_dedup_checked_at): at 200k contacts a full cross-join
// is O(n) × O(ANN) per run. With probes=10 and lists=200, each ANN query ~5ms.
// 200k × 5ms = 1000s — exceeds Vercel's 300s max. Incremental mode only checks
// contacts where last_dedup_checked_at IS NULL — at steady state that's a few
// hundred rows instead of 200k. O(new) not O(total).
//
// Why chunked: even the incremental set may be large after a bulk import.
// The job processes BATCH_SIZE contacts per invocation, checkpoints progress
// in dedup_jobs.contacts_processed, and the cron retriggers nightly to continue.

const BATCH_SIZE = 2000
const SIMILARITY_THRESHOLD = 0.92

export async function runDedupJob(jobId: string, userId: string) {
  const job = await dbDirect.query(
    `SELECT contacts_processed FROM dedup_jobs WHERE id = $1`,
    [jobId]
  )
  const alreadyProcessed = job.rows[0]?.contacts_processed ?? 0

  await dbDirect.query(
    `UPDATE dedup_jobs SET status='running', started_at=COALESCE(started_at, now()) WHERE id=$1`,
    [jobId]
    // Why COALESCE: job may have been interrupted and resumed. Preserve original start time.
  )

  try {
    // Pass 1: exact email duplicates (always run in full — fast and cheap)
    // Why lower(): email comparison should be case-insensitive.
    // Why a.id < b.id: ensures each pair is only considered once, not twice.
    const emailDupes = await dbDirect.query(`
      SELECT a.id AS a_id, b.id AS b_id, 1.0 AS similarity
      FROM contacts a
      JOIN contacts b
        ON lower(a.email) = lower(b.email)
        AND a.id < b.id
        AND a.user_id = $1
        AND b.user_id = $1
        AND a.merged_into_id IS NULL
        AND b.merged_into_id IS NULL
    `, [userId])

    // Pass 2: vector similarity — incremental, only unchecked contacts
    // Why OFFSET alreadyProcessed: safe resume point after timeout.
    // The ORDER BY created_at is stable — same rows in same order each run.
    const unchecked = await dbDirect.query(`
      SELECT id, embedding
      FROM contacts
      WHERE user_id = $1
        AND merged_into_id IS NULL
        AND embedding IS NOT NULL
        AND last_dedup_checked_at IS NULL
      ORDER BY created_at
      LIMIT $2 OFFSET $3
    `, [userId, BATCH_SIZE, alreadyProcessed])

    const vectorDupes: Array<{ a_id: string; b_id: string; similarity: number }> = []

    for (const contact of unchecked.rows) {
      // Why SET LOCAL probes=10: dedup accuracy matters more than speed.
      // Default probes=1 scans 1/200 partitions = 0.5% of vectors, misses edge cases.
      // probes=10 scans 5% — meaningfully higher recall for the dedup use case.
      await dbDirect.query(`SET LOCAL ivfflat.probes = 10`)

      const neighbors = await dbDirect.query(`
        SELECT id,
               1 - (embedding <=> $1::vector) AS similarity
        FROM contacts
        WHERE user_id = $2
          AND id != $3
          AND merged_into_id IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [contact.embedding, userId, contact.id])
      // Why LIMIT 5: only the top-5 nearest neighbors matter for dedup.
      // Checking more would add query time without finding real duplicates.

      for (const neighbor of neighbors.rows) {
        if (neighbor.similarity > SIMILARITY_THRESHOLD) {
          // Enforce consistent pair ordering (smaller id first) for the unique constraint
          const [idA, idB] = contact.id < neighbor.id
            ? [contact.id, neighbor.id]
            : [neighbor.id, contact.id]
          vectorDupes.push({
            a_id: idA,
            b_id: idB,
            similarity: neighbor.similarity,
          })
        }
      }

      // Mark this contact as checked regardless of whether duplicates were found
      await dbDirect.query(
        `UPDATE contacts SET last_dedup_checked_at = now() WHERE id = $1`,
        [contact.id]
      )
    }

    // Bulk insert candidates — unique constraint handles re-runs safely
    // Why ON CONFLICT DO NOTHING: the dedup job runs nightly and may encounter
    // the same pair across runs. Without this, it would error on duplicates.
    const allCandidates = [...emailDupes.rows, ...vectorDupes]
    for (const pair of allCandidates) {
      await dbDirect.query(`
        INSERT INTO dedup_candidates (user_id, contact_a_id, contact_b_id, similarity)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT ON CONSTRAINT uq_dedup_pair DO NOTHING
      `, [userId, pair.a_id, pair.b_id, pair.similarity])
    }

    const newProcessed = alreadyProcessed + unchecked.rows.length

    // Check if there's more work remaining
    const remaining = await dbDirect.query(`
      SELECT COUNT(*) FROM contacts
      WHERE user_id = $1
        AND merged_into_id IS NULL
        AND embedding IS NOT NULL
        AND last_dedup_checked_at IS NULL
    `, [userId])

    const isDone = parseInt(remaining.rows[0].count) === 0

    await dbDirect.query(`
      UPDATE dedup_jobs
      SET contacts_processed = $1,
          pairs_found = pairs_found + $2,
          status = $3,
          completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END
      WHERE id = $4
    `, [newProcessed, allCandidates.length, isDone ? 'done' : 'running', jobId])
    // Why status='running' not 'pending' when incomplete: cron checks for
    // running jobs and retriggers them. Pending means not yet started.

    return { processed: newProcessed, pairsFound: allCandidates.length, done: isDone }
  } catch (err) {
    await dbDirect.query(`
      UPDATE dedup_jobs SET status='failed', error_message=$1 WHERE id=$2
    `, [(err as Error).message, jobId])
    throw err
  }
}

/**
 * Find or create a dedup job for the user and run it.
 * Resumes an existing 'pending' or 'running' job if one exists.
 */
export async function dedupForUser(userId: string) {
  // Look for an existing incomplete job
  const existing = await dbDirect.query(
    `SELECT id FROM dedup_jobs
     WHERE user_id = $1 AND status IN ('pending', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  )

  let jobId: string
  if (existing.rows.length > 0) {
    jobId = existing.rows[0].id
  } else {
    // Count contacts that need checking
    const countResult = await dbDirect.query(
      `SELECT COUNT(*) FROM contacts
       WHERE user_id = $1 AND merged_into_id IS NULL
         AND embedding IS NOT NULL AND last_dedup_checked_at IS NULL`,
      [userId]
    )
    const total = parseInt(countResult.rows[0].count)
    if (total === 0) return { processed: 0, pairsFound: 0, done: true, jobId: null }

    const newJob = await dbDirect.query(
      `INSERT INTO dedup_jobs (user_id, contacts_total, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [userId, total]
    )
    jobId = newJob.rows[0].id
  }

  const result = await runDedupJob(jobId, userId)
  return { ...result, jobId }
}
