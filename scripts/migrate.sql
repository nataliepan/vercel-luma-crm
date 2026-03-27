-- Run this against your Neon database once to set up the schema.
-- Use the UNPOOLED connection string — PgBouncer can't handle multi-statement transactions.
--
-- From project root:
--   psql $DATABASE_URL_UNPOOLED -f scripts/migrate.sql

-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Core contacts table
CREATE TABLE contacts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT NOT NULL,
  email                 TEXT NOT NULL,
  given_email           TEXT,
  name                  TEXT,
  company               TEXT,
  role                  TEXT,
  linkedin_url          TEXT,
  notes                 TEXT,
  raw_fields            JSONB,
  embedding             vector(1536),
  embedding_status      TEXT DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'done', 'failed')),
  merged_into_id        UUID REFERENCES contacts(id),
  last_dedup_checked_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  -- Why unique constraint not just index: ON CONFLICT (user_id, email) in the
  -- contact upsert requires a unique constraint, not just a unique index.
  CONSTRAINT uq_contacts_user_email UNIQUE (user_id, email)
);

-- Events table
CREATE TABLE events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  series_name       TEXT,
  luma_event_id     TEXT,
  -- Why luma_event_id: Luma encodes a stable evt-XXXX identifier in every row's
  -- qr_code_url. This is the only reliable key for distinguishing two sessions
  -- with the same title (e.g. a recurring weekly event). series_name groups them
  -- for display; luma_event_id decides whether a new import is a re-export or a
  -- separate session. NULL for non-Luma imports or CSVs with stripped URLs.
  event_date        DATE,
  last_exported_at  TIMESTAMPTZ,
  source_filename   TEXT,
  tags              TEXT[],
  count_approved    INTEGER NOT NULL DEFAULT 0,
  count_pending     INTEGER NOT NULL DEFAULT 0,
  count_invited     INTEGER NOT NULL DEFAULT 0,
  count_declined    INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Junction: contacts <-> events
CREATE TABLE contact_events (
  contact_id        UUID REFERENCES contacts(id) ON DELETE CASCADE,
  event_id          UUID REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, event_id),
  registered_at     TIMESTAMPTZ,
  approval_status   TEXT CHECK (approval_status IN ('approved', 'pending', 'declined', 'invited')),
  has_joined_event  BOOLEAN DEFAULT false,
  custom_responses  JSONB DEFAULT '{}',
  raw_row           JSONB
);

-- Segments
CREATE TABLE segments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT,
  filter_sql    TEXT,
  contact_count INTEGER,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Dedup job tracking
CREATE TABLE dedup_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT NOT NULL,
  status             TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  contacts_total     INTEGER,
  contacts_processed INTEGER DEFAULT 0,
  pairs_found        INTEGER DEFAULT 0,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  error_message      TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- Import tracking
CREATE TABLE imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  event_id      UUID REFERENCES events(id),
  filename      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  column_map    JSONB,
  imported_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_import_hash UNIQUE (user_id, content_hash)
);

-- Dedup candidate pairs
CREATE TABLE dedup_candidates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  contact_a_id UUID REFERENCES contacts(id),
  contact_b_id UUID REFERENCES contacts(id),
  similarity   FLOAT,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'rejected')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_dedup_pair UNIQUE (contact_a_id, contact_b_id)
);

-- Indexes
CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_email ON contacts(user_id, email);

-- Why ivfflat not hnsw: better for write-heavy bulk imports.
-- Why lists=200: tuned for 200k rows (pgvector recommends rows/1000).
CREATE INDEX idx_contacts_embedding ON contacts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 200);

CREATE INDEX idx_contacts_trgm_email ON contacts USING gin(email gin_trgm_ops);
CREATE INDEX idx_contacts_trgm_name ON contacts USING gin(name gin_trgm_ops);

-- Partial index: only indexes pending rows — stays small at any table size.
CREATE INDEX idx_contacts_pending_embed ON contacts(user_id, embedding_status)
  WHERE embedding_status = 'pending';

-- Partial index: incremental dedup — O(new) not O(total).
CREATE INDEX idx_contacts_dedup_unchecked ON contacts(user_id, created_at)
  WHERE last_dedup_checked_at IS NULL;

CREATE INDEX idx_dedup_candidates_user ON dedup_candidates(user_id, status);
CREATE INDEX idx_contacts_given_email ON contacts(user_id, given_email);
CREATE INDEX idx_events_series ON events(user_id, series_name);
CREATE UNIQUE INDEX idx_events_luma_id ON events(user_id, luma_event_id) WHERE luma_event_id IS NOT NULL;
-- Why partial unique index: enforces one event row per Luma session per user.
-- Partial (WHERE NOT NULL) allows multiple events without a luma_event_id
-- (non-Luma CSVs) without violating the constraint.
CREATE INDEX idx_imports_hash ON imports(user_id, content_hash);
