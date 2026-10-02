import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { test } from "node:test";

import { deriveConsentPersistenceCandidate, loadBoundSourceWorkflow, SOURCE_AUTHORITY } from "../../scripts/n8n-phase-one-persistence.mjs";
import { buildOnboardingEmailDispatcherWorkflow, buildOnboardingEmailOutboxPackage, buildOnboardingEmailReconcilerWorkflow } from "../../scripts/n8n-onboarding-email-outbox.mjs";

const edges = (workflow, node, output = 0) => (workflow.connections?.[node]?.main?.[output] || []).map(({ node: target }) => target);
const postgres = (workflow, name) => workflow.nodes.find((node) => node.type === "n8n-nodes-base.postgres" && node.name === name);
const rollout = readFileSync(new URL("../../docs/operations/onboarding-email-outbox-rollout.md", import.meta.url), "utf8");
const protectedSourceOptions = (() => {
  if (process.env.PKC_TEST_PROTECTED_N8N_UNAVAILABLE === "1") {
    return { skip: "protected Phase One workflow authority is unavailable on this runner" };
  }
  try {
    fs.accessSync(SOURCE_AUTHORITY.path, fs.constants.R_OK);
    return {};
  } catch {
    return { skip: "protected Phase One workflow authority is unavailable on this runner" };
  }
})();

for (const [name, build] of [["dispatcher", buildOnboardingEmailDispatcherWorkflow], ["reconciler", buildOnboardingEmailReconcilerWorkflow]]) {
  test(`${name} candidate is inactive, MCP-off, and zero-retention`, () => {
    const workflow = build();
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.availableInMCP, false);
    const identity = workflow.nodes.find((node) => node.name.endsWith("Worker Identity"));
    assert.match(identity.parameters.jsCode, /batch_size:1\b/);
    assert.deepEqual({
      saveDataErrorExecution: workflow.settings.saveDataErrorExecution,
      saveDataSuccessExecution: workflow.settings.saveDataSuccessExecution,
      saveExecutionProgress: workflow.settings.saveExecutionProgress,
      saveManualExecutions: workflow.settings.saveManualExecutions,
    }, { saveDataErrorExecution: "none", saveDataSuccessExecution: "none", saveExecutionProgress: false, saveManualExecutions: false });
  });
}

