import { parseUtcTimestamp, snapshotJsonData } from "./canonical.mjs";

const PLAN_DIGEST = "7f9b6d6f5c17e80649e42fefd860f476160be6bd1a809511543e4a27814e5454";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SENSITIVE_KEY_PATTERN = /password|secret|token|cookie|authorization|private.?key|seed|otp|recovery.?code|database.?url/i;
const SENSITIVE_VALUE_PATTERN = /(?:^|\s)(?:password|secret|token|authorization|client[_-]?secret|database[_-]?url)\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const RECEIPT_LIMITS = Object.freeze({ maxDepth: 6, maxNodes: 512, maxArrayLength: 64, maxStringLength: 1024, maxAggregateBytes: 16 * 1024 });
export const PROTECTED_WORKFLOW_IDS = ["wfDsutVsW15DHGr3", "nvgxxBPinPmsEmZq", "uuNgivASLQZ08gX7", "GVVnbelFG97UjJDw", "W63ETZfmKVI7UDFW", "jb0I4CqlJuuG6fXs"].sort();

function snapshot(value, label) {
  return snapshotJsonData(value, { label, ...RECEIPT_LIMITS, secretKeyPattern: SENSITIVE_KEY_PATTERN, secretPattern: SENSITIVE_VALUE_PATTERN });
}

function closed(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} has unknown keys: ${unknown.sort().join(", ")}`);
}

function iso(value, label) { parseUtcTimestamp(value, label); }
function boundedString(value, label, max) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${label} must be a nonempty string of at most ${max} characters`);
}
function stateReference(value, label) {
  closed(value, ["stateReceiptId", "stateDigest"], label);
  boundedString(value.stateReceiptId, `${label}.stateReceiptId`, 256);
  if (!HEX64.test(value.stateDigest ?? "")) throw new Error(`${label}.stateDigest must be exact lowercase SHA-256`);
}

export function validateMutationReceipt(raw) {
  const value = snapshot(raw, "mutation receipt");
  closed(value, ["schemaVersion", "planDigest", "candidateSha", "deployedSha", "actor", "occurredAt", "target", "priorState", "newState", "verification", "rollback"], "mutation receipt");
  if (value.schemaVersion !== 1 || value.planDigest !== PLAN_DIGEST) throw new Error("approved plan digest mismatch");
  if (!HEX40.test(value.candidateSha ?? "") || !HEX40.test(value.deployedSha ?? "")) throw new Error("candidate/deployed SHA must be exact 40-character lowercase hex");
  boundedString(value.actor, "actor", 128); iso(value.occurredAt, "occurredAt");
  closed(value.target, ["system", "environment", "providerObjectIds"], "target");
  boundedString(value.target.system, "target.system", 128);
  boundedString(value.target.environment, "target.environment", 128);
  if (!Array.isArray(value.target.providerObjectIds) || value.target.providerObjectIds.length === 0 || value.target.providerObjectIds.length > 64) throw new Error("target.providerObjectIds must contain 1 to 64 entries");
  for (const id of value.target.providerObjectIds) boundedString(id, "target.providerObjectIds entry", 256);
  if (new Set(value.target.providerObjectIds).size !== value.target.providerObjectIds.length) throw new Error("target.providerObjectIds must be unique");
  stateReference(value.priorState, "priorState");
  stateReference(value.newState, "newState");
  closed(value.rollback, ["handle", "procedure"], "rollback");
  boundedString(value.rollback.handle, "rollback.handle", 256);
  boundedString(value.rollback.procedure, "rollback.procedure", 1024);
  if (!Array.isArray(value.verification) || value.verification.length === 0 || value.verification.length > 64) throw new Error("verification must contain 1 to 64 items");
  for (const item of value.verification) {
    closed(item, ["check", "result", "evidenceId"], "verification item");
    boundedString(item.check, "verification.check", 256);
    if (item.result !== "pass") throw new Error("successful mutation receipt requires all verification items to pass");
    boundedString(item.evidenceId, "verification.evidenceId", 256);
  }
  return value;
}

export function validateApprovalReceipt(raw) {
  const value = snapshot(raw, "approval receipt");
  closed(value, ["schemaVersion", "planDigest", "action", "actor", "approvedAt", "workflowIds", "purgePlanDigest", "typedApproval"], "approval receipt");
  if (value.schemaVersion !== 1 || value.planDigest !== PLAN_DIGEST) throw new Error("approved plan digest mismatch");
  if (value.action !== "PURGE_PROTECTED_N8N_HISTORY" || value.typedApproval !== "APPROVE PURGE_PROTECTED_N8N_HISTORY") throw new Error("exact typed approval required");
  boundedString(value.actor, "actor", 128); iso(value.approvedAt, "approvedAt");
  if (!Array.isArray(value.workflowIds) || value.workflowIds.length !== PROTECTED_WORKFLOW_IDS.length || new Set(value.workflowIds).size !== PROTECTED_WORKFLOW_IDS.length || [...value.workflowIds].sort().some((id, index) => id !== PROTECTED_WORKFLOW_IDS[index])) throw new Error("exact protected workflow ID set required");
  if (!HEX64.test(value.purgePlanDigest ?? "")) throw new Error("purge plan digest invalid");
  return value;
}

export { PLAN_DIGEST as APPROVED_PLAN_DIGEST, RECEIPT_LIMITS };
