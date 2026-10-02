import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const roles = readFileSync(new URL("../../db/roles/000_roles.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../db/migrations/001_founder_mfa.sql", import.meta.url), "utf8");
const correctiveMigration = readFileSync(new URL("../../db/migrations/002_founder_mfa_production_authority.sql", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../../db/migrations/manifest.json", import.meta.url), "utf8"));
const runner = readFileSync(new URL("../../db/migrate.mjs", import.meta.url), "utf8");
const readiness = readFileSync(new URL("../../db/readiness.mjs", import.meta.url), "utf8");
const nativeHarness = readFileSync(new URL("../../scripts/test-founder-mfa-postgres.sh", import.meta.url), "utf8");

test("ordered migration authority is checksum-ledgered, target-guarded, locked, and replay safe", () => {
  assert.deepEqual(manifest.schemaVersion, 1);
  assert.equal(manifest.migrations.length, 4);
  assert.equal(manifest.migrations[0].file, "001_founder_mfa.sql");
  assert.equal(manifest.migrations[1].file, "002_founder_mfa_production_authority.sql");
  assert.equal(manifest.migrations[2].file, "003_onboarding_email_outbox.sql");
  assert.equal(manifest.migrations[3].file, "004_backup_read_authority.sql");
  for (const entry of manifest.migrations) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.match(runner, /pg_advisory_xact_lock/);
  assert.match(runner, /migration_ledger/);
  assert.match(runner, /checksum_mismatch/);
  assert.match(runner, /expectedDatabase/);
  assert.match(runner, /row\.filename !== migration\.file/);
  assert.match(runner, /row\.environment !== expectedEnvironment/);
  assert.match(runner, /pg_db_role_setting/);
  assert.match(runner, /\.setrole\s*=\s*0/);
  assert.match(runner, /migration_ledger_not_contiguous_prefix/);
  assert.match(runner, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(migration, /environment text NOT NULL/);
  assert.match(correctiveMigration, /founder_mfa_enrollment_authorizations/);
  assert.match(correctiveMigration, /founder_mfa_recovery_operations/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /COMMIT/);
});

test("roles and defaults are closed around a dedicated NOLOGIN owner", () => {
  assert.match(roles, /pkc_mfa_owner NOLOGIN/);
  for (const role of ["pkc_mfa_migrator", "pkc_mfa_runtime", "pkc_mfa_verifier", "pkc_mfa_outbox_worker", "pkc_onboarding_runtime", "pkc_onboarding_email_worker", "pkc_onboarding_email_reconciler"]) {
    assert.match(roles, new RegExp(`${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`));
  }
  assert.match(roles, /GRANT pkc_mfa_owner TO pkc_mfa_migrator/);
  assert.match(roles, /1 \/ \(pg_catalog\.current_database\(\) = :'expected_database'\)::integer/);
  assert.match(roles, /\\set ON_ERROR_STOP on/);
  assert.match(roles, /expected_empty_cluster/);
  assert.doesNotMatch(roles, /GRANT pkc_mfa_owner TO pkc_mfa_runtime/);
  assert.match(roles, /REVOKE (?:CONNECT, TEMPORARY|ALL)[^;]*FROM PUBLIC/);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE pkc_mfa_owner/);
  assert.match(migration, /REVOKE ALL ON FUNCTIONS FROM PUBLIC/);
});

test("schema enforces UUID subject and relational same-factor ownership", () => {
  assert.match(migration, /founder_subject uuid NOT NULL UNIQUE/);
  assert.match(migration, /FOREIGN KEY \(factor_id, challenge_id\)/);
  assert.match(migration, /FOREIGN KEY \(factor_id, finalize_id\)/);
  assert.match(migration, /CHECK \(octet_length\(claims::text\) <=/);
  assert.match(migration, /CHECK \(octet_length\(payload::text\) <=/);
  assert.match(migration, /prevent_audit_mutation/);
});

test("worker functions are hardened, schema-qualified, fenced, bounded and PUBLIC-closed", () => {
  for (const name of ["claim_founder_mfa_outbox", "complete_founder_mfa_outbox", "mark_founder_mfa_outbox_unknown", "reconcile_founder_mfa_outbox"]) {
    assert.match(migration, new RegExp(`FUNCTION pkc_auth\\.${name}`));
  }
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pkc_auth/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /lease_fence = .*lease_fence \+ 1/);
  assert.match(migration, /IS DISTINCT FROM/);
  assert.match(migration, /attempts\s*<\s*(?:o\.)?max_attempts/);
  assert.match(migration, /reconciliation_attempts\+1>=o\.max_attempts/);
  assert.match(migration, /terminal_rejected/);
  assert.match(migration, /defer_founder_mfa_outbox_reconciliation/);
  assert.match(migration, /claim_founder_mfa_outbox_reconciliation/);
  assert.match(migration, /reconciliation_lease_owner/);
  assert.match(migration, /reconciliation_lease_fence/);
  assert.match(migration, /lease_expires_at>pg_catalog\.clock_timestamp\(\)/);
  assert.match(migration, /reconciliation_lease_expires_at>pg_catalog\.clock_timestamp\(\)/);
  assert.doesNotMatch(migration, /state IN \('pending','unknown'\).*next_attempt_at/s);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION pkc_auth\.claim_founder_mfa_outbox[^;]+ TO pkc_mfa_outbox_worker/);
  assert.doesNotMatch(migration, /\bEXECUTE\s+(?:format|immediate)\b/i);
});

test("readiness attests exact database, version, roles, owners, ACLs, functions and TLS posture", () => {
  for (const marker of ["expectedDatabase", "expectedUser", "server_version_num", "migration_ledger", "pg_authid", "proacl", "prosecdef", "proconfig", "relacl", "nspacl", "default_acl", "constraints"]) {
    assert.match(readiness, new RegExp(marker));
  }
  assert.match(readiness, /serverVersion >= 160000 && serverVersion < 170000/);
});

test("native PostgreSQL harness uses the reviewed immutable image reference", () => {
  assert.match(nativeHarness, /postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea/);
  assert.doesNotMatch(nativeHarness, /docker (?:run|image inspect)[^\n]*postgres:16-alpine(?:\s|$)/);
});
