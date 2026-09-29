import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../../server/ops/canonical.mjs";
import { buildCandidateManifest } from "../../server/ops/candidate.mjs";
import { createKeyFiles, cleanupInterruptedKeyRun } from "../../server/ops/keys.mjs";
import { evaluateMonitoring, MONITORING_PAYLOAD_POLICY } from "../../server/ops/monitoring.mjs";
import { RECEIPT_LIMITS, validateApprovalReceipt, validateMutationReceipt } from "../../server/ops/receipts.mjs";
import { evaluateRestoreEvidence } from "../../server/ops/restore.mjs";
import { buildVercelCandidateEvidence, verifyVercelDeployment } from "../../server/ops/vercel.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const AT = "2026-09-28T00:00:00.000Z";
const SHA = "a".repeat(40);
const HEX = (character) => character.repeat(64);
const PLAN_DIGEST = "7f9b6d6f5c17e80649e42fefd860f476160be6bd1a809511543e4a27814e5454";
const PROTECTED = ["wfDsutVsW15DHGr3", "nvgxxBPinPmsEmZq", "uuNgivASLQZ08gX7", "GVVnbelFG97UjJDw", "W63ETZfmKVI7UDFW", "jb0I4CqlJuuG6fXs"];
const VARIABLES = ["PKC_DATABASE_URL", "PKC_DATABASE_NAME", "PKC_DATABASE_USER", "PKC_DATABASE_ENVIRONMENT", "PKC_FOUNDER_SUBJECT", "PKC_TOTP_ENCRYPTION_KEYRING", "PKC_TOTP_ENCRYPTION_KEY_VERSION", "PKC_MFA_HANDOFF_KEYRING", "PKC_MFA_HANDOFF_KEY_VERSION", "PKC_MFA_FINALIZE_KEYRING", "PKC_MFA_FINALIZE_KEY_VERSION", "PKC_MFA_RECOVERY_PEPPER_KEYRING", "PKC_MFA_RECOVERY_PEPPER_VERSION", "PKC_AUTH_KEY", "PKC_N8N_BASE_URL", "PKC_N8N_ALLOWED_ORIGINS", "PKC_PUBLIC_ALLOWED_ORIGINS", "PKC_FOUNDER_MFA_MODE"];

function candidateEvidence(functionInventory = ["api/[...route].js"]) {
  const manifestBody = { schemaVersion: 1, serialization: "test-canonical-manifest", snapshot: { headCommit: SHA, headTree: "b".repeat(40), dirty: false, statusDigest: HEX("0") }, files: functionInventory.map((path) => ({ path, bytes: 1, mode: 0o644, sha256: HEX("d") })) };
  return buildVercelCandidateEvidence({ ...manifestBody, fingerprint: sha256(canonicalJson(manifestBody)) });
}

function vercelInput() {
  return {
    environment: "Preview", expectedEnvironment: "Preview", founderMfaMode: "enforced", sourceSha: SHA, expectedSourceSha: SHA,
    state: "READY", deploymentId: "dpl_immutable", aliasTarget: "dpl_immutable", expectedAliasTarget: "dpl_immutable",
    rollbackDeploymentId: "dpl_previous", functions: ["api/[...route].js"], maxFunctions: 10,
    candidate: candidateEvidence(),
    variables: VARIABLES.map((name) => ({ name, scopes: ["Preview"] })),
    vercelKids: { handoff: "handoff-v3", finalize: "finalize-v3" }, n8nKids: { handoff: "handoff-v3", finalize: "finalize-v3" },
  };
}

function mutationReceipt() {
  return {
    schemaVersion: 1, planDigest: PLAN_DIGEST, candidateSha: SHA, deployedSha: SHA, actor: "operator-id", occurredAt: AT,
    target: { system: "vercel", environment: "preview", providerObjectIds: ["dpl_immutable"] },
    priorState: { stateReceiptId: "prior-receipt", stateDigest: HEX("b") },
    newState: { stateReceiptId: "new-receipt", stateDigest: HEX("c") },
    verification: [{ check: "source-sha", result: "pass", evidenceId: "ev-1" }],
    rollback: { handle: "dpl_old", procedure: "restore-alias-after-approval" },
  };
}

