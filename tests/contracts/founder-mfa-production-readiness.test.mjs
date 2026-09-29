import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseFounderMfaMode, requireFounderMfaAction } from "../../server/mfa/mode.mjs";
import { enrollmentAuthorizationMatches, enrollmentAuthorityFromConfig } from "../../server/mfa/enrollment-authorization.mjs";
import { createFounderMfaService } from "../../server/mfa/service.mjs";
import { createFounderMfaStore } from "../../server/mfa/store.mjs";
import { pgBigint } from "../../server/mfa/pg-bigint.mjs";

test("PostgreSQL bigint authority preserves exact canonical decimal strings", () => {
  for (const value of ["0", "9007199254740992", "9007199254740993", "9223372036854775807"])
    assert.equal(pgBigint(value), value);
  for (const value of [0, 1, -1, "-1", "01", "+1", " 1", "1 ", "9223372036854775808", "1.0", ""])
    assert.throws(() => pgBigint(value), /invalid_pg_bigint/);
});

test("founder MFA mode is a closed production authority and customer traffic is never intercepted", () => {
  for (const mode of ["disabled", "armed", "enforced"]) {
    assert.equal(parseFounderMfaMode({ PKC_FOUNDER_MFA_MODE: mode, NODE_ENV: "production" }), mode);
    assert.equal(requireFounderMfaAction(mode, "customer"), false);
  }
  assert.throws(() => parseFounderMfaMode({ NODE_ENV: "production" }), /founder_mfa_mode_not_configured/);
  assert.throws(() => parseFounderMfaMode({ PKC_FOUNDER_MFA_MODE: "ENFORCED", NODE_ENV: "production" }), /invalid_founder_mfa_mode/);
  for (const mode of ["disabled", "armed"]) {
    for (const action of ["challenge", "disclose", "verify", "finalize", "recovery", "sensitive"]) {
      assert.throws(() => requireFounderMfaAction(mode, action), /founder_mfa_mode_denied/);
    }
  }
  assert.equal(requireFounderMfaAction("armed", "synthetic-denial"), true);
  assert.equal(requireFounderMfaAction("enforced", "challenge"), true);
});

test("enrollment authorization binds exact immutable authority and current factor state", () => {
  const expected = {
    founderSubject: "11111111-1111-4111-8111-111111111111",
    sourceCommit: "a".repeat(40), deploymentId: "dpl_immutable_1",
    workflowDigest: "b".repeat(64), approvalId: "approval-2026-09-28-0001",
    factorState: "unenrolled", authEpoch: "0",
  };
  const row = {
    founder_subject: expected.founderSubject, source_commit: expected.sourceCommit,
    deployment_id: expected.deploymentId, workflow_digest: expected.workflowDigest,
    approval_id: expected.approvalId, expected_factor_state: expected.factorState,
    expected_auth_epoch: "0", issued_at: "2026-09-28T00:00:00.000Z",
    expires_at: "2026-09-28T00:10:00.000Z", consumed_at: null,
  };
  assert.equal(enrollmentAuthorizationMatches(row, expected, new Date("2026-09-28T00:05:00.000Z")), true);
  assert.throws(
    () => enrollmentAuthorizationMatches(
      { ...row, expected_auth_epoch: 9007199254740993 },
      { ...expected, authEpoch: "9007199254740992" },
      new Date("2026-09-28T00:05:00.000Z"),
    ),
    /invalid_expected_auth_epoch/,
  );
  assert.throws(
    () => enrollmentAuthorityFromConfig(
      { founderSubject: expected.founderSubject, deployment: { sourceCommit: expected.sourceCommit, deploymentId: expected.deploymentId, workflowDigest: expected.workflowDigest, enrollmentApprovalId: expected.approvalId } },
      { state: "unenrolled", auth_epoch: 9007199254740993 },
    ),
    /invalid_auth_epoch/,
  );
  for (const patch of [
    { founder_subject: "22222222-2222-4222-8222-222222222222" },
    { source_commit: "c".repeat(40) }, { deployment_id: "dpl_other" },
    { workflow_digest: "d".repeat(64) }, { approval_id: "approval-other" },
    { expected_factor_state: "pending" }, { expected_auth_epoch: "1" },
    { expires_at: "2026-09-28T00:04:59.999Z" }, { consumed_at: "2026-09-28T00:04:00.000Z" },
  ]) assert.equal(enrollmentAuthorizationMatches({ ...row, ...patch }, expected, new Date("2026-09-28T00:05:00.000Z")), false);
});

test("store rejects a numeric PostgreSQL bigint driver value before authority projection", async () => {
  const store = createFounderMfaStore({
    pool: {
      connect: async () => { throw new Error("must_not_connect"); },
      query: async () => ({ rows: [{
        founder_subject: "11111111-1111-4111-8111-111111111111",
        state: "active",
        auth_epoch: 9007199254740993,
        revoked_before: null,
      }] }),
    },
  });
  await assert.rejects(
    store.readFactorAuthority("11111111-1111-4111-8111-111111111111"),
    /invalid_auth_epoch/,
  );
  for (const relative of ["server/mfa/store.mjs", "server/mfa/enrollment-authorization.mjs", "server/mfa/service.mjs"])
    assert.doesNotMatch(readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"), /pgBigint\(String\(/);
});

test("no-code recovery is structurally absent from runtime authority and service methods", () => {
  const migration = readFileSync(new URL("../../db/migrations/002_founder_mfa_production_authority.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*founder_mfa_recovery_operations[^;]*TO\s+pkc_mfa_runtime/is);
  const store = { transaction: async () => { throw new Error("must_not_write"); } };
  const config = {
    mode: "enforced",
    founderSubject: "11111111-1111-4111-8111-111111111111",
    keys: { encryption: Buffer.alloc(32), finalize: Buffer.alloc(32), recovery: Buffer.alloc(32) },
    keyrings: { handoff: new Map(), encryption: new Map([[1, Buffer.alloc(32)]]), finalize: new Map([[1, Buffer.alloc(32)]]), recovery: new Map([[1, Buffer.alloc(32)]]) },
    keyVersions: { encryption: 1, finalize: 1, recovery: 1 },
    deployment: { sourceCommit: "a".repeat(40), workflowDigest: "b".repeat(64) },
  };
  const service = createFounderMfaService({ store, config });
  for (const invented of ["noCodeRecovery", "administrativeRecovery", "dualApprovalRecovery", "recoverWithoutCode"])
    assert.equal(service[invented], undefined);
  const runtimeStore = createFounderMfaStore({ pool: { connect: async () => { throw new Error("must_not_connect"); } } });
  assert.equal(runtimeStore.readRecoveryOperation, undefined);
});
