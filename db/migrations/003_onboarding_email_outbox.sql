SET LOCAL search_path = pg_catalog, pkc_auth;

CREATE TABLE pkc_auth.onboarding_submission_claims (
  submission_id text PRIMARY KEY CHECK (pg_catalog.octet_length(submission_id) BETWEEN 8 AND 128),
  request_digest bytea NOT NULL CHECK (pg_catalog.octet_length(request_digest)=32),
  recipient_email text NOT NULL CHECK (pg_catalog.octet_length(recipient_email) BETWEEN 3 AND 320),
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','persisted')),
  persistence_lease_owner uuid,
  persistence_lease_expires_at timestamptz,
  persistence_lease_fence bigint NOT NULL DEFAULT 0 CHECK (persistence_lease_fence>=0),
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  persisted_at timestamptz,
  CHECK ((state='persisted')=(persisted_at IS NOT NULL)),
  CHECK ((persistence_lease_owner IS NULL)=(persistence_lease_expires_at IS NULL)),
  CHECK (persistence_lease_owner IS NULL OR state='claimed')
);

CREATE TABLE pkc_auth.onboarding_email_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  submission_id text NOT NULL UNIQUE REFERENCES pkc_auth.onboarding_submission_claims(submission_id) ON DELETE RESTRICT,
  operation_key text NOT NULL UNIQUE CHECK (pg_catalog.octet_length(operation_key) BETWEEN 16 AND 200),
  request_digest bytea NOT NULL CHECK (pg_catalog.octet_length(request_digest)=32),
  recipient_email text NOT NULL CHECK (pg_catalog.octet_length(recipient_email) BETWEEN 3 AND 320),
  email_subject text NOT NULL DEFAULT 'Welcome to ProjectKidCreations' CHECK (email_subject='Welcome to ProjectKidCreations'),
  email_body text NOT NULL DEFAULT 'Welcome aboard from ProjectKidCreations.' CHECK (email_body='Welcome aboard from ProjectKidCreations.'),
  state text NOT NULL DEFAULT 'blocked' CHECK (state IN ('blocked','pending','transmitting','ambiguous','accepted')),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence>=0),
  request_sha256 bytea CHECK (request_sha256 IS NULL OR pg_catalog.octet_length(request_sha256)=32),
  reconciliation_lease_owner uuid,
  reconciliation_lease_expires_at timestamptz,
  reconciliation_lease_fence bigint NOT NULL DEFAULT 0 CHECK (reconciliation_lease_fence>=0),
  reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts>=0),
  next_reconcile_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  provider_message_id text CHECK (provider_message_id IS NULL OR pg_catalog.octet_length(provider_message_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  accepted_at timestamptz,
  CHECK ((state='transmitting')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((reconciliation_lease_owner IS NULL)=(reconciliation_lease_expires_at IS NULL)),
  CHECK (reconciliation_lease_owner IS NULL OR state='ambiguous'),
  CHECK ((state='accepted')=(accepted_at IS NOT NULL AND provider_message_id IS NOT NULL AND request_sha256 IS NOT NULL)),
  CHECK (state<>'accepted' OR lease_owner IS NULL)
);
CREATE INDEX onboarding_email_outbox_dispatch ON pkc_auth.onboarding_email_outbox(state,created_at,outbox_id) WHERE state IN ('pending','transmitting');
CREATE INDEX onboarding_email_outbox_reconciliation ON pkc_auth.onboarding_email_outbox(state,next_reconcile_at,created_at,outbox_id) WHERE state='ambiguous';

CREATE FUNCTION pkc_auth.prevent_onboarding_claim_rewrite() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF OLD.submission_id IS DISTINCT FROM NEW.submission_id
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR OLD.recipient_email IS DISTINCT FROM NEW.recipient_email
     OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
     OR (OLD.state='persisted' AND NEW.state<>'persisted')
     OR (OLD.persisted_at IS NOT NULL AND OLD.persisted_at IS DISTINCT FROM NEW.persisted_at) THEN
    RAISE EXCEPTION 'onboarding_claim_request_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_claim_request_immutable
  BEFORE UPDATE ON pkc_auth.onboarding_submission_claims
  FOR EACH ROW EXECUTE FUNCTION pkc_auth.prevent_onboarding_claim_rewrite();

CREATE FUNCTION pkc_auth.prevent_onboarding_email_identity_rewrite() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF OLD.outbox_id IS DISTINCT FROM NEW.outbox_id
     OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
     OR OLD.operation_key IS DISTINCT FROM NEW.operation_key
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR OLD.recipient_email IS DISTINCT FROM NEW.recipient_email
     OR OLD.email_subject IS DISTINCT FROM NEW.email_subject
     OR OLD.email_body IS DISTINCT FROM NEW.email_body
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.request_sha256 IS NOT NULL AND OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256)
     OR (OLD.provider_message_id IS NOT NULL AND OLD.provider_message_id IS DISTINCT FROM NEW.provider_message_id)
     OR (OLD.accepted_at IS NOT NULL AND OLD.accepted_at IS DISTINCT FROM NEW.accepted_at) THEN
    RAISE EXCEPTION 'onboarding_email_request_digest_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_email_request_digest_immutable
  BEFORE UPDATE ON pkc_auth.onboarding_email_outbox
  FOR EACH ROW EXECUTE FUNCTION pkc_auth.prevent_onboarding_email_identity_rewrite();

CREATE FUNCTION pkc_auth.claim_onboarding_submission(p_submission_id text,p_request_digest bytea,p_recipient_email text,p_persistence_worker_id uuid)
RETURNS TABLE(claim_state text,outbox_id uuid,email_state text,persistence_fence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
DECLARE
  existing_digest bytea;
  existing_email text;
  existing_state text;
  existing_lease_owner uuid;
  existing_lease_expires_at timestamptz;
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_runtime' THEN RAISE EXCEPTION 'invalid_onboarding_runtime'; END IF;
  IF p_submission_id IS NULL OR pg_catalog.octet_length(p_submission_id) NOT BETWEEN 8 AND 128
     OR p_request_digest IS NULL OR pg_catalog.octet_length(p_request_digest)<>32
     OR p_recipient_email IS NULL OR pg_catalog.octet_length(p_recipient_email) NOT BETWEEN 3 AND 320
     OR p_persistence_worker_id IS NULL THEN
    RAISE EXCEPTION 'invalid_onboarding_claim_arguments';
  END IF;
  INSERT INTO pkc_auth.onboarding_submission_claims(submission_id,request_digest,recipient_email)
    VALUES(p_submission_id,p_request_digest,p_recipient_email) ON CONFLICT (submission_id) DO NOTHING;
  SELECT c.request_digest,c.recipient_email,c.state,c.persistence_lease_owner,c.persistence_lease_expires_at
    INTO existing_digest,existing_email,existing_state,existing_lease_owner,existing_lease_expires_at
    FROM pkc_auth.onboarding_submission_claims c WHERE c.submission_id=p_submission_id FOR UPDATE;
  IF existing_digest IS DISTINCT FROM p_request_digest OR existing_email IS DISTINCT FROM p_recipient_email THEN
    RAISE EXCEPTION 'request_digest_mismatch';
  END IF;
  INSERT INTO pkc_auth.onboarding_email_outbox(submission_id,operation_key,request_digest,recipient_email)
    VALUES(p_submission_id,'onboarding-email:'||p_submission_id,p_request_digest,p_recipient_email)
    ON CONFLICT (submission_id) DO NOTHING;
  IF existing_state='persisted' THEN
    RETURN QUERY SELECT 'persisted'::text,o.outbox_id,o.state,c.persistence_lease_fence::text
      FROM pkc_auth.onboarding_submission_claims c JOIN pkc_auth.onboarding_email_outbox o USING(submission_id)
      WHERE c.submission_id=p_submission_id;
    RETURN;
  END IF;
  IF existing_lease_owner IS NOT NULL AND existing_lease_expires_at>pg_catalog.clock_timestamp() THEN
    RETURN QUERY SELECT 'in_progress'::text,o.outbox_id,o.state,c.persistence_lease_fence::text
      FROM pkc_auth.onboarding_submission_claims c JOIN pkc_auth.onboarding_email_outbox o USING(submission_id)
      WHERE c.submission_id=p_submission_id;
    RETURN;
  END IF;
  UPDATE pkc_auth.onboarding_submission_claims c
    SET persistence_lease_owner=p_persistence_worker_id,
        persistence_lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds',
        persistence_lease_fence=c.persistence_lease_fence+1
    WHERE c.submission_id=p_submission_id AND c.state='claimed';
  RETURN QUERY SELECT 'claimed'::text,o.outbox_id,o.state,c.persistence_lease_fence::text
    FROM pkc_auth.onboarding_submission_claims c
    JOIN pkc_auth.onboarding_email_outbox o USING(submission_id)
    WHERE c.submission_id=p_submission_id;
END $$;

CREATE FUNCTION pkc_auth.mark_onboarding_submission_persisted(p_submission_id text,p_request_digest bytea,p_persistence_worker_id uuid,p_persistence_lease_fence bigint)
RETURNS TABLE(claim_state text,outbox_id uuid,email_state text,persistence_fence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_runtime' THEN RAISE EXCEPTION 'invalid_onboarding_runtime'; END IF;
  IF p_submission_id IS NULL OR p_request_digest IS NULL OR pg_catalog.octet_length(p_request_digest)<>32
     OR p_persistence_worker_id IS NULL OR p_persistence_lease_fence IS NULL THEN RAISE EXCEPTION 'invalid_onboarding_persist_arguments'; END IF;
  UPDATE pkc_auth.onboarding_submission_claims c
    SET state='persisted',persisted_at=pg_catalog.clock_timestamp(),persistence_lease_owner=NULL,persistence_lease_expires_at=NULL
    WHERE c.submission_id=p_submission_id AND c.request_digest=p_request_digest AND c.state='claimed'
      AND c.persistence_lease_owner IS NOT DISTINCT FROM p_persistence_worker_id
      AND c.persistence_lease_fence IS NOT DISTINCT FROM p_persistence_lease_fence
      AND c.persistence_lease_expires_at>pg_catalog.clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_onboarding_persistence_fence'; END IF;
  UPDATE pkc_auth.onboarding_email_outbox o SET state='pending'
    WHERE o.submission_id=p_submission_id AND o.request_digest=p_request_digest AND o.state='blocked';
  RETURN QUERY SELECT c.state,o.outbox_id,o.state,c.persistence_lease_fence::text
    FROM pkc_auth.onboarding_submission_claims c JOIN pkc_auth.onboarding_email_outbox o USING(submission_id)
    WHERE c.submission_id=p_submission_id AND c.request_digest=p_request_digest;
END $$;

CREATE FUNCTION pkc_auth.claim_onboarding_email_outbox(p_worker_id uuid,p_batch_size integer)
RETURNS TABLE(outbox_id uuid,operation_key text,recipient_email text,email_subject text,email_body text,request_digest_hex text,lease_fence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_worker' THEN RAISE EXCEPTION 'invalid_onboarding_email_worker'; END IF;
  IF p_worker_id IS NULL OR p_batch_size IS NULL OR p_batch_size<1 OR p_batch_size>25 THEN RAISE EXCEPTION 'invalid_onboarding_email_claim_arguments'; END IF;
  UPDATE pkc_auth.onboarding_email_outbox o
    SET state='pending',lease_owner=NULL,lease_expires_at=NULL
    WHERE o.state='transmitting' AND o.lease_expires_at<=pg_catalog.clock_timestamp()
      AND o.request_sha256 IS NULL;
  UPDATE pkc_auth.onboarding_email_outbox o
    SET state='ambiguous',lease_owner=NULL,lease_expires_at=NULL,next_reconcile_at=pg_catalog.clock_timestamp()
    WHERE o.state='transmitting' AND o.lease_expires_at<=pg_catalog.clock_timestamp()
      AND o.request_sha256 IS NOT NULL;
  RETURN QUERY
  WITH candidates AS (
    SELECT o.outbox_id FROM pkc_auth.onboarding_email_outbox o
      WHERE o.state='pending'
      ORDER BY o.created_at,o.outbox_id FOR UPDATE SKIP LOCKED LIMIT p_batch_size
  ), claimed AS (
    UPDATE pkc_auth.onboarding_email_outbox o SET state='transmitting',lease_owner=p_worker_id,
      lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds',lease_fence=o.lease_fence+1
      FROM candidates c WHERE o.outbox_id=c.outbox_id
      RETURNING o.outbox_id,o.operation_key,o.recipient_email,o.email_subject,o.email_body,
        pg_catalog.encode(o.request_digest,'hex') AS request_digest_hex,o.lease_fence::text AS lease_fence
  ) SELECT * FROM claimed;
END $$;

CREATE FUNCTION pkc_auth.arm_onboarding_email_outbox(p_outbox_id uuid,p_worker_id uuid,p_lease_fence bigint,p_request_sha256 bytea)
RETURNS TABLE(state text,operation_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_worker' THEN RAISE EXCEPTION 'invalid_onboarding_email_worker'; END IF;
  IF p_outbox_id IS NULL OR p_worker_id IS NULL OR p_lease_fence IS NULL OR p_request_sha256 IS NULL OR pg_catalog.octet_length(p_request_sha256)<>32 THEN RAISE EXCEPTION 'invalid_onboarding_email_arm_arguments'; END IF;
  RETURN QUERY UPDATE pkc_auth.onboarding_email_outbox o SET request_sha256=p_request_sha256
    WHERE o.outbox_id=p_outbox_id AND o.state='transmitting' AND o.lease_owner IS NOT DISTINCT FROM p_worker_id
      AND o.lease_fence IS NOT DISTINCT FROM p_lease_fence AND o.lease_expires_at>pg_catalog.clock_timestamp()
      AND (o.request_sha256 IS NULL OR o.request_sha256=p_request_sha256)
    RETURNING o.state,o.operation_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_onboarding_email_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.accept_onboarding_email_outbox(p_outbox_id uuid,p_worker_id uuid,p_lease_fence bigint,p_request_sha256 bytea,p_provider_message_id text)
RETURNS TABLE(state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_worker' THEN RAISE EXCEPTION 'invalid_onboarding_email_worker'; END IF;
  IF p_provider_message_id IS NULL OR pg_catalog.octet_length(p_provider_message_id) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'invalid_onboarding_email_accept_arguments'; END IF;
  RETURN QUERY UPDATE pkc_auth.onboarding_email_outbox o SET state='accepted',lease_owner=NULL,lease_expires_at=NULL,
      provider_message_id=p_provider_message_id,accepted_at=pg_catalog.clock_timestamp()
    WHERE o.outbox_id=p_outbox_id AND o.state='transmitting' AND o.lease_owner IS NOT DISTINCT FROM p_worker_id
      AND o.lease_fence IS NOT DISTINCT FROM p_lease_fence AND o.lease_expires_at>pg_catalog.clock_timestamp()
      AND o.request_sha256=p_request_sha256 RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_onboarding_email_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.mark_onboarding_email_ambiguous(p_outbox_id uuid,p_worker_id uuid,p_lease_fence bigint,p_request_sha256 bytea)
RETURNS TABLE(state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_worker' THEN RAISE EXCEPTION 'invalid_onboarding_email_worker'; END IF;
  RETURN QUERY UPDATE pkc_auth.onboarding_email_outbox o SET state='ambiguous',lease_owner=NULL,lease_expires_at=NULL,next_reconcile_at=pg_catalog.clock_timestamp()
    WHERE o.outbox_id=p_outbox_id AND o.state='transmitting' AND o.lease_owner IS NOT DISTINCT FROM p_worker_id
      AND o.lease_fence IS NOT DISTINCT FROM p_lease_fence AND o.lease_expires_at>pg_catalog.clock_timestamp()
      AND o.request_sha256=p_request_sha256 RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_onboarding_email_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.claim_onboarding_email_outbox_reconciliation(p_worker_id uuid,p_batch_size integer)
RETURNS TABLE(outbox_id uuid,operation_key text,request_sha256_hex text,reconciliation_lease_fence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_reconciler' THEN RAISE EXCEPTION 'invalid_onboarding_email_reconciler'; END IF;
  IF p_worker_id IS NULL OR p_batch_size IS NULL OR p_batch_size<1 OR p_batch_size>25 THEN RAISE EXCEPTION 'invalid_onboarding_reconciliation_claim_arguments'; END IF;
  RETURN QUERY WITH candidates AS (
    SELECT o.outbox_id FROM pkc_auth.onboarding_email_outbox o
      WHERE o.state='ambiguous' AND o.next_reconcile_at<=pg_catalog.clock_timestamp()
        AND (o.reconciliation_lease_owner IS NULL OR o.reconciliation_lease_expires_at<=pg_catalog.clock_timestamp())
      ORDER BY o.created_at,o.outbox_id FOR UPDATE SKIP LOCKED LIMIT p_batch_size
  ), claimed AS (
    UPDATE pkc_auth.onboarding_email_outbox o SET reconciliation_lease_owner=p_worker_id,
      reconciliation_lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds',reconciliation_lease_fence=o.reconciliation_lease_fence+1
      FROM candidates c WHERE o.outbox_id=c.outbox_id
      RETURNING o.outbox_id,o.operation_key,CASE WHEN o.request_sha256 IS NULL THEN NULL ELSE pg_catalog.encode(o.request_sha256,'hex') END AS request_sha256_hex,
        o.reconciliation_lease_fence::text AS reconciliation_lease_fence
  ) SELECT * FROM claimed;
END $$;

CREATE FUNCTION pkc_auth.reconcile_onboarding_email_accepted(p_outbox_id uuid,p_worker_id uuid,p_reconciliation_lease_fence bigint,p_request_sha256 bytea,p_provider_message_id text)
RETURNS TABLE(state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_reconciler' THEN RAISE EXCEPTION 'invalid_onboarding_email_reconciler'; END IF;
  RETURN QUERY UPDATE pkc_auth.onboarding_email_outbox o SET state='accepted',provider_message_id=p_provider_message_id,
      accepted_at=pg_catalog.clock_timestamp(),reconciliation_lease_owner=NULL,reconciliation_lease_expires_at=NULL
    WHERE o.outbox_id=p_outbox_id AND o.state='ambiguous'
      AND o.reconciliation_lease_owner IS NOT DISTINCT FROM p_worker_id
      AND o.reconciliation_lease_fence IS NOT DISTINCT FROM p_reconciliation_lease_fence
      AND o.reconciliation_lease_expires_at>pg_catalog.clock_timestamp()
      AND o.request_sha256 IS NOT DISTINCT FROM p_request_sha256
      AND p_provider_message_id IS NOT NULL AND pg_catalog.octet_length(p_provider_message_id) BETWEEN 1 AND 512
    RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_onboarding_reconciliation_fence'; END IF;
END $$;

CREATE FUNCTION pkc_auth.defer_onboarding_email_reconciliation(p_outbox_id uuid,p_worker_id uuid,p_reconciliation_lease_fence bigint)
RETURNS TABLE(state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_reconciler' THEN RAISE EXCEPTION 'invalid_onboarding_email_reconciler'; END IF;
  RETURN QUERY UPDATE pkc_auth.onboarding_email_outbox o SET reconciliation_attempts=o.reconciliation_attempts+1,
      next_reconcile_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>LEAST(3600,pg_catalog.power(2,LEAST(11,o.reconciliation_attempts+1))::integer)),
      reconciliation_lease_owner=NULL,reconciliation_lease_expires_at=NULL
    WHERE o.outbox_id=p_outbox_id AND o.state='ambiguous'
      AND o.reconciliation_lease_owner IS NOT DISTINCT FROM p_worker_id
      AND o.reconciliation_lease_fence IS NOT DISTINCT FROM p_reconciliation_lease_fence
      AND o.reconciliation_lease_expires_at>pg_catalog.clock_timestamp()
    RETURNING o.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_onboarding_reconciliation_fence'; END IF;
END $$;

GRANT USAGE ON SCHEMA pkc_auth TO pkc_onboarding_runtime,pkc_onboarding_email_worker,pkc_onboarding_email_reconciler;
REVOKE ALL ON pkc_auth.onboarding_submission_claims, pkc_auth.onboarding_email_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION pkc_auth.prevent_onboarding_claim_rewrite(),pkc_auth.prevent_onboarding_email_identity_rewrite() FROM PUBLIC;
REVOKE ALL ON FUNCTION pkc_auth.claim_onboarding_submission(text,bytea,text,uuid),pkc_auth.mark_onboarding_submission_persisted(text,bytea,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pkc_auth.claim_onboarding_email_outbox(uuid,integer),pkc_auth.arm_onboarding_email_outbox(uuid,uuid,bigint,bytea),pkc_auth.accept_onboarding_email_outbox(uuid,uuid,bigint,bytea,text),pkc_auth.mark_onboarding_email_ambiguous(uuid,uuid,bigint,bytea),pkc_auth.claim_onboarding_email_outbox_reconciliation(uuid,integer),pkc_auth.reconcile_onboarding_email_accepted(uuid,uuid,bigint,bytea,text),pkc_auth.defer_onboarding_email_reconciliation(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pkc_auth.claim_onboarding_submission(text,bytea,text,uuid),pkc_auth.mark_onboarding_submission_persisted(text,bytea,uuid,bigint) TO pkc_onboarding_runtime;
GRANT EXECUTE ON FUNCTION pkc_auth.claim_onboarding_email_outbox(uuid,integer),pkc_auth.arm_onboarding_email_outbox(uuid,uuid,bigint,bytea),pkc_auth.accept_onboarding_email_outbox(uuid,uuid,bigint,bytea,text),pkc_auth.mark_onboarding_email_ambiguous(uuid,uuid,bigint,bytea) TO pkc_onboarding_email_worker;
GRANT EXECUTE ON FUNCTION pkc_auth.claim_onboarding_email_outbox_reconciliation(uuid,integer),pkc_auth.reconcile_onboarding_email_accepted(uuid,uuid,bigint,bytea,text),pkc_auth.defer_onboarding_email_reconciliation(uuid,uuid,bigint) TO pkc_onboarding_email_reconciler;
