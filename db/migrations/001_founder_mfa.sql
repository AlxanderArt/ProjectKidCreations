BEGIN;

CREATE SCHEMA IF NOT EXISTS pkc_auth;
REVOKE ALL ON SCHEMA pkc_auth FROM PUBLIC;

CREATE TABLE pkc_auth.founder_mfa_factors (
  factor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_subject uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'unenrolled' CHECK (state IN ('unenrolled','pending','active','recovery_required','disabled')),
  enrollment_generation integer NOT NULL DEFAULT 0 CHECK (enrollment_generation >= 0),
  secret_algorithm text CHECK (secret_algorithm IS NULL OR secret_algorithm = 'aes-256-gcm'),
  secret_key_version integer CHECK (secret_key_version IS NULL OR secret_key_version > 0),
  secret_ciphertext bytea,
  secret_nonce bytea CHECK (secret_nonce IS NULL OR octet_length(secret_nonce) = 12),
  secret_tag bytea CHECK (secret_tag IS NULL OR octet_length(secret_tag) = 16),
  totp_algorithm text NOT NULL DEFAULT 'SHA1' CHECK (totp_algorithm = 'SHA1'),
  totp_digits smallint NOT NULL DEFAULT 6 CHECK (totp_digits = 6),
  totp_period_seconds smallint NOT NULL DEFAULT 30 CHECK (totp_period_seconds = 30),
  last_accepted_counter bigint CHECK (last_accepted_counter IS NULL OR last_accepted_counter >= 0),
  auth_epoch bigint NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0),
  revoked_before timestamptz,
  enrolled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  CHECK (
    (state IN ('pending','active')
      AND secret_algorithm = 'aes-256-gcm'
      AND secret_key_version IS NOT NULL
      AND secret_ciphertext IS NOT NULL
      AND secret_nonce IS NOT NULL
      AND secret_tag IS NOT NULL)
    OR
    (state IN ('unenrolled','recovery_required','disabled')
      AND secret_algorithm IS NULL
      AND secret_key_version IS NULL
      AND secret_ciphertext IS NULL
      AND secret_nonce IS NULL
      AND secret_tag IS NULL)
  ),
  CHECK (state <> 'active' OR (last_accepted_counter IS NOT NULL AND enrolled_at IS NOT NULL))
);

CREATE TABLE pkc_auth.founder_mfa_challenges (
  challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  anti_csrf_hash bytea NOT NULL CHECK (octet_length(anti_csrf_hash) = 32),
  handoff_jti uuid NOT NULL UNIQUE,
  login_attempt_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('enroll','verify','recover')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','consumed','superseded','exhausted','expired')),
  password_authenticated_at timestamptz NOT NULL,
  attempts_used smallint NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  secret_disclosed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  superseded_at timestamptz,
  CHECK (attempts_used <= max_attempts),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX founder_mfa_challenges_one_pending_per_factor
  ON pkc_auth.founder_mfa_challenges (factor_id)
  WHERE state = 'pending';
CREATE INDEX founder_mfa_challenges_login_attempt
  ON pkc_auth.founder_mfa_challenges (login_attempt_id);

CREATE TABLE pkc_auth.founder_mfa_recovery_codes (
  recovery_code_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  pepper_version integer NOT NULL CHECK (pepper_version > 0),
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  used_by_challenge_id uuid REFERENCES pkc_auth.founder_mfa_challenges(challenge_id) ON DELETE RESTRICT,
  UNIQUE (factor_id, code_hash),
  CHECK ((used_at IS NULL) = (used_by_challenge_id IS NULL))
);

CREATE TABLE pkc_auth.founder_mfa_finalizations (
  finalize_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  challenge_id uuid NOT NULL UNIQUE REFERENCES pkc_auth.founder_mfa_challenges(challenge_id) ON DELETE RESTRICT,
  grant_hash bytea NOT NULL UNIQUE CHECK (octet_length(grant_hash) = 32),
  grant_jti uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL UNIQUE,
  session_issued_at timestamptz NOT NULL,
  session_expires_at timestamptz NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  auth_epoch bigint NOT NULL CHECK (auth_epoch >= 0),
  claims jsonb NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  state text NOT NULL CHECK (state IN ('pending','dispatching','unknown','succeeded','terminal_rejected')),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  receipt_digest bytea CHECK (receipt_digest IS NULL OR octet_length(receipt_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  CHECK (session_expires_at > session_issued_at),
  CHECK ((state = 'dispatching') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'succeeded') = (receipt_digest IS NOT NULL AND finalized_at IS NOT NULL))
);

CREATE TABLE pkc_auth.founder_mfa_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  operation_type text NOT NULL CHECK (operation_type IN ('revoke_founder_sessions','project_session','project_audit')),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  finalize_id uuid REFERENCES pkc_auth.founder_mfa_finalizations(finalize_id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','unknown','succeeded','terminal_rejected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  last_error_class text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((state = 'dispatching') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'succeeded') = (completed_at IS NOT NULL))
);

CREATE INDEX founder_mfa_outbox_dispatch
  ON pkc_auth.founder_mfa_outbox (state, created_at)
  WHERE state IN ('pending','unknown');

CREATE TABLE pkc_auth.founder_mfa_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id uuid REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  challenge_id uuid REFERENCES pkc_auth.founder_mfa_challenges(challenge_id) ON DELETE RESTRICT,
  finalize_id uuid REFERENCES pkc_auth.founder_mfa_finalizations(finalize_id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  event_type text NOT NULL,
  outcome_class text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX founder_mfa_audit_events_created
  ON pkc_auth.founder_mfa_audit_events (created_at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA pkc_auth FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pkc_auth FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pkc_auth REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pkc_auth REVOKE ALL ON SEQUENCES FROM PUBLIC;

COMMIT;
