SET LOCAL search_path = pg_catalog, pkc_auth;

CREATE TABLE pkc_auth.founder_mfa_enrollment_authorizations (
  enrollment_authorization_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  founder_subject uuid NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  deployment_id text NOT NULL CHECK (pg_catalog.octet_length(deployment_id) BETWEEN 8 AND 256),
  workflow_digest text NOT NULL CHECK (workflow_digest ~ '^[0-9a-f]{64}$'),
  approval_id text NOT NULL UNIQUE CHECK (pg_catalog.octet_length(approval_id) BETWEEN 8 AND 128),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  expected_factor_state text NOT NULL CHECK (expected_factor_state IN ('unenrolled','recovery_required')),
  expected_auth_epoch bigint NOT NULL CHECK (expected_auth_epoch >= 0),
  consumed_at timestamptz,
  consumed_by_challenge_id uuid,
  CHECK (expires_at > issued_at),
  CHECK ((consumed_at IS NULL) = (consumed_by_challenge_id IS NULL)),
  FOREIGN KEY (founder_subject) REFERENCES pkc_auth.founder_mfa_factors(founder_subject) ON DELETE RESTRICT,
  FOREIGN KEY (consumed_by_challenge_id) REFERENCES pkc_auth.founder_mfa_challenges(challenge_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX founder_mfa_one_current_enrollment_authorization
  ON pkc_auth.founder_mfa_enrollment_authorizations(founder_subject)
  WHERE consumed_at IS NULL;

ALTER TABLE pkc_auth.founder_mfa_challenges
  ADD COLUMN enrollment_authorization_id uuid REFERENCES pkc_auth.founder_mfa_enrollment_authorizations(enrollment_authorization_id) ON DELETE RESTRICT;

CREATE TABLE pkc_auth.founder_mfa_recovery_operations (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[a-z][a-z0-9_-]{7,127}$'),
  factor_id uuid NOT NULL REFERENCES pkc_auth.founder_mfa_factors(factor_id) ON DELETE RESTRICT,
  operator_principal_id text NOT NULL CHECK (operator_principal_id ~ '^[a-z][a-z0-9_-]{7,127}$'),
  operator_approval_id text NOT NULL CHECK (operator_approval_id ~ '^[a-z][a-z0-9_-]{7,127}$'),
  verifier_principal_id text NOT NULL CHECK (verifier_principal_id ~ '^[a-z][a-z0-9_-]{7,127}$'),
  verifier_approval_id text NOT NULL CHECK (verifier_approval_id ~ '^[a-z][a-z0-9_-]{7,127}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  prior_auth_epoch bigint NOT NULL CHECK (prior_auth_epoch >= 0),
  resulting_auth_epoch bigint NOT NULL CHECK (resulting_auth_epoch = prior_auth_epoch + 1),
  completed_at timestamptz NOT NULL,
  CHECK (operator_principal_id <> verifier_principal_id),
  CHECK (operator_approval_id <> verifier_approval_id)
);

CREATE FUNCTION pkc_auth.prevent_enrollment_authorization_rewrite() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN
  IF OLD.founder_subject IS DISTINCT FROM NEW.founder_subject
     OR OLD.source_commit IS DISTINCT FROM NEW.source_commit
     OR OLD.deployment_id IS DISTINCT FROM NEW.deployment_id
     OR OLD.workflow_digest IS DISTINCT FROM NEW.workflow_digest
     OR OLD.approval_id IS DISTINCT FROM NEW.approval_id
     OR OLD.issued_at IS DISTINCT FROM NEW.issued_at
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.expected_factor_state IS DISTINCT FROM NEW.expected_factor_state
     OR OLD.expected_auth_epoch IS DISTINCT FROM NEW.expected_auth_epoch
     OR OLD.consumed_at IS NOT NULL
     OR (NEW.consumed_at IS NULL) <> (NEW.consumed_by_challenge_id IS NULL) THEN
    RAISE EXCEPTION 'enrollment_authorization_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER founder_mfa_enrollment_authorization_immutable
  BEFORE UPDATE ON pkc_auth.founder_mfa_enrollment_authorizations
  FOR EACH ROW EXECUTE FUNCTION pkc_auth.prevent_enrollment_authorization_rewrite();

CREATE FUNCTION pkc_auth.prevent_recovery_operation_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pkc_auth AS $$
BEGIN RAISE EXCEPTION 'recovery_operation_immutable'; END $$;
CREATE TRIGGER founder_mfa_recovery_operation_append_only
  BEFORE UPDATE OR DELETE ON pkc_auth.founder_mfa_recovery_operations
  FOR EACH STATEMENT EXECUTE FUNCTION pkc_auth.prevent_recovery_operation_mutation();

REVOKE ALL ON pkc_auth.founder_mfa_enrollment_authorizations, pkc_auth.founder_mfa_recovery_operations FROM PUBLIC;
REVOKE ALL ON FUNCTION pkc_auth.prevent_enrollment_authorization_rewrite(), pkc_auth.prevent_recovery_operation_mutation() FROM PUBLIC;
GRANT SELECT,UPDATE ON pkc_auth.founder_mfa_enrollment_authorizations TO pkc_mfa_runtime;
