import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createNodeRouter } from "../../server/api/node-router.mjs";

const PROXY_ROUTES = Object.freeze({
  "/api/phase-two/save": "phaseTwoSave",
  "/api/phase-three/save": "phaseThreeSave",
  "/api/account/login": "accountLogin",
  "/api/account/bootstrap-redeem": "accountBootstrapRedeem",
  "/api/account/password-complete": "accountPasswordComplete",
  "/api/account/password-change": "accountPasswordChange",
  "/api/account/email-change": "accountEmailChange",
  "/api/account/delete": "accountDelete",
  "/api/account/activity": "accountActivity",
  "/api/account/profile": "accountProfile",
  "/api/account/sessions": "accountSessions",
  "/api/account/admin/list": "accountAdminList",
  "/api/account/admin/search": "accountAdminSearch",
  "/api/account/admin/chat": "accountAdminChat",
});

const MFA_ROUTES = Object.freeze({
  "/api/account/mfa-enrollment": "enrollment",
  "/api/account/mfa-verify": "verify",
  "/api/account/mfa-recovery": "recovery",
  "/api/account/mfa-finalize": "finalize",
});

function response() {
  return {
    statusCode: 200,
    headers: new Map(),
    payload: undefined,
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    status(value) { this.statusCode = value; return this; },
    send(value) { this.payload = value; return this; },
    end(value) { this.payload = value; },
  };
}

function fixture() {
  const calls = [];
  const handler = (kind, id) => async (req, res) => {
    calls.push({ kind, id, req, res });
    res.statusCode = 204;
    res.end();
  };
  const router = createNodeRouter({
    proxyHandlerFactory: (id) => handler("proxy", id),
    mfaHandlerFactory: (id) => handler("mfa", id),
    entryStateHandler: handler("entry", "entryState"),
  });
  return { calls, router };
}

test("the Node catch-all dispatches the exact 14 manifest URLs, four MFA URLs, and entry-state", async () => {
  const { calls, router } = fixture();
  const expected = [
    ...Object.entries(PROXY_ROUTES).map(([path, id]) => [path, "proxy", id]),
    ...Object.entries(MFA_ROUTES).map(([path, id]) => [path, "mfa", id]),
    ["/api/account/entry-state", "entry", "entryState"],
  ];

  for (const [path, kind, id] of expected) {
    const req = { method: "TRACE", url: `${path}?preserved=yes` };
    const res = response();
    await router(req, res);
    const call = calls.at(-1);
    assert.deepEqual([call.kind, call.id], [kind, id], path);
    assert.equal(call.req, req, path);
    assert.equal(call.res, res, path);
    assert.equal(call.req.method, "TRACE", path);
    assert.equal(call.req.url, `${path}?preserved=yes`, path);
    assert.equal(res.statusCode, 204, path);
  }
  assert.equal(calls.length, 19);
});

test("the Node catch-all fails closed for unknown and non-canonical request targets", async () => {
  const invalidTargets = [
    "/api/account/unknown",
    "/api/account/Login",
    "/api/account/login/",
    "/api/account%2Flogin",
    "/api/account%2flogin",
    "/api//account/login",
    "//api/account/login",
    "/api/account/../account/login",
    "https://example.test/api/account/login",
    "",
  ];

  for (const url of invalidTargets) {
    const { calls, router } = fixture();
    const res = response();
    await router({ method: "POST", url }, res);
    assert.equal(calls.length, 0, url);
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8", url);
    assert.equal(res.headers.get("cache-control"), "no-store, max-age=0", url);
    assert.deepEqual(JSON.parse(String(res.payload)), { ok: false, error: "not_found" }, url);
  }
});

test("the Node catch-all rejects fragments anywhere in the complete request target", async () => {
  const fragmentTargets = [
    "/api/account/login#malformed",
    "/api/account/login?#malformed",
    "/api/account/login?preserved=yes#malformed",
  ];

  for (const url of fragmentTargets) {
    const { calls, router } = fixture();
    const res = response();
    await router({ method: "POST", url }, res);
    assert.equal(calls.length, 0, url);
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8", url);
    assert.equal(res.headers.get("cache-control"), "no-store, max-age=0", url);
    assert.deepEqual(JSON.parse(String(res.payload)), { ok: false, error: "not_found" }, url);
  }
});

