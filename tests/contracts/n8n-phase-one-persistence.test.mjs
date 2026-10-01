import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { parseCandidateArguments } from "../../scripts/n8n-phase-one-candidate.mjs";
import {
  CANDIDATE_NAME,
  CANDIDATE_PATH,
  CANDIDATE_ID,
  CONSENT_KEYS,
  N8N_IMAGE,
  SOURCE_AUTHORITY,
  buildCandidatePackage,
  deriveConsentPersistenceCandidate,
  loadBoundSourceWorkflow,
  parseBoundedJson,
  readJsonDescriptorSafe,
  semanticHash,
  serializeDeterministic,
} from "../../scripts/n8n-phase-one-persistence.mjs";

const require = createRequire(import.meta.url);
const source = () => loadBoundSourceWorkflow().value;
const candidate = () => deriveConsentPersistenceCandidate(source());
const edgeTargets = (workflow, name, output = 0) => (workflow.connections?.[name]?.main?.[output] || []).map((edge) => edge.node);

function runCode(node, json) {
  const items = [{ json: structuredClone(json) }];
  return Function("$input", "$env", "$execution", "$", "require", node.parameters.jsCode)(
    { first: () => items[0], all: () => items },
    {},
    { id: "synthetic-execution" },
    () => ({ first: () => items[0], all: () => items }),
    require,
  );
}

function runStatefulCode(node, json, staticData, referencedItems = {}) {
  return Function(
    "$input",
    "$json",
    "$getWorkflowStaticData",
    "$execution",
    "$",
    "require",
    node.parameters.jsCode,
  )(
    { first: () => ({ json }), all: () => [{ json }] },
    json,
    () => staticData,
    { id: "synthetic-execution" },
    (name) => ({
      first: () => ({ json: referencedItems[name] || {} }),
      all: () => [{ json: referencedItems[name] || {} }],
    }),
    require,
  );
}

function validPayload() {
  const payload = {
    version: "v1",
    submissionId: "synthetic-submission-0001",
    firstName: "Example",
    lastName: "Person",
    email: "example.invalid@example.test",
    minimumAgeConfirmed: true,
    termsAccepted: true,
    privacyAcknowledged: true,
    policyVersion: "pkc-onboarding-14-plus-v1",
  };
  payload.hash = crypto.createHash("sha256").update([
    payload.firstName,
    payload.lastName,
    payload.email,
    payload.submissionId,
    payload.version,
  ].join("|")).digest("hex");
  return payload;
}

test("descriptor-safe reader rejects hostile JSON and unsafe file identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-phase-one-hostile-"));
  try {
    const valid = path.join(root, "valid.json");
    fs.writeFileSync(valid, '{"a":1}', { mode: 0o600 });
    const link = path.join(root, "link.json");
    fs.symlinkSync(valid, link);
    assert.throws(() => readJsonDescriptorSafe(link, { protectedInput: true }), /ELOOP|symbolic/i);

    const duplicate = path.join(root, "duplicate.json");
    fs.writeFileSync(duplicate, '{"a":1,"a":2}', { mode: 0o600 });
    assert.throws(() => readJsonDescriptorSafe(duplicate, { protectedInput: true }), /duplicate key/i);

    const malformed = path.join(root, "malformed.json");
    fs.writeFileSync(malformed, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]), { mode: 0o600 });
    assert.throws(() => readJsonDescriptorSafe(malformed, { protectedInput: true }), /encoded data|UTF/i);

    const permissive = path.join(root, "permissive.json");
    fs.writeFileSync(permissive, '{"a":1}', { mode: 0o644 });
    assert.throws(() => readJsonDescriptorSafe(permissive, { protectedInput: true }), /0600/);

    const fifo = path.join(root, "pipe");
    execFileSync("mkfifo", [fifo]);
    fs.chmodSync(fifo, 0o600);
    assert.throws(() => readJsonDescriptorSafe(fifo, { protectedInput: true }), /regular file/);

    assert.throws(() => parseBoundedJson(`${"[".repeat(90)}0${"]".repeat(90)}`), /depth bound/i);
    assert.throws(() => parseBoundedJson(`{"x":"${"a".repeat(1_000_001)}"}`), /string bound/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected source is immutably bound by identity, topology, and both hashes", () => {
  const loaded = loadBoundSourceWorkflow();
  assert.equal(loaded.rawSha256, SOURCE_AUTHORITY.rawSha256);
  assert.equal(loaded.canonicalSha256, SOURCE_AUTHORITY.canonicalSha256);
  assert.equal(loaded.value.id, SOURCE_AUTHORITY.id);
  assert.equal(loaded.value.name, SOURCE_AUTHORITY.name);
  assert.equal(loaded.value.versionId, SOURCE_AUTHORITY.versionId);
  assert.equal(loaded.value.updatedAt, SOURCE_AUTHORITY.updatedAt);
  assert.equal(loaded.value.nodes.length, SOURCE_AUTHORITY.nodeCount);

  const drift = structuredClone(loaded.value);
  drift.updatedAt = "2026-09-26T19:38:49.278Z";
  assert.throws(() => deriveConsentPersistenceCandidate(drift), /source authority drift/i);
});

