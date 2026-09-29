import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { assertCompleteN8nGate, assertSerializedN8nGate } from "../support/n8n-gate-assertions.mjs";
import { authorityMode, authorityRegistry, loadAuthority } from "../support/n8n-authority-fixture.mjs";

const complete = () => assertCompleteN8nGate({ inputs: loadAuthority(), registry: authorityRegistry });
const EXPECTED_SYNTHETIC_PINS = Object.freeze([
  ["login", "wfDsutVsW15DHGr3", "70b399d886b5744dcda715e2c8e699db4e39491e641ba31be8209703336ef18a"],
  ["bootstrap", "nvgxxBPinPmsEmZq", "e0800cd6dcbb575e12818f3a72fd990467f1c38d35e80661eb9a089eb6ece0f4"],
  ["profile", "uuNgivASLQZ08gX7", "ec921599820986e3ccaaa3fd616ba3d8a4ecedf8f2cb8736fa4ea66c9e1b7825"],
  ["sessions", "GVVnbelFG97UjJDw", "65dcfc4a52cd51d5f98d40a0407ed1b212b19c3587f4541571e8a5bf33e08c02"],
  ["revoke", "W63ETZfmKVI7UDFW", "fef65b25730ae7b93acc528f4f3f7a72dc619bc0e33807d52e9b6c2176824433"],
  ["logout", "jb0I4CqlJuuG6fXs", "38fe59267d06b8dfe678059e29f2dfbc2f51a0437ee0ee9b74d156c1bcd4c615"],
]);

function mutateResult(mutator) {
  const result = structuredClone(complete());
  mutator(result);
  for (const artifact of result.artifacts) {
    artifact.rawSha256 = crypto.createHash("sha256").update(`${JSON.stringify(artifact.workflow, null, 2)}\n`).digest("hex");
    const manifestEntry = result.manifest.artifacts.find((entry) => entry.role === artifact.role);
    manifestEntry.rawSha256 = artifact.rawSha256;
  }
  return result;
}

test("the complete gate engine accepts the selected authority without mode exceptions", () => {
  const result = complete();
  assert.equal(result.artifacts.length, 9);
});

test("synthetic authority uses independently pinned registry literals", { skip: authorityMode !== "synthetic" ? "synthetic pin authority is not selected" : false }, () => {
  assert.deepEqual(authorityRegistry.map((entry) => [entry.role, entry.id, entry.sourceFingerprint]), EXPECTED_SYNTHETIC_PINS);
  const source = fs.readFileSync(new URL("../../scripts/n8n-synthetic-authority.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /WORKFLOW_REGISTRY|createRegistryForInputs/);
});

test("the complete gate engine detects topology mutation", () => {
  const result = mutateResult((candidate) => {
    const login = candidate.artifacts.find((item) => item.role === "login").workflow;
    login.connections.Webhook.main[0][0].node = "Respond Success";
  });
  assert.throws(() => assertSerializedN8nGate(result), /topology|dominate/i);
});

test("the complete gate engine detects founder tuple gate mutation", () => {
  const result = mutateResult((candidate) => {
    const login = candidate.artifacts.find((item) => item.role === "login").workflow;
    for (const node of login.nodes) if (typeof node.parameters?.jsCode === "string") node.parameters.jsCode = node.parameters.jsCode.replaceAll("PK Blick", "PK Other");
  });
  assert.throws(() => assertSerializedN8nGate(result), /founder tuple|founder authority/i);
});

test("the complete gate engine detects finalizer response allowlist and validator mutation", () => {
  const allowlistDrift = mutateResult((candidate) => {
    const finalizer = candidate.artifacts.find((item) => item.role === "finalizer").workflow;
    const response = finalizer.nodes.find((node) => node.type === "n8n-nodes-base.respondToWebhook");
    response.parameters.responseBody = response.parameters.responseBody.replace(" } }}", ", private_value: $json.private_value } }}");
  });
  assert.throws(() => assertSerializedN8nGate(allowlistDrift), /response allowlist/i);

  const validatorDrift = mutateResult((candidate) => {
    const finalizer = candidate.artifacts.find((item) => item.role === "finalizer").workflow;
    finalizer.nodes = finalizer.nodes.filter((node) => node.name !== "Validate Finalizer Public Response");
  });
  assert.throws(() => assertSerializedN8nGate(validatorDrift), /response validator/i);
});

test("the selected registry and fingerprints cannot self-authorize mutable input drift", () => {
  const inputs = loadAuthority();
  inputs[0].nodes[0].parameters.path += "-mutated";
  assert.throws(() => assertCompleteN8nGate({ inputs, registry: authorityRegistry }), /fingerprint drift/i);
});
