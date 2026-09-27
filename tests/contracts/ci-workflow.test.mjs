import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const workflow = await readFile(workflowUrl, "utf8");

const APPROVED_ACTIONS = new Map([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
]);

test("CI uses approved immutable Node 24 action revisions", () => {
  const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s*#.*)?$/gm)]
    .map((match) => ({ action: match[1], revision: match[2] }));

  assert.equal(actionUses.length, 5, "CI action inventory changed; review and approve every action");
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