test("candidate derivation is deterministic, inactive, minimized, and source-immutable", () => {
  const input = source();
  const before = serializeDeterministic(input);
  const first = deriveConsentPersistenceCandidate(input);
  const second = deriveConsentPersistenceCandidate(input);
  assert.equal(serializeDeterministic(input), before);
  assert.deepEqual(first, second);
  assert.equal(first.name, CANDIDATE_NAME);
  assert.equal(first.id, CANDIDATE_ID);
  assert.notEqual(first.id, SOURCE_AUTHORITY.id);
  assert.equal(first.active, false);
  assert.equal(first.nodes.length, 21);
  assert.equal(first.nodes.find((node) => node.type === "n8n-nodes-base.webhook").parameters.path, CANDIDATE_PATH);
  assert.equal(first.settings.availableInMCP, false);
  assert.equal(first.settings.executionTimeout, 40);
  assert.ok(first.settings.executionTimeout > 30 && first.settings.executionTimeout < 45);
  assert.deepEqual({
    saveDataErrorExecution: first.settings.saveDataErrorExecution,
    saveDataSuccessExecution: first.settings.saveDataSuccessExecution,
    saveExecutionProgress: first.settings.saveExecutionProgress,
    saveManualExecutions: first.settings.saveManualExecutions,
  }, {
    saveDataErrorExecution: "none",
    saveDataSuccessExecution: "none",
    saveExecutionProgress: false,
    saveManualExecutions: false,
  });
  for (const key of ["versionId", "createdAt", "updatedAt", "activeVersion", "activeVersionId", "versionCounter", "shared", "tags", "triggerCount", "meta", "pinData", "staticData"]) {
    assert.equal(key in first, false, key);
  }
  for (const node of first.nodes) {
    assert.equal("id" in node, false);
    for (const [type, reference] of Object.entries(node.credentials || {})) {
      assert.ok(type.length > 0);
      assert.deepEqual(Object.keys(reference), ["name"]);
      assert.equal(typeof reference.name, "string");
      assert.ok(reference.name.length > 0);
    }
  }
});

test("candidate enforces the exact closed consent input and the legacy hash", () => {
  const workflow = candidate();
  const intake = workflow.nodes.find((node) => node.parameters?.jsCode?.includes("pkc_consent_schema_invalid"));
  const enrich = workflow.nodes.find((node) => node.parameters?.jsCode?.includes("createHash('sha256')") && node.parameters.jsCode.includes("hashOk"));
  assert.ok(intake);
  assert.ok(enrich);

  const payload = validPayload();
  const accepted = runCode(intake, { body: payload, headers: {} });
  assert.equal(accepted.length, 1);
  const enriched = runCode(enrich, accepted[0].json);
  assert.equal(enriched[0].json._meta.hashOk, true);
  for (const key of CONSENT_KEYS) assert.equal(enriched[0].json[key], payload[key]);

  for (const mutate of [
    (value) => { delete value.termsAccepted; },
    (value) => { value.extra = true; },
    (value) => { value._meta = {}; },
    (value) => { value.headers = {}; },
    (value) => { value.minimumAgeConfirmed = 1; },
    (value) => { value.termsAccepted = "true"; },
    (value) => { value.privacyAcknowledged = false; },
    (value) => { value.policyVersion = "pkc-onboarding-launch-v2"; },
  ]) {
    const hostile = structuredClone(payload);
    mutate(hostile);
    assert.throws(() => runCode(intake, { body: hostile, headers: {} }), /pkc_consent_(?:schema|value)_invalid/);
  }

  const wrongHash = structuredClone(payload);
  wrongHash.hash = "0".repeat(64);
  assert.throws(
    () => runCode(enrich, runCode(intake, { body: wrongHash, headers: {} })[0].json),
    /HASH_MISMATCH/,
  );
});

