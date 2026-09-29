import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import { canonicalJson, sha256 } from "../../server/ops/canonical.mjs";
import { buildCandidateManifest, verifyCandidateManifest } from "../../server/ops/candidate.mjs";
import { createKeyFiles, cleanupInterruptedKeyRun, probeHistoricalKeyring, planEncryptionRotation } from "../../server/ops/keys.mjs";
import { evaluateRestoreEvidence } from "../../server/ops/restore.mjs";
import { buildVercelCandidateEvidence, verifyVercelDeployment } from "../../server/ops/vercel.mjs";
import { buildRetentionManifest, buildPurgePlan, applyPurgePlan, scanPrivacyEvidence } from "../../server/ops/n8n-retention.mjs";
import { evaluateMonitoring } from "../../server/ops/monitoring.mjs";
import { validateMutationReceipt, validateApprovalReceipt } from "../../server/ops/receipts.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const PLAN_DIGEST = "7f9b6d6f5c17e80649e42fefd860f476160be6bd1a809511543e4a27814e5454";
const SHA = "a".repeat(40);
const AT = "2026-09-28T00:00:00.000Z";
const PROTECTED = ["wfDsutVsW15DHGr3", "nvgxxBPinPmsEmZq", "uuNgivASLQZ08gX7", "GVVnbelFG97UjJDw", "W63ETZfmKVI7UDFW", "jb0I4CqlJuuG6fXs"];

const localKeyApproval = { executeLocal: true, targetKind: "disposable-local", typedApproval: "APPROVE LOCAL KEY GENERATION" };
function candidateEvidence(functionInventory = ["api/[...route].js"]) {
  const manifestBody = { schemaVersion: 1, serialization: "test-canonical-manifest", snapshot: { headCommit: SHA, headTree: "b".repeat(40), dirty: false, statusDigest: "0".repeat(64) }, files: functionInventory.map((path) => ({ path, bytes: 1, mode: 0o644, sha256: "d".repeat(64) })) };
  return buildVercelCandidateEvidence({ ...manifestBody, fingerprint: sha256(canonicalJson(manifestBody)) });
}
function restoreInput() {
  return { source: { id: "db-source", snapshotId: "snap-immutable-1", immutable: true, capturedAt: "2026-09-28T00:00:00Z", snapshotDigest: "a".repeat(64), providerReceiptId: "provider-receipt-1", providerReceiptDigest: "b".repeat(64) }, target: { id: "drill-7f1", disposable: true, isolated: true, labels: { purpose: "restore-drill", production: "false" } }, restoredAt: "2026-09-28T00:04:00Z", observedAt: "2026-09-28T00:40:00Z", completedAt: "2026-09-28T00:44:00Z", verifier: { identity: "independent-operator", evidenceIds: ["catalog-readback-1"] }, migrationLedger: { expectedDigest: "c".repeat(64), observedDigest: "c".repeat(64) }, catalog: { expectedDigest: "d".repeat(64), observedDigest: "d".repeat(64) }, roles: { expectedDigest: "e".repeat(64), observedDigest: "e".repeat(64) }, keyVersions: { expectedDigest: "f".repeat(64), observedDigest: "f".repeat(64) }, residue: { expectedInventoryDigest: "1".repeat(64), observedInventoryDigest: "1".repeat(64), expectedCounts: { databases: 0, files: 0, containers: 0 }, observedCounts: { databases: 0, files: 0, containers: 0 } } };
}

function runCli(name, args = [], input = "") {
  return spawnSync(process.execPath, [join(ROOT, "scripts/ops", `${name}.mjs`), ...args], {
    cwd: ROOT, encoding: "utf8", input, env: { ...process.env, NO_COLOR: "1" },
  });
}

function assertNoCanary(result, canary) {
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("canonical JSON recursively sorts keys and terminates with one LF", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, b: 1 }, list: [{ y: 2, x: 1 }] }), '{"a":{"b":1,"d":2},"list":[{"x":1,"y":2}],"z":1}\n');
  assert.equal(sha256("x").length, 64);
});

