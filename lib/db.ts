import { Pool } from '@neondatabase/serverless'

// Why two pools: API routes use the pooled URL (PgBouncer) — connections are
// shared across serverless function instances. Migrations and long-running jobs
// (dedup, embed) use the unpooled direct URL because PgBouncer can't handle
// multi-statement transactions or COPY commands correctly.
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  // Why max=5: Vercel can spin up many concurrent function instances simultaneously.
  // Each holds up to 5 connections. At Neon Pro's 100-connection limit, this allows
  // 20 concurrent function instances with headroom. Without this, a traffic spike
  // exhausts the pool and all queries start timing out.
})

export const dbDirect = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 2,
  // Why max=2: direct connections are only used by background jobs (dedup, embed, cron).
  // These run sequentially, never concurrently. Low ceiling prevents accidents.
})
