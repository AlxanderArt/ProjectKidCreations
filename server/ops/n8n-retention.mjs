import { assertClosedKeys, canonicalJson, parseUtcTimestamp, sha256 } from "./canonical.mjs";
import { PROTECTED_WORKFLOW_IDS, validateApprovalReceipt } from "./receipts.mjs";

export { PROTECTED_WORKFLOW_IDS };

function exactIds(ids) {
  if (!Array.isArray(ids)) throw new Error("workflow IDs must be the exact protected set");
  const sorted = [...ids].sort();
  if (canonicalJson(sorted) !== canonicalJson(PROTECTED_WORKFLOW_IDS)) throw new Error("workflow IDs must be the exact protected set");
  return sorted;
}

function utc(value, label) {
  return parseUtcTimestamp(value, label);
}

export function buildRetentionManifest(ids = PROTECTED_WORKFLOW_IDS) {
  return { schemaVersion: 1, mode: "retention-only", workflowIds: exactIds(ids), desired: { saveDataErrorExecution: "none", saveDataSuccessExecution: "none", saveExecutionProgress: false, saveManualExecutions: false, pinData: "absent", staticData: "absent" } };
}

export function scanPrivacyEvidence(value, canaries = []) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  const prohibitedNames = /password|cookie|authorization|recovery.?code|totp|otp|seed|token|finalize.?grant/i;
  const hits = canaries.filter((canary) => canary && text.includes(canary));
  return { ok: hits.length === 0 && !prohibitedNames.test(text), canaryHits: hits.length, prohibitedFieldPattern: prohibitedNames.test(text) };
}

export function buildPurgePlan(input) {
  assertClosedKeys(input, ["workflowIds", "snapshot", "interval", "counts", "at"], "purge plan input");
  const { workflowIds, snapshot, interval, counts, at } = input;
  assertClosedKeys(snapshot, ["id", "immutable"], "snapshot");
  if (typeof snapshot.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(snapshot.id) || snapshot.immutable !== true) throw new Error("nonempty bounded immutable quarantine snapshot ID required");
  assertClosedKeys(interval, ["from", "to"], "interval");
  const from = utc(interval.from, "interval.from");
  const to = utc(interval.to, "interval.to");
  const createdAt = utc(at, "createdAt");
  if (from >= to || to > createdAt) throw new Error("interval must satisfy from < to <= createdAt");
  assertClosedKeys(counts, ["executions", "binaryObjects", "logGenerations"], "counts");
  for (const key of ["executions", "binaryObjects", "logGenerations"]) if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new Error(`counts.${key} must be a nonnegative safe integer`);
  const body = { schemaVersion: 1, mode: "plan-only", createdAt: at, workflowIds: exactIds(workflowIds), snapshot: { id: snapshot.id, immutable: true }, interval, counts, scope: { executionMetadata: true, payloads: true, binaryData: true, logs: true }, postconditions: { executions: 0, binaryObjects: 0, currentRetentionStillHardened: true, privacyCanaryAbsent: true } };
  return { ...body, receiptDigest: sha256(canonicalJson(body)) };
}

export async function applyPurgePlan({ plan, approval, enableDestructive = false, adapter }) {
  if (!enableDestructive) throw new Error("destructive apply disabled; plan-only default");
  let valid;
  try { valid = validateApprovalReceipt(approval); }
  catch (error) { throw new Error(`approval invalid: ${error.message}`); }
  if (valid.planDigest === undefined || valid.purgePlanDigest !== plan.receiptDigest || canonicalJson(valid.workflowIds) !== canonicalJson(plan.workflowIds)) throw new Error("approval does not bind exact purge plan");
  if (!adapter?.gate0Fake) throw new Error("Gate 0 live destructive adapter is deliberately disabled");
  return { applied: false, simulation: true, writes: 0, receiptDigest: plan.receiptDigest };
}