test("candidate manifest includes tracked and nonignored untracked files deterministically", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pkc-candidate-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, ".gitignore"), "ignored\n");
  await writeFile(join(repo, "tracked.txt"), "tracked\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: repo });
  await writeFile(join(repo, "new.txt"), "new\n");
  await writeFile(join(repo, "ignored"), "ignored\n");
  const first = await buildCandidateManifest(repo);
  const second = await buildCandidateManifest(repo);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.files.map((entry) => entry.path), [".gitignore", "new.txt", "tracked.txt"]);
  assert.equal(first.snapshot.dirty, true);
  assert.equal(first.snapshot.headCommit.length, 40);
  assert.equal(first.snapshot.headTree.length, 40);
  assert.equal(first.snapshot.statusDigest.length, 64);
  assert.equal("indexTree" in first.snapshot, false, "manifest must not call a tree-writing Git operation");
  assert.equal(first.serialization, "PKC-CANDIDATE-MANIFEST-V1: canonical UTF-8 JSON; recursively sorted object keys; array order preserved; LF terminator; fingerprint=SHA-256(manifest bytes without fingerprint field)");
  assert.deepEqual(await verifyCandidateManifest(repo, first), { ok: true, fingerprint: first.fingerprint });
});

test("candidate rejects symlinks, path escapes, and secret policy matches", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pkc-candidate-hostile-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "safe.txt"), "safe\n");
  await symlink("safe.txt", join(repo, "link.txt"));
  await assert.rejects(buildCandidateManifest(repo), /symlink/i);
  await lstat(join(repo, "link.txt")).then(() => import("node:fs/promises").then(({ unlink }) => unlink(join(repo, "link.txt"))));
  await writeFile(join(repo, ".env.production"), "CANARY_SECRET=do-not-read\n");
  await assert.rejects(buildCandidateManifest(repo, { includePaths: [".env.production"] }), /forbidden candidate.*path/i);
  await assert.rejects(buildCandidateManifest(repo, { includePaths: ["../escape"] }), /escapes|relative/i);
});

test("key operation writes four distinct mode-0600 files and emits metadata only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pkc-keys-"));
  const canaries = {
    handoff: Buffer.from("H".repeat(32)), encryption: Buffer.from("E".repeat(32)),
    finalize: Buffer.from("F".repeat(32)), recovery: Buffer.from("R".repeat(32)),
  };
  const receipt = await createKeyFiles({ directory: dir, version: 3, at: AT, material: canaries, ...localKeyApproval });
  assert.equal(receipt.keys.length, 4);
  assert.equal(JSON.stringify(receipt).includes("HHHH"), false);
  for (const key of receipt.keys) assert.equal((await lstat(key.path)).mode & 0o777, 0o600);
  await assert.rejects(createKeyFiles({ directory: dir, version: 4, at: AT, material: { ...canaries, finalize: canaries.handoff }, ...localKeyApproval }), /duplicate/i);
  assert.deepEqual(probeHistoricalKeyring({ "encryption-v2": true, "encryption-v3": true }, ["encryption-v2", "encryption-v3"]), { ok: true, readable: ["encryption-v2", "encryption-v3"], missing: [] });
  assert.equal(planEncryptionRotation({ from: "encryption-v2", to: "encryption-v3", dependentRows: 2 }).removeOldKeyAllowed, false);
});

test("key operation rejects a symlink ceremony directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkc-key-symlink-"));
  const target = join(root, "target");
  const link = join(root, "link");
  await mkdir(target);
  await symlink(target, link);
  await assert.rejects(createKeyFiles({ directory: link, version: 1, at: AT, material: { handoff: Buffer.alloc(32, 1), encryption: Buffer.alloc(32, 2), finalize: Buffer.alloc(32, 3), recovery: Buffer.alloc(32, 4) }, ...localKeyApproval }), /symlink/i);
});

test("interrupted key cleanup requires its exact ownership marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pkc-key-cleanup-"));
  const protectedPath = join(directory, "handoff-v8.key");
  await writeFile(protectedPath, "do-not-delete", { mode: 0o600 });
  await assert.rejects(cleanupInterruptedKeyRun({ directory, version: 8, executeLocal: true, targetKind: "disposable-local", typedApproval: "APPROVE LOCAL KEY CLEANUP" }), /marker/i);
  assert.equal(await readFile(protectedPath, "utf8"), "do-not-delete");
});

