-- DRAFT MIGRATION: review/authorize before applying. Never run automatically.
-- Separate private schema; no change to User/auth/revocation or legacy ads tables.
CREATE SCHEMA IF NOT EXISTS ads_private;
REVOKE ALL ON SCHEMA ads_private FROM PUBLIC;
CREATE TABLE ads_private.admob_challenge (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL,
  distribution text NOT NULL CHECK (distribution IN ('play', 'direct')),
  purpose text NOT NULL CHECK (purpose = 'optional_pending_policy'),
  target jsonb NOT NULL,
  ad_unit text NOT NULL,
  reward_amount text NOT NULL,
  reward_item text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'cancelled', 'verified')),
  transaction_id text UNIQUE,
  verified_at timestamptz
);
CREATE INDEX admob_active_scope ON ads_private.admob_challenge(account_id, distribution, expires_at) WHERE state = 'pending';
CREATE TABLE ads_private.admob_ssv_inbox (
  transaction_id text PRIMARY KEY,
  nonce text NOT NULL,
  digest text NOT NULL,
  ad_unit text NOT NULL,
  rewarded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('verified', 'rejected'))
);
ALTER TABLE ads_private.admob_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_private.admob_ssv_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA ads_private FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA ads_private FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA ads_private FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA ads_private FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA ads_private FROM authenticated;
  END IF;
END $$;
-- No Data API exposure/policies. Owner or explicitly reviewed server-only role
-- accesses this schema through Prisma; never grant anon/authenticated access.
