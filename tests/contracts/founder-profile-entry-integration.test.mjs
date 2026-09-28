import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import { patchFounderProfileAuthority } from "../../scripts/n8n-founder-mfa.mjs";
import { createEntryStateHandler } from "../../server/api/entry-state.mjs";
import { handleProxy } from "../../server/proxy/core.mjs";

const SNAPSHOT = "/tmp/pkc-account-profile-workflow.json";
const available = fs.existsSync(SNAPSHOT);
const FOUNDER_SUBJECT = "11111111-1111-4111-8111-111111111111";

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `missing ${name}`);
  return node;
}

function executeCode(source, { input = [], nodes = {}, env = {} } = {}) {
  const items = Array.isArray(input) ? input : [input];
  const $input = { first: () => items[0], all: () => items };
  const $ = (name) => ({ first: () => nodes[name]?.[0], all: () => nodes[name] || [] });
  return Function("$input", "$", "$env", "require", "Buffer", source)($input, $, env, (name) => {
    if (name !== "crypto") throw new Error(`unsupported module ${name}`);
    return crypto;
  }, Buffer);
}

function transformedProfile() {
  const workflow = patchFounderProfileAuthority(JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")));
  const account = {
    account_id: FOUNDER_SUBJECT,
    username: "PK Blick",
    email: "changed-founder-address@example.test",
    display_name: "Founder",
    is_admin: "TRUE",
  };
  const now = Date.now();
  const trace = { username: "PK Blick", session_id: "session-1", request_id: "request-1", trace_start_ms: now };
  const session = {
    session_id: "session-1",
    account_id: FOUNDER_SUBJECT,
    username: "PK Blick",
    auth_epoch: "4",
    amr: "pwd otp",
    mfa_verified_at: new Date((Math.floor(now / 1000) - 5) * 1000).toISOString(),
  };
  const nodes = {
    "Init Trace": [{ json: trace }],
    "Read Account": [{ json: account }],
    "Read Sessions": [{ json: session }],
  };
  const built = executeCode(nodeByName(workflow, "Build Profile Response").parameters.jsCode, { nodes });
  return executeCode(nodeByName(workflow, "Enforce Founder Profile Assurance").parameters.jsCode, {
    input: built,
    nodes,
    env: { PKC_FOUNDER_SUBJECT: FOUNDER_SUBJECT },
  })[0].json;
}

function proxyEnv() {
  return {
    PKC_N8N_BASE_URL: "https://n8n.example.test",
    PKC_AUTH_KEY: "internal-key",
    PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test",
    PKC_PUBLIC_ALLOWED_ORIGINS: "https://app.example.test",
    PKC_FOUNDER_SUBJECT: FOUNDER_SUBJECT,
  };
}

function mockResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    payload: "",
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(value) { this.payload = value; },
  };
}

test("transformed profile account_id reaches proxy founder policy", { skip: available ? false : "protected workflow snapshot is unavailable" }, async () => {
  const output = transformedProfile();
  assert.equal(output.profile.account_id, FOUNDER_SUBJECT);
  let calls = 0;
  const response = await handleProxy("accountProfile", new Request("https://app.example.test/api/account/profile", {
    method: "GET",
    headers: { cookie: "pkc_session=session-token" },
  }), {
    env: proxyEnv(),
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(output), { headers: { "content-type": "application/json" } });
    },
    founderAuthority: async () => ({ founderSubject: FOUNDER_SUBJECT, state: "active", authEpoch: 4, revokedBefore: null }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("entry-state rejects noncanonical founder config and account identifiers", { skip: available ? false : "protected workflow snapshot is unavailable" }, async () => {
  const output = transformedProfile();
  let fetches = 0;
  let handler = createEntryStateHandler({
    env: { ...proxyEnv(), PKC_FOUNDER_SUBJECT: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    fetch: async () => { fetches += 1; return new Response(JSON.stringify(output)); },
  });
  let res = mockResponse();
  await handler({ method: "GET", headers: { cookie: "pkc_session=session-token" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(fetches, 0);

  const hostile = structuredClone(output);
  hostile.profile.account_id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  handler = createEntryStateHandler({
    env: proxyEnv(),
    fetch: async () => new Response(JSON.stringify(hostile), { headers: { "content-type": "application/json" } }),
  });
  res = mockResponse();
  await handler({ method: "GET", headers: { cookie: "pkc_session=session-token" } }, res);
  assert.equal(res.statusCode, 409);
});

test("transformed profile account_id reaches entry-state owner projection", { skip: available ? false : "protected workflow snapshot is unavailable" }, async () => {
  const output = transformedProfile();
  const handler = createEntryStateHandler({
    env: proxyEnv(),
    fetch: async () => new Response(JSON.stringify(output), { headers: { "content-type": "application/json" } }),
  });
  const res = mockResponse();
  await handler({ method: "GET", headers: { cookie: "pkc_session=session-token" } }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.state, "owner_active");
  assert.equal(body.account.account_id, FOUNDER_SUBJECT);
  assert.equal(body.capabilities.admin, true);
});
