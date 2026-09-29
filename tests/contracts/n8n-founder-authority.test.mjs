import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OWNER_USERNAME,
  authenticateInternalRequest,
  canonicalizeUsername,
  classifyProvisioningIdentity,
  patchAccountWorkflow,
} from "../../scripts/n8n-founder-authority.mjs";

const node = (name, jsCode = "") => ({
  name,
  type: "n8n-nodes-base.code",
  parameters: { jsCode },
});

function fixture(id) {
  const fixtures = {
    nvgxxBPinPmsEmZq: {
      id,
      name: "PKC — Account Bootstrap",
      nodes: [
        node("Init Trace", "const username = String(body.username || '').trim().toLowerCase();\nif (!/^[a-z0-9_.-]{3,32}$/.test(username)) {}"),
        node("Issue Token", "const trace = $('Init Trace').first().json;\nconst existing = $input.all().map(i => i.json);\nconst account = existing.find(r => String(r.username||'').toLowerCase() === trace.username);\nreturn [{ json: { account } }];"),
        node("Build New Account Row", "const trace = $('Issue Token').first().json;\nconst now = new Date().toISOString();\ndisplay_name: trace.first_name || trace.username,\nis_admin: 'FALSE',"),
        node("redeem-init", "const username = String(body.username||'').trim().toLowerCase();"),
        node("redeem-validate", "if (String(entry.username).toLowerCase() !== trace.username) return [];\nreturn [{ json: { ...trace, _valid: true, submission_id: entry.submission_id, email: entry.email } }];"),
        node("redeem-hash-and-sign", "const trace = $('redeem-validate').first().json;\nconst rows = $input.all().map(i => i.json);\nconst acct = rows.find(r => r && String(r.username||'').toLowerCase() === trace.username) || null;\nif (acct && acct.password_hash) throw new Error('409: already_redeemed');\nreturn [{ json: { acct } }];"),
      ],
      connections: {
        "Already-Redeemed Response": { main: [[{ node: "Build Result", type: "main", index: 0 }]] },
      },
    },
    wfDsutVsW15DHGr3: {
      id,
      name: "PKC — Account Login",
      nodes: [
        node("Init Trace", "const username = String(body.username || '').trim().toLowerCase();\nif (!/^[a-z0-9_.-]{3,32}$/.test(username)) {}"),
        node("Verify Credentials", "const account = rows.find(r => String(r.username||'').toLowerCase() === trace.username) || null;\n// Locked permanently"),
      ],
      connections: {},
    },
    uuNgivASLQZ08gX7: {
      id,
      name: "PKC — Account Get Profile",
      nodes: [node("Init Trace", "username: String(payload.sub || '').toLowerCase(),")],
      connections: {},
    },
    downstream: {
      id,
      name: "Downstream account authority fixture",
      nodes: [
        node("Session", "username: String(payload.sub || '').toLowerCase(),\nelse if (String(row.username||'').toLowerCase() !== String(init.username||'').toLowerCase()) {}"),
        node("Reset", "const username=String(entry.username||'').toLowerCase();\nconst acct=rows.find(r=>String(r.username||'').toLowerCase()===trace.username);"),
        node("Ownership", "if (String(target.username || '').toLowerCase() !== String(trace.username || '').toLowerCase()) {}"),
        node("Activity", "const mine = rows.filter(r => String(r.target_username || '').toLowerCase() === String(trace.username || '').toLowerCase());"),
      ],
      connections: {},
    },
  };
  return structuredClone(fixtures[id]);
}

function executeCode(source, { input = [], nodes = {} } = {}) {
  const items = Array.isArray(input) ? input : [input];
  const $input = { first: () => items[0], all: () => items };
  const $ = (name) => ({ first: () => nodes[name]?.[0], all: () => nodes[name] || [] });
  return Function("$input", "$", source)($input, $);
}

test("the sole Founder identity keeps exact case and space", () => {
  assert.equal(OWNER_USERNAME, "PK Blick");
  assert.equal(canonicalizeUsername(" PK Blick "), "PK Blick");
  assert.equal(canonicalizeUsername("ordinary_user"), "ordinary_user");
  assert.equal(canonicalizeUsername("Ordinary_User"), "ordinary_user");
  assert.throws(() => canonicalizeUsername("PK blick"), /reserved_owner_identity/);
  assert.throws(() => canonicalizeUsername("Another Founder"), /invalid_username/);
});