test("key CLI never prints injected key canaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pkc-key-cli-"));
  const canary = "CANARY_SECRET_MUST_NEVER_PRINT_123456";
  const result = runCli("keys", ["generate", "--directory", dir, "--version", "1", "--at", AT, "--stdin-material"], `${canary}\n${"B".repeat(32)}\n${"C".repeat(32)}\n${"D".repeat(32)}\n`);
  assert.notEqual(result.status, 0);
  assertNoCanary(result, canary);
});

test("restore evidence refuses unsafe targets and reports non-authoritative parity, RPO, RTO, and cleanup", () => {
  const input = restoreInput();
  const safe = evaluateRestoreEvidence(input);
  assert.equal(safe.status, "syntax-and-parity-only");
  assert.equal(safe.authoritative, false);
  assert.equal(safe.releaseEligible, false);
  assert.equal(safe.paritySatisfied, true);
  assert.equal(safe.rpoSeconds, 240);
  assert.equal(safe.rtoSeconds, 2640);
  assert.throws(() => evaluateRestoreEvidence({ ...input, target: { ...input.target, id: input.source.id } }), /source.*target/i);
  assert.throws(() => evaluateRestoreEvidence({ ...input, target: { ...input.target, id: "production-copy" } }), /production-like/i);
});

test("Vercel verifier binds exact source, scopes, KIDs, inventory, environment, alias, and rollback", () => {
  const base = { phase: "promoted", environment: "Preview", expectedEnvironment: "Preview", founderMfaMode: "enforced", expectedFounderMfaMode: "enforced", sourceSha: SHA, expectedSourceSha: SHA, sourceTreeSha: "b".repeat(40), state: "READY", deploymentId: "dpl_immutable", aliasTarget: "dpl_immutable", rollbackDeploymentId: "dpl_previous", functions: ["api/[...route].js"], maxFunctions: 10, candidate: candidateEvidence(), variables: [
    { name: "PKC_DATABASE_URL", scopes: ["Preview"] }, { name: "PKC_DATABASE_NAME", scopes: ["Preview"] },
    { name: "PKC_DATABASE_USER", scopes: ["Preview"] }, { name: "PKC_DATABASE_ENVIRONMENT", scopes: ["Preview"] },
    { name: "PKC_FOUNDER_SUBJECT", scopes: ["Preview"] },
    { name: "PKC_MFA_HANDOFF_KEYRING", scopes: ["Preview"] }, { name: "PKC_MFA_HANDOFF_KEY_VERSION", scopes: ["Preview"] },
    { name: "PKC_MFA_FINALIZE_KEYRING", scopes: ["Preview"] }, { name: "PKC_MFA_FINALIZE_KEY_VERSION", scopes: ["Preview"] },
  ], vercelKids: { handoff: "handoff-v3", finalize: "finalize-v3" }, n8nKids: { handoff: "handoff-v3", finalize: "finalize-v3" } };
  for (const name of ["PKC_TOTP_ENCRYPTION_KEYRING", "PKC_TOTP_ENCRYPTION_KEY_VERSION", "PKC_MFA_RECOVERY_PEPPER_KEYRING", "PKC_MFA_RECOVERY_PEPPER_VERSION", "PKC_AUTH_KEY", "PKC_N8N_BASE_URL", "PKC_N8N_ALLOWED_ORIGINS", "PKC_PUBLIC_ALLOWED_ORIGINS", "PKC_FOUNDER_MFA_MODE", "PKC_SOURCE_COMMIT", "PKC_MFA_WORKFLOW_DIGEST"]) base.variables.push({ name, scopes: ["Preview"] });
  assert.equal(verifyVercelDeployment(base).ok, true);
  for (const founderMfaMode of ["disabled", "armed", "enforced"]) assert.equal(verifyVercelDeployment({ ...base, founderMfaMode, expectedFounderMfaMode: founderMfaMode }).founderMfaMode, founderMfaMode);
  assert.equal(verifyVercelDeployment({ ...base, phase: "isolated", founderMfaMode: "disabled", expectedFounderMfaMode: "disabled", aliasTarget: base.rollbackDeploymentId }).phase, "isolated");
  assert.throws(() => verifyVercelDeployment({ ...base, phase: "isolated" }), /alias/i);
  assert.throws(() => verifyVercelDeployment({ ...base, sourceTreeSha: "c".repeat(40) }), /tree/i);
  assert.throws(() => verifyVercelDeployment({ ...base, candidate: { ...base.candidate, manifestDirty: true } }), /candidate.*digest|dirty|clean/i);
  assert.throws(() => verifyVercelDeployment({ ...base, environment: "Production" }), /environment/i);
  assert.throws(() => verifyVercelDeployment({ ...base, variables: base.variables.map((item) => item.name === "PKC_DATABASE_URL" ? { ...item, scopes: ["Preview", "Production"] } : item) }), /scope/i);
  for (const name of ["PKC_SOURCE_COMMIT", "PKC_MFA_WORKFLOW_DIGEST"]) {
    assert.throws(() => verifyVercelDeployment({ ...base, variables: base.variables.filter((item) => item.name !== name) }), /required variable.*scope/i);
  }
  assert.throws(() => verifyVercelDeployment({ ...base, n8nKids: { ...base.n8nKids, finalize: "finalize-v2" } }), /KID/i);
});

