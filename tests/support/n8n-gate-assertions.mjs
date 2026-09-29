import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  FINALIZER_PUBLIC_RESPONSE_KEYS,
  artifactPrivacyScan,
  serializeNineArtifacts,
} from "../../scripts/n8n-workflow-as-code.mjs";
import { assertOutboxWorkflowDatabaseContract } from "../../scripts/n8n-outbox-db-contract.mjs";

const LOGIN_SIDE_EFFECTS = Object.freeze([
  "Read User Sessions",
  "Revoke Oldest Session",
  "Append New Session",
  "Update Account (Success)",
  "Audit Success",
  "Respond Success",
]);

function reachable(workflow, from, to, omitted = null) {
  if (from === omitted) return false;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    if (current === to) return true;
    for (const lanes of Object.values(workflow.connections?.[current] || {})) {
      for (const lane of lanes || []) {
        for (const edge of lane || []) {
          if (edge.node !== omitted && !seen.has(edge.node)) {
            seen.add(edge.node);
            queue.push(edge.node);
          }
        }
      }
    }
  }
  return false;
}

function codeSource(node) {
  return typeof node?.parameters?.jsCode === "string" ? node.parameters.jsCode : "";
}

function assertExactTopology(workflow) {
  const names = workflow.nodes.map((node) => node.name);
  assert.equal(new Set(names).size, names.length, "topology contains duplicate node names");
  const known = new Set(names);
  for (const [source, lanes] of Object.entries(workflow.connections || {})) {
    assert.ok(known.has(source), `topology source is missing: ${source}`);
    for (const outputs of Object.values(lanes || {})) {
      for (const lane of outputs || []) for (const edge of lane || []) assert.ok(known.has(edge.node), `topology target is missing: ${edge.node}`);
    }
  }

  const entry = workflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook")?.name;
  assert.ok(entry, "login topology webhook is missing");
  for (const target of LOGIN_SIDE_EFFECTS) assert.ok(known.has(target), `login topology side effect is missing: ${target}`);

  const founderGates = workflow.nodes.filter((node) => {
    const source = codeSource(node);
    return source.includes("PKC_FOUNDER_SUBJECT") && source.includes("PK Blick") && source.includes("is_admin");
  });
  assert.ok(founderGates.length > 0, "founder tuple authority gate is missing");
  assert.ok(founderGates.some((gate) => LOGIN_SIDE_EFFECTS.every((target) => reachable(workflow, entry, target) && !reachable(workflow, entry, target, gate.name))), "founder authority gate must dominate every login success side effect");

  const founderSource = founderGates.map(codeSource).join("\n");
  assert.match(founderSource, /PKC_FOUNDER_SUBJECT/, "founder tuple must bind the configured UUID subject");
  assert.match(founderSource, /(?:username[^\n]{0,120}===\s*['"]PK Blick['"]|['"]PK Blick['"][^\n]{0,120}username)/, "founder tuple must bind the exact case-sensitive username");
  assert.match(founderSource, /is_admin/, "founder tuple must bind admin authority");
}

function responseKeys(expression) {
  const body = String(expression || "");
  const object = body.match(/\{\{\s*\{([\s\S]*)\}\s*\}\}/)?.[1];
  if (!object) return [];
  return [...object.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((match) => match[1]).sort();
}

function assertFinalizer(finalizer) {
  const responses = finalizer.nodes.filter((node) => node.type === "n8n-nodes-base.respondToWebhook");
  assert.equal(responses.length, 1, "finalizer must have exactly one public response node");
  assert.deepEqual(responseKeys(responses[0].parameters?.responseBody), [...FINALIZER_PUBLIC_RESPONSE_KEYS].sort(), "finalizer response allowlist drift");

  const validator = finalizer.nodes.find((node) => node.name === "Validate Finalizer Public Response");
  assert.ok(validator, "finalizer response validator is missing");
  const validatorSource = codeSource(validator);
  assert.match(validatorSource, /unexpected_finalizer_response_shape/, "finalizer response validator must fail closed");
  const receipt = Object.fromEntries(FINALIZER_PUBLIC_RESPONSE_KEYS.map((key) => [key, key]));
  Object.assign(receipt, { ok: true, status: "authenticated", receipt_version: 1, auth_epoch: "1", mfa_verified_at: 2, issued_at: 3, expires_at: 4 });
  const execute = (value) => Function("$", validatorSource)((name) => {
    assert.equal(name, "Verify Finalize Grant");
    return { first: () => ({ json: { receipt: value } }) };
  });
  assert.deepEqual(Object.keys(execute(receipt)[0].json).sort(), [...FINALIZER_PUBLIC_RESPONSE_KEYS].sort());
  assert.throws(() => execute({ ...receipt, private_value: "blocked" }), /unexpected_finalizer_response_shape/);

  const verifier = finalizer.nodes.find((node) => /Verify Finalize Grant/.test(node.name));
  assert.ok(verifier, "finalizer grant verifier is missing");
  assert.match(codeSource(verifier), /timingSafeEqual/, "finalizer grant verifier must compare signatures in constant time");
}

function assertQueryReplacementCardinality(workflows) {
  for (const workflow of workflows) {
    for (const node of workflow.nodes.filter((candidate) => candidate.type === "n8n-nodes-base.postgres")) {
      const query = String(node.parameters?.query || "");
      const highest = [...query.matchAll(/\$(\d+)/g)].reduce((value, match) => Math.max(value, Number(match[1])), 0);
      const replacements = node.parameters?.options?.queryReplacement;
      assert.ok(Array.isArray(replacements), `${node.name}: queryReplacement must be an array`);
      assert.equal(replacements.length, highest, `${node.name}: queryReplacement cardinality drift`);
    }
  }
}

export function assertSerializedN8nGate(result) {
  assert.equal(result?.artifacts?.length, 9, "serialization must emit exactly nine artifacts");
  assert.equal(result?.manifest?.artifactCount, 9, "manifest artifact count drift");
  assert.equal(result?.manifest?.sources?.length, 6, "manifest source authority must contain exactly six entries");
  assert.equal(result?.manifest?.artifacts?.length, 9, "manifest artifact authority must contain exactly nine entries");

  const roles = result.artifacts.map((artifact) => artifact.role);
  assert.deepEqual(roles, ["login", "bootstrap", "profile", "sessions", "revoke", "logout", "finalizer", "dispatcher", "rollback-login"]);
  for (const artifact of result.artifacts) {
    const bytes = Buffer.from(`${JSON.stringify(artifact.workflow, null, 2)}\n`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), artifact.rawSha256, `${artifact.role}: serialized byte hash drift`);
  }

  const login = result.artifacts.find((artifact) => artifact.role === "login").workflow;
  const finalizer = result.artifacts.find((artifact) => artifact.role === "finalizer").workflow;
  const dispatcher = result.artifacts.find((artifact) => artifact.role === "dispatcher").workflow;
  assertExactTopology(login);
  assertFinalizer(finalizer);
  assertOutboxWorkflowDatabaseContract(dispatcher);
  assertQueryReplacementCardinality(result.artifacts.map((artifact) => artifact.workflow));
  const privacy = artifactPrivacyScan(result.artifacts.map((artifact) => artifact.workflow));
  assert.equal(privacy.ok, true, `artifact privacy gate failed: ${privacy.findings.join(", ")}`);
  return result;
}

export function assertCompleteN8nGate({ inputs, registry }) {
  assert.ok(Array.isArray(registry), "authority registry must be an array");
  assert.equal(registry.length, 6, "authority registry must contain exactly six entries");
  assert.equal(new Set(registry.map((entry) => entry.id)).size, 6, "authority registry ids must be unique");
  for (const entry of registry) {
    assert.match(entry.sourceFingerprint, /^[0-9a-f]{64}$/, `${entry.role}: source fingerprint pin is malformed`);
    assert.equal(entry.sourceInventorySha256, entry.sourceFingerprint, `${entry.role}: inventory and source fingerprint pins must agree`);
  }
  return assertSerializedN8nGate(serializeNineArtifacts(inputs, { registry }));
}
