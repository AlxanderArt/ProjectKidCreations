import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  FINALIZE_CLAIM_KEYS,
  HANDOFF_CLAIM_KEYS,
  buildFounderMfaFinalizerWorkflow,
  decodeFounderMfaKey,
  patchAccountLoginForFounderMfa,
  patchFounderProfileAuthority,
  patchFounderSessionAuthority,
  verifyFounderFinalizeGrant,
} from "../../scripts/n8n-founder-mfa.mjs";

const codeNode = (name, jsCode) => ({
  name,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  parameters: { language: "javaScript", jsCode },
});

const edge = (node) => ({ node, type: "main", index: 0 });

function loginFixture() {
  return {
    name: "PKC — Account Login fixture",
    active: true,
    staticData: { forbidden: true },
    pinData: { forbidden: [{ json: { password: "fixture-must-not-survive" } }] },
    settings: {
      executionOrder: "v1",
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "all",
      saveExecutionProgress: true,
      saveManualExecutions: true,
    },
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, parameters: { httpMethod: "POST", path: "fixture", responseMode: "responseNode" } },
      codeNode("Init Trace", `const body = ($input.first()?.json?.body) || {};
const username = String(body.username || '').trim();
const password = String(body.password || '');
return [{ json: { request_id: crypto.randomUUID(), username, password } }];`),
      { name: "Read Account", type: "n8n-nodes-base.googleSheets", typeVersion: 4.7, parameters: { operation: "read", filtersUI: { values: [{ lookupColumn: "username", lookupValue: "={{ $('Init Trace').first().json.username }}" }] }, options: {} } },
      codeNode("Verify Credentials", `const crypto = require('crypto');
const trace = $('Init Trace').first().json;
const rows = $('Read Account').all().map(i => i.json);
const account = rows.find(r => String(r.username||'') === trace.username) || null;
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const ok = account && trace.password === account.password_hash;
if (!ok) return [{ json: { ...trace, outcome: 'fail_password', http_status: 401, error_code: 'invalid_credentials' } }];
// SUCCESS — build session + JWT
const secret = $env.PKC_JWT_SECRET;
if (!secret) throw new Error('500: PKC_JWT_SECRET env var not set');
const session_id = crypto.randomUUID();
const iat = Math.floor(nowMs/1000);
const exp = iat + 24*60*60;
const jwt = 'fixture.' + session_id;
const expires_at_iso = new Date(exp*1000).toISOString();
return [{ json: { ...trace, outcome: 'success', http_status: 200, account, session_id, jwt, expires_at_iso, created_at_iso: nowIso, updated_at: nowIso } }];`),
      {
        name: "Route Outcome",
        type: "n8n-nodes-base.switch",
        typeVersion: 3.2,
        onError: "continueErrorOutput",
        parameters: {
          options: { fallbackOutput: "extra", renameFallbackOutput: "fail_other" },
          rules: { values: [
            { conditions: { combinator: "and", conditions: [{ leftValue: "={{ $json.outcome }}", operator: { operation: "equals", type: "string" }, rightValue: "success" }], options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 } }, outputKey: "success", renameOutput: true },
            { conditions: { combinator: "and", conditions: [{ leftValue: "={{ $json.outcome }}", operator: { operation: "equals", type: "string" }, rightValue: "fail_password" }], options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 } }, outputKey: "fail_password", renameOutput: true },
          ] },
        },
      },
      { name: "Read User Sessions", type: "n8n-nodes-base.googleSheets", typeVersion: 4.7, onError: "continueRegularOutput", parameters: { operation: "read", options: {} } },
      codeNode("Pick Oldest Active Session", "return $input.all();"),
      { name: "Append New Session", type: "n8n-nodes-base.googleSheets", typeVersion: 4.7, parameters: { operation: "append", columns: { mappingMode: "defineBelow", matchingColumns: [], schema: [], value: {} }, options: {} } },
      { name: "Audit Success", type: "n8n-nodes-base.googleSheets", typeVersion: 4.7, parameters: { operation: "append", columns: { mappingMode: "defineBelow", matchingColumns: [], schema: [], value: {} }, options: {} } },
      { name: "Respond Success", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.4, parameters: { respondWith: "json", responseBody: "={{ { ok: true } }}", options: { responseCode: 200, responseHeaders: { entries: [{ name: "Set-Cookie", value: "pkc_session=fixture" }] } } } },
      { name: "Respond Fail", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.4, parameters: { respondWith: "json", responseBody: "={{ { ok: false } }}", options: { responseCode: 401 } } },
      { name: "Respond Other", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.4, parameters: { respondWith: "json", responseBody: "={{ { ok: false } }}", options: { responseCode: 423 } } },
    ],
    connections: {
      Webhook: { main: [[edge("Init Trace")]] },
      "Init Trace": { main: [[edge("Read Account")]] },
      "Read Account": { main: [[edge("Verify Credentials")]] },
      "Verify Credentials": { main: [[edge("Route Outcome")]] },
      "Route Outcome": { main: [[edge("Read User Sessions")], [edge("Respond Fail")], [edge("Respond Other")]] },
      "Read User Sessions": { main: [[edge("Pick Oldest Active Session")]] },
      "Pick Oldest Active Session": { main: [[edge("Append New Session")]] },
      "Append New Session": { main: [[edge("Audit Success")]] },
      "Audit Success": { main: [[edge("Respond Success")]] },
    },
  };
}