function restoreEvidence() {
  return {
    source: {
      id: "db-source", snapshotId: "snap-immutable-20260928", immutable: true,
      capturedAt: "2026-09-28T00:00:00.000Z", snapshotDigest: HEX("a"),
      providerReceiptId: "provider-receipt-1", providerReceiptDigest: HEX("b"),
    },
    target: { id: "drill-7f1", disposable: true, isolated: true, labels: { purpose: "restore-drill", production: "false" } },
    restoredAt: "2026-09-28T00:04:00.000Z", observedAt: "2026-09-28T00:40:00.000Z", completedAt: "2026-09-28T00:44:00.000Z",
    verifier: { identity: "independent-operator", evidenceIds: ["catalog-readback-1", "residue-readback-1"] },
    migrationLedger: { expectedDigest: HEX("c"), observedDigest: HEX("c") },
    catalog: { expectedDigest: HEX("d"), observedDigest: HEX("d") },
    roles: { expectedDigest: HEX("e"), observedDigest: HEX("e") },
    keyVersions: { expectedDigest: HEX("f"), observedDigest: HEX("f") },
    residue: {
      expectedInventoryDigest: HEX("1"), observedInventoryDigest: HEX("1"),
      expectedCounts: { databases: 0, files: 0, containers: 0 }, observedCounts: { databases: 0, files: 0, containers: 0 },
    },
  };
}

function runCli(name, args = []) {
  return spawnSync(process.execPath, [join(ROOT, "scripts/ops", `${name}.mjs`), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

async function disposableRepo(files) {
  const repo = await mkdtemp(join(tmpdir(), "pkc-renewed-hold-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  for (const [path, value] of Object.entries(files)) await writeFile(join(repo, path), value);
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}

test("Vercel verification consumes exact frozen candidate evidence and exact release ceiling", () => {
  const base = vercelInput();
  assert.equal(verifyVercelDeployment(base).functionCount, 1);
  for (const maxFunctions of [9, 11, Number.MAX_SAFE_INTEGER]) assert.throws(() => verifyVercelDeployment({ ...base, maxFunctions }), /exact.*10|function.*ceiling/i);
  assert.throws(() => verifyVercelDeployment({ ...base, candidate: { ...base.candidate, evidenceDigest: HEX("0") } }), /candidate.*digest|evidence/i);
  assert.throws(() => verifyVercelDeployment({ ...base, functions: ["api/not-in-manifest.js"] }), /candidate|inventory|manifest/i);
  assert.throws(() => verifyVercelDeployment({ ...base, candidate: candidateEvidence([]), functions: [] }), /nonempty|inventory/i);
});

test("Vercel candidate evidence is generated from a disposable accepted catch-all candidate", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pkc-vercel-candidate-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await mkdir(join(repo, "api"));
  await writeFile(join(repo, "api", "[...route].js"), "export default function handler() {}\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "accepted catch-all router"], { cwd: repo });
  const manifest = await buildCandidateManifest(repo);
  const candidate = buildVercelCandidateEvidence(manifest);
  const input = { ...vercelInput(), sourceSha: manifest.snapshot.headCommit, expectedSourceSha: manifest.snapshot.headCommit, candidate };
  assert.equal(verifyVercelDeployment(input).candidateFingerprint, manifest.fingerprint);
});

test("monitoring is closed, descriptor-safe, bounded, and never executes getters", () => {
  let getterCount = 0;
  const metadata = Object.create(null);
  Object.defineProperty(metadata, "eventId", { enumerable: true, get() { getterCount += 1; return "never"; } });
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, metadata }), /plain|accessor|data/i);
  assert.equal(getterCount, 0);
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false, unknown: true } }), /unknown/i);
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, unknown: true }), /unknown/i);
  assert.throws(() => evaluateMonitoring(new Proxy({}, { ownKeys() { throw new Error("trap"); } })), /monitoring|plain|inspect/i);
});

test("monitoring rejects secret-like values, huge/deep inputs, and hashes only <=128 opaque IDs", () => {
  const secretLike = ["pass", "word"].join("") + "=" + "q".repeat(24);
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, metadata: { state: secretLike } }), /secret/i);
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, metadata: { eventId: "x".repeat(129) } }), /128|length|bound/i);
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, metadata: { eventId: "x".repeat(128), operationKey: "y".repeat(128), state: "FAILED", errorClass: "READ_TIMEOUT", observedAt: AT, attemptCount: 1, extra: "z" } }), /unknown/i);
  const deep = {}; let cursor = deep; for (let index = 0; index < 1000; index += 1) cursor = cursor.next = {};
  assert.throws(() => evaluateMonitoring({ at: AT, readiness: { ok: false }, metadata: deep }), (error) => !(error instanceof RangeError) && /depth|unknown|bound/i.test(error.message));
});

