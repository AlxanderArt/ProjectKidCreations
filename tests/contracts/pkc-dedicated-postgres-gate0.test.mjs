import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
const roles = read("db/roles/000_roles.sql");
const repairRoles = read("db/roles/004_onboarding_roles.sql");
const migration = read("db/migrations/003_onboarding_email_outbox.sql");
const migrate = read("db/migrate.mjs");
const readiness = read("db/readiness.mjs");
const workflows = read("scripts/n8n-onboarding-email-outbox.mjs");
const rollout = read("docs/operations/onboarding-email-outbox-rollout.md");
const sealing = read("docs/operations/migration-role-sealing.md");
const nativeHarness = read("scripts/test-founder-mfa-postgres.sh");

const functionBlock = (name) => migration.match(new RegExp(`CREATE FUNCTION pkc_auth\\.${name}\\([^]*?END \\$\\$;`, "i"))?.[0] || "";

test("fresh-cluster bootstrap is explicit and the idempotent repair authority provisions three isolated onboarding logins", () => {
  assert.match(roles, /expected_empty_cluster/);
  assert.match(roles, /pkc_onboarding_email_reconciler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/);
  for (const role of ["pkc_onboarding_runtime", "pkc_onboarding_email_worker", "pkc_onboarding_email_reconciler"]) {
    assert.match(repairRoles, new RegExp(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`));
    assert.match(repairRoles, new RegExp(`ALTER ROLE ${role} IN DATABASE :"expected_database" RESET ALL`));
  }
  assert.doesNotMatch(repairRoles, /CREATE ROLE pkc_mfa_migrator|GRANT pkc_mfa_owner/);
  assert.match(repairRoles, /GRANT EXECUTE ON FUNCTION pg_catalog\.pg_control_system\(\) TO pkc_mfa_migrator, pkc_mfa_verifier/);
  assert.match(read("db/roles/020_seal_bootstrap.sql"), /ALTER ROLE pkc_bootstrap_admin NOLOGIN/);
  assert.match(sealing, /fresh dedicated cluster[^]*000_roles\.sql[^]*exactly once/i);
  assert.match(sealing, /idempotent[^]*004_onboarding_roles\.sql[^]*idempotent[^]*006_backup_reader\.sql/i);
  assert.match(sealing, /001_founder_mfa\.sql[^]*002_founder_mfa_production_authority\.sql[^]*003_onboarding_email_outbox\.sql[^]*004_backup_read_authority\.sql[^]*010_seal_migrator\.sql/is);
});

test("dispatcher and reconciliation database authority are disjoint", () => {
  for (const name of ["claim_onboarding_email_outbox_reconciliation", "reconcile_onboarding_email_accepted", "defer_onboarding_email_reconciliation"])
    assert.match(functionBlock(name), /SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_reconciler'/);
  for (const name of ["claim_onboarding_email_outbox", "arm_onboarding_email_outbox", "accept_onboarding_email_outbox", "mark_onboarding_email_ambiguous"])
    assert.match(functionBlock(name), /SESSION_USER IS DISTINCT FROM 'pkc_onboarding_email_worker'/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION pkc_auth\.claim_onboarding_email_outbox_reconciliation[^;]+TO pkc_onboarding_email_reconciler/i);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION pkc_auth\.claim_onboarding_email_outbox_reconciliation[^;]+TO pkc_onboarding_email_worker/i);
  assert.match(readiness, /pkc_onboarding_email_reconciler/);
});

test("expired pre-arm claims return to pending while armed or transmitting uncertainty becomes ambiguous", () => {
  const claim = functionBlock("claim_onboarding_email_outbox");
  assert.match(claim, /state='pending'[^;]*request_sha256 IS NULL/i);
  assert.match(claim, /state='ambiguous'[^;]*request_sha256 IS NOT NULL/i);
  assert.match(claim, /lease_owner=NULL[^]*lease_expires_at=NULL/i);
  assert.match(rollout, /expired unarmed[^]*pending/i);
  assert.match(rollout, /armed[^]*ambiguous[^]*never[^]*resend/i);
});

test("n8n dispatcher and reconciler reference separate PostgreSQL credentials", () => {
  assert.match(workflows, /PKC Onboarding Email Dispatcher/);
  assert.match(workflows, /PKC Onboarding Email Reconciler/);
  assert.match(workflows, /buildOnboardingEmailDispatcherWorkflow[^]*DISPATCHER_CREDENTIAL/);
  assert.match(workflows, /buildOnboardingEmailReconcilerWorkflow[^]*RECONCILER_CREDENTIAL/);
});

test("migration and readiness bind exact cluster and endpoint identity plus durable PostgreSQL 16 settings", () => {
  for (const source of [migrate, readiness]) {
    for (const marker of ["expectedSystemIdentifier", "expectedServerAddress", "expectedServerPort", "pg_control_system", "server_version_num", "full_page_writes", "synchronous_commit", "fsync"])
      assert.match(source, new RegExp(marker));
  }
  assert.match(readiness, /expectedTls\s*=\s*true/);
  assert.match(readiness, /ssl[^]*=== true/);
  assert.match(nativeHarness, /PKC_DATABASE_SYSTEM_IDENTIFIER/);
  assert.match(nativeHarness, /PKC_DATABASE_SERVER_ADDRESS/);
  assert.match(nativeHarness, /PKC_DATABASE_SERVER_PORT/);
});

test("migration and readiness use a descriptor-safe PGPASSFILE loader", async (t) => {
  const { loadPgClientAuthority } = await import("../../db/client-authority.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "pkc-pgpass-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pgpass = path.join(root, "pgpass");
  const ca = path.join(root, "ca.crt");
  const cert = path.join(root, "client.crt");
  const key = path.join(root, "client.key");
  writeFileSync(pgpass, "db.example.invalid:5432:pkc:worker:dummy-test-password\n", { mode: 0o600 });
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nQUJDRA==\n-----END CERTIFICATE-----\n", { mode: 0o600 });
  writeFileSync(cert, "-----BEGIN CERTIFICATE-----\nRUZHSA==\n-----END CERTIFICATE-----\n", { mode: 0o600 });
  writeFileSync(key, `-----BEGIN ${"PRIVATE"} KEY-----\nSUpLTA==\n-----END ${"PRIVATE"} KEY-----\n`, { mode: 0o600 });
  const strictDsn = `postgresql://worker@db.example.invalid:5432/pkc?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}&sslcert=${encodeURIComponent(cert)}&sslkey=${encodeURIComponent(key)}`;
  const authority = await loadPgClientAuthority({
    connectionString: strictDsn,
    pgpassFile: pgpass,
  });
  assert.equal(authority.password, "dummy-test-password");
  assert.equal(authority.ssl.rejectUnauthorized, true);
  assert.equal(authority.ssl.servername, "db.example.invalid");
  assert.match(authority.ssl.ca, /BEGIN CERTIFICATE/);
  assert.doesNotMatch(authority.connectionString, /sslmode|sslrootcert|sslcert|sslkey/);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.ssl), true);
  await assert.rejects(() => loadPgClientAuthority({ connectionString: strictDsn }), /pgpassfile_invalid/);
  await assert.rejects(() => loadPgClientAuthority({
    connectionString: "postgresql://worker@db.example.invalid:5432/pkc?sslmode=disable",
    pgpassFile: pgpass,
  }), /invalid_pg_connection_authority/);
  const link = path.join(root, "pgpass-link");
  symlinkSync(pgpass, link);
  await assert.rejects(() => loadPgClientAuthority({ connectionString: strictDsn, pgpassFile: link }), /pgpassfile_invalid/);
  chmodSync(pgpass, 0o644);
  await assert.rejects(() => loadPgClientAuthority({ connectionString: strictDsn, pgpassFile: pgpass }), /pgpassfile_invalid/);
  assert.match(migrate, /loadPgClientAuthority/);
  assert.match(readiness, /loadPgClientAuthority/);
});
