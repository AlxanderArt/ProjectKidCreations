SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  binding_count integer;
  bound_environment text;
BEGIN
  IF current_database() IS DISTINCT FROM current_setting('pkc.expected_database', true) THEN
    RAISE EXCEPTION 'database_target_mismatch';
  END IF;
  SELECT pg_catalog.count(*),pg_catalog.min(pg_catalog.substr(setting,17))
    INTO binding_count,bound_environment
  FROM pg_catalog.pg_db_role_setting s
  CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
  WHERE s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
    AND s.setrole=0 AND pg_catalog.left(setting,16)='pkc.environment=';
  IF binding_count<>1 OR bound_environment NOT IN ('development','test','preview','production')
      OR bound_environment IS DISTINCT FROM current_setting('pkc.expected_environment', true) THEN
    RAISE EXCEPTION 'database_environment_binding_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='pkc_auth' AND nspowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_owner')) THEN
    RAISE EXCEPTION 'unexpected_pkc_auth_owner';
  END IF;
END
$guard$;

CREATE SCHEMA IF NOT EXISTS pkc_auth AUTHORIZATION pkc_mfa_owner;
ALTER SCHEMA pkc_auth OWNER TO pkc_mfa_owner;
REVOKE ALL ON SCHEMA pkc_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA pkc_auth TO pkc_mfa_runtime, pkc_mfa_verifier, pkc_mfa_outbox_worker;
SET LOCAL ROLE pkc_mfa_owner;

CREATE TABLE pkc_auth.migration_ledger (
  version integer PRIMARY KEY CHECK (version > 0),
  filename text NOT NULL UNIQUE CHECK (filename ~ '^[0-9]{3}_[a-z0-9_]+[.]sql$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL CHECK (environment IN ('development','test','preview','production')),
  applied_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  applied_by name NOT NULL DEFAULT SESSION_USER
);

CREATE TABLE pkc_auth.founder_mfa_factors (
  factor_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  founder_subject uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'unenrolled' CHECK (state IN ('unenrolled','pending','active','recovery_required','disabled')),
  enrollment_generation integer NOT NULL DEFAULT 0 CHECK (enrollment_generation >= 0),
  secret_algorithm text CHECK (secret_algorithm IS NULL OR secret_algorithm = 'aes-256-gcm'),
  secret_key_version integer CHECK (secret_key_version IS NULL OR secret_key_version > 0),
  secret_ciphertext bytea,
  secret_nonce bytea CHECK (secret_nonce IS NULL OR pg_catalog.octet_length(secret_nonce)=12),
  secret_tag bytea CHECK (secret_tag IS NULL OR pg_catalog.octet_length(secret_tag)=16),
  totp_algorithm text NOT NULL DEFAULT 'SHA1' CHECK (totp_algorithm='SHA1'),
  totp_digits smallint NOT NULL DEFAULT 6 CHECK (totp_digits=6),
  totp_period_seconds smallint NOT NULL DEFAULT 30 CHECK (totp_period_seconds=30),
  last_accepted_counter bigint CHECK (last_accepted_counter IS NULL OR last_accepted_counter>=0),
  auth_epoch bigint NOT NULL DEFAULT 0 CHECK (auth_epoch>=0),
  revoked_before timestamptz,
  enrolled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version>=0),
  CHECK (((state IN ('pending','active')) AND secret_algorithm='aes-256-gcm' AND secret_key_version IS NOT NULL AND secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND secret_tag IS NOT NULL)
      OR ((state IN ('unenrolled','recovery_required','disabled')) AND secret_algorithm IS NULL AND secret_key_version IS NULL AND secret_ciphertext IS NULL AND secret_nonce IS NULL AND secret_tag IS NULL)),
  CHECK (state<>'active' OR (last_accepted_counter IS NOT NULL AND enrolled_at IS NOT NULL))
);