test("Sheets explicitly maps consent and can only fail through a minimized 503 branch", () => {
  const workflow = candidate();
  const sheet = workflow.nodes.find((node) => node.type === "n8n-nodes-base.googleSheets");
  assert.ok(sheet);
  assert.equal(sheet.parameters.columns.mappingMode, "defineBelow");
  assert.deepEqual(Object.keys(sheet.parameters.columns.value).sort(), [
    "email", "firstName", "hash", "lastName", "minimumAgeConfirmed", "policyVersion",
    "privacyAcknowledged", "submissionId", "termsAccepted", "version",
  ]);
  assert.equal(sheet.retryOnFail, undefined);
  assert.equal(sheet.maxTries, undefined);
  assert.equal(sheet.waitBetweenTries, undefined);
  assert.equal(sheet.continueOnFail, undefined);
  assert.equal(sheet.onError, "continueErrorOutput");

  const failureTargets = edgeTargets(workflow, sheet.name, 1);
  assert.equal(failureTargets.length, 1);
  const failureRelease = workflow.nodes.find((node) => node.name === failureTargets[0]);
  assert.equal(failureRelease?.type, "n8n-nodes-base.code");
  const failureCodeName = edgeTargets(workflow, failureRelease.name)[0];
  const failureCode = workflow.nodes.find((node) => node.name === failureCodeName);
  const failureJson = runCode(failureCode, { private: "must-not-escape" })[0].json;
  assert.deepEqual(failureJson, {
    ok: false,
    persisted: false,
    duplicate: false,
    error: "persistence_unavailable",
  });
  const responseName = edgeTargets(workflow, failureCode.name)[0];
  const response = workflow.nodes.find((node) => node.name === responseName);
  assert.equal(response.type, "n8n-nodes-base.respondToWebhook");
  assert.equal(response.parameters.options.responseCode, 503);
  assert.doesNotMatch(response.parameters.responseBody, /\$json|message|stack|submission|email/i);
  assert.equal(edgeTargets(workflow, response.name).length, 0);
});

test("Sheets failure releases only its owned lock before a retry can acquire", () => {
  const workflow = candidate();
  const sheet = workflow.nodes.find((node) => node.type === "n8n-nodes-base.googleSheets");
  const failureRelease = workflow.nodes.find((node) => node.name === edgeTargets(workflow, sheet.name, 1)[0]);
  const submissionId = validPayload().submissionId;
  const oldOwner = "old-execution-owner";
  const staticData = { locks: { [submissionId]: { owner: oldOwner, expiresAt: Date.now() + 5_000 } } };

  runStatefulCode(failureRelease, { error: "synthetic" }, staticData, {
    Enrich: { submissionId, _meta: { lockOwner: oldOwner } },
  });
  assert.equal(Object.hasOwn(staticData.locks, submissionId), false);

  const acquire = workflow.nodes.find((node) => node.name === "Lock Acquire");
  const retried = runStatefulCode(acquire, { submissionId, _meta: {} }, staticData);
  assert.equal(typeof retried[0].json._meta.lockOwner, "string");
  assert.ok(retried[0].json._meta.lockOwner.length > 0);
});

