import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseCandidateArguments } from "../../scripts/n8n-phase-one-candidate.mjs";
import {
  CANDIDATE_ID, CANDIDATE_NAME, CANDIDATE_PATH, CONSENT_KEYS, INPUT_KEYS, N8N_IMAGE,
  POSTGRES_RUNTIME_CREDENTIAL_NAME, SOURCE_AUTHORITY, buildCandidatePackage,
  deriveConsentPersistenceCandidate, loadBoundSourceWorkflow, parseBoundedJson,
  readJsonDescriptorSafe, semanticHash, serializeDeterministic,
} from "../../scripts/n8n-phase-one-persistence.mjs";

const source = () => loadBoundSourceWorkflow().value;
const candidate = () => deriveConsentPersistenceCandidate(source());
const targets = (workflow, name, output = 0) => (workflow.connections?.[name]?.main?.[output] || []).map(({ node }) => node);

function validPayload() {
  const payload = { version: "v1", submissionId: "synthetic-submission-0001", firstName: "Example", lastName: "Person", email: "example.invalid@example.test", minimumAgeConfirmed: true, termsAccepted: true, privacyAcknowledged: true, policyVersion: "pkc-onboarding-14-plus-v1" };
  payload.hash = crypto.createHash("sha256").update([payload.firstName, payload.lastName, payload.email, payload.submissionId, payload.version].join("|")).digest("hex");
  return payload;
}
function runCode(node, json) {
  const item = { json: structuredClone(json) };
  return Function("$input", "$env", "$execution", "$", "require", node.parameters.jsCode)(
    { first: () => item, all: () => [item] }, {}, { id: "synthetic" }, () => ({ first: () => item, all: () => [item] }), () => crypto,
  );
}

