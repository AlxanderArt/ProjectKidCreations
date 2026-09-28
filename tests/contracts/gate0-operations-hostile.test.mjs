import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson, sha256 } from "../../server/ops/canonical.mjs";
import { evaluateMonitoring } from "../../server/ops/monitoring.mjs";
import { validateApprovalReceipt, validateMutationReceipt } from "../../server/ops/receipts.mjs";
import { evaluateRestoreEvidence } from "../../server/ops/restore.mjs";
import { buildVercelCandidateEvidence, verifyVercelDeployment } from "../../server/ops/vercel.mjs";
import { buildPurgePlan } from "../../server/ops/n8n-retention.mjs";

const AT = "2026-09-28T00:00:00.000Z";
const PLAN_DIGEST = "7f9b6d6f5c17e80649e42fefd860f476160be6bd1a809511543e4a27814e5454";
const SHA = "a".repeat(40);
const PROTECTED = ["wfDsutVsW15DHGr3", "nvgxxBPinPmsEmZq", "uuNgivASLQZ08gX7", "GVVnbelFG97UjJDw", "W63ETZfmKVI7UDFW", "jb0I4CqlJuuG6fXs"];

const VARIABLES = ["PKC_DATABASE_URL", "PKC_FOUNDER_SUBJECT", "PKC_TOTP_ENCRYPTION_KEYRING", "PKC_TOTP_ENCRYPTION_KEY_VERSION", "PKC_MFA_HANDOFF_KEYRING", "PKC_MFA_HANDOFF_KEY_VERSION", "PKC_MFA_FINALIZE_KEYRING", "PKC_MFA_FINALIZE_KEY_VERSION", "PKC_MFA_RECOVERY_PEPPER_KEYRING", "PKC_MFA_RECOVERY_PEPPER_VERSION", "PKC_AUTH_KEY", "PKC_N8N_BASE_URL", "PKC_N8N_ALLOWED_ORIGINS", "PKC_PUBLIC_ALLOWED_ORIGINS", "PKC_FOUNDER_MFA_MODE"];

function vercelInput() {
  const functionInventory = ["api/[...route].js"];
  const manifestBody = { schemaVersion: 1, serialization: "test-canonical-manifest", snapshot: { headCommit: SHA, headTree: "b".repeat(40), dirty: false, statusDigest: "0".repeat(64) }, files: functionInventory.map((path) => ({ path, bytes: 1, mode: 0o644, sha256: "d".repeat(64) })) };
  const candidate = buildVercelCandidateEvidence({ ...manifestBody, fingerprint: sha256(canonicalJson(manifestBody)) });
  return { environment: "Preview", expectedEnvironment: "Preview", sourceSha: SHA, expectedSourceSha: SHA, state: "READY", deploymentId: "dpl_immutable", aliasTarget: "dpl_immutable", expectedAliasTarget: "dpl_immutable", rollbackDeploymentId: "dpl_previous", functions: functionInventory, maxFunctions: 10, candidate, variables: VARIABLES.map((name) => ({ name, scopes: ["Preview"] })), vercelKids: { handoff: "handoff-v3", finalize: "finalize-v3" }, n8nKids: { handoff: "handoff-v3", finalize: "finalize-v3" } };
}

function restoreInput() {
  return { source: { id: "db-source", snapshotId: "snap-immutable-20260928", immutable: true, capturedAt: "2026-09-28T00:00:00Z", snapshotDigest: "a".repeat(64), providerReceiptId: "provider-receipt-1", providerReceiptDigest: "b".repeat(64) }, target: { id: "drill-7f1", disposable: true, isolated: true, labels: { purpose: "restore-drill", production: "false" } }, restoredAt: "2026-09-28T00:04:00Z", observedAt: "2026-09-28T00:40:00Z", completedAt: "2026-09-28T00:44:00Z", verifier: { identity: "independent-operator", evidenceIds: ["catalog-readback-1"] }, migrationLedger: { expectedDigest: "c".repeat(64), observedDigest: "c".repeat(64) }, catalog: { expectedDigest: "d".repeat(64), observedDigest: "d".repeat(64) }, roles: { expectedDigest: "e".repeat(64), observedDigest: "e".repeat(64) }, keyVersions: { expectedDigest: "f".repeat(64), observedDigest: "f".repeat(64) }, residue: { expectedInventoryDigest: "1".repeat(64), observedInventoryDigest: "1".repeat(64), expectedCounts: { databases: 0, files: 0, containers: 0 }, observedCounts: { databases: 0, files: 0, containers: 0 } } };
}

function purgeInput() {
  return { workflowIds: [...PROTECTED], snapshot: { id: "snap-n8n-immutable-20260928", immutable: true }, interval: { from: "2026-09-27T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" }, counts: { executions: 40, binaryObjects: 3, logGenerations: 2 }, at: "2026-09-28T00:00:00.000Z" };
}