test("Founder authority requires configured UUID, exact username, and admin; email is irrelevant", () => {
  const subject = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    classifyProvisioningIdentity({ account_id: subject, username: "PK Blick", is_admin: true, email: "changed@example.test" }, subject),
    { accountId: subject, username: OWNER_USERNAME, isOwner: true },
  );
  assert.deepEqual(
    classifyProvisioningIdentity({ account_id: "22222222-2222-4222-8222-222222222222", username: "customer_1", is_admin: false, email: "founder@example.test" }, subject),
    { accountId: "22222222-2222-4222-8222-222222222222", username: "customer_1", isOwner: false },
  );
  for (const account of [
    { account_id: subject, username: "customer_1", is_admin: true },
    { account_id: subject, username: "PK Blick", is_admin: false },
    { account_id: "22222222-2222-4222-8222-222222222222", username: "PK Blick", is_admin: true },
    { account_id: "22222222-2222-4222-8222-222222222222", username: "customer_1", is_admin: true },
  ]) assert.throws(() => classifyProvisioningIdentity(account, subject), /owner_identity_mismatch/);
  for (const founderSubject of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ` ${subject}`, `${subject} `, "malformed"]) {
    assert.throws(() => classifyProvisioningIdentity({ account_id: subject, username: "PK Blick", is_admin: true }, founderSubject), /invalid_founder_subject/);
  }
  for (const accountId of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ` ${subject}`, `${subject} `, "malformed"]) {
    assert.throws(() => classifyProvisioningIdentity({ account_id: accountId, username: "PK Blick", is_admin: true }, subject), /invalid_account_id/);
  }
});

test("internal authentication is exact and fails closed", () => {
  assert.equal(authenticateInternalRequest("secret", "secret"), true);
  assert.equal(authenticateInternalRequest("secret ", "secret"), false);
  assert.equal(authenticateInternalRequest("SECRET", "secret"), false);
  assert.equal(authenticateInternalRequest("", "secret"), false);
  assert.throws(() => authenticateInternalRequest("secret", ""), /PKC_AUTH_KEY missing/);
});

test("bootstrap patch preserves exact owner authority and response branches", () => {
  const patched = patchAccountWorkflow(fixture("nvgxxBPinPmsEmZq"));
  const byName = Object.fromEntries(patched.nodes.map((item) => [item.name, item]));
  assert.match(byName["Init Trace"].parameters.jsCode, /OWNER_USERNAME = 'PK Blick'/);
  assert.match(byName["Init Trace"].parameters.jsCode, /PKC_FOUNDER_SUBJECT/);
  assert.doesNotMatch(byName["Init Trace"].parameters.jsCode, /OWNER_EMAIL/);
  assert.match(byName["Init Trace"].parameters.jsCode, /x-pkc-key/);
  assert.match(byName["Build New Account Row"].parameters.jsCode, /is_owner \? 'TRUE' : 'FALSE'/);
  assert.match(byName["Build New Account Row"].parameters.jsCode, /is_owner \? OWNER_USERNAME/);
  assert.doesNotMatch(byName["Issue Token"].parameters.jsCode, /toLowerCase\(\) === trace\.username/);
  assert.doesNotMatch(byName["redeem-validate"].parameters.jsCode, /String\(entry\.username\)\.toLowerCase/);
  assert.equal(patched.connections["Already-Redeemed Response"], undefined);
});

