import assert from "node:assert/strict";
import { test } from "node:test";

import { patchDurableWorkflow } from "../../scripts/n8n-durable-flow.mjs";

const codeNode = (name, jsCode) => ({
  name,
  type: "n8n-nodes-base.code",
  parameters: { jsCode },
});

test("Phase One response proves persisted or duplicate state", () => {
  const workflow = {
    id: "RjsC9WMIDrIisJbl",
    nodes: [codeNode("Response Builder", "const item = $input.first().json;\nconst m = item._meta || {};\nreturn [{ json: { ok: true, duplicate: !!m.duplicate, stage: m.stage_completed || 'unknown' } }];")],
    connections: {},
  };
  const patched = patchDurableWorkflow(workflow);
  const code = patched.nodes[0].parameters.jsCode;
  assert.match(code, /persisted:/);
  assert.match(code, /m\.sheetStatus === 'written'/);
  assert.match(code, /!!m\.duplicate/);
});

test("Phase Three response returns a short-lived signed activation proof from authoritative row data", () => {
  const workflow = {
    id: "s4erDMlvnW8vLIxI",
    nodes: [codeNode("Build Response", "const row = item._row;\nconst launch_mode = item.launch_mode || 'test';\nconst persisted = launch_mode === 'live';\nreturn respond(true, 'SUCCESS', persisted ? 'Profile committed.' : 'Test mode: profile not persisted.', { submissionId: row.submissionId, username: row.username, completed_at: row.completed_at, is_adult: row.is_adult === 'true', persisted });")],
    connections: {},
  };
  const patched = patchDurableWorkflow(workflow);
  const code = patched.nodes[0].parameters.jsCode;
  assert.match(code, /createHmac\('sha256', expectedKey\)/);
  assert.match(code, /submission_id: row\.submissionId/);
  assert.match(code, /email: row\.email/);
  assert.match(code, /expires_at_ms/);
  assert.match(code, /activation_proof/);
  assert.match(code, /const activation_proof = persisted \?/);
  assert.match(code, /if \(!expectedKey\) throw/);
});

test("public bootstrap derives non-owner identity only from a valid activation proof", () => {
  const workflow = {
    id: "nvgxxBPinPmsEmZq",
    nodes: [codeNode("Init Trace", "const body = ($input.first()?.json?.body) || {};\nconst rawUsername = String(body.username || '').trim();\nconst email = String(body.email || '').trim().toLowerCase();\nconst is_owner = ownerByUsername && ownerByEmail;\nconst submission_id = String(body.submission_id || '').trim();")],
    connections: {},
  };
  const patched = patchDurableWorkflow(workflow);
  const code = patched.nodes[0].parameters.jsCode;
  assert.match(code, /activation_proof/);
  assert.match(code, /timingSafeEqual/);
  assert.match(code, /activation_proof_required/);
  assert.match(code, /activation_proof_expired/);
  assert.match(code, /claims\.submission_id/);
  assert.doesNotMatch(code, /rawUsername/);
});

test("unsupported workflows fail closed", () => {
  assert.throws(() => patchDurableWorkflow({ id: "unknown", nodes: [], connections: {} }), /unsupported workflow/);
});