test("monitoring rejects malformed and secret-bearing metadata without copying it", () => {
  const canary = "CANARY_SECRET_MONITORING_7c9f";
  assert.throws(() => evaluateMonitoring({
    at: AT,
    readiness: { ok: false },
    metadata: {
      eventId: { token: canary },
      operationKey: [canary, { nested: canary }],
      state: "X".repeat(1_000_000),
      attemptCount: { value: 3, token: canary },
      errorClass: { nested: [canary] },
      observedAt: { value: AT, token: canary },
      extra: canary,
    },
  }), /secret|unknown|plain|bound/i);
});

test("monitoring validates and bounds primitive evidence fields", () => {
  const result = evaluateMonitoring({
    at: AT,
    readiness: { ok: false },
    metadata: {
      eventId: "provider-event-123",
      operationKey: "rotate-founder-key",
      state: "FAILED",
      attemptCount: 3,
      errorClass: "READ_TIMEOUT",
      observedAt: AT,
    },
  });
  assert.deepEqual(Object.keys(result.alerts[0].metadata).sort(), ["attemptCount", "errorClass", "eventIdDigest", "observedAt", "operationKeyDigest", "state"]);
  assert.match(result.alerts[0].metadata.eventIdDigest, /^[0-9a-f]{64}$/);
  assert.match(result.alerts[0].metadata.operationKeyDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.alerts[0].metadata.state, "FAILED");
  assert.equal(result.alerts[0].metadata.attemptCount, 3);
  assert.equal(result.alerts[0].metadata.errorClass, "READ_TIMEOUT");
  assert.equal(result.alerts[0].metadata.observedAt, AT);
  assert.ok(Buffer.byteLength(canonicalJson(result.alerts[0].metadata)) <= 512);

  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, metadata: { state: "bad state", attemptCount: -1, errorClass: "x".repeat(65), observedAt: "tomorrow" } }), /invalid|timestamp|bound/i);
  assert.throws(() => evaluateMonitoring({ at: "2026-02-30T00:00:00.000Z", readiness: { ok: false } }), /timestamp|UTC/i);
});

test("approval receipt requires the exact protected workflow set", () => {
  const approval = { schemaVersion: 1, planDigest: PLAN_DIGEST, action: "PURGE_PROTECTED_N8N_HISTORY", actor: "operator-id", approvedAt: AT, workflowIds: PROTECTED.slice().sort(), purgePlanDigest: "b".repeat(64), typedApproval: "APPROVE PURGE_PROTECTED_N8N_HISTORY" };
  assert.deepEqual(validateApprovalReceipt(approval), approval);
  assert.throws(() => validateApprovalReceipt({ ...approval, workflowIds: ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5", "fake-6"] }), /exact protected workflow|exact workflow/i);
  assert.throws(() => validateApprovalReceipt({ ...approval, approvedAt: "2026-02-30T00:00:00.000Z" }), /timestamp|UTC/i);
});

test("mutation receipt rejects hollow and unbounded nested evidence", () => {
  const receipt = { schemaVersion: 1, planDigest: PLAN_DIGEST, candidateSha: SHA, deployedSha: SHA, actor: "operator-id", occurredAt: AT, target: { system: "vercel", environment: "preview", providerObjectIds: ["dpl_immutable"] }, priorState: { stateReceiptId: "prior", stateDigest: "b".repeat(64) }, newState: { stateReceiptId: "new", stateDigest: "c".repeat(64) }, verification: [{ check: "source-sha", result: "pass", evidenceId: "ev-1" }], rollback: { handle: "dpl_old", procedure: "restore-alias-after-approval" } };
  assert.deepEqual(validateMutationReceipt(receipt), receipt);
  assert.throws(() => validateMutationReceipt({ ...receipt, actor: "" }), /actor/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, actor: "x".repeat(129) }), /actor/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, target: { system: "", environment: "", providerObjectIds: [] }, verification: [{ check: "", result: "maybe", evidenceId: "" }], rollback: { handle: "", procedure: "" } }), /target|system|environment|provider|verification|rollback/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, target: { ...receipt.target, providerObjectIds: ["dpl_immutable", "dpl_immutable"] } }), /unique|provider/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, target: { ...receipt.target, providerObjectIds: ["x".repeat(257)] } }), /provider/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, verification: [{ check: "source-sha", result: "pass", evidenceId: "ev-1", extra: true }] }), /unknown/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, occurredAt: "2026-02-30T00:00:00.000Z" }), /timestamp|UTC/i);
});

test("restore evidence requires immutable-reference syntax and exact safe target labels", () => {
  const base = restoreInput();
  assert.equal(evaluateRestoreEvidence(base).paritySatisfied, true);
  assert.equal(evaluateRestoreEvidence(base).authoritative, false);
  assert.throws(() => evaluateRestoreEvidence({ ...base, source: { ...base.source, immutable: false } }), /immutable/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, source: { ...base.source, snapshotId: "s" } }), /snapshot/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, source: { ...base.source, snapshotId: "snapshot-latest" } }), /snapshot/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, target: { ...base.target, labels: { ...base.target.labels, production: true } } }), /label|production/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, target: { ...base.target, labels: { ...base.target.labels, extra: "unsafe" } } }), /unknown|label/i);
});

