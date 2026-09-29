import assert from "node:assert/strict";
import test from "node:test";

import { scanMigrationTransactionControl, validateMigrationLedger } from "../../db/migrate.mjs";
import { rolloutReceiptDigest, validateN8nRolloutReceipt, assertN8nActivationPrerequisites, validateN8nActivationReceipt } from "../../server/ops/n8n-rollout.mjs";
import { N8N_ARTIFACT_ROLES, N8N_IMAGE } from "../../scripts/n8n-workflow-as-code.mjs";

const AT = "2026-09-28T00:00:00.000Z";

test("migration scanner rejects only top-level transaction control", () => {
  for (const sql of ["BEGIN; SELECT 1", "START TRANSACTION;", "COMMIT;", "ROLLBACK;", "ABORT;", "SAVEPOINT x;", "RELEASE x;", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;", "PREPARE TRANSACTION 'x';"])
    assert.throws(() => scanMigrationTransactionControl(sql), /top_level_transaction_control/);
  for (const sql of [
    "SELECT 'BEGIN; COMMIT'", "-- ROLLBACK\nSELECT 1", "/* START TRANSACTION */ SELECT 1",
    "DO $body$ BEGIN PERFORM 1; END $body$;", "CREATE FUNCTION x() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;",
  ]) assert.equal(scanMigrationTransactionControl(sql), true);
  for (const sql of ["SELECT 'unterminated", 'SELECT "unterminated', "SELECT $tag$unterminated", "/* unterminated"])
    assert.throws(() => scanMigrationTransactionControl(sql), /unterminated_migration/);
});

test("migration ledger must be the exact contiguous manifest prefix", () => {
  const plan = [
    { version: 1, file: "001_a.sql", sha256: "a".repeat(64) },
    { version: 2, file: "002_b.sql", sha256: "b".repeat(64) },
  ];
  const row = (version) => ({ version, filename: plan[version - 1].file, sha256: plan[version - 1].sha256, environment: "test" });
  assert.equal(validateMigrationLedger([], plan, "test"), undefined);
  assert.equal(validateMigrationLedger([row(1), row(2)], plan, "test"), undefined);
  for (const ledger of [[row(2)], [row(1), row(1)], [row(2), row(1)]])
    assert.throws(() => validateMigrationLedger(ledger, plan, "test"), /not_contiguous_prefix/);
  assert.throws(() => validateMigrationLedger([{ ...row(1), sha256: "c".repeat(64) }], plan, "test"), /checksum_mismatch/);
  assert.throws(() => validateMigrationLedger([{ ...row(1), environment: "preview" }], plan, "test"), /environment_mismatch/);
});


test("immutable n8n receipt binds rollout authority and activation fails before adapter prerequisites", () => {
  const roles = [...N8N_ARTIFACT_ROLES];
  const receipt = {
    schemaVersion: 1, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
    n8nVersion: N8N_IMAGE.version, imageDigest: N8N_IMAGE.repoDigest,
    artifactHashes: Object.fromEntries(roles.map((role, i) => [role, "d".repeat(63) + i.toString(16)])),
    workflows: roles.map((role, i) => ({ role, oldId: `old-workflow-${i + 1}`, oldVersion: 7, newId: `new-workflow-${i + 1}`, newVersion: 1, webhookPath: `pkc-workflow-${i + 1}`, state: "inactive" })),
    credentials: [{ name: "PKC Alerts", type: "httpHeaderAuth" }], approvalId: "approval-rollout-0001",
    trafficClass: "test", backupHandle: "backup-immutable-0001", rollbackHandle: "rollback-workflows-0001",
    adapterPrerequisites: { deliveryWorkflowId: "new-delivery", deliveryVersion: 1, reconciliationWorkflowId: "new-reconcile", reconciliationVersion: 1, contractDigest: "e".repeat(64), ready: false },
  };
  const expected = structuredClone({ ...receipt, roles: receipt.workflows.map(({ role }) => role), importReceiptDigest: rolloutReceiptDigest(receipt) });
  delete expected.schemaVersion;
  assert.deepEqual(validateN8nRolloutReceipt(receipt, expected), receipt);
  assert.throws(() => assertN8nActivationPrerequisites(receipt, "dispatcher", expected), /test_traffic_activation_denied/);
  const ready = { ...receipt, trafficClass: "live", adapterPrerequisites: { ...receipt.adapterPrerequisites, ready: true } };
  const expectedReady = { ...expected, trafficClass: "live", adapterPrerequisites: { ...expected.adapterPrerequisites, ready: true }, importReceiptDigest: rolloutReceiptDigest(ready) };
  assert.equal(assertN8nActivationPrerequisites(ready, "dispatcher", expectedReady), true);
  assert.throws(() => assertN8nActivationPrerequisites(ready, "invented-role", expectedReady), /unknown_activation_role/);
  assert.throws(() => validateN8nRolloutReceipt(Object.fromEntries([...Object.entries(receipt), ["credentialSecret", "forbidden"]]), expected), /unknown_rollout_field|secret/i);
  assert.throws(() => validateN8nRolloutReceipt({ ...receipt, workflows: receipt.workflows.slice(0, 8) }, expected), /invalid_rollout_workflows/);
  assert.throws(() => validateN8nRolloutReceipt({ ...receipt, sourceCommit: "f".repeat(40) }, expected), /rollout_authority_mismatch/);
  assert.throws(() => validateN8nRolloutReceipt({ ...receipt, workflows: receipt.workflows.map((item, index) => index === 8 ? { ...item, newId: receipt.workflows[0].newId } : item) }, expected), /rollout_authority_mismatch|invalid_rollout/);
  assert.throws(() => validateN8nActivationReceipt({ schemaVersion: 1, role: "invented", workflowId: "new-workflow-1", version: 1, webhookPath: "pkc-workflow-1", activatedAt: AT, importReceiptDigest: "f".repeat(64) }, expectedReady), /unknown_activation_role/);
  const immutable = validateN8nRolloutReceipt(receipt, expected);
  assert.notEqual(immutable, receipt);
  assert.equal(Object.isFrozen(immutable), true);
  assert.equal(Object.isFrozen(immutable.workflows), true);
});

test("n8n rollout semantics reject coordinated malformed receipt and authority values", () => {
  const roles = [...N8N_ARTIFACT_ROLES];
  const receipt = {
    schemaVersion: 1, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
    n8nVersion: N8N_IMAGE.version, imageDigest: N8N_IMAGE.repoDigest,
    artifactHashes: Object.fromEntries(roles.map((role, index) => [role, index.toString(16).padStart(64, "0")])),
    workflows: roles.map((role, index) => ({ role, oldId: `old-workflow-${index + 1}`, oldVersion: 7, newId: `new-workflow-${index + 1}`, newVersion: 1, webhookPath: `pkc-workflow-${index + 1}`, state: "inactive" })),
    credentials: [{ name: "PKC Alerts", type: "httpHeaderAuth" }], approvalId: "approval-rollout-0001",
    trafficClass: "live", backupHandle: "backup-immutable-0001", rollbackHandle: "rollback-workflows-0001",
    adapterPrerequisites: { deliveryWorkflowId: "new-delivery", deliveryVersion: 1, reconciliationWorkflowId: "new-reconcile", reconciliationVersion: 1, contractDigest: "e".repeat(64), ready: true },
  };
  const authorityFor = (candidate) => {
    const authority = structuredClone({ ...candidate, roles: candidate.workflows.map(({ role }) => role), importReceiptDigest: rolloutReceiptDigest(candidate) });
    delete authority.schemaVersion;
    return authority;
  };
  assert.deepEqual(validateN8nRolloutReceipt(receipt, authorityFor(receipt)), receipt);

  const coordinatedMutants = [
    { ...receipt, sourceCommit: "g".repeat(40) },
    { ...receipt, sourceTree: "a".repeat(39) },
    { ...receipt, artifactHashes: { ...receipt.artifactHashes, login: "d".repeat(63) } },
    { ...receipt, workflows: receipt.workflows.map((item, index) => index === 8 ? { ...item, oldId: receipt.workflows[0].oldId } : item) },
    { ...receipt, workflows: receipt.workflows.map((item, index) => index === 8 ? { ...item, newId: receipt.workflows[0].newId } : item) },
    { ...receipt, workflows: receipt.workflows.map((item, index) => index === 8 ? { ...item, webhookPath: receipt.workflows[0].webhookPath } : item) },
    { ...receipt, workflows: receipt.workflows.map((item, index) => index === 8 ? { ...item, newId: receipt.workflows[0].oldId } : item) },
    { ...receipt, workflows: receipt.workflows.map((item, index) => index === 0 ? { ...item, state: "active" } : item) },
    { ...receipt, credentials: [{ name: "", type: "httpHeaderAuth" }] },
    { ...receipt, credentials: [{ name: " PKC Alerts", type: "httpHeaderAuth" }] },
    { ...receipt, credentials: [{ name: "PKC Alerts", type: "httpHeaderAuth" }, { name: "PKC Alerts", type: "httpHeaderAuth" }] },
    { ...receipt, approvalId: "bad approval" },
    { ...receipt, trafficClass: "preview" },
    { ...receipt, adapterPrerequisites: { ...receipt.adapterPrerequisites, deliveryWorkflowId: "x" } },
    { ...receipt, adapterPrerequisites: { ...receipt.adapterPrerequisites, deliveryVersion: 0 } },
    { ...receipt, adapterPrerequisites: { ...receipt.adapterPrerequisites, contractDigest: "f".repeat(63) } },
    { ...receipt, n8nVersion: "2.19.6" },
    { ...receipt, imageDigest: `sha256:${"f".repeat(64)}` },
  ];
  for (const mutant of coordinatedMutants) assert.throws(() => validateN8nRolloutReceipt(mutant, authorityFor(mutant)), /invalid_|duplicate|canonical|pinned|separation/i);

  const activation = { schemaVersion: 1, role: "dispatcher", workflowId: receipt.workflows[7].newId, version: 1, webhookPath: receipt.workflows[7].webhookPath, activatedAt: AT, importReceiptDigest: rolloutReceiptDigest(receipt) };
  const expected = authorityFor(receipt);
  assert.deepEqual(validateN8nActivationReceipt(activation, expected), activation);
  for (const mutated of [
    { ...activation, activatedAt: "2026-09-28T00:00:00Z" },
    { ...activation, activatedAt: "2026-99-99T00:00:00.000Z" },
    { ...activation, importReceiptDigest: "f".repeat(64) },
  ]) assert.throws(() => validateN8nActivationReceipt(mutated, expected), /activation|digest|date/i);
  const testReceipt = { ...receipt, trafficClass: "test" };
  assert.throws(() => assertN8nActivationPrerequisites(testReceipt, "dispatcher", authorityFor(testReceipt)), /test_traffic|traffic/i);
  const unready = { ...receipt, adapterPrerequisites: { ...receipt.adapterPrerequisites, ready: false } };
  const unreadyAuthority = authorityFor(unready);
  for (const role of roles) {
    assert.throws(() => assertN8nActivationPrerequisites(unready, role, unreadyAuthority), /adapter_prerequisite_not_ready/);
    const workflow = unready.workflows.find((entry) => entry.role === role);
    assert.throws(() => validateN8nActivationReceipt({
      schemaVersion: 1, role, workflowId: workflow.newId, version: workflow.newVersion,
      webhookPath: workflow.webhookPath, activatedAt: AT, importReceiptDigest: unreadyAuthority.importReceiptDigest,
    }, unreadyAuthority), /adapter_prerequisite_not_ready/);
  }
  const emptyCredentials = { ...receipt, credentials: [] };
  assert.throws(() => validateN8nRolloutReceipt(emptyCredentials, authorityFor(emptyCredentials)), /invalid_rollout_credentials/);
});