CREATE TABLE pkc_auth.founder_mfa_challenges (
  challenge_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (pg_catalog.octet_length(token_hash)=32),
  anti_csrf_hash bytea NOT NULL CHECK (pg_catalog.octet_length(anti_csrf_hash)=32),
  handoff_jti uuid NOT NULL UNIQUE,
  login_attempt_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('enroll','verify','recover')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','consumed','superseded','exhausted','expired')),
  password_authenticated_at timestamptz NOT NULL,
  attempts_used smallint NOT NULL DEFAULT 0 CHECK (attempts_used>=0),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  secret_disclosed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (factor_id, challenge_id),
  CHECK (attempts_used<=max_attempts),
  CHECK (expires_at>created_at)
);
CREATE UNIQUE INDEX founder_mfa_challenges_one_pending_per_factor ON pkc_auth.founder_mfa_challenges(factor_id) WHERE state='pending';
CREATE INDEX founder_mfa_challenges_login_attempt ON pkc_auth.founder_mfa_challenges(login_attempt_id);

CREATE TABLE pkc_auth.founder_mfa_recovery_codes (
  recovery_code_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  pepper_version integer NOT NULL CHECK (pepper_version>0),
  code_hash bytea NOT NULL CHECK (pg_catalog.octet_length(code_hash)=32),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  used_at timestamptz,
  used_by_challenge_id uuid,
  UNIQUE (factor_id, code_hash),
  FOREIGN KEY (factor_id, used_by_challenge_id) REFERENCES pkc_auth.founder_mfa_challenges(factor_id, challenge_id) ON DELETE RESTRICT,
  CHECK ((used_at IS NULL)=(used_by_challenge_id IS NULL))
);

CREATE TABLE pkc_auth.founder_mfa_finalizations (
  finalize_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  challenge_id uuid NOT NULL UNIQUE,
  grant_hash bytea NOT NULL UNIQUE CHECK (pg_catalog.octet_length(grant_hash)=32),
  grant_jti uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL UNIQUE,
  session_issued_at timestamptz NOT NULL,
  session_expires_at timestamptz NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  auth_epoch bigint NOT NULL CHECK (auth_epoch>=0),
  claims jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(claims)='object') CHECK (octet_length(claims::text) <= 4096),
  request_digest bytea NOT NULL CHECK (pg_catalog.octet_length(request_digest)=32),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','unknown','succeeded','terminal_rejected')),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence>=0),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts BETWEEN 0 AND 5),
  receipt_digest bytea CHECK (receipt_digest IS NULL OR pg_catalog.octet_length(receipt_digest)=32),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  finalized_at timestamptz,
  UNIQUE (factor_id, finalize_id),
  FOREIGN KEY (factor_id, challenge_id) REFERENCES pkc_auth.founder_mfa_challenges(factor_id, challenge_id) ON DELETE RESTRICT,
  CHECK (session_expires_at>session_issued_at),
  CHECK ((state='dispatching')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state='succeeded')=(receipt_digest IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (state<>'succeeded' OR lease_owner IS NULL)
);

CREATE TABLE pkc_auth.founder_mfa_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operation_key text NOT NULL UNIQUE CHECK (pg_catalog.octet_length(operation_key) BETWEEN 8 AND 200),
  operation_type text NOT NULL CHECK (operation_type='revoke_founder_sessions'),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  finalize_id uuid,
  payload jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(payload)='object') CHECK (octet_length(payload::text) <= 2048),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','unknown','succeeded','terminal_rejected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts BETWEEN 0 AND 8),
  next_reconcile_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence>=0),
  reconciliation_lease_owner uuid,
  reconciliation_lease_expires_at timestamptz,
  reconciliation_lease_fence bigint NOT NULL DEFAULT 0 CHECK (reconciliation_lease_fence>=0),
  last_error_class text CHECK (last_error_class IS NULL OR last_error_class IN ('delivery_outcome_unknown','transport_unavailable','receipt_mismatch','delivery_exhausted','reconciliation_exhausted')),
  receipt_digest bytea CHECK (receipt_digest IS NULL OR pg_catalog.octet_length(receipt_digest)=32),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (factor_id, finalize_id) REFERENCES pkc_auth.founder_mfa_finalizations(factor_id, finalize_id) ON DELETE RESTRICT,
  CHECK ((state='dispatching')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((reconciliation_lease_owner IS NULL)=(reconciliation_lease_expires_at IS NULL)),
  CHECK (reconciliation_lease_owner IS NULL OR state='unknown'),
  CHECK ((state='succeeded')=(completed_at IS NOT NULL AND receipt_digest IS NOT NULL)),
  CHECK (attempts<=max_attempts)
);
CREATE INDEX founder_mfa_outbox_dispatch ON pkc_auth.founder_mfa_outbox(state,next_attempt_at,created_at) WHERE state IN ('pending','unknown','dispatching');