test("n8n retention manifest and purge plan are exact and deterministic", () => {
  const manifest = buildRetentionManifest(PROTECTED);
  assert.deepEqual(manifest.workflowIds, PROTECTED.slice().sort());
  assert.equal(canonicalJson(manifest), canonicalJson(buildRetentionManifest([...PROTECTED].reverse())));
  const plan = buildPurgePlan({ workflowIds: PROTECTED, snapshot: { id: "snap-n8n-immutable", immutable: true }, interval: { from: "2025-01-01T00:00:00Z", to: AT }, counts: { executions: 40, binaryObjects: 3, logGenerations: 2 }, at: AT });
  assert.equal(plan.mode, "plan-only");
  assert.equal(plan.scope.binaryData, true);
  assert.equal(plan.scope.logs, true);
  assert.equal(plan.receiptDigest.length, 64);
  assert.deepEqual(scanPrivacyEvidence({ executionCount: 0 }, ["SYNTHETIC_CANARY"]), { ok: true, canaryHits: 0, prohibitedFieldPattern: false });
  assert.equal(scanPrivacyEvidence({ payload: "SYNTHETIC_CANARY" }, ["SYNTHETIC_CANARY"]).ok, false);
});

test("n8n destructive apply is disabled without exact typed approval and performs zero writes", async () => {
  let writes = 0;
  const adapter = { async apply() { writes += 1; } };
  const plan = buildPurgePlan({ workflowIds: PROTECTED, snapshot: { id: "snap-n8n-immutable", immutable: true }, interval: { from: "2025-01-01T00:00:00Z", to: AT }, counts: { executions: 1, binaryObjects: 0, logGenerations: 0 }, at: AT });
  await assert.rejects(applyPurgePlan({ plan, adapter }), /disabled|approval/i);
  assert.equal(writes, 0);
  await assert.rejects(applyPurgePlan({ plan, adapter, enableDestructive: true, approval: { action: "PURGE" } }), /approval/i);
  assert.equal(writes, 0);
  const approval = { schemaVersion: 1, planDigest: PLAN_DIGEST, action: "PURGE_PROTECTED_N8N_HISTORY", actor: "operator-id", approvedAt: AT, workflowIds: PROTECTED.slice().sort(), purgePlanDigest: plan.receiptDigest, typedApproval: "APPROVE PURGE_PROTECTED_N8N_HISTORY" };
  const simulated = await applyPurgePlan({ plan, adapter: { ...adapter, gate0Fake: true }, enableDestructive: true, approval });
  assert.deepEqual(simulated, { applied: false, simulation: true, writes: 0, receiptDigest: plan.receiptDigest });
  assert.equal(writes, 0);
});

