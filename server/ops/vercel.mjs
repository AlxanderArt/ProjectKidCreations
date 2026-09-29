import { canonicalJson, sha256, snapshotJsonData } from "./canonical.mjs";

const REQUIRED = [
  "PKC_DATABASE_URL", "PKC_DATABASE_NAME", "PKC_DATABASE_USER", "PKC_DATABASE_ENVIRONMENT", "PKC_FOUNDER_SUBJECT", "PKC_TOTP_ENCRYPTION_KEYRING", "PKC_TOTP_ENCRYPTION_KEY_VERSION",
  "PKC_MFA_HANDOFF_KEYRING", "PKC_MFA_HANDOFF_KEY_VERSION", "PKC_MFA_FINALIZE_KEYRING", "PKC_MFA_FINALIZE_KEY_VERSION",
  "PKC_MFA_RECOVERY_PEPPER_KEYRING", "PKC_MFA_RECOVERY_PEPPER_VERSION", "PKC_AUTH_KEY", "PKC_N8N_BASE_URL",
  "PKC_N8N_ALLOWED_ORIGINS", "PKC_PUBLIC_ALLOWED_ORIGINS", "PKC_FOUNDER_MFA_MODE",
];
const ENFORCED_REQUIRED = ["PKC_SOURCE_COMMIT", "PKC_MFA_WORKFLOW_DIGEST"];
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FUNCTION_PATH = /^api\/(?:[A-Za-z0-9._[\]-]+\/)*[A-Za-z0-9._[\]-]+\.js$/;
export const VERCEL_RELEASE_FUNCTION_CEILING = 10;

function closed(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} has unknown keys: ${unknown.sort().join(", ")}`);
}

function canonicalInventory(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > VERCEL_RELEASE_FUNCTION_CEILING) throw new Error(`${label} must be a nonempty inventory within the exact release ceiling`);
  for (const path of value) if (typeof path !== "string" || !FUNCTION_PATH.test(path) || path.split("/").some((segment) => segment === "..")) throw new Error(`${label} contains an invalid function path`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate function paths`);
  return [...value].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function deriveFunctionInventory(manifestFiles) {
  if (!Array.isArray(manifestFiles)) throw new Error("candidate manifest files must be an array");
  const functions = [];
  for (const file of manifestFiles) {
    const path = file?.path;
    if (path === "api" || (typeof path === "string" && path.startsWith("api/"))) {
      if (typeof path !== "string" || !FUNCTION_PATH.test(path) || path.split("/").some((segment) => segment === "..")) throw new Error("candidate manifest contains an invalid function path under the closed function-path policy");
      functions.push(path);
    }
  }
  return canonicalInventory(functions, "candidate manifest function inventory");
}

function verifyCandidate(candidate) {
  closed(candidate, ["schemaVersion", "commitSha", "treeSha", "manifestDirty", "manifestStatusDigest", "manifestSerialization", "manifestFingerprint", "manifestFiles", "functionInventory", "functionInventoryDigest", "evidenceDigest"], "candidate evidence");
  if (candidate.schemaVersion !== 1 || !HEX40.test(candidate.commitSha ?? "") || !HEX40.test(candidate.treeSha ?? "") || typeof candidate.manifestDirty !== "boolean" || typeof candidate.manifestSerialization !== "string" || candidate.manifestSerialization.length > 512 || !HEX64.test(candidate.manifestStatusDigest ?? "") || !HEX64.test(candidate.manifestFingerprint ?? "") || !HEX64.test(candidate.functionInventoryDigest ?? "") || !HEX64.test(candidate.evidenceDigest ?? "")) throw new Error("candidate evidence identity is invalid");
  const body = { schemaVersion: candidate.schemaVersion, commitSha: candidate.commitSha, treeSha: candidate.treeSha, manifestDirty: candidate.manifestDirty, manifestStatusDigest: candidate.manifestStatusDigest, manifestSerialization: candidate.manifestSerialization, manifestFingerprint: candidate.manifestFingerprint, manifestFiles: candidate.manifestFiles, functionInventory: candidate.functionInventory, functionInventoryDigest: candidate.functionInventoryDigest };
  if (sha256(canonicalJson(body)) !== candidate.evidenceDigest) throw new Error("candidate evidence digest mismatch");
  const inventory = canonicalInventory(candidate.functionInventory, "candidate function inventory");
  if (canonicalJson(candidate.functionInventory) !== canonicalJson(inventory) || sha256(canonicalJson(candidate.functionInventory)) !== candidate.functionInventoryDigest) throw new Error("candidate function inventory digest or canonical order mismatch");
  if (!Array.isArray(candidate.manifestFiles) || candidate.manifestFiles.length === 0 || candidate.manifestFiles.length > 10_000) throw new Error("candidate manifest file evidence must be nonempty and bounded");
  const manifestPaths = new Set();
  for (const file of candidate.manifestFiles) {
    closed(file, ["path", "bytes", "mode", "sha256"], "candidate manifest file");
    if (typeof file.path !== "string" || file.path.length === 0 || file.path.length > 512 || manifestPaths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || !HEX64.test(file.sha256 ?? "")) throw new Error("candidate manifest file evidence is invalid");
    manifestPaths.add(file.path);
  }
  const derivedInventory = deriveFunctionInventory(candidate.manifestFiles);
  if (canonicalJson(inventory) !== canonicalJson(derivedInventory)) throw new Error("candidate function inventory does not exactly equal the exhaustive inventory derived from the frozen manifest");
  const manifestBody = { schemaVersion: 1, serialization: candidate.manifestSerialization, snapshot: { headCommit: candidate.commitSha, headTree: candidate.treeSha, dirty: candidate.manifestDirty, statusDigest: candidate.manifestStatusDigest }, files: candidate.manifestFiles };
  if (sha256(canonicalJson(manifestBody)) !== candidate.manifestFingerprint) throw new Error("candidate manifest fingerprint does not bind the supplied exact files and snapshot");
  return inventory;
}