CREATE TABLE pkc_auth.founder_mfa_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  factor_id uuid REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  challenge_id uuid,
  finalize_id uuid,
  correlation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (pg_catalog.octet_length(event_type) BETWEEN 1 AND 80),
  outcome_class text NOT NULL CHECK (outcome_class IN ('accepted','rejected','unknown','terminal')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(metadata)='object') CHECK (pg_catalog.octet_length(metadata::text)<=2048),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (factor_id, challenge_id) REFERENCES pkc_auth.founder_mfa_challenges(factor_id,challenge_id) ON DELETE RESTRICT,
  FOREIGN KEY (factor_id, finalize_id) REFERENCES pkc_auth.founder_mfa_finalizations(factor_id,finalize_id) ON DELETE RESTRICT
);
CREATE INDEX founder_mfa_audit_events_created ON pkc_auth.founder_mfa_audit_events(created_at DESC);

CREATE FUNCTION pkc_auth.prevent_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN RAISE EXCEPTION 'audit_append_only'; END $$;
CREATE TRIGGER founder_mfa_audit_append_only BEFORE UPDATE OR DELETE ON pkc_auth.founder_mfa_audit_events FOR EACH STATEMENT EXECUTE FUNCTION pkc_auth.prevent_audit_mutation();
CREATE TRIGGER founder_mfa_audit_no_truncate BEFORE TRUNCATE ON pkc_auth.founder_mfa_audit_events FOR EACH STATEMENT EXECUTE FUNCTION pkc_auth.prevent_audit_mutation();