test("phase-one candidate uses PostgreSQL claim then Sheets persistence release and only returns queued", protectedSourceOptions, () => {
  const workflow = deriveConsentPersistenceCandidate(loadBoundSourceWorkflow().value);
  const serialized = JSON.stringify(workflow);
  assert.equal(workflow.active, false);
  assert.ok(postgres(workflow, "Claim Submission + Block Email"));
  assert.ok(postgres(workflow, "Release Email After Sheets Persistence"));
  assert.deepEqual(edges(workflow, "Enrich"), ["Claim Submission + Block Email"]);
  assert.deepEqual(edges(workflow, "Claim Submission + Block Email"), ["Needs Sheets Persistence"]);
  assert.deepEqual(edges(workflow, "Needs Sheets Persistence", 0), ["Lookup Existing Sheet Submission"]);
  assert.deepEqual(edges(workflow, "Existing Sheet Row Is Exact", 1), ["Sheets Append"]);
  assert.deepEqual(edges(workflow, "Sheets Append", 0), ["Release Email After Sheets Persistence"]);
  assert.doesNotMatch(serialized, /n8n-nodes-base\.gmail|\$getWorkflowStaticData|staticData/);
  const response = workflow.nodes.find((node) => node.name === "Response Builder");
  assert.match(response.parameters.jsCode, /email:\s*['"]queued['"]/);
  assert.doesNotMatch(response.parameters.jsCode, /accepted|failed|sent/);
});

test("dispatcher arms the exact raw Gmail request before one-attempt send and routes uncertainty to ambiguous", () => {
  const workflow = buildOnboardingEmailDispatcherWorkflow();
  const serialized = JSON.stringify(workflow);
  assert.ok(postgres(workflow, "Claim Pending Email"));
  assert.ok(postgres(workflow, "Arm Exact Gmail Request"));
  const send = workflow.nodes.find((node) => node.name === "Send Exact Raw Gmail Request");
  assert.equal(send.type, "n8n-nodes-base.httpRequest");
  assert.equal(send.retryOnFail, undefined);
  assert.equal(send.parameters.method, "POST");
  assert.equal(send.parameters.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.match(serialized, /request_sha256/);
  assert.deepEqual(edges(workflow, "Build Exact Raw Gmail Request"), ["Arm Exact Gmail Request"]);
  assert.deepEqual(edges(workflow, "Arm Exact Gmail Request"), ["Send Exact Raw Gmail Request"]);
  assert.deepEqual(edges(workflow, "Send Exact Raw Gmail Request", 1), ["Mark Gmail API Acceptance Ambiguous"]);
  assert.ok(postgres(workflow, "Record Gmail API Acceptance"));
  assert.doesNotMatch(serialized, /Gmail Delivery|Delivery Ambiguous/);
  assert.doesNotMatch(serialized, /firstName|first_name/);
});

test("reconciler searches Gmail by immutable Message-ID and never sends", () => {
  const workflow = buildOnboardingEmailReconcilerWorkflow();
  const serialized = JSON.stringify(workflow);
  const search = workflow.nodes.find((node) => node.name === "Search Gmail By Message-ID");
  assert.equal(search.type, "n8n-nodes-base.httpRequest");
  assert.equal(search.parameters.method, "GET");
  assert.equal(search.parameters.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages");
  const maxResults = search.parameters.queryParameters.parameters.find(({ name }) => name === "maxResults");
  assert.equal(String(maxResults?.value), "2");
  const labelIds = search.parameters.queryParameters.parameters.find(({ name }) => name === "labelIds");
  assert.equal(labelIds?.value, "SENT");
  assert.match(serialized, /in:sent rfc822msgid/);
  assert.match(serialized, /messages\.length===1/);
  assert.match(serialized, /nextPageToken/);
  assert.doesNotMatch(serialized, /messages\/send|n8n-nodes-base\.gmail/);
  assert.ok(postgres(workflow, "Claim Ambiguous Email"));
  assert.ok(postgres(workflow, "Reconcile Gmail Accepted"));
  assert.ok(postgres(workflow, "Defer Gmail Reconciliation"));
  assert.equal(postgres(workflow, "Claim Ambiguous Email").credentials.postgres.name, "PKC Onboarding Email Reconciler");
  assert.equal(postgres(buildOnboardingEmailDispatcherWorkflow(), "Claim Pending Email").credentials.postgres.name, "PKC Onboarding Email Dispatcher");
});

test("dispatcher and reconciler freeze into deterministic hash-bound package bytes", () => {
  const first = buildOnboardingEmailOutboxPackage();
  const second = buildOnboardingEmailOutboxPackage();
  assert.deepEqual(first, second);
  assert.equal(first.manifest.candidates.length, 2);
  assert.match(first.manifest.n8n.repoDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.manifest.n8n.reference, /@sha256:[0-9a-f]{64}$/);
  for (const candidate of first.manifest.candidates) {
    assert.equal(candidate.active, false);
    assert.match(candidate.sha256, /^[0-9a-f]{64}$/);
  }
});

test("candidate-specific rollout keeps every mutation gated and rollback routing-first", () => {
  for (const marker of [
    "Gate 0 — additive onboarding role provisioning",
    "db/roles/004_onboarding_roles.sql",
    "zero target-database role-setting overrides",
    "Gate 1 — exact migration authorization",
    "Gate 2 — inactive workflow imports",
    "Gate 3 — native runtime and OAuth proof",
    "Gate 4 — worker activation",
    "Gate 5 — isolated intake activation",
    "Gate 6 — separate Preview cutover",
    "Gate 7 — optional canary",
    "Route first",
    "ambiguous",
    "never return to `pending`",
    "projectkidcreations@gmail.com",
  ]) assert.equal(rollout.toLowerCase().includes(marker.toLowerCase()), true, marker);
});