test("monitor evaluator covers required signals and redacts/caps alert payloads", () => {
  const result = evaluateMonitoring({ at: AT, readiness: { ok: false }, migration: { checksumDrift: true, roleDrift: true, aclDrift: true }, outbox: { oldestPendingSeconds: 121, retryMax: 8, unknownMinutes: 6, terminal: 1, dlq: 2 }, keys: { readFailures: 1 }, n8n: { workflowDrift: true, versionDrift: true, retentionDrift: true }, vercel: { sourceDrift: true, aliasDrift: true }, backup: { failed: true }, auth: { challengeExhaustion: 4, epochMismatchSpike: true, sessionAnomaly: true } });
  const codes = new Set(result.alerts.map((alert) => alert.code));
  for (const code of ["READINESS_DRIFT", "MIGRATION_CHECKSUM_DRIFT", "ROLE_DRIFT", "ACL_DRIFT", "OUTBOX_AGE", "OUTBOX_RETRY", "OUTBOX_UNKNOWN", "OUTBOX_TERMINAL", "OUTBOX_DLQ", "KEY_READ_FAILURE", "N8N_WORKFLOW_DRIFT", "N8N_VERSION_DRIFT", "N8N_RETENTION_DRIFT", "VERCEL_SOURCE_DRIFT", "VERCEL_ALIAS_DRIFT", "BACKUP_FAILURE", "AUTH_CHALLENGE_EXHAUSTION", "AUTH_EPOCH_MISMATCH", "SESSION_ANOMALY"]) assert.equal(codes.has(code), true, code);
  const bytes = canonicalJson(result);
  assert.doesNotMatch(bytes, /CANARY|token/i);
  assert.ok(Buffer.byteLength(bytes) < 12000);
});

test("mutation and approval receipts reject extra fields, malformed hashes, and secret-bearing metadata", () => {
  const receipt = { schemaVersion: 1, planDigest: PLAN_DIGEST, candidateSha: SHA, deployedSha: SHA, actor: "operator-id", occurredAt: AT, target: { system: "vercel", environment: "preview", providerObjectIds: ["dpl_immutable"] }, priorState: { stateReceiptId: "prior", stateDigest: "b".repeat(64) }, newState: { stateReceiptId: "new", stateDigest: "c".repeat(64) }, verification: [{ check: "source-sha", result: "pass", evidenceId: "ev-1" }], rollback: { handle: "dpl_old", procedure: "restore-alias-after-approval" } };
  assert.deepEqual(validateMutationReceipt(receipt), receipt);
  assert.throws(() => validateMutationReceipt({ ...receipt, extra: true }), /unknown/i);
  assert.throws(() => validateMutationReceipt({ ...receipt, candidateSha: "short" }), /SHA/i);
  const receiptCanary = "CANARY";
  assert.throws(() => validateMutationReceipt({ ...receipt, newState: { ...receipt.newState, password: receiptCanary } }), /secret/i);
  const approval = { schemaVersion: 1, planDigest: PLAN_DIGEST, action: "PURGE_PROTECTED_N8N_HISTORY", actor: "operator-id", approvedAt: AT, workflowIds: PROTECTED.slice().sort(), purgePlanDigest: "b".repeat(64), typedApproval: "APPROVE PURGE_PROTECTED_N8N_HISTORY" };
  assert.deepEqual(validateApprovalReceipt(approval), approval);
  assert.throws(() => validateApprovalReceipt({ ...approval, typedApproval: "yes" }), /typed approval/i);
});

test("every Gate 0 operations CLI has help and a safe no-action default", () => {
  for (const name of ["candidate", "keys", "restore", "vercel", "n8n-retention", "monitor", "receipt"]) {
    const help = runCli(name, ["--help"]);
    assert.equal(help.status, 0, `${name} --help: ${help.stderr}`);
    assert.match(help.stdout, /Usage:/);
    const dry = runCli(name);
    assert.equal(dry.status, 0, `${name} default: ${dry.stderr}`);
    assert.match(dry.stdout, /dry-run|read-only|no action/i);
  }
});

test("tracked schemas, templates, policy, and all required runbooks exist", async () => {
  const paths = [
    "schemas/operations/mutation-receipt.schema.json", "schemas/operations/destructive-approval.schema.json",
    "evidence/templates/mutation-receipt.json", "evidence/templates/destructive-approval.json", "monitoring/founder-mfa-alert-policy.json",
    ...["preflight", "migration-role-sealing", "key-ceremony-rotation-recovery", "backup-restore", "n8n-retention-history", "inactive-imports-readback", "vercel-staging", "activation-cutover", "customer-only-rollback", "founder-enrollment", "incident-response", "forward-only-post-enrollment-recovery"].map((name) => `docs/operations/${name}.md`),
  ];
  for (const path of paths) assert.ok((await readFile(join(ROOT, path), "utf8")).length > 300, path);
});