test("monitoring JSON policy exactly matches reviewed runtime payload policy", async () => {
  const policy = JSON.parse(await (await import("node:fs/promises")).readFile(join(ROOT, "monitoring/founder-mfa-alert-policy.json"), "utf8"));
  assert.deepEqual(policy.payloadPolicy, MONITORING_PAYLOAD_POLICY);
});

test("mutation receipts are closed descriptor-safe digest references and require every verification to pass", () => {
  const base = mutationReceipt();
  assert.deepEqual(validateMutationReceipt(base), base);
  assert.throws(() => validateMutationReceipt({ ...base, verification: [{ check: "source-sha", result: "fail", evidenceId: "ev-1" }] }), /all.*pass|successful|verification/i);
  assert.throws(() => validateMutationReceipt({ ...base, priorState: { ...base.priorState, arbitrary: {} } }), /unknown/i);
  const secretLike = ["auth", "orization"].join("") + ": Bearer " + "q".repeat(24);
  assert.throws(() => validateMutationReceipt({ ...base, newState: { ...base.newState, stateReceiptId: secretLike } }), /secret/i);
  assert.throws(() => validateMutationReceipt({ ...base, rollback: { ...base.rollback, procedure: "x".repeat(5000) } }), /1024|bound/i);
});

test("receipts reject accessors, exotic prototypes, huge/deep aggregates, and never throw RangeError", () => {
  const base = mutationReceipt();
  let getterCount = 0;
  const target = { ...base.target };
  Object.defineProperty(target, "system", { enumerable: true, get() { getterCount += 1; return "vercel"; } });
  assert.throws(() => validateMutationReceipt({ ...base, target }), /accessor|data/i);
  assert.equal(getterCount, 0);
  assert.throws(() => validateMutationReceipt(Object.assign(Object.create({ inherited: true }), base)), /plain|prototype/i);
  const deep = {}; let cursor = deep; for (let index = 0; index < 20_000; index += 1) cursor = cursor.next = {};
  assert.throws(() => validateMutationReceipt({ ...base, priorState: deep }), (error) => !(error instanceof RangeError) && /depth|unknown|bound/i.test(error.message));
});

test("approval receipts use the same descriptor, aggregate, and secret-value protections", () => {
  const approval = { schemaVersion: 1, planDigest: PLAN_DIGEST, action: "PURGE_PROTECTED_N8N_HISTORY", actor: "operator-id", approvedAt: AT, workflowIds: PROTECTED.slice().sort(), purgePlanDigest: HEX("b"), typedApproval: "APPROVE PURGE_PROTECTED_N8N_HISTORY" };
  assert.deepEqual(validateApprovalReceipt(approval), approval);
  let count = 0;
  Object.defineProperty(approval, "actor", { enumerable: true, get() { count += 1; return "operator-id"; } });
  assert.throws(() => validateApprovalReceipt(approval), /accessor|data/i);
  assert.equal(count, 0);
});

test("receipt JSON schemas exactly publish runtime limits and closed success semantics", async () => {
  const { readFile } = await import("node:fs/promises");
  const mutation = JSON.parse(await readFile(join(ROOT, "schemas/operations/mutation-receipt.schema.json"), "utf8"));
  const approval = JSON.parse(await readFile(join(ROOT, "schemas/operations/destructive-approval.schema.json"), "utf8"));
  const published = { ...RECEIPT_LIMITS, secretScan: "key-names-and-string-values" };
  assert.deepEqual(mutation["x-runtimeLimits"], published);
  assert.deepEqual(approval["x-runtimeLimits"], published);
  assert.equal(mutation.$defs.stateReference.additionalProperties, false);
  assert.deepEqual(mutation.$defs.stateReference.required, ["stateReceiptId", "stateDigest"]);
  assert.equal(mutation.properties.verification.items.properties.result.const, "pass");
});

