import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const workflow = await readFile(workflowUrl, "utf8");
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

const APPROVED_ACTIONS = new Map([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
]);

test("CI uses approved immutable Node 24 action revisions", () => {
  const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s*#.*)?$/gm)]
    .map((match) => ({ action: match[1], revision: match[2] }));

  assert.equal(actionUses.length, 8, "CI action inventory changed; review and approve every action");
  for (const { action, revision } of actionUses) {
    assert.ok(APPROVED_ACTIONS.has(action), `${action} is not an approved CI action`);
    assert.match(revision, /^[0-9a-f]{40}$/, `${action} must use a full immutable SHA`);
    assert.equal(revision, APPROVED_ACTIONS.get(action), `${action} must use its approved Node 24 revision`);
  }
});

test("CI selects the current responsive landing composition contract", () => {
  assert.match(workflow, /landing keeps vertical sections/);
  assert.match(workflow, /PC section navigation/);
  assert.doesNotMatch(workflow, /landing stays centered/);
});

test("CI runs the exact pinned native PostgreSQL harness", () => {
  assert.doesNotMatch(workflow, /^\s*services:\s*\n\s*postgres:/m);
  assert.match(workflow, /docker pull postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea/);
  assert.match(workflow, /npm run test:mfa:postgres/);
});

test("CI runs mandatory permission-isolated synthetic gate coverage without claiming production snapshot evidence", () => {
  assert.match(workflow, /unit-only synthetic workflow fixtures \(not production evidence\)/i);
  assert.match(workflow, /mandatory n8n gate engine with permission-isolated synthetic authority \(not production snapshot evidence\)/i);
  assert.match(workflow, /NODE_VERSION:\s*"24"/);
  assert.match(workflow, /n8n-ci-rehearsal-fixtures\.mjs/);
  assert.doesNotMatch(workflow, /n8n-disposable\/rehearse\.mjs/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.equal(packageJson.scripts["test:contracts"], "node scripts/run-contract-tests.mjs");
  assert.equal(packageJson.scripts["test:contracts:protected"], "node --test tests/contracts/n8n-workflow-as-code.test.mjs tests/contracts/n8n-gate0-authority.test.mjs tests/contracts/n8n-gate-engine.test.mjs");
  assert.equal(packageJson.scripts["test:contracts:protected:synthetic"], "bash scripts/run-synthetic-n8n-gate.sh");
  assert.match(workflow, /permission-isolated synthetic authority[\s\S]*npm run test:contracts:protected:synthetic/i);
});

test("CI runs the complete founder MFA browser suite in Chromium and mobile WebKit", () => {
  assert.match(workflow, /playwright install --with-deps chromium webkit/);
  assert.match(workflow, /tests\/e2e\/founder-mfa\.spec\.mjs[\s\S]*--project=desktop-chromium[\s\S]*--project=mobile-webkit/);
});

test("CI stays secretless with read-only repository contents", () => {
  assert.match(workflow, /^permissions:\s*\n\s*contents:\s*read$/m);
  assert.doesNotMatch(workflow, /secrets\s*\./);
  assert.doesNotMatch(workflow, /contents:\s*write/);
});