test("bootstrap token and account selectors execute exact-one cardinality", () => {
  const patched = patchAccountWorkflow(fixture("nvgxxBPinPmsEmZq"));
  const byName = Object.fromEntries(patched.nodes.map((item) => [item.name, item]));
  const account = { account_id: "22222222-2222-4222-8222-222222222222", username: "customer_1", email: "customer@example.test", is_admin: "FALSE", password_hash: "" };
  const issueNodes = { "Init Trace": [{ json: { username: "customer_1", email: "customer@example.test" } }] };
  assert.equal(executeCode(byName["Issue Token"].parameters.jsCode, { input: [{ json: account }], nodes: issueNodes })[0].json.account.username, "customer_1");
  assert.throws(() => executeCode(byName["Issue Token"].parameters.jsCode, { input: [{ json: account }, { json: account }], nodes: issueNodes }), /account_authority_ambiguous/);

  const redeemNodes = { "redeem-validate": [{ json: { username: "customer_1", email: "customer@example.test", is_owner: false } }] };
  assert.equal(executeCode(byName["redeem-hash-and-sign"].parameters.jsCode, { input: [{ json: account }], nodes: redeemNodes })[0].json.acct.username, "customer_1");
  assert.throws(() => executeCode(byName["redeem-hash-and-sign"].parameters.jsCode, { input: [{ json: account }, { json: account }], nodes: redeemNodes }), /account_authority_ambiguous/);
});

test("login patch authenticates internally and uses exact canonical account identity", () => {
  const patched = patchAccountWorkflow(fixture("wfDsutVsW15DHGr3"));
  const byName = Object.fromEntries(patched.nodes.map((item) => [item.name, item]));
  assert.match(byName["Init Trace"].parameters.jsCode, /x-pkc-key/);
  assert.match(byName["Init Trace"].parameters.jsCode, /canonicalUsername/);
  assert.match(byName["Verify Credentials"].parameters.jsCode, /String\(r\.username\|\|''\) === trace\.username/);
  assert.match(byName["Verify Credentials"].parameters.jsCode, /account_id/);
  assert.match(byName["Verify Credentials"].parameters.jsCode, /owner_identity_mismatch/);
});

test("downstream account workflows preserve exact JWT subject", () => {
  const patched = patchAccountWorkflow(fixture("uuNgivASLQZ08gX7"));
  const code = patched.nodes[0].parameters.jsCode;
  assert.match(code, /canonicalUsername\(payload\.sub, payload\)/);
  assert.doesNotMatch(code, /String\(payload\.sub \|\| ''\)\.toLowerCase\(\)/);
});

test("every downstream account comparison preserves canonical identity exactly", () => {
  const patched = patchAccountWorkflow(fixture("downstream"));
  const code = patched.nodes.map((item) => item.parameters.jsCode).join("\n");
  assert.match(code, /canonicalUsername\(payload\.sub, payload\)/);
  assert.match(code, /canonicalUsername\(entry\.username\)/);
  assert.match(code, /String\(row\.username\|\|''\) !== String\(init\.username\|\|''\)/);
  assert.match(code, /String\(r\.username\|\|''\)===trace\.username/);
  assert.match(code, /String\(target\.username \|\| ''\) !== String\(trace\.username \|\| ''\)/);
  assert.match(code, /String\(r\.target_username \|\| ''\) === String\(trace\.username \|\| ''\)/);
});

test("every externally reachable webhook branch requires the internal server key", () => {
  const workflow = {
    id: "webhook-auth",
    name: "Webhook auth fixture",
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { path: "fixture" } },
      node("Init Trace", "const body = $input.first().json.body || {};"),
    ],
    connections: { Webhook: { main: [[{ node: "Init Trace", type: "main", index: 0 }]] } },
  };
  const patched = patchAccountWorkflow(workflow);
  const code = patched.nodes.find((item) => item.name === "Init Trace").parameters.jsCode;
  assert.match(code, /PKC_AUTH_KEY/);
  assert.match(code, /_authHeaders\['x-pkc-key'\]/);
  assert.match(code, /timingSafeEqual/);
  assert.match(code, /401: unauthorized/);
});

test("account webhook patch does not trust authentication-looking comments", () => {
  const workflow = {
    id: "webhook-auth-comments",
    name: "Webhook auth hostile fixture",
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { path: "fixture" } },
      node("Init Trace", "// $env.PKC_AUTH_KEY x-pkc-key\nreturn $input.all();"),
    ],
    connections: { Webhook: { main: [[{ node: "Init Trace", type: "main", index: 0 }]] } },
  };
  const patched = patchAccountWorkflow(workflow);
  const source = patched.nodes.find((item) => item.name === "Init Trace").parameters.jsCode;
  assert.match(source, /timingSafeEqual/);
  assert.ok(source.startsWith("const _authCrypto = require('crypto');"));
});