test("the catch-all consumes founder handoffs internally and never returns them to the browser", async () => {
  const signedHandoff = "signed-founder-handoff-material-that-must-not-leak";
  const csrf = "B".repeat(43);
  const browserTokenMaterial = "A".repeat(43);
  const loginCredentialMaterial = "correct-password";
  const consumed = [];
  let mfaGraphLoads = 0;
  const router = createNodeRouter({
    proxyDependencies: {
      env: {
        PKC_N8N_BASE_URL: "https://n8n.example.test",
        PKC_AUTH_KEY: "test-auth-key",
        PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test",
        PKC_PUBLIC_ALLOWED_ORIGINS: "https://projectkidcreations.test",
        PKC_FOUNDER_SUBJECT: "11111111-1111-4111-8111-111111111111",
        PKC_FOUNDER_MFA_MODE: "enforced",
      },
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        status: "mfa_required",
        request_id: "request-1",
        login_attempt_id: "11111111-1111-4111-8111-111111111111",
        handoff: signedHandoff,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
    mfaModuleLoader: async () => {
      mfaGraphLoads += 1;
      return {
        beginTrustedFounderMfa: async (handoff) => {
          consumed.push(handoff);
          return { status: "mfa_required", mode: "verify", csrf, token: browserTokenMaterial, maxAgeSeconds: 300 };
        },
      };
    },
  });
  const res = response();

  await router({
    method: "POST",
    url: "/api/account/login",
    headers: {
      host: "projectkidcreations.test",
      origin: "https://projectkidcreations.test",
      "content-type": "application/json",
    },
    body: {
      username: "PK Blick",
      password: loginCredentialMaterial,
      login_attempt_id: "11111111-1111-4111-8111-111111111111",
    },
  }, res);

  assert.deepEqual(consumed, [signedHandoff]);
  assert.equal(mfaGraphLoads, 1);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers.get("set-cookie"), /^__Host-pkc_mfa=.*HttpOnly; Secure; SameSite=Strict/);
  const browserBody = JSON.parse(String(res.payload));
  assert.deepEqual(browserBody, { ok: true, status: "mfa_required", mode: "verify", csrf });
  assert.equal(String(res.payload).includes(signedHandoff), false);
  assert.equal(Object.hasOwn(browserBody, "handoff"), false);
});

test("ordinary catch-all module load and dispatch never load the MFA route graph", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "pkc-node-router-lazy-mfa-"));
  try {
    const loaderPath = path.join(temporaryRoot, "reject-mfa-loader.mjs");
    writeFileSync(loaderPath, `export async function load(url, context, nextLoad) {\n  if (url.endsWith('/server/mfa/routes.mjs')) throw new Error('MFA_GRAPH_LOADED');\n  return nextLoad(url, context);\n}\n`);
    const routerUrl = pathToFileURL(path.resolve("server/api/node-router.mjs")).href;
    const script = `
      const { createNodeRouter } = await import(${JSON.stringify(routerUrl)});
      const router = createNodeRouter({
        proxyHandlerFactory: () => async (_req, res) => { res.statusCode = 204; res.end(); },
        entryStateHandler: async (_req, res) => { res.statusCode = 204; res.end(); },
      });
      const res = { statusCode: 200, setHeader() {}, end() {} };
      await router({ method: 'POST', url: '/api/phase-two/save' }, res);
      if (res.statusCode !== 204) throw new Error('ordinary_dispatch_failed');
      console.log('ordinary-route-ok');
    `;
    const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loaderPath).href, "--input-type=module", "--eval", script], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ordinary-route-ok/);
    assert.doesNotMatch(result.stderr, /MFA_GRAPH_LOADED/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
