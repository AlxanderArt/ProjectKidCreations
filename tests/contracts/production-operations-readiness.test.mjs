import assert from "node:assert/strict";
import test from "node:test";

import { scanMigrationTransactionControl, validateMigrationLedger } from "../../db/migrate.mjs";
import { validateAlertDeliveryConfig, createAlertDelivery } from "../../server/ops/alert-delivery.mjs";
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

test("alert delivery is disabled by default and configured delivery is secret-safe idempotent and acknowledged", async () => {
  assert.deepEqual(validateAlertDeliveryConfig({}), { enabled: false });
  assert.throws(() => validateAlertDeliveryConfig(Object.fromEntries([["enabled", false], ["token", "forbidden"]])), /invalid_alert_delivery/);
  for (const endpoint of ["http://alerts.invalid/hook", "https://localhost/hook", "https://alerts.invalid/docker.sock", "https://root@alerts.invalid/hook"])
    assert.throws(() => validateAlertDeliveryConfig({ enabled: true, endpoint, credentialName: "pkc-alert-writer" }), /invalid_alert_delivery/);
  const calls = [];
  const authority = { transportId: "pinned-https-v1", credentialBrokerId: "broker-v1" };
  const transportContract = { pinsResolvedAddresses: true, disablesRedirects: true, supportsAbortSignal: true };
  for (const endpoint of ["https://[::1]/hook", "https://[fc00::1]/hook", "https://[2001:db8::1]/hook"])
    assert.throws(() => validateAlertDeliveryConfig({ enabled: true, endpoint, credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 1, ...authority }), /invalid_alert_delivery/);
  const deliver = createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/v1/pkc", credentialName: "pkc-alert-writer", timeoutMs: 1000, maxAttempts: 2, ...authority }, {
    resolve: async () => ["8.8.8.8"],
    transport: async (message, options) => { assert.ok(options.signal instanceof AbortSignal); calls.push(message); return { status: "acknowledged", deliveryId: message.idempotencyKey }; },
    ...authority, ...transportContract,
  });
  const alert = { schemaVersion: 1, evaluatedAt: AT, externalSend: false, alerts: [{ code: "READINESS_DRIFT", severity: "critical", at: AT, metadata: {} }] };
  const first = await deliver(alert); const second = await deliver(alert);
  assert.equal(first.status, "acknowledged");
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.match(first.deliveryId, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(calls).includes("pkc-alert-writer"), false);

  const concurrentCalls = [];
  const concurrent = createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/v1/concurrent", credentialName: "pkc-alert-writer", timeoutMs: 1000, maxAttempts: 2, ...authority }, {
    resolve: async () => ["8.8.8.8"], ...authority, ...transportContract,
    transport: async (message) => { concurrentCalls.push(message); await new Promise((resolve) => setTimeout(resolve, 10)); return { status: "acknowledged", deliveryId: message.idempotencyKey }; },
  });
  const receipts = await Promise.all([concurrent(alert), concurrent(alert), concurrent(alert)]);
  assert.equal(concurrentCalls.length, 1);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.deepEqual(receipts[1], receipts[2]);
  assert.equal(Object.isFrozen(calls[0].payload.alerts[0].metadata), true);

  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::2", "fc00::1", "2001:db8::1", "2001:0db8::1", "3fff::1"])
    await assert.rejects(createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/h", credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 1, ...authority }, { resolve: async () => [address], transport: async () => { throw new Error("must_not_send"); }, ...authority, ...transportContract })(alert), /alert_delivery_ssrf/);

  let sends = 0;
  const ambiguous = createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/h", credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 3, ...authority }, { resolve: async () => ["8.8.8.8"], transport: async (_m, { signal }) => { sends += 1; await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); throw new Error("timeout"); }, ...authority, ...transportContract });
  assert.deepEqual(await ambiguous(alert), { status: "UNKNOWN_REQUIRES_RECONCILIATION", deliveryId: calls[0].idempotencyKey });
  assert.deepEqual(await ambiguous(alert), { status: "UNKNOWN_REQUIRES_RECONCILIATION", deliveryId: calls[0].idempotencyKey });
  assert.equal(sends, 1);

  assert.throws(() => createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/h", credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 1, ...authority }, { resolve: async () => ["8.8.8.8"], transport: async () => ({}), ...authority }), /unconfigured/);
  for (const address of ["100::1", "2001:2::1", "2001:10::1", "64:ff9b:1::1"])
    await assert.rejects(createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/h", credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 1, ...authority }, { resolve: async () => [address], transport: async () => { throw new Error("must_not_send"); }, ...authority, ...transportContract })(alert), /alert_delivery_ssrf/);
  let getterCalls = 0;
  let hostileSends = 0;
  const hostileAck = createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/hostile", credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 1, ...authority }, { resolve: async () => ["8.8.8.8"], transport: async () => { hostileSends += 1; return Object.defineProperty({ deliveryId: "x" }, "status", { enumerable: true, get() { getterCalls += 1; return "acknowledged"; } }); }, ...authority, ...transportContract });
  const hostileFirst = await hostileAck(alert);
  assert.equal(hostileFirst.status, "UNKNOWN_REQUIRES_RECONCILIATION");
  assert.deepEqual(await hostileAck(alert), hostileFirst);
  assert.equal(hostileSends, 1);
  assert.equal(getterCalls, 0);

  for (const ack of [null, {}, { status: "acknowledged", deliveryId: "mismatched" }, { status: "acknowledged", deliveryId: calls[0].idempotencyKey, extra: true }, { status: "acknowledged", deliveryId: "x".repeat(1024) }]) {
    let malformedSends = 0;
    const malformed = createAlertDelivery({ enabled: true, endpoint: "https://alerts.example.invalid/malformed", credentialName: "pkc-alert-writer", timeoutMs: 100, maxAttempts: 1, ...authority }, { resolve: async () => ["8.8.8.8"], transport: async () => { malformedSends += 1; return ack; }, ...authority, ...transportContract });
    const firstUnknown = await malformed(alert);
    assert.equal(firstUnknown.status, "UNKNOWN_REQUIRES_RECONCILIATION");
    assert.deepEqual(await malformed(alert), firstUnknown);
    assert.equal(malformedSends, 1);
  }
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