test("a stale Sheets failure cannot delete a replacement lock owner", () => {
  const workflow = candidate();
  const sheet = workflow.nodes.find((node) => node.type === "n8n-nodes-base.googleSheets");
  const failureRelease = workflow.nodes.find((node) => node.name === edgeTargets(workflow, sheet.name, 1)[0]);
  const submissionId = validPayload().submissionId;
  const staticData = { locks: { [submissionId]: { owner: "replacement-owner", expiresAt: Date.now() + 5_000 } } };

  runStatefulCode(failureRelease, { error: "late synthetic failure" }, staticData, {
    Enrich: { submissionId, _meta: { lockOwner: "stale-owner" } },
  });
  assert.equal(staticData.locks[submissionId].owner, "replacement-owner");
});

test("an in-flight duplicate cannot reach Aggregate or acknowledge persistence", () => {
  const workflow = candidate();
  const duplicateCode = workflow.nodes.find((node) => node.name === edgeTargets(workflow, "IF Lock Dup", 0)[0]);
  assert.equal(duplicateCode.name, "Build Submission In Progress");
  assert.deepEqual(runCode(duplicateCode, {}), [{ json: {
    ok: false,
    persisted: false,
    duplicate: true,
    error: "submission_in_progress",
  } }]);
  const duplicateResponse = workflow.nodes.find((node) => node.name === edgeTargets(workflow, duplicateCode.name)[0]);
  assert.equal(duplicateResponse.parameters.options.responseCode, 409);
  assert.equal(edgeTargets(workflow, duplicateResponse.name).length, 0);
  assert.equal(edgeTargets(workflow, "IF Lock Dup", 0).includes("Aggregate"), false);
  const sheet = workflow.nodes.find((node) => node.type === "n8n-nodes-base.googleSheets");
  assert.deepEqual(edgeTargets(workflow, sheet.name, 0), ["Aggregate"]);
});

test("Gmail keeps behavior with bounded retries while only owned topology changes", () => {
  const original = source();
  const workflow = candidate();
  const gmail = workflow.nodes.find((node) => node.type === "n8n-nodes-base.gmail");
  assert.equal(gmail.retryOnFail, true);
  assert.equal(gmail.maxTries, 2);
  assert.equal(gmail.waitBetweenTries, 1000);
  assert.equal(gmail.continueOnFail, true);

  const sheetName = original.nodes.find((node) => node.type === "n8n-nodes-base.googleSheets").name;
  for (const [name, connection] of Object.entries(original.connections)) {
    if (name === "IF Lock Dup") continue;
    const expected = structuredClone(connection);
    if (name === sheetName) expected.main.push([]);
    const actual = structuredClone(workflow.connections[name]);
    if (name === sheetName) actual.main[1] = [];
    assert.deepEqual(actual, expected, name);
  }
});

test("candidate CLI requires an explicit caller-supplied output path without building", () => {
  assert.throws(() => parseCandidateArguments([]), /--out/);
  assert.throws(() => parseCandidateArguments(["build", "--out"]), /--out/);
  const parsed = parseCandidateArguments(["build", "--out", "relative-new-directory"]);
  assert.equal(parsed.outputDirectory, path.resolve("relative-new-directory"));
});

test("in-memory package has deterministic raw and semantic hashes without consent timestamp or digest fields", () => {
  const first = buildCandidatePackage(source());
  const second = buildCandidatePackage(source());
  assert.deepEqual(first, second);
  assert.equal(first.manifest.schema, "pkc-n8n-phase-one-consent-persistence-candidate-v1");
  assert.deepEqual(first.manifest.n8n, N8N_IMAGE);
  assert.equal(first.manifest.source.rawSha256, SOURCE_AUTHORITY.rawSha256);
  assert.equal(first.manifest.source.semanticSha256, SOURCE_AUTHORITY.canonicalSha256);
  assert.equal(first.manifest.candidate.rawSha256, crypto.createHash("sha256").update(first.workflowBytes).digest("hex"));
  assert.equal(first.manifest.candidate.semanticSha256, semanticHash(first.workflow));
  assert.equal(first.manifest.candidate.active, false);
  assert.equal(first.manifest.candidate.id, CANDIDATE_ID);
  assert.equal(first.manifest.candidate.nodeCount, 21);
  assert.doesNotMatch(first.workflowBytes, /consent(?:Timestamp|Digest)|consent_(?:timestamp|digest)/i);
});
