import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(new URL("../../db/migrations/003_onboarding_email_outbox.sql", import.meta.url), "utf8");
const roles = readFileSync(new URL("../../db/roles/000_roles.sql", import.meta.url), "utf8");
const onboardingRoles = readFileSync(new URL("../../db/roles/004_onboarding_roles.sql", import.meta.url), "utf8");
const readiness = readFileSync(new URL("../../db/readiness.mjs", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../../db/migrations/manifest.json", import.meta.url), "utf8"));

const functionBlock = (name) => migration.match(new RegExp(`CREATE FUNCTION pkc_auth\\.${name}\\([^]*?END \\$\\$;`, "i"))?.[0] || "";

test("migration 003 creates a durable unique claim and exactly one initially-blocked email", () => {
  assert.match(migration, /CREATE TABLE pkc_auth\.onboarding_submission_claims/i);
  assert.match(migration, /submission_id text PRIMARY KEY/i);
  assert.match(migration, /request_digest bytea NOT NULL[^;]+octet_length\(request_digest\)\s*=\s*32/is);
  assert.match(migration, /CREATE TABLE pkc_auth\.onboarding_email_outbox/i);
  assert.match(migration, /submission_id text NOT NULL UNIQUE/i);
  assert.match(migration, /state text NOT NULL DEFAULT 'blocked'/i);
  assert.match(functionBlock("claim_onboarding_submission"), /INSERT INTO pkc_auth\.onboarding_submission_claims/i);
  assert.match(functionBlock("claim_onboarding_submission"), /INSERT INTO pkc_auth\.onboarding_email_outbox/i);
  assert.match(functionBlock("claim_onboarding_submission"), /request_digest_mismatch/i);
});

test("persistence releases one pending email while immutable request identity stays bound", () => {
  const claim = functionBlock("claim_onboarding_submission");
  const persist = functionBlock("mark_onboarding_submission_persisted");
  assert.match(migration, /persistence_lease_owner uuid/i);
  assert.match(migration, /persistence_lease_expires_at timestamptz/i);
  assert.match(migration, /persistence_lease_fence bigint NOT NULL DEFAULT 0/i);
  assert.match(claim, /FOR UPDATE/i);
  assert.match(claim, /claim_state[^]*in_progress/i);
  assert.match(claim, /persistence_lease_fence::text/i);
  assert.match(persist, /state='persisted'/i);
  assert.match(persist, /SET state='pending'/i);
  assert.match(persist, /request_digest/i);
  assert.match(persist, /p_persistence_lease_fence bigint/i);
  assert.match(persist, /persistence_lease_expires_at>pg_catalog\.clock_timestamp\(\)/i);
  assert.match(migration, /onboarding_claim_request_immutable/i);
  assert.match(migration, /request_digest_immutable/i);
});

test("delivery is claim then exact-request arm then accepted or ambiguous with no post-arm retry", () => {
  const claim = functionBlock("claim_onboarding_email_outbox");
  const arm = functionBlock("arm_onboarding_email_outbox");
  const accepted = functionBlock("accept_onboarding_email_outbox");
  const ambiguous = functionBlock("mark_onboarding_email_ambiguous");
  assert.match(claim, /state='transmitting'/i);
  assert.match(claim, /state='ambiguous'[^;]+lease_expires_at/is);
  assert.match(claim, /lease_fence::text/i);
  assert.match(arm, /request_sha256/i);
  assert.match(arm, /state='transmitting'/i);
  assert.match(accepted, /o\.request_sha256=p_request_sha256/i);
  assert.match(accepted, /state='accepted'/i);
  assert.match(ambiguous, /o\.request_sha256=p_request_sha256/i);
  assert.match(ambiguous, /state='ambiguous'/i);
  assert.match(claim, /candidates AS \([^]*WHERE o\.state='pending'/i);
});

test("ambiguous rows are reconciliation-only and all bigint fences cross as text", () => {
  const claim = functionBlock("claim_onboarding_email_outbox_reconciliation");
  const reconcile = functionBlock("reconcile_onboarding_email_accepted");
  assert.match(claim, /WHERE o\.state='ambiguous'/i);
  assert.match(claim, /reconciliation_lease_fence::text/i);
  assert.match(reconcile, /AND o\.state='ambiguous'/i);
  assert.match(reconcile, /p_reconciliation_lease_fence bigint/i);
});

test("dedicated onboarding roles are function-only, session-bound, and public is closed", () => {
  for (const role of ["pkc_onboarding_runtime", "pkc_onboarding_email_worker"]) {
    assert.match(roles, new RegExp(`CREATE ROLE ${role} LOGIN`));
    assert.match(readiness, new RegExp(role));
    assert.match(migration, new RegExp(`SESSION_USER IS DISTINCT FROM '${role}'`));
  }
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog, pkc_auth/gi);
  assert.match(migration, /REVOKE ALL ON pkc_auth\.onboarding_submission_claims, pkc_auth\.onboarding_email_outbox FROM PUBLIC/i);
  assert.doesNotMatch(migration, /GRANT (?:SELECT|INSERT|UPDATE|DELETE) ON pkc_auth\.onboarding_/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION pkc_auth\.claim_onboarding_submission[^;]+TO pkc_onboarding_runtime/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION pkc_auth\.claim_onboarding_email_outbox[^;]+TO pkc_onboarding_email_worker/i);
  assert.match(readiness, /role_settings/);
  for (const setting of ["statement_timeout=5s", "lock_timeout=2s", "idle_in_transaction_session_timeout=10s"]) {
    assert.match(readiness, new RegExp(setting));
  }
});

test("additive onboarding role provisioning is target-guarded and cannot open migrator authority", () => {
  assert.match(onboardingRoles, /current_database\(\) = :'expected_database'/);
  for (const role of ["pkc_onboarding_runtime", "pkc_onboarding_email_worker"]) {
    assert.match(onboardingRoles, new RegExp(`CREATE ROLE ${role} LOGIN`));
    assert.match(onboardingRoles, new RegExp(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`));
    assert.match(onboardingRoles, new RegExp(`ALTER ROLE ${role} IN DATABASE :"expected_database" RESET ALL`));
  }
  assert.doesNotMatch(onboardingRoles, /pkc_mfa_migrator|GRANT pkc_mfa_owner/);
});

test("worker projection is generic and excludes firstName", () => {
  assert.match(migration, /Welcome to ProjectKidCreations/);
  assert.match(migration, /Welcome aboard from ProjectKidCreations\./);
  const claim = functionBlock("claim_onboarding_email_outbox");
  assert.match(claim, /RETURNS TABLE\(outbox_id uuid,operation_key text,recipient_email text,email_subject text,email_body text,request_digest_hex text,lease_fence text\)/i);
  assert.doesNotMatch(claim, /first_?name/i);
});

test("manifest appends migration 003 without rewriting prior checksums", () => {
  assert.deepEqual(manifest.migrations.slice(0, 2).map(({ version, file, sha256 }) => ({ version, file, sha256 })), [
    { version: 1, file: "001_founder_mfa.sql", sha256: "3f50589a00e46dfcf87fd6240532c83a604537f820bfb44c89e9c53a19dfbf22" },
    { version: 2, file: "002_founder_mfa_production_authority.sql", sha256: "50c13f882442af7d4fa9016713265c6738132606644049449a8d2c051659696e" },
  ]);
  assert.equal(manifest.migrations[2]?.version, 3);
  assert.equal(manifest.migrations[2]?.file, "003_onboarding_email_outbox.sql");
  assert.match(manifest.migrations[2]?.sha256 || "", /^[0-9a-f]{64}$/);
});