test("descriptor reader and bounded parser reject hostile source inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-phase-one-hostile-"));
  try {
    const valid = path.join(root, "valid.json"); fs.writeFileSync(valid, '{"a":1}', { mode: 0o600 });
    const link = path.join(root, "link.json"); fs.symlinkSync(valid, link);
    assert.throws(() => readJsonDescriptorSafe(link, { protectedInput: true }), /ELOOP|symbolic/i);
    const duplicate = path.join(root, "duplicate.json"); fs.writeFileSync(duplicate, '{"a":1,"a":2}', { mode: 0o600 });
    assert.throws(() => readJsonDescriptorSafe(duplicate, { protectedInput: true }), /duplicate key/i);
    assert.throws(() => parseBoundedJson(`${"[".repeat(90)}0${"]".repeat(90)}`), /depth bound/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("protected native source remains immutably bound", () => {
  const loaded = loadBoundSourceWorkflow();
  assert.equal(loaded.rawSha256, SOURCE_AUTHORITY.rawSha256);
  assert.equal(loaded.canonicalSha256, SOURCE_AUTHORITY.canonicalSha256);
  const drift = structuredClone(loaded.value); drift.updatedAt = "2026-09-26T19:38:49.278Z";
  assert.throws(() => deriveConsentPersistenceCandidate(drift), /source authority drift/i);
});

test("durable candidate is deterministic, inactive, minimized, and credential-ID-free", () => {
  const input = source(); const before = serializeDeterministic(input);
  const first = deriveConsentPersistenceCandidate(input); const second = deriveConsentPersistenceCandidate(input);
  assert.equal(serializeDeterministic(input), before);
  assert.deepEqual(first, second);
  assert.equal(first.name, CANDIDATE_NAME); assert.equal(first.id, CANDIDATE_ID); assert.equal(first.active, false);
  assert.equal(first.nodes.find((node) => node.type === "n8n-nodes-base.webhook").parameters.path, CANDIDATE_PATH);
  assert.equal(first.settings.availableInMCP, false);
  assert.deepEqual({ error: first.settings.saveDataErrorExecution, success: first.settings.saveDataSuccessExecution, progress: first.settings.saveExecutionProgress, manual: first.settings.saveManualExecutions }, { error: "none", success: "none", progress: false, manual: false });
  for (const node of first.nodes) for (const reference of Object.values(node.credentials || {})) assert.deepEqual(Object.keys(reference), ["name"]);
});

test("closed consent input and legacy digest remain enforced before PostgreSQL claim", () => {
  const workflow = candidate();
  const intake = workflow.nodes.find((node) => node.parameters?.jsCode?.includes("pkc_consent_schema_invalid"));
  const hash = workflow.nodes.find((node) => node.name === "Hash Verify");
  const payload = validPayload();
  const accepted = runCode(intake, { body: payload, headers: {} });
  assert.equal(accepted.length, 1);
  assert.equal(runCode(hash, accepted[0].json)[0].json._meta.hashOk, true);
  for (const key of CONSENT_KEYS) assert.equal(accepted[0].json[key], payload[key]);
  for (const mutate of [(value) => { delete value.termsAccepted; }, (value) => { value.extra = true; }, (value) => { value.minimumAgeConfirmed = 1; }]) {
    const hostile = structuredClone(payload); mutate(hostile);
    assert.throws(() => runCode(intake, { body: hostile, headers: {} }), /pkc_consent_(?:schema|value)_invalid/);
  }
});

test("PostgreSQL claim binds a server-derived digest over the complete closed onboarding payload", () => {
  const workflow = candidate();
  const enrich = workflow.nodes.find((node) => node.name === "Enrich");
  const claim = workflow.nodes.find((node) => node.name === "Claim Submission + Block Email");
  assert.match(enrich.parameters.jsCode, /serverRequestDigest/);
  for (const key of INPUT_KEYS.filter((key) => key !== "hash")) {
    assert.match(enrich.parameters.jsCode, new RegExp(`\\b${key}\\b`), key);
  }
  assert.match(claim.parameters.options.queryReplacement[1], /serverRequestDigest/);
  assert.doesNotMatch(claim.parameters.options.queryReplacement[1], /\.json\.hash\b/);
  assert.match(claim.parameters.options.queryReplacement[3], /persistenceWorkerId/);
});

test("PostgreSQL owns claim/release while Sheets remains explicit and Gmail/static authority is absent", () => {
  const workflow = candidate();
  const claim = workflow.nodes.find((node) => node.name === "Claim Submission + Block Email");
  const release = workflow.nodes.find((node) => node.name === "Release Email After Sheets Persistence");
  const sheet = workflow.nodes.find((node) => node.type === "n8n-nodes-base.googleSheets");
  assert.equal(claim.type, "n8n-nodes-base.postgres");
  assert.equal(release.type, "n8n-nodes-base.postgres");
  assert.deepEqual(claim.credentials, { postgres: { name: POSTGRES_RUNTIME_CREDENTIAL_NAME } });
  assert.match(claim.parameters.query, /claim_onboarding_submission/);
  assert.match(release.parameters.query, /mark_onboarding_submission_persisted/);
  assert.deepEqual(Object.keys(sheet.parameters.columns.value).sort(), [...INPUT_KEYS].sort());
  assert.deepEqual(targets(workflow, "Enrich"), [claim.name]);
  assert.deepEqual(targets(workflow, "Needs Sheets Persistence", 1), ["Submission Already Persisted"]);
  assert.deepEqual(targets(workflow, "Submission Already Persisted", 0), ["Build Already Persisted Response"]);
  assert.deepEqual(targets(workflow, "Submission Already Persisted", 1), ["Build Persistence Failure"]);
  assert.deepEqual(targets(workflow, "Needs Sheets Persistence", 0), ["Lookup Existing Sheet Submission"]);
  assert.deepEqual(targets(workflow, "Lookup Existing Sheet Submission"), ["Classify Existing Sheet Submission"]);
  assert.deepEqual(targets(workflow, "Existing Sheet Row Is Exact", 0), [release.name]);
  assert.deepEqual(targets(workflow, "Existing Sheet Row Is Exact", 1), ["Sheets Append"]);
  assert.deepEqual(targets(workflow, "Sheets Append", 0), [release.name]);
  assert.match(release.parameters.options.queryReplacement[3], /persistence_fence/);
  assert.equal(workflow.nodes.some((node) => node.type === "n8n-nodes-base.gmail"), false);
  assert.doesNotMatch(JSON.stringify(workflow), /\$getWorkflowStaticData|staticData/);
});

test("success acknowledges durable Sheets persistence and queued email only", () => {
  const workflow = candidate();
  const response = workflow.nodes.find((node) => node.name === "Response Builder");
  assert.match(response.parameters.jsCode, /email:'queued'/);
  assert.doesNotMatch(response.parameters.jsCode, /accepted|failed|sent|delivered/);
  const failure = workflow.nodes.find((node) => node.name === "Respond Persistence Unavailable");
  assert.equal(failure.parameters.options.responseCode, 503);
  assert.doesNotMatch(failure.parameters.responseBody, /\$json|email|submissionId|stack|message/);
});

test("candidate package hashes final inactive bytes and CLI requires a caller path", () => {
  const first = buildCandidatePackage(source()); const second = buildCandidatePackage(source());
  assert.deepEqual(first, second); assert.deepEqual(first.manifest.n8n, N8N_IMAGE);
  assert.equal(first.manifest.candidate.rawSha256, crypto.createHash("sha256").update(first.workflowBytes).digest("hex"));
  assert.equal(first.manifest.candidate.semanticSha256, semanticHash(first.workflow));
  assert.equal(first.manifest.candidate.active, false);
  assert.throws(() => parseCandidateArguments([]), /--out/);
  assert.equal(parseCandidateArguments(["build", "--out", "relative-new-directory"]).outputDirectory, path.resolve("relative-new-directory"));
});