test("restore evidence requires exact zero residue integers and strict UTC timestamps", () => {
  const base = restoreInput();
  for (const residue of [{}, { expectedInventoryDigest: "1".repeat(64) }, { ...base.residue, extra: 0 }, { ...base.residue, observedCounts: { databases: -1, files: 0, containers: 0 } }, { ...base.residue, observedCounts: { databases: "0", files: 0, containers: 0 } }]) {
    assert.throws(() => evaluateRestoreEvidence({ ...base, residue }), /residue|unknown|integer/i);
  }
  assert.throws(() => evaluateRestoreEvidence({ ...base, restoredAt: "September 28, 2026" }), /UTC|timestamp/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, source: { ...base.source, capturedAt: "2026-02-30T00:00:00.000Z" }, restoredAt: "2026-03-03T00:00:00.000Z", completedAt: "2026-03-04T00:00:00.000Z" }), /UTC|timestamp/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, unexpected: true }), /unknown/i);
});

test("Vercel verification binds to the frozen candidate function inventory", () => {
  const base = vercelInput();
  assert.equal(verifyVercelDeployment(base).functionCount, 1);
  for (const functions of [[], ["api/extra.js"], [base.functions[0], base.functions[0]], ["api/drift.js"]]) {
    assert.throws(() => verifyVercelDeployment({ ...base, functions }), /function inventory|candidate|manifest/i);
  }
});

test("Vercel verification requires the exact configured function ceiling ten", () => {
  const base = vercelInput();
  for (const maxFunctions of [9, 10.5, "10", 11, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => verifyVercelDeployment({ ...base, maxFunctions }), /function.*ceiling|exact.*10/i);
  }
});

test("purge planning validates closed authority before digesting", () => {
  const base = purgeInput();
  assert.equal(buildPurgePlan(base).receiptDigest.length, 64);
  assert.throws(() => buildPurgePlan({ ...base, extra: true }), /unknown/i);
  assert.throws(() => buildPurgePlan({ ...base, workflowIds: ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5", "fake-6"] }), /exact protected set/i);
  assert.throws(() => buildPurgePlan({ ...base, snapshot: { ...base.snapshot, id: "" } }), /snapshot/i);
  assert.throws(() => buildPurgePlan({ ...base, snapshot: { ...base.snapshot, extra: true } }), /unknown/i);
});

test("purge planning requires strict ordered UTC interval and exact safe counts", () => {
  const base = purgeInput();
  for (const interval of [{ from: base.interval.to, to: base.interval.from }, { from: base.interval.from, to: "2026-09-29T00:00:00.000Z" }, { from: "yesterday", to: base.interval.to }, { ...base.interval, extra: true }]) {
    assert.throws(() => buildPurgePlan({ ...base, interval }), /interval|timestamp|unknown/i);
  }
  for (const counts of [{ executions: "40", binaryObjects: 3, logGenerations: 2 }, { executions: -1, binaryObjects: 3, logGenerations: 2 }, { executions: 40, binaryObjects: 3 }, { executions: 40, binaryObjects: 3, logGenerations: 2, extra: 0 }]) {
    assert.throws(() => buildPurgePlan({ ...base, counts }), /count|integer|unknown/i);
  }
  assert.throws(() => buildPurgePlan({ ...base, at: "2026-09-28 00:00:00" }), /createdAt|UTC|timestamp/i);
  assert.throws(() => buildPurgePlan({ ...base, interval: { from: "2026-02-28T00:00:00.000Z", to: "2026-02-30T00:00:00.000Z" }, at: "2026-03-03T00:00:00.000Z" }), /interval|UTC|timestamp/i);
});

test("preflight documents the exact no-tree-write candidate contract", async () => {
  const text = await readFile(new URL("../../docs/operations/preflight.md", import.meta.url), "utf8");
  assert.match(text, /HEAD commit, HEAD tree, dirty state\/status digest, complete tracked-plus-nonignored-untracked inventory, and fingerprint/i);
  assert.doesNotMatch(text, /index tree/i);
  assert.match(text, /no tree-writing Git operation/i);
});

test("receipt schemas encode the strict runtime bounds", async () => {
  const mutation = JSON.parse(await readFile(new URL("../../schemas/operations/mutation-receipt.schema.json", import.meta.url), "utf8"));
  const approval = JSON.parse(await readFile(new URL("../../schemas/operations/destructive-approval.schema.json", import.meta.url), "utf8"));
  const utcPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
  assert.equal(mutation.properties.occurredAt.pattern, utcPattern);
  assert.equal(approval.properties.approvedAt.pattern, utcPattern);
  assert.equal(mutation.properties.actor.maxLength, 128);
  assert.equal(mutation.properties.target.properties.providerObjectIds.minItems, 1);
  assert.equal(mutation.properties.target.properties.providerObjectIds.maxItems, 64);
  assert.equal(mutation.properties.verification.maxItems, 64);
});
