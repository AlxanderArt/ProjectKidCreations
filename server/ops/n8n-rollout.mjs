import { createHash } from "node:crypto";

import { N8N_ARTIFACT_ROLES, N8N_IMAGE } from "../../scripts/n8n-workflow-as-code.mjs";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{3,255}$/;
const ROOT = ["schemaVersion", "sourceCommit", "sourceTree", "n8nVersion", "imageDigest", "artifactHashes", "workflows", "credentials", "approvalId", "trafficClass", "backupHandle", "rollbackHandle", "adapterPrerequisites"];
const AUTHORITY_ROOT = ["sourceCommit", "sourceTree", "n8nVersion", "imageDigest", "roles", "artifactHashes", "workflows", "credentials", "approvalId", "trafficClass", "backupHandle", "rollbackHandle", "adapterPrerequisites", "importReceiptDigest"];
const WORKFLOW_FIELDS = ["role", "oldId", "oldVersion", "newId", "newVersion", "webhookPath", "state"];
const ADAPTER_FIELDS = ["deliveryWorkflowId", "deliveryVersion", "reconciliationWorkflowId", "reconciliationVersion", "contractDigest", "ready"];

function closed(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...allowed].sort())) throw new Error(code);
}
function id(value, code) { if (!ID.test(value || "")) throw new Error(code); }
function immutableSnapshot(value) {
  const copy = structuredClone(value);
  const freeze = (entry) => { if (entry && typeof entry === "object" && !Object.isFrozen(entry)) { for (const child of Object.values(entry)) freeze(child); Object.freeze(entry); } return entry; };
  return freeze(copy);
}
function exact(actual, expected, code) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(code); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function rolloutReceiptDigest(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function validateRoles(roles) {
  exact(roles, N8N_ARTIFACT_ROLES, "invalid_canonical_rollout_roles");
}

function validateArtifactHashes(value, roles) {
  closed(value, roles, "invalid_artifact_hashes");
  exact(Object.keys(value), roles, "invalid_artifact_hash_order");
  if (Object.values(value).some((hash) => !HEX64.test(hash))) throw new Error("invalid_artifact_hashes");
}

function validateWorkflows(workflows, roles) {
  if (!Array.isArray(workflows) || workflows.length !== roles.length) throw new Error("invalid_rollout_workflows");
  const oldIds = new Set();
  const newIds = new Set();
  const paths = new Set();
  for (let index = 0; index < workflows.length; index += 1) {
    const item = workflows[index];
    closed(item, WORKFLOW_FIELDS, "invalid_rollout_workflow");
    if (item.role !== roles[index] || item.state !== "inactive") throw new Error("invalid_rollout_workflows");
    for (const field of ["role", "oldId", "newId", "webhookPath"]) id(item[field], "invalid_rollout_workflow");
    if (![item.oldVersion, item.newVersion].every((entry) => Number.isSafeInteger(entry) && entry >= 1)) throw new Error("invalid_rollout_workflow");
    if (item.oldId === item.newId || oldIds.has(item.oldId) || newIds.has(item.newId) || paths.has(item.webhookPath)) throw new Error("invalid_rollout_workflow_duplicate_or_separation");
    oldIds.add(item.oldId);
    newIds.add(item.newId);
    paths.add(item.webhookPath);
  }
  for (const workflowId of oldIds) if (newIds.has(workflowId)) throw new Error("invalid_rollout_workflow_old_new_separation");
}

function validateCredentials(credentials) {
  if (!Array.isArray(credentials) || credentials.length < 1 || credentials.length > 32) throw new Error("invalid_rollout_credentials");
  const names = new Set();
  const metadata = new Set();
  for (const item of credentials) {
    closed(item, ["name", "type"], "invalid_rollout_credentials");
    if (typeof item.name !== "string" || !item.name || item.name.trim() !== item.name || !ID.test(item.type || "")) throw new Error("invalid_rollout_credentials");
    const key = `${item.name}\u0000${item.type}`;
    if (names.has(item.name) || metadata.has(key)) throw new Error("invalid_rollout_credentials_duplicate");
    names.add(item.name);
    metadata.add(key);
  }
}

function validateAdapter(adapter) {
  closed(adapter, ADAPTER_FIELDS, "invalid_adapter_prerequisites");
  id(adapter.deliveryWorkflowId, "invalid_adapter_prerequisites");
  id(adapter.reconciliationWorkflowId, "invalid_adapter_prerequisites");
  if (adapter.deliveryWorkflowId === adapter.reconciliationWorkflowId
      || ![adapter.deliveryVersion, adapter.reconciliationVersion].every((entry) => Number.isSafeInteger(entry) && entry >= 1)
      || !HEX64.test(adapter.contractDigest || "") || typeof adapter.ready !== "boolean") throw new Error("invalid_adapter_prerequisites");
}

function validateSemanticAuthority(value, { authority = false } = {}) {
  closed(value, authority ? AUTHORITY_ROOT : ROOT, authority ? "invalid_expected_rollout_authority" : "unknown_rollout_field");
  if ((!authority && value.schemaVersion !== 1) || !HEX40.test(value.sourceCommit || "") || !HEX40.test(value.sourceTree || "")) throw new Error("invalid_rollout_source");
  if (value.n8nVersion !== N8N_IMAGE.version || value.imageDigest !== N8N_IMAGE.repoDigest) throw new Error("invalid_pinned_rollout_runtime");
  const roles = authority ? value.roles : N8N_ARTIFACT_ROLES;
  validateRoles(roles);
  validateArtifactHashes(value.artifactHashes, roles);
  validateWorkflows(value.workflows, roles);
  validateCredentials(value.credentials);
  for (const field of ["approvalId", "backupHandle", "rollbackHandle"]) id(value[field], `invalid_${field}`);
  if (!new Set(["test", "live"]).has(value.trafficClass)) throw new Error("invalid_traffic_class");
  validateAdapter(value.adapterPrerequisites);
  if (authority && !HEX64.test(value.importReceiptDigest || "")) throw new Error("invalid_import_receipt_digest");
  return roles;
}

function validatedAuthority(expectedAuthority) {
  if (!expectedAuthority || typeof expectedAuthority !== "object" || Array.isArray(expectedAuthority)) throw new Error("missing_expected_rollout_authority");
  validateSemanticAuthority(expectedAuthority, { authority: true });
  return expectedAuthority;
}

export function validateN8nRolloutReceipt(value, expectedAuthority) {
  validateSemanticAuthority(value);
  const expected = validatedAuthority(expectedAuthority);
  for (const field of ["sourceCommit", "sourceTree", "n8nVersion", "imageDigest", "artifactHashes", "workflows", "credentials", "approvalId", "trafficClass", "backupHandle", "rollbackHandle", "adapterPrerequisites"]) {
    exact(value[field], expected[field], `rollout_authority_mismatch:${field}`);
  }
  if (rolloutReceiptDigest(value) !== expected.importReceiptDigest) throw new Error("rollout_authority_mismatch:importReceiptDigest");
  return immutableSnapshot(value);
}

function canonicalIsoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function validateN8nActivationReceipt(value, expectedAuthority) {
  closed(value, ["schemaVersion", "role", "workflowId", "version", "webhookPath", "activatedAt", "importReceiptDigest"], "invalid_activation_receipt");
  const expectedAuthorityValue = validatedAuthority(expectedAuthority);
  if (expectedAuthorityValue.trafficClass !== "live") throw new Error("test_traffic_activation_denied");
  if (value.schemaVersion !== 1 || !N8N_ARTIFACT_ROLES.includes(value.role)) throw new Error("unknown_activation_role");
  const expected = expectedAuthorityValue.workflows.find((entry) => entry.role === value.role);
  if (!expected || value.workflowId !== expected.newId || value.version !== expected.newVersion || value.webhookPath !== expected.webhookPath) throw new Error("activation_authority_mismatch");
  if (!canonicalIsoInstant(value.activatedAt)) throw new Error("invalid_activation_date");
  if (!HEX64.test(value.importReceiptDigest || "") || value.importReceiptDigest !== expectedAuthorityValue.importReceiptDigest) throw new Error("activation_import_receipt_digest_mismatch");
  if (expectedAuthorityValue.adapterPrerequisites.ready !== true) throw new Error("adapter_prerequisite_not_ready");
  return immutableSnapshot(value);
}

export function assertN8nActivationPrerequisites(raw, role, expectedAuthority) {
  const receipt = validateN8nRolloutReceipt(raw, expectedAuthority);
  if (!N8N_ARTIFACT_ROLES.includes(role)) throw new Error("unknown_activation_role");
  if (receipt.trafficClass !== "live" || expectedAuthority.trafficClass !== "live") throw new Error("test_traffic_activation_denied");
  if (receipt.adapterPrerequisites.ready !== true || expectedAuthority.adapterPrerequisites.ready !== true) throw new Error("adapter_prerequisite_not_ready");
  return true;
}