function nodeByName(workflow, name) {
  const result = workflow.nodes.find((node) => node.name === name);
  assert.ok(result, `missing ${name}`);
  return result;
}

function decodePart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function sign(payload, key) {
  const header = { alg: "HS256", typ: "JWT", kid: payload.kid };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = crypto.createHmac("sha256", key).update(input).digest("base64url");
  return `${input}.${signature}`;
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

function accountSessionToken(payload, secret = "test-jwt-secret") {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function validFinalizeClaims(now = 2_000_000_000) {
  return {
    iss: "pkc-vercel-founder-mfa",
    aud: "pkc-n8n-founder-mfa-finalizer",
    typ: "pkc-founder-mfa-finalize+jwt",
    purpose: "founder_mfa_finalize",
    version: 1,
    kid: "finalize-v1",
    sub: "11111111-1111-4111-8111-111111111111",
    username: "PK Blick",
    is_admin: true,
    jti: "grant-7c37df64-7508-4bf6-a7b9-5f9a70c052a3",
    login_attempt_id: "22222222-2222-4222-8222-222222222222",
    finalize_id: "finalize-599a838d-93ce-46fb-950d-56d50683f47b",
    session_id: "session-631e3812-f74d-43c8-8ac0-5bc36eec85be",
    password_authenticated_at: now - 45,
    mfa_verified_at: now - 10,
    auth_epoch: 4,
    amr: ["pwd", "otp"],
    session_issued_at: now - 10,
    session_expires_at: now + 3600,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 45,
  };
}

test("login transform is deterministic, inactive, and strips export residue", () => {
  const source = loginFixture();
  const first = patchAccountLoginForFounderMfa(source);
  const second = patchAccountLoginForFounderMfa(source);
  assert.deepEqual(first, second);
  assert.equal(source.active, true, "source object must not be mutated");
  assert.equal(first.active, false);
  assert.equal(first.staticData, undefined);
  assert.equal(first.pinData, undefined);
  assert.deepEqual(first.settings, {
    executionOrder: "v1",
    saveDataErrorExecution: "none",
    saveDataSuccessExecution: "none",
    saveExecutionProgress: false,
    saveManualExecutions: false,
  });
  assert.equal(nodeByName(first, "Route Outcome").onError, "continueErrorOutput");
  assert.equal(nodeByName(first, "Read User Sessions").onError, "continueRegularOutput");
});

test("founder password success branches before customer session construction", () => {
  const patched = patchAccountLoginForFounderMfa(loginFixture());
  const init = nodeByName(patched, "Init Trace").parameters.jsCode;
  const verify = nodeByName(patched, "Verify Credentials").parameters.jsCode;
  assert.match(init, /login_attempt_id/);
  assert.match(init, /\^\[0-9a-f\]\{8\}/i);
  assert.match(verify, /founderTuple/);
  assert.match(verify, /PKC_FOUNDER_SUBJECT/);
  assert.match(verify, /account\.account_id/);
  assert.doesNotMatch(verify, /projectkidcreations@gmail\.com/);
  assert.match(verify, /outcome: 'mfa_required'/);
  assert.ok(verify.indexOf("outcome: 'mfa_required'") < verify.indexOf("crypto.randomUUID()"));
  const founderBranch = verify.slice(verify.indexOf("const founderTuple"), verify.indexOf("// SUCCESS — build session + JWT"));
  assert.doesNotMatch(founderBranch, /\.\.\.trace/);
  assert.doesNotMatch(founderBranch, /password\s*[,}]/);
  assert.match(founderBranch, /PKC_FOUNDER_MFA_HANDOFF_KEY/);
  assert.match(founderBranch, /PKC_FOUNDER_MFA_HANDOFF_KID/);
  assert.match(founderBranch, /Buffer\.from\(encodedHandoffKey, 'base64'\)/);
  assert.match(founderBranch, /handoffKey\.toString\('base64'\) !== encodedHandoffKey/);
  for (const key of HANDOFF_CLAIM_KEYS) assert.match(founderBranch, new RegExp(`\\b${key}\\b`), key);
  assert.deepEqual(
    nodeByName(patched, "Route Outcome").parameters.rules.values.map((rule) => rule.outputKey),
    ["mfa_required", "success", "fail_password"],
  );
  assert.equal(patched.connections["Route Outcome"].main[0][0].node, "Respond MFA Required");
  assert.equal(patched.connections["Route Outcome"].main[1][0].node, "Read User Sessions");
});

test("n8n and Vercel use the same canonical 32-byte signing-key representation", () => {
  const bytes = Buffer.alloc(32, 0xa5);
  const encoded = bytes.toString("base64");
  assert.deepEqual(decodeFounderMfaKey(encoded, "test_key"), bytes);
  assert.throws(() => decodeFounderMfaKey(encoded.replace(/=$/, ""), "test_key"), /invalid_test_key/);
  assert.throws(() => decodeFounderMfaKey(Buffer.alloc(31, 1).toString("base64"), "test_key"), /invalid_test_key/);

  const workflow = buildFounderMfaFinalizerWorkflow(loginFixture());
  const source = nodeByName(workflow, "Verify Finalize Grant").parameters.jsCode;
  assert.match(source, /Buffer\.from\(encodedKey, 'base64'\)/);
  assert.match(source, /key\.toString\('base64'\) !== encodedKey/);
});

test("MFA-required response is typed, no-store, and never sets a cookie", () => {
  const patched = patchAccountLoginForFounderMfa(loginFixture());
  const response = nodeByName(patched, "Respond MFA Required");
  const serialized = JSON.stringify(response.parameters);
  assert.match(serialized, /mfa_required/);
  assert.match(serialized, /handoff/);
  assert.match(serialized, /Cache-Control/);
  assert.match(serialized, /no-store/);
  assert.doesNotMatch(serialized, /Set-Cookie/i);
  assert.doesNotMatch(serialized, /password/i);
});

test("login transform rejects malformed topology instead of partially patching", () => {
  const fixture = loginFixture();
  fixture.nodes = fixture.nodes.filter((node) => node.name !== "Route Outcome");
  assert.throws(() => patchAccountLoginForFounderMfa(fixture), /missing node Route Outcome/);
});

test("login transform fails closed if the founder branch anchor moves after session creation", () => {
  const fixture = loginFixture();
  const verify = nodeByName(fixture, "Verify Credentials");
  verify.parameters.jsCode = verify.parameters.jsCode
    .replace("// SUCCESS — build session + JWT\n", "")
    .replace("const session_id = crypto.randomUUID();", "const session_id = crypto.randomUUID();\n// SUCCESS — build session + JWT");
  assert.throws(() => patchAccountLoginForFounderMfa(fixture), /source fingerprint drift|pre-session success anchor/);
});

test("login transform fails closed instead of rerouting customer success", () => {
  const fixture = loginFixture();
  fixture.connections["Route Outcome"].main[0] = [edge("Respond Fail")];
  assert.throws(() => patchAccountLoginForFounderMfa(fixture), /customer success route drift/);
});

test("transformed exact login executes UUID-only founder authority, changed contact email, and duplicate rejection", {
  skip: fs.existsSync("/tmp/pkc-account-login-workflow.json") ? false : "protected workflow snapshot is unavailable",
}, () => {
  const founderSubject = "11111111-1111-4111-8111-111111111111";
  const workflow = patchAccountLoginForFounderMfa(readProtectedSnapshot(protectedSnapshots.login));
  const source = nodeByName(workflow, "Verify Credentials").parameters.jsCode;
  const salt = "test-salt";
  const password = "correct-horse-battery";
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  const account = {
    account_id: founderSubject,
    username: "PK Blick",
    email: "changed-founder-address@example.test",
    is_admin: "TRUE",
    password_hash: `scrypt:${salt}:${hash}`,
    status: "active",
  };
  const trace = { username: "PK Blick", password, login_attempt_id: "22222222-2222-4222-8222-222222222222", request_id: "request-1" };
  const env = {
    PKC_FOUNDER_SUBJECT: founderSubject,
    PKC_FOUNDER_MFA_HANDOFF_KEY: Buffer.alloc(32, 7).toString("base64"),
    PKC_FOUNDER_MFA_HANDOFF_KID: "handoff-v1",
    PKC_JWT_SECRET: "test-jwt-secret",
  };
  const run = (rows, envOverride = env, traceOverride = trace) => executeCode(source, {
    nodes: { "Init Trace": [{ json: traceOverride }], "Read Account": rows.map((row) => ({ json: row })) },
    env: envOverride,
  });
  assert.equal(run([account])[0].json.outcome, "mfa_required");
  assert.throws(
    () => run([account, { ...account, username: "customer_1", is_admin: "FALSE" }]),
    /account_authority_ambiguous/,
    "duplicate immutable founder account_id rows must fail even when mutable usernames differ",
  );
  assert.throws(() => run([account, account]), /account_authority_ambiguous/);
  for (const partial of [
    { ...account, account_id: "33333333-3333-4333-8333-333333333333" },
    { ...account, is_admin: "FALSE" },
  ]) assert.throws(() => run([partial]), /founder_identity_mismatch/);
  assert.throws(() => run([{ ...account, username: "customer_1" }]), /founder_identity_mismatch/);
  assert.throws(() => run([{ ...account, account_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }]), /founder_identity_mismatch/);
  assert.throws(() => run([account], { ...env, PKC_FOUNDER_SUBJECT: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }), /founder_mfa_not_configured/);
  const customer = { ...account, account_id: "44444444-4444-4444-8444-444444444444", username: "customer_1", is_admin: "FALSE" };
  assert.equal(run([customer], env, { ...trace, username: "customer_1" })[0].json.outcome, "success");
});

test("finalizer verifies a closed signed grant and rejects tampering, expiry, and extra claims", () => {
  const now = 2_000_000_000;
  const key = "test-only-finalize-key-not-a-production-secret";
  const claims = validFinalizeClaims(now);
  const verified = verifyFounderFinalizeGrant(sign(claims, key), { key, expectedKid: "finalize-v1", now });
  assert.deepEqual(verified, claims);

  const [head, body, signature] = sign(claims, key).split(".");
  const tampered = { ...decodePart(body), auth_epoch: 5 };
  assert.throws(() => verifyFounderFinalizeGrant(`${head}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`, { key, expectedKid: "finalize-v1", now }), /invalid_finalize_signature/);
  assert.throws(() => verifyFounderFinalizeGrant(sign({ ...claims, exp: now - 1 }, key), { key, expectedKid: "finalize-v1", now }), /expired_finalize_grant/);
  assert.throws(() => verifyFounderFinalizeGrant(sign({ ...claims, unexpected: true }, key), { key, expectedKid: "finalize-v1", now }), /invalid_finalize_claims/);
  assert.throws(() => verifyFounderFinalizeGrant(sign({ ...claims, sub: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, key), { key, expectedKid: "finalize-v1", now }), /invalid_finalize_claims/);
  assert.throws(() => verifyFounderFinalizeGrant(sign({ ...claims, sub: ` ${claims.sub}` }, key), { key, expectedKid: "finalize-v1", now }), /invalid_finalize_claims/);
  assert.throws(() => verifyFounderFinalizeGrant(sign({ ...claims, amr: ["pwd"] }, key), { key, expectedKid: "finalize-v1", now }), /invalid_finalize_claims/);
});

test("inactive finalizer is deterministic and derives session identity only from grant claims", () => {
  const first = buildFounderMfaFinalizerWorkflow(loginFixture());
  const second = buildFounderMfaFinalizerWorkflow(loginFixture());
  assert.deepEqual(first, second);
  assert.equal(first.active, false);
  assert.equal(first.staticData, undefined);
  assert.equal(first.pinData, undefined);
  const source = first.nodes.filter((node) => typeof node.parameters?.jsCode === "string").map((node) => node.parameters.jsCode).join("\n");
  assert.match(source, /PKC_AUTH_KEY/);
  assert.match(source, /PKC_FOUNDER_MFA_FINALIZE_KEY/);
  assert.match(source, /PKC_FOUNDER_MFA_FINALIZE_KID/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /founder_identity_mismatch/);
  assert.match(source, /auth_epoch/);
  assert.match(source, /mfa_verified_at/);
  assert.match(source, /session_id/);
  assert.doesNotMatch(source, /randomUUID|randomBytes/);
  for (const key of FINALIZE_CLAIM_KEYS) assert.match(source, new RegExp(`\\b${key}\\b`), key);
});

test("finalizer preserves founder tuple but never authorizes from Sheet auth_epoch", () => {
  const workflow = buildFounderMfaFinalizerWorkflow(loginFixture());
  const source = nodeByName(workflow, "Verify Finalize Grant").parameters.jsCode;
  assert.match(source, /account\.username === 'PK Blick'/);
  assert.match(source, /account\.account_id/);
  assert.match(source, /claims\.sub/);
  assert.doesNotMatch(source, /projectkidcreations@gmail\.com/);
  assert.match(source, /account\.is_admin/);
  assert.doesNotMatch(source, /account\.auth_epoch/);
  assert.doesNotMatch(source, /claims\.auth_epoch\s*!==\s*currentEpoch/);
});

test("finalizer uses keyed idempotent session and audit projections and a matching receipt", () => {
  const workflow = buildFounderMfaFinalizerWorkflow(loginFixture());
  const session = nodeByName(workflow, "Upsert Founder Session Projection");
  const audit = nodeByName(workflow, "Upsert Founder Audit Projection");
  assert.equal(session.parameters.operation, "appendOrUpdate");
  assert.deepEqual(session.parameters.columns.matchingColumns, ["session_id"]);
  assert.equal(session.parameters.columns.schema.find((field) => field.id === "session_id").required, true);
  assert.equal(session.parameters.columns.schema.find((field) => field.id === "session_id").defaultMatch, true);
  assert.equal(session.parameters.columns.schema.find((field) => field.id === "username").canBeUsedToMatch, false);
  assert.equal(Object.hasOwn(session.parameters.columns.value, "jwt"), false, "bearer JWT must not be persisted");
  assert.equal(audit.parameters.operation, "appendOrUpdate");
  assert.deepEqual(audit.parameters.columns.matchingColumns, ["request_id"]);
  assert.equal(audit.parameters.columns.schema.find((field) => field.id === "request_id").required, true);
  assert.equal(audit.parameters.columns.schema.find((field) => field.id === "request_id").defaultMatch, true);
  assert.match(audit.parameters.columns.value.details_json, /audit_projection\.details_json/);
  assert.match(nodeByName(workflow, "Verify Finalize Grant").parameters.jsCode, /details_json: JSON\.stringify\(\{ finalize_id:/);
  const receipt = nodeByName(workflow, "Respond Finalized");
  assert.match(receipt.parameters.responseBody, /Verify Finalize Grant.*\.json\.receipt/);
  const finalizeSource = nodeByName(workflow, "Verify Finalize Grant").parameters.jsCode;
  for (const field of ["finalize_id", "session_id", "session_token", "grant_jti", "auth_epoch", "mfa_verified_at", "expires_at"]) {
    assert.match(finalizeSource, new RegExp(`receipt[^;]*\\b${field}\\b`, "s"));
  }
});

test("finalizer rejects drifted projection sheet templates", () => {
  const fixture = loginFixture();
  nodeByName(fixture, "Append New Session").parameters.operation = "update";
  assert.throws(() => buildFounderMfaFinalizerWorkflow(fixture), /session projection template drift/);
});

test("all transformed security workflows disable secret-bearing persistence and continue-on-fail", () => {
  for (const workflow of [patchAccountLoginForFounderMfa(loginFixture()), buildFounderMfaFinalizerWorkflow(loginFixture())]) {
    assert.equal(workflow.settings.saveDataErrorExecution, "none");
    assert.equal(workflow.settings.saveDataSuccessExecution, "none");
    assert.equal(workflow.settings.saveExecutionProgress, false);
    assert.equal(workflow.settings.saveManualExecutions, false);
    assert.ok(workflow.nodes.every((node) => node.continueOnFail !== true));
  }
});

const protectedSnapshots = Object.freeze({
  login: "/tmp/pkc-account-login-workflow.json",
  profile: "/tmp/pkc-account-profile-workflow.json",
  sessions: "/tmp/pkc-account-sessions-workflow.json",
});
const protectedSnapshotsAvailable = Object.values(protectedSnapshots).every((file) => fs.existsSync(file));

function readProtectedSnapshot(file) {
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600, `${path.basename(file)} must remain mode 0600`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("profile and session transforms reject an arbitrary Code node masquerading as Verify Session", () => {
  const masquerade = {
    name: "unreviewed",
    active: false,
    settings: {},
    nodes: [codeNode("Verify Session", "return $input.all();"), codeNode("Build Response", "return $input.all();")],
    connections: { "Verify Session": { main: [[edge("Build Response")]] } },
  };
  assert.throws(() => patchFounderProfileAuthority(masquerade), /profile workflow source fingerprint drift/);
  assert.throws(() => patchFounderSessionAuthority(masquerade), /session workflow source fingerprint drift/);
});

test("exact protected profile and session snapshots transform and round-trip offline", {
  skip: protectedSnapshotsAvailable ? false : "protected workflow snapshots are unavailable",
}, () => {
  const profileSource = readProtectedSnapshot(protectedSnapshots.profile);
  const sessionsSource = readProtectedSnapshot(protectedSnapshots.sessions);
  const loginSource = readProtectedSnapshot(protectedSnapshots.login);
  const login = patchAccountLoginForFounderMfa(loginSource);
  const finalizer = buildFounderMfaFinalizerWorkflow(loginSource);
  const profile = patchFounderProfileAuthority(profileSource);
  const sessions = patchFounderSessionAuthority(sessionsSource);

  assert.equal(login.active, false);
  assert.deepEqual(
    nodeByName(finalizer, "Upsert Founder Session Projection").parameters.documentId,
    nodeByName(loginSource, "Append New Session").parameters.documentId,
  );
  assert.deepEqual(
    nodeByName(finalizer, "Upsert Founder Session Projection").parameters.sheetName,
    nodeByName(loginSource, "Append New Session").parameters.sheetName,
  );
  assert.deepEqual(
    nodeByName(finalizer, "Upsert Founder Audit Projection").parameters.sheetName,
    nodeByName(loginSource, "Audit Success").parameters.sheetName,
  );

  const profileGate = nodeByName(profile, "Enforce Founder Profile Assurance");
  assert.match(profileGate.parameters.jsCode, /founder_assurance/);
  assert.match(profileGate.parameters.jsCode, /auth_epoch: sessionEpoch/);
  assert.doesNotMatch(profileGate.parameters.jsCode, /account\.auth_epoch|founder_session_epoch_mismatch/);
  assert.equal(profile.connections["Build Profile Response"].main[0][0].node, profileGate.name);
  assert.equal(profile.connections[profileGate.name].main[0][0].node, "Respond OK");

  const sessionGate = nodeByName(sessions, "Enforce Founder Session Assurance");
  assert.match(sessionGate.parameters.jsCode, /founder_session_assurance_invalid/);
  assert.match(sessionGate.parameters.jsCode, /if \(!founderSession\).*return/i);
  assert.equal(sessions.connections["Build Sessions Response"].main[0][0].node, sessionGate.name);
  assert.equal(sessions.connections[sessionGate.name].main[0][0].node, "Respond OK");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-founder-mfa-offline-"));
  fs.chmodSync(tempRoot, 0o700);
  try {
    for (const [name, workflow] of [["profile", profile], ["sessions", sessions]]) {
      const output = path.join(tempRoot, `${name}.json`);
      fs.writeFileSync(output, `${JSON.stringify(workflow, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      assert.equal(fs.statSync(output).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), workflow);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(profileSource.active, true, "profile source object must not be mutated");
  assert.equal(sessionsSource.active, true, "sessions source object must not be mutated");
  assert.equal(loginSource.active, true, "login source object must not be mutated");
});

test("transformed protected Init Trace nodes execute canonical founder JWT authority and retain customer username subjects", {
  skip: protectedSnapshotsAvailable ? false : "protected workflow snapshots are unavailable",
}, () => {
  const founderSubject = "11111111-1111-4111-8111-111111111111";
  const secret = "test-jwt-secret";
  const now = Math.floor(Date.now() / 1000);
  const founderClaims = {
    sub: founderSubject,
    username: "PK Blick",
    is_admin: true,
    jti: "session-founder",
    iat: now - 5,
    exp: now + 300,
    aud: "pkc-account",
    amr: ["pwd", "otp"],
    auth_epoch: 4,
    mfa_verified_at: now - 5,
  };
  const env = { PKC_AUTH_KEY: "internal-key", PKC_JWT_SECRET: secret, PKC_FOUNDER_SUBJECT: founderSubject };
  const run = (workflow, claims) => executeCode(nodeByName(workflow, "Init Trace").parameters.jsCode, {
    input: [{ json: { headers: { "x-pkc-key": "internal-key", cookie: `pkc_session=${accountSessionToken(claims, secret)}` } } }],
    env,
  })[0].json;

  for (const source of [protectedSnapshots.profile, protectedSnapshots.sessions]) {
    const workflow = source === protectedSnapshots.profile
      ? patchFounderProfileAuthority(readProtectedSnapshot(source))
      : patchFounderSessionAuthority(readProtectedSnapshot(source));
    assert.equal(run(workflow, founderClaims)._failed, false);
    assert.equal(run(workflow, founderClaims).username, "PK Blick");
    assert.equal(run(workflow, { sub: "customer_1", jti: "session-customer", iat: now - 5, exp: now + 300, aud: "pkc-account" }).username, "customer_1");
    for (const hostile of [
      { ...founderClaims, sub: "PK Blick" },
      { ...founderClaims, username: undefined },
      { ...founderClaims, is_admin: false },
      { ...founderClaims, extra: true },
    ]) assert.equal(run(workflow, hostile)._failed, true, JSON.stringify(hostile));
  }
});

test("transformed protected profile output projects one exact canonical account_id", {
  skip: protectedSnapshotsAvailable ? false : "protected workflow snapshots are unavailable",
}, () => {
  const founderSubject = "11111111-1111-4111-8111-111111111111";
  const workflow = patchFounderProfileAuthority(readProtectedSnapshot(protectedSnapshots.profile));
  const source = nodeByName(workflow, "Build Profile Response").parameters.jsCode;
  const account = { account_id: founderSubject, username: "PK Blick", email: "changed@example.test", is_admin: "TRUE" };
  const nodes = {
    "Init Trace": [{ json: { username: "PK Blick", account_id: founderSubject, request_id: "request-1", trace_start_ms: Date.now() } }],
    "Read Account": [{ json: account }],
  };
  const result = executeCode(source, { nodes })[0].json;
  assert.equal(result.profile.account_id, founderSubject);
  assert.throws(() => executeCode(source, {
    nodes: {
      ...nodes,
      "Read Account": [{ json: account }, { json: { ...account, username: "customer_1", is_admin: "FALSE" } }],
    },
  }), /account_authority_ambiguous/);
  assert.throws(() => executeCode(source, { nodes: { ...nodes, "Read Account": [{ json: account }, { json: account }] } }), /account_authority_ambiguous/);
});

test("transformed protected session assurance preserves legacy customers and fails closed on founder identity conflicts", {
  skip: protectedSnapshotsAvailable ? false : "protected workflow snapshots are unavailable",
}, () => {
  const founderSubject = "11111111-1111-4111-8111-111111111111";
  const workflow = patchFounderSessionAuthority(readProtectedSnapshot(protectedSnapshots.sessions));
  const source = nodeByName(workflow, "Enforce Founder Session Assurance").parameters.jsCode;
  const item = { sessions: [{ session_id: "session-1" }] };
  const trace = { username: "customer_1", session_id: "session-1" };
  const env = { PKC_FOUNDER_SUBJECT: founderSubject };
  const run = (rows, traceOverride = trace) => executeCode(source, {
    input: [{ json: item }],
    nodes: {
      "Init Trace": [{ json: traceOverride }],
      "Read Current Session": rows.map((row) => ({ json: row })),
    },
    env,
  });
  const customer = { session_id: "session-1", username: "customer_1" };

  for (const legacy of [
    customer,
    { ...customer, account_id: null },
    { ...customer, account_id: "" },
  ]) assert.deepEqual(run([legacy]), [{ json: item }]);

  for (const invalid of [
    { ...customer, account_id: "malformed" },
    { ...customer, account_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    { ...customer, account_id: ` ${founderSubject}` },
    { ...customer, account_id: `${founderSubject} ` },
    { ...customer, account_id: founderSubject },
    { ...customer, username: "PK Blick" },
    { ...customer, account_id: "22222222-2222-4222-8222-222222222222", username: "PK Blick" },
  ]) assert.throws(() => run([invalid]), /founder_session_assurance_invalid/, JSON.stringify(invalid));

  const founder = {
    session_id: "session-1",
    account_id: founderSubject,
    username: "PK Blick",
    auth_epoch: "4",
    amr: "pwd otp",
    mfa_verified_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
  };
  assert.deepEqual(run([founder], { username: "PK Blick", account_id: founderSubject, session_id: "session-1" })[0].json.founder_assurance.amr, ["pwd", "otp"]);
  assert.throws(() => run([{ ...founder, amr: "pwd" }], { username: "PK Blick", account_id: founderSubject, session_id: "session-1" }), /founder_session_assurance_invalid/);
  assert.throws(() => run([customer, customer]), /session_authority_ambiguous/);
});

test("transformed profile and session gates reject duplicate authority rows at runtime", {
  skip: protectedSnapshotsAvailable ? false : "protected workflow snapshots are unavailable",
}, () => {
  const founderSubject = "11111111-1111-4111-8111-111111111111";
  const account = { account_id: founderSubject, username: "PK Blick", is_admin: "TRUE" };
  const session = { session_id: "session-1", account_id: founderSubject, username: "PK Blick", auth_epoch: "4", amr: "pwd otp", mfa_verified_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
  const env = { PKC_FOUNDER_SUBJECT: founderSubject };

  const profile = patchFounderProfileAuthority(readProtectedSnapshot(protectedSnapshots.profile));
  const profileSource = nodeByName(profile, "Enforce Founder Profile Assurance").parameters.jsCode;
  const profileNodes = {
    "Init Trace": [{ json: { username: "PK Blick", account_id: founderSubject, session_id: "session-1" } }],
    "Read Account": [{ json: account }, { json: account }],
    "Read Sessions": [{ json: session }],
  };
  assert.throws(() => executeCode(profileSource, { input: [{ json: { profile: account } }], nodes: profileNodes, env }), /account_authority_ambiguous/);
  assert.throws(() => executeCode(profileSource, {
    input: [{ json: { profile: account } }],
    nodes: {
      ...profileNodes,
      "Read Account": [{ json: account }, { json: { ...account, username: "customer_1", is_admin: "FALSE" } }],
    },
    env,
  }), /account_authority_ambiguous/);

  const sessions = patchFounderSessionAuthority(readProtectedSnapshot(protectedSnapshots.sessions));
  const sessionSource = nodeByName(sessions, "Enforce Founder Session Assurance").parameters.jsCode;
  const sessionNodes = {
    "Init Trace": [{ json: { username: "PK Blick", session_id: "session-1" } }],
    "Read Current Session": [{ json: session }, { json: session }],
  };
  assert.throws(() => executeCode(sessionSource, { input: [{ json: { sessions: [] } }], nodes: sessionNodes, env }), /session_authority_ambiguous/);
});

test("protected transforms fail closed on exact workflow and projection-locator drift", {
  skip: protectedSnapshotsAvailable ? false : "protected workflow snapshots are unavailable",
}, () => {
  const profile = readProtectedSnapshot(protectedSnapshots.profile);
  nodeByName(profile, "Build Profile Response").parameters.jsCode += "\n// unreviewed drift";
  assert.throws(() => patchFounderProfileAuthority(profile), /profile workflow source fingerprint drift/);

  const sessions = readProtectedSnapshot(protectedSnapshots.sessions);
  sessions.connections["Build Sessions Response"].main[0] = [edge("Respond Fail Session")];
  assert.throws(() => patchFounderSessionAuthority(sessions), /session workflow source fingerprint drift/);

  const login = readProtectedSnapshot(protectedSnapshots.login);
  nodeByName(login, "Append New Session").parameters.sheetName.value = "unreviewed-sheet-drift";
  assert.throws(() => buildFounderMfaFinalizerWorkflow(login), /session projection template drift/);
});

test("claim key constants are closed and stable", () => {
  assert.deepEqual(HANDOFF_CLAIM_KEYS, ["aud", "exp", "iat", "is_admin", "iss", "jti", "kid", "login_attempt_id", "nbf", "password_authenticated_at", "purpose", "sub", "typ", "username", "version"]);
  assert.deepEqual(FINALIZE_CLAIM_KEYS, ["amr", "aud", "auth_epoch", "exp", "finalize_id", "iat", "is_admin", "iss", "jti", "kid", "login_attempt_id", "mfa_verified_at", "nbf", "password_authenticated_at", "purpose", "session_expires_at", "session_id", "session_issued_at", "sub", "typ", "username", "version"]);
});