test("restore reports non-authoritative syntax and parity without provider provenance", () => {
  const base = restoreEvidence();
  assert.equal(evaluateRestoreEvidence(base).paritySatisfied, true);
  assert.equal(evaluateRestoreEvidence(base).releaseEligible, false);
  assert.equal(evaluateRestoreEvidence({ ...base, catalog: { ...base.catalog, observedDigest: HEX("0") } }).paritySatisfied, false);
  assert.equal(evaluateRestoreEvidence({ ...base, residue: { ...base.residue, observedInventoryDigest: HEX("0") } }).paritySatisfied, false);
  const invented = { source: { id: "db-source", snapshotId: "snap-made-up", immutable: true, capturedAt: AT }, target: base.target, restoredAt: base.restoredAt, completedAt: base.completedAt, migrationLedger: { exact: true }, catalog: { exact: true }, roles: { exact: true }, keyVersions: { allUsable: true }, residue: { databases: 0, files: 0, containers: 0 } };
  assert.throws(() => evaluateRestoreEvidence(invented), /unknown|digest|receipt|verifier|observed/i);
  assert.throws(() => evaluateRestoreEvidence({ ...base, observedAt: base.restoredAt }), /ordered|timestamp/i);
});

test("canonical JSON rejects non-finite, negative zero, cycles, accessors, and prototypes", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) assert.throws(() => canonicalJson(value), /finite|negative zero|canonical/i);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /cycle/i);
  let count = 0; const accessor = {}; Object.defineProperty(accessor, "x", { enumerable: true, get() { count += 1; return 1; } });
  assert.throws(() => canonicalJson(accessor), /accessor|data/i); assert.equal(count, 0);
  assert.throws(() => canonicalJson(new Date()), /plain|prototype|canonical/i);
});

test("canonical JSON preserves nested own __proto__ keys without prototype mutation", () => {
  const hostile = JSON.parse('{"outer":{"safe":1,"__proto__":{"polluted":true}},"__proto__":{"root":true}}');
  const bytes = canonicalJson(hostile);
  assert.equal(bytes, '{"__proto__":{"root":true},"outer":{"__proto__":{"polluted":true},"safe":1}}\n');
  const decoded = JSON.parse(bytes);
  assert.equal(Object.hasOwn(decoded, "__proto__"), true);
  assert.equal(Object.hasOwn(decoded.outer, "__proto__"), true);
  assert.equal({}.polluted, undefined);

  const receipt = mutationReceipt();
  receipt.target = JSON.parse(JSON.stringify(receipt.target).replace(/}$/, ',"__proto__":{"system":"bypass"}}'));
  assert.throws(() => validateMutationReceipt(receipt), /unknown.*__proto__/i);
});

test("Vercel function inventory is derived exhaustively from the frozen manifest", () => {
  assert.equal(buildVercelCandidateEvidence.length, 1);
  const functions = Array.from({ length: 11 }, (_, index) => `api/function-${index}.js`);
  const manifestBody = {
    schemaVersion: 1,
    serialization: "test-canonical-manifest",
    snapshot: { headCommit: SHA, headTree: "b".repeat(40), dirty: false, statusDigest: HEX("0") },
    files: functions.map((path) => ({ path, bytes: 1, mode: 0o644, sha256: HEX("d") })),
  };
  const manifest = { ...manifestBody, fingerprint: sha256(canonicalJson(manifestBody)) };
  assert.throws(() => buildVercelCandidateEvidence(manifest, [functions[0]]), /function.*ceiling|11.*10/i);

  const invalidBody = { ...manifestBody, files: [{ path: "api/not-a-function.ts", bytes: 1, mode: 0o644, sha256: HEX("d") }] };
  const invalid = { ...invalidBody, fingerprint: sha256(canonicalJson(invalidBody)) };
  assert.throws(() => buildVercelCandidateEvidence(invalid, []), /invalid function path|closed function.*policy/i);
});

test("complete invented restore evidence can never produce an authoritative success verdict", () => {
  const result = evaluateRestoreEvidence(restoreEvidence());
  assert.equal(result.authoritative, false);
  assert.equal(result.releaseEligible, false);
  assert.equal(result.status, "syntax-and-parity-only");
  assert.equal(Object.hasOwn(result, "ok"), false);
  assert.equal(Object.hasOwn(result.checks, "immutableSnapshotReceipt"), false);
});

