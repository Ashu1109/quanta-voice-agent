-- ──────────────────────────────────────────────────────
-- Quanta AI Lab — Leads Table Migration
-- Run this in Supabase SQL Editor (or any PostgreSQL client)
-- ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leads (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name         TEXT,
  email             TEXT,
  company           TEXT,
  use_case          TEXT,
  budget            TEXT,
  timeline          TEXT,
  raw_transcript    TEXT,
  call_duration_sec INTEGER,
  call_status       TEXT DEFAULT 'completed',
  called_at         TIMESTAMPTZ DEFAULT now()
);

-- Index for fast email lookups and deduplication checks
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

-- Index for querying by call status
CREATE INDEX IF NOT EXISTS idx_leads_call_status ON leads(call_status);

-- Index for date-range queries
CREATE INDEX IF NOT EXISTS idx_leads_called_at ON leads(called_at);