CREATE FUNCTION pkc_auth.claim_founder_mfa_outbox(worker_id uuid, batch_size integer)
RETURNS TABLE(outbox_id uuid,operation_key text,operation_type text,payload jsonb,lease_fence bigint,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF worker_id IS NULL OR batch_size IS NULL OR batch_size<1 OR batch_size>25 THEN RAISE EXCEPTION 'invalid_claim_arguments'; END IF;
  RETURN QUERY
  WITH expired AS (
    UPDATE pkc_auth.founder_mfa_outbox o SET state='unknown',lease_owner=NULL,lease_expires_at=NULL,last_error_class='delivery_outcome_unknown',next_reconcile_at=pg_catalog.clock_timestamp()
    WHERE o.state='dispatching' AND o.lease_expires_at<=pg_catalog.clock_timestamp()
    RETURNING o.outbox_id
  ), candidates AS (
    SELECT o.outbox_id FROM pkc_auth.founder_mfa_outbox o
    WHERE o.state='pending' AND o.next_attempt_at<=pg_catalog.clock_timestamp() AND o.attempts<o.max_attempts
    ORDER BY o.created_at,o.outbox_id FOR UPDATE SKIP LOCKED LIMIT batch_size
  ), claimed AS (
    UPDATE pkc_auth.founder_mfa_outbox o SET state='dispatching',lease_owner=worker_id,
      lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds', lease_fence = o.lease_fence + 1, attempts=o.attempts+1
    FROM candidates c WHERE o.outbox_id=c.outbox_id
    RETURNING o.outbox_id,o.operation_key,o.operation_type,o.payload,o.lease_fence,o.attempts
  ) SELECT * FROM claimed;
END $$;

CREATE FUNCTION pkc_auth.complete_founder_mfa_outbox(p_outbox_id uuid,p_worker_id uuid,p_lease_fence bigint,p_operation_key text,p_receipt_digest bytea)
RETURNS TABLE(state text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF p_worker_id IS NULL OR p_lease_fence IS NULL OR p_operation_key IS NULL OR p_receipt_digest IS NULL OR pg_catalog.octet_length(p_receipt_digest)<>32 THEN RAISE EXCEPTION 'invalid_completion_arguments'; END IF;
  RETURN QUERY UPDATE pkc_auth.founder_mfa_outbox o SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,receipt_digest=p_receipt_digest,completed_at=pg_catalog.clock_timestamp(),last_error_class=NULL
  WHERE o.outbox_id=p_outbox_id AND o.state='dispatching' AND o.lease_owner IS NOT DISTINCT FROM p_worker_id AND o.lease_fence IS NOT DISTINCT FROM p_lease_fence AND o.operation_key=p_operation_key
    AND o.lease_expires_at>pg_catalog.clock_timestamp()
  RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_outbox_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.mark_founder_mfa_outbox_unknown(p_outbox_id uuid,p_worker_id uuid,p_lease_fence bigint,p_operation_key text,p_error_class text)
RETURNS TABLE(state text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF p_worker_id IS NULL OR p_lease_fence IS NULL OR p_operation_key IS NULL OR p_error_class IS NULL OR p_error_class NOT IN ('delivery_outcome_unknown','transport_unavailable','receipt_mismatch') THEN RAISE EXCEPTION 'invalid_unknown_arguments'; END IF;
  RETURN QUERY UPDATE pkc_auth.founder_mfa_outbox o SET state='unknown',
    lease_owner=NULL,lease_expires_at=NULL,last_error_class=p_error_class,next_reconcile_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>LEAST(300,pg_catalog.power(2,o.attempts)::integer))
  WHERE o.outbox_id=p_outbox_id AND o.state='dispatching' AND o.lease_owner IS NOT DISTINCT FROM p_worker_id AND o.lease_fence IS NOT DISTINCT FROM p_lease_fence
    AND o.operation_key=p_operation_key AND o.lease_expires_at>pg_catalog.clock_timestamp() RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_outbox_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.claim_founder_mfa_outbox_reconciliation(worker_id uuid,batch_size integer)
RETURNS TABLE(outbox_id uuid,operation_key text,operation_type text,reconciliation_lease_fence bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF worker_id IS NULL OR batch_size IS NULL OR batch_size<1 OR batch_size>25 THEN RAISE EXCEPTION 'invalid_reconciliation_claim_arguments'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT o.outbox_id FROM pkc_auth.founder_mfa_outbox o
    WHERE o.state='unknown' AND o.next_reconcile_at<=pg_catalog.clock_timestamp()
      AND (o.reconciliation_lease_owner IS NULL OR o.reconciliation_lease_expires_at<=pg_catalog.clock_timestamp())
    ORDER BY o.created_at,o.outbox_id FOR UPDATE SKIP LOCKED LIMIT batch_size
  ), claimed AS (
    UPDATE pkc_auth.founder_mfa_outbox o SET reconciliation_lease_owner=worker_id,
      reconciliation_lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds',
      reconciliation_lease_fence=o.reconciliation_lease_fence+1
    FROM candidates c WHERE o.outbox_id=c.outbox_id
    RETURNING o.outbox_id,o.operation_key,o.operation_type,o.reconciliation_lease_fence
  ) SELECT * FROM claimed;
END $$;

CREATE FUNCTION pkc_auth.reconcile_founder_mfa_outbox(p_outbox_id uuid,p_worker_id uuid,p_reconciliation_lease_fence bigint,p_operation_key text,p_receipt_digest bytea)
RETURNS TABLE(state text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF p_worker_id IS NULL OR p_reconciliation_lease_fence IS NULL OR p_operation_key IS NULL OR p_receipt_digest IS NULL OR pg_catalog.octet_length(p_receipt_digest)<>32 THEN RAISE EXCEPTION 'invalid_reconcile_arguments'; END IF;
  RETURN QUERY UPDATE pkc_auth.founder_mfa_outbox o SET state='succeeded',receipt_digest=p_receipt_digest,completed_at=pg_catalog.clock_timestamp(),last_error_class=NULL,
    reconciliation_lease_owner=NULL,reconciliation_lease_expires_at=NULL
    WHERE o.outbox_id=p_outbox_id AND o.operation_key=p_operation_key AND o.state='unknown'
      AND o.reconciliation_lease_owner IS NOT DISTINCT FROM p_worker_id
      AND o.reconciliation_lease_fence IS NOT DISTINCT FROM p_reconciliation_lease_fence
      AND o.reconciliation_lease_expires_at>pg_catalog.clock_timestamp() RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconcile_state_mismatch'; END IF;
END $$;

CREATE FUNCTION pkc_auth.defer_founder_mfa_outbox_reconciliation(p_outbox_id uuid,p_worker_id uuid,p_reconciliation_lease_fence bigint,p_operation_key text)
RETURNS TABLE(state text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF p_outbox_id IS NULL OR p_worker_id IS NULL OR p_reconciliation_lease_fence IS NULL OR p_operation_key IS NULL THEN RAISE EXCEPTION 'invalid_reconciliation_defer_arguments'; END IF;
  RETURN QUERY UPDATE pkc_auth.founder_mfa_outbox o SET
    reconciliation_attempts=o.reconciliation_attempts+1,
    state=CASE WHEN o.reconciliation_attempts+1>=o.max_attempts THEN 'terminal_rejected' ELSE 'unknown' END,
    last_error_class=CASE WHEN o.reconciliation_attempts+1>=o.max_attempts THEN 'reconciliation_exhausted' ELSE o.last_error_class END,
    next_reconcile_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>LEAST(300,pg_catalog.power(2,o.reconciliation_attempts+1)::integer)),
    reconciliation_lease_owner=NULL,reconciliation_lease_expires_at=NULL
  WHERE o.outbox_id=p_outbox_id AND o.operation_key=p_operation_key AND o.state='unknown'
    AND o.reconciliation_lease_owner IS NOT DISTINCT FROM p_worker_id
    AND o.reconciliation_lease_fence IS NOT DISTINCT FROM p_reconciliation_lease_fence
    AND o.reconciliation_lease_expires_at>pg_catalog.clock_timestamp()
  RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_reconciliation_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.founder_mfa_outbox_monitor()
RETURNS TABLE(pending bigint,unknown bigint,terminal bigint,oldest_pending_seconds bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
SELECT pg_catalog.count(*) FILTER(WHERE state='pending'),pg_catalog.count(*) FILTER(WHERE state='unknown'),pg_catalog.count(*) FILTER(WHERE state='terminal_rejected'),
  COALESCE(EXTRACT(epoch FROM pg_catalog.clock_timestamp()-(pg_catalog.min(created_at) FILTER(WHERE state IN ('pending','unknown'))))::bigint,0) FROM pkc_auth.founder_mfa_outbox $$;

REVOKE ALL ON ALL TABLES IN SCHEMA pkc_auth FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pkc_auth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pkc_auth FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE pkc_mfa_owner IN SCHEMA pkc_auth REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE pkc_mfa_owner IN SCHEMA pkc_auth REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE pkc_mfa_owner IN SCHEMA pkc_auth REVOKE ALL ON FUNCTIONS FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON pkc_auth.founder_mfa_factors,pkc_auth.founder_mfa_challenges,pkc_auth.founder_mfa_recovery_codes,pkc_auth.founder_mfa_finalizations,pkc_auth.founder_mfa_outbox TO pkc_mfa_runtime;
GRANT SELECT,INSERT ON pkc_auth.founder_mfa_audit_events TO pkc_mfa_runtime;
GRANT SELECT ON pkc_auth.migration_ledger TO pkc_mfa_runtime,pkc_mfa_verifier;
GRANT EXECUTE ON FUNCTION pkc_auth.claim_founder_mfa_outbox(uuid,integer) TO pkc_mfa_outbox_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.complete_founder_mfa_outbox(uuid,uuid,bigint,text,bytea) TO pkc_mfa_outbox_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.mark_founder_mfa_outbox_unknown(uuid,uuid,bigint,text,text) TO pkc_mfa_outbox_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.claim_founder_mfa_outbox_reconciliation(uuid,integer) TO pkc_mfa_outbox_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.reconcile_founder_mfa_outbox(uuid,uuid,bigint,text,bytea) TO pkc_mfa_outbox_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.defer_founder_mfa_outbox_reconciliation(uuid,uuid,bigint,text) TO pkc_mfa_outbox_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.founder_mfa_outbox_monitor() TO pkc_mfa_outbox_worker,pkc_mfa_verifier;