test("restore CLI emits only the non-authoritative syntax/parity contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pkc-restore-syntax-parity-"));
  const input = join(directory, "invented-complete-evidence.json");
  await writeFile(input, JSON.stringify(restoreEvidence()));
  const result = runCli("restore", ["verify", "--input", input]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "syntax-and-parity-only");
  assert.equal(output.authoritative, false);
  assert.equal(output.releaseEligible, false);
  assert.equal(Object.hasOwn(output, "ok"), false);
});

test("candidate rejects dumps, screenshots, and secret assignments in ordinary text", async () => {
  const secretAssignment = ["client", "_secret"].join("") + " = " + "q".repeat(24) + "\n";
  for (const [path, value] of [["database.dump", "fixture"], ["screen.png", "fixture"], ["notes.txt", secretAssignment]]) {
    const repo = await disposableRepo(Object.fromEntries([[path, value]]));
    await assert.rejects(buildCandidateManifest(repo), /forbidden|secret|artifact/i, path);
  }
});

test("candidate rejects secret assignments in JavaScript source", async () => {
  const assignment = ["pass", "word"].join("") + " = " + "q".repeat(24) + "\n";
  for (const path of ["hostile.js", "hostile.mjs"]) {
    const repo = await disposableRepo(Object.fromEntries([[path, assignment]]));
    await assert.rejects(buildCandidateManifest(repo), /secret/i, path);
  }
});

test("restore, Vercel, and monitor CLIs enforce their exact evidence grammar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pkc-evidence-cli-grammar-"));
  const cases = [
    { name: "restore", command: "verify", value: restoreEvidence() },
    { name: "vercel", command: "verify", value: vercelInput() },
    { name: "monitor", command: "evaluate", value: { at: AT, readiness: { ok: true } } },
  ];
  for (const entry of cases) {
    const input = join(directory, `${entry.name}.json`);
    await writeFile(input, JSON.stringify(entry.value));
    assert.equal(runCli(entry.name, [entry.command, "--input", input]).status, 0, entry.name);
    for (const args of [
      [entry.command, "--input", input, "--unexpected"],
      [entry.command, "--input", input, "--input", input],
      [entry.command, input],
      [entry.command, "--input"],
      [entry.command, "--input", ""],
      ["--help", "--unexpected"],
    ]) {
      const result = runCli(entry.name, args);
      assert.notEqual(result.status, 0, `${entry.name}: ${args.join(" ")}`);
      assert.match(result.stderr, /usage|exact|argument|input|command/i, `${entry.name}: ${result.stderr}`);
    }
  }
});

test("receipt CLI rejects unknown type before attempting input read", () => {
  const result = runCli("receipt", ["verify", "--type", "nonsense", "--input", "/definitely/missing.json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /type.*mutation.*approval|unknown.*type/i);
  assert.doesNotMatch(result.stderr, /ENOENT|no such file/i);
});

test("all operations command enums are closed and candidate writes require typed local approval", async () => {
  for (const name of ["candidate", "keys", "restore", "vercel", "n8n-retention", "monitor", "receipt"]) {
    const result = runCli(name, ["nonsense"]);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /unknown|command|requires|required/i, name);
  }
  const directory = await mkdtemp(join(tmpdir(), "pkc-candidate-output-"));
  const output = join(directory, "candidate.json");
  const result = runCli("candidate", ["manifest", "--root", ROOT, "--output", output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed.*approval|explicit.*local/i);
  await assert.rejects((await import("node:fs/promises")).readFile(output), /ENOENT/);
});

test("key writes and deletion require explicit local approval and reject production-like targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pkc-production-keys-"));
  const material = { handoff: Buffer.alloc(32, 1), encryption: Buffer.alloc(32, 2), finalize: Buffer.alloc(32, 3), recovery: Buffer.alloc(32, 4) };
  await assert.rejects(createKeyFiles({ directory, version: 1, at: AT, material }), /approval|execute|target/i);
  await assert.rejects(createKeyFiles({ directory, version: 1, at: AT, material, executeLocal: true, targetKind: "disposable-local", typedApproval: "APPROVE LOCAL KEY GENERATION" }), /production/i);
  await assert.rejects(cleanupInterruptedKeyRun({ directory, version: 1 }), /approval|execute|target/i);
  const cli = runCli("keys", ["cleanup", "--directory", directory, "--version", "1"]);
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /approval|execute|target/i);
});