export function buildVercelCandidateEvidence(rawManifest) {
  const manifest = snapshotJsonData(rawManifest, { label: "candidate manifest", maxDepth: 5, maxNodes: 20_000, maxArrayLength: 10_000, maxStringLength: 1024, maxAggregateBytes: 4 * 1024 * 1024 });
  closed(manifest, ["schemaVersion", "serialization", "snapshot", "files", "fingerprint"], "candidate manifest");
  closed(manifest.snapshot, ["headCommit", "headTree", "dirty", "statusDigest"], "candidate manifest snapshot");
  const functionInventory = deriveFunctionInventory(manifest.files);
  const body = {
    schemaVersion: 1,
    commitSha: manifest.snapshot.headCommit,
    treeSha: manifest.snapshot.headTree,
    manifestDirty: manifest.snapshot.dirty,
    manifestStatusDigest: manifest.snapshot.statusDigest,
    manifestSerialization: manifest.serialization,
    manifestFingerprint: manifest.fingerprint,
    manifestFiles: manifest.files,
    functionInventory,
    functionInventoryDigest: sha256(canonicalJson(functionInventory)),
  };
  const candidate = { ...body, evidenceDigest: sha256(canonicalJson(body)) };
  verifyCandidate(candidate);
  return candidate;
}

export function verifyVercelDeployment(raw) {
  const input = snapshotJsonData(raw, { label: "Vercel deployment evidence", maxDepth: 6, maxNodes: 20_000, maxArrayLength: 10_000, maxStringLength: 1024, maxAggregateBytes: 4 * 1024 * 1024 });
  closed(input, ["phase", "environment", "expectedEnvironment", "founderMfaMode", "expectedFounderMfaMode", "sourceSha", "expectedSourceSha", "sourceTreeSha", "state", "deploymentId", "aliasTarget", "rollbackDeploymentId", "functions", "maxFunctions", "candidate", "variables", "vercelKids", "n8nKids"], "Vercel deployment evidence");
  const inventory = verifyCandidate(input.candidate);
  if (input.candidate.manifestDirty) throw new Error("deployment verification requires a clean committed candidate manifest");
  if (!HEX40.test(input.sourceSha ?? "") || input.sourceSha !== input.expectedSourceSha || input.sourceSha !== input.candidate.commitSha) throw new Error("exact candidate source SHA mismatch");
  if (!HEX40.test(input.sourceTreeSha ?? "") || input.sourceTreeSha !== input.candidate.treeSha) throw new Error("exact candidate source tree mismatch");
  if (!input.environment || input.environment !== input.expectedEnvironment) throw new Error("deployment environment mismatch");
  if (input.state !== "READY") throw new Error("deployment is not Ready");
  if (!["disabled", "armed", "enforced"].includes(input.expectedFounderMfaMode) || input.founderMfaMode !== input.expectedFounderMfaMode) throw new Error("founder MFA mode does not match the exact expected rollout mode");
  if (!input.deploymentId || !["isolated", "promoted"].includes(input.phase)) throw new Error("deployment phase is invalid");
  if (!input.rollbackDeploymentId || input.rollbackDeploymentId === input.deploymentId) throw new Error("rollback pointer missing or invalid");
  const expectedAliasTarget = input.phase === "isolated" ? input.rollbackDeploymentId : input.deploymentId;
  if (input.aliasTarget !== expectedAliasTarget) throw new Error("alias pointer mismatch for deployment phase");
  if (input.maxFunctions !== VERCEL_RELEASE_FUNCTION_CEILING) throw new Error("function ceiling must be the exact configured release contract value 10");
  const deployed = canonicalInventory(input.functions, "deployed function inventory");
  if (canonicalJson(input.functions) !== canonicalJson(deployed) || canonicalJson(deployed) !== canonicalJson(inventory)) throw new Error("deployed function inventory does not exactly match frozen candidate inventory and manifest");
  const variableRows = input.variables ?? [];
  if (!Array.isArray(variableRows) || variableRows.length > 128) throw new Error("variable metadata must be a bounded array");
  const names = new Map();
  for (const row of variableRows) {
    closed(row, ["name", "scopes"], "variable metadata row");
    if (typeof row.name !== "string" || names.has(row.name)) throw new Error("duplicate or invalid variable name rejected");
    names.set(row.name, row.scopes);
  }
  const requiredVariables = input.expectedFounderMfaMode === "enforced" ? [...REQUIRED, ...ENFORCED_REQUIRED] : REQUIRED;
  for (const name of requiredVariables) {
    const scopes = names.get(name);
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== input.environment) throw new Error(`required variable name/scope mismatch: ${name}`);
  }
  for (const purpose of ["handoff", "finalize"]) {
    const kid = input.vercelKids?.[purpose];
    if (!new RegExp(`^${purpose}-v[1-9][0-9]*$`).test(kid ?? "") || kid !== input.n8nKids?.[purpose]) throw new Error(`${purpose} KID agreement failed`);
  }
  return { ok: true, mode: "read-only", phase: input.phase, founderMfaMode: input.founderMfaMode, deploymentId: input.deploymentId, sourceSha: input.sourceSha, candidateTree: input.candidate.treeSha, candidateFingerprint: input.candidate.manifestFingerprint, candidateEvidenceDigest: input.candidate.evidenceDigest, environment: input.environment, functionCount: input.functions.length, functionInventoryDigest: input.candidate.functionInventoryDigest, variableNames: [...names.keys()].sort(), rollbackDeploymentId: input.rollbackDeploymentId };
}
