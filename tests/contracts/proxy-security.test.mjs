import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { test } from "node:test";

import { ROUTES } from "../../server/proxy/manifest.mjs";
import { handleProxy } from "../../server/proxy/core.mjs";
import { createEdgeHandler } from "../../server/proxy/edge.mjs";
import { createNodeHandler } from "../../server/proxy/node.mjs";

const root = resolve(import.meta.dirname, "../..");

test("package declares ESM so Vercel Node wrappers can import the shared core", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
});

const GOOD_ENV = Object.freeze({
  PKC_N8N_BASE_URL: "https://n8n.example.test",
  PKC_AUTH_KEY: "server-secret",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test,https://standby.example.test",
  PKC_PUBLIC_ALLOWED_ORIGINS: "https://app.example.test,https://www.example.test",
});

const okJson = (body = { ok: true }, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { "content-type": "application/json", ...(init.headers || {}) },
});

function request(path, options = {}) {
  const { method = "POST", headers = {} } = options;
  const body = Object.hasOwn(options, "body") ? options.body : {};
  const origin = Object.hasOwn(options, "origin") ? options.origin : "https://app.example.test";
  const merged = new Headers(headers);
  if (origin !== undefined) merged.set("origin", origin);
  if (body !== undefined && method !== "GET") merged.set("content-type", merged.get("content-type") || "application/json");
  return new Request(`https://app.example.test${path}`, {
    method,
    headers: merged,
    body: body === undefined || method === "GET" ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

async function call(routeId, req, fetchImpl = async () => okJson(), extra = {}) {
  return handleProxy(routeId, req, { env: GOOD_ENV, fetch: fetchImpl, ...extra });
}

async function body(response) {
  return response.json();
}

function activationProof(overrides = {}) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    submission_id: "submission-1",
    username: "sampleuser",
    email: "sample@example.test",
    first_name: "Sample",
    issued_at_ms: now,
    expires_at_ms: now + (30 * 60 * 1000),
    ...overrides,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", GOOD_ENV.PKC_AUTH_KEY).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function routeFiles(dir = resolve(root, "api")) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name.endsWith(".js") && !path.endsWith("/account/entry-state.js")
      ? [relative(root, path).replaceAll("\\", "/")]
      : [];
  }).sort();
}

function mockNodeResponse() {
  const headers = new Map();
  let resolveDone;
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise; });
  return {
    statusCode: 200,
    headers,
    payload: undefined,
    done,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
    end(value) { this.payload = value; resolveDone(); return this; },
    send(value) { this.payload = value; resolveDone(); return this; },
    json(value) { this.payload = JSON.stringify(value); resolveDone(); return this; },
  };
}

test("manifest fixes the original 23 mappings and 14 Edge / 9 Node split", async () => {
  const files = routeFiles();
  assert.equal(files.length, 23);
  assert.deepEqual(Object.values(ROUTES).map((r) => r.file).sort(), files);
  assert.equal(Object.values(ROUTES).filter((r) => r.runtime === "edge").length, 14);
  assert.equal(Object.values(ROUTES).filter((r) => r.runtime === "nodejs").length, 9);
  for (const [id, route] of Object.entries(ROUTES)) {
    const mod = await import(`../../${route.file}?inventory=${encodeURIComponent(id)}`);
    assert.equal(mod.config.runtime, route.runtime, route.file);
    if (route.runtime === "nodejs") assert.equal(mod.config.maxDuration, 60, route.file);
  }
});

test("manifest preserves every upstream endpoint and exact method set", () => {
  const expected = {
    onboarding: ["POST", "/webhook/pkc-onboarding"],
    phaseTwoVerify: ["POST", "/webhook/pkc-phase-two/verify"],
    phaseTwoSave: ["POST", "/webhook/pkc-phase-two/save"],
    phaseTwoEvent: ["POST", "/webhook/pkc-phase-two/event"],
    phaseThreeVerify: ["POST", "/webhook/pkc-phase-three/verify"],
    phaseThreeSave: ["POST", "/webhook/pkc-phase-three/save"],
    phaseThreeEvent: ["POST", "/webhook/pkc-phase-three/event"],
    phaseThreeCheckUsername: ["POST", "/webhook/pkc-phase-three/check-username"],
    accountLogin: ["POST", "/webhook/pkc-accounts/login"],
    accountBootstrap: ["POST", "/webhook/pkc-accounts/bootstrap"],
    accountBootstrapRedeem: ["POST", "/webhook/pkc-accounts/bootstrap/redeem"],
    accountPasswordRequest: ["POST", "/webhook/pkc-accounts/password/request-reset"],
    accountPasswordComplete: ["POST", "/webhook/pkc-accounts/password/complete-reset"],
    accountPasswordChange: ["POST", "/webhook/pkc-accounts/password/change"],
    accountEmailChange: ["POST", "/webhook/pkc-accounts/email/change"],
    accountDelete: ["POST", "/webhook/pkc-accounts/delete"],
    accountLogout: ["POST", "/webhook/pkc-accounts/logout"],
    accountActivity: ["GET", "/webhook/pkc-accounts/activity"],
    accountProfile: [["GET", "PATCH"], "/webhook/pkc-accounts/profile"],
    accountSessions: [["GET", "POST"], { GET: "/webhook/pkc-accounts/sessions", POST: "/webhook/pkc-accounts/sessions/revoke" }],
    accountAdminList: ["POST", "/webhook/pkc-admin/accounts/list"],
    accountAdminSearch: ["POST", "/webhook/pkc-admin/accounts/search"],
    accountAdminChat: ["POST", "/webhook/pkc-accounts-agent/chat"],
  };
  assert.equal(Object.keys(ROUTES).length, 23);
  for (const [id, [methods, upstream]] of Object.entries(expected)) {
    assert.deepEqual(ROUTES[id].methods, Array.isArray(methods) ? methods : [methods], id);
    assert.deepEqual(ROUTES[id].upstream, upstream, id);
  }
});

test("configuration fails closed before fetch for every missing or blank required value", async () => {
  for (const key of Object.keys(GOOD_ENV)) {
    for (const value of [undefined, "", "   "]) {
      let fetches = 0;
      const env = { ...GOOD_ENV, [key]: value };
      const response = await handleProxy("onboarding", request("/api/onboarding", { body: { version: "1", submissionId: "s", timestamp: "t", env: "prod", mode: "prod", data: {}, confidence: {}, perf: {}, hash: "h" } }), {
        env,
        fetch: async () => { fetches += 1; return okJson(); },
      });
      assert.equal(response.status, 503, `${key}=${String(value)}`);
      assert.equal(fetches, 0, key);
      assertSecurityHeaders(response);
    }
  }
});

test("base URL requires an allowlisted credential-free HTTPS origin with no path, query, or fragment", async () => {
  for (const base of [
    "http://n8n.example.test",
    "https://u:p@n8n.example.test",
    "https://n8n.example.test/webhook",
    "https://n8n.example.test/?x=1",
    "https://n8n.example.test/#x",
    "https://evil.example.test",
  ]) {
    let fetches = 0;
    const response = await handleProxy("phaseTwoVerify", request("/api/phase-two/verify", { body: { token: "t" } }), {
      env: { ...GOOD_ENV, PKC_N8N_BASE_URL: base },
      fetch: async () => { fetches += 1; return okJson(); },
    });
    assert.equal(response.status, 503, base);
    assert.equal(fetches, 0, base);
  }
});

test("methods are exact and 405 returns the exact Allow header without fetching", async () => {
  let fetches = 0;
  const response = await call("accountProfile", request("/api/account/profile", { method: "DELETE", body: undefined }), async () => {
    fetches += 1;
    return okJson();
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, PATCH");
  assert.equal(fetches, 0);
  assertSecurityHeaders(response);
});

test("all mutations reject missing, null, and cross-site Origin before fetch", async () => {
  for (const origin of [undefined, "null", "https://evil.example.test"] ) {
    let fetches = 0;
    const response = await call("phaseTwoVerify", request("/api/phase-two/verify", { body: { token: "t" }, origin }), async () => {
      fetches += 1;
      return okJson();
    });
    assert.equal(response.status, 403, String(origin));
    assert.equal(fetches, 0);
  }
});

test("Sec-Fetch-Site cross-site fails even with a forged allowed Origin", async () => {
  let fetches = 0;
  const response = await call("accountLogin", request("/api/account/login", {
    body: { username: "sampleuser", password: "correct-horse" },
    headers: { "sec-fetch-site": "cross-site" },
  }), async () => {
    fetches += 1;
    return okJson();
  });
  assert.equal(response.status, 403);
  assert.equal(fetches, 0);
});

test("JSON bodies must be objects with route-specific fields and reject unknown keys", async () => {
  for (const raw of ["[]", "null", "{bad", JSON.stringify({ token: "t", smuggled: true })]) {
    let fetches = 0;
    const response = await call("phaseTwoVerify", request("/api/phase-two/verify", { body: raw }), async () => {
      fetches += 1;
      return okJson();
    });
    assert.equal(response.status, 400, raw);
    assert.equal(fetches, 0);
  }
});

test("required fields, primitive types, lengths, and confirmation flags are validated", async () => {
  const cases = [
    ["accountLogin", {}, 422],
    ["accountLogin", { username: "sampleuser", password: 123 }, 422],
    ["accountLogin", { username: "x".repeat(65), password: "correct-horse" }, 422],
    ["accountBootstrap", { activation_proof: "short" }, 422],
    ["accountDelete", { current_password: "correct-horse", i_am_sure: false }, 422],
    ["accountSessions", { session_id: "" }, 422],
  ];
  for (const [routeId, body, expected] of cases) {
    const response = await call(routeId, request("/x", {
      body,
      headers: routeId === "accountDelete" || routeId === "accountSessions"
        ? { cookie: "pkc_session=valid" }
        : {},
    }), async () => okJson());
    assert.equal(response.status, expected, `${routeId}: ${JSON.stringify(body)}`);
  }
});

test("Phase Three proxy rejects deferred PII and injects the launch privacy contract server-side", async () => {
  const baseProfile = {
    display_name: "Customer",
    username: "customer_1",
    bio: "",
    skill_level: "builder",
    blasters_owned: [],
    accessory_interests: [],
    email_drops: false,
    age_confirmed: true,
    terms_accepted: true,
  };
  for (const injected of [
    { birthday: "2000-01-01" },
    { shipping: { line1: "private" } },
    { socials: { insta: "private" } },
    { privacy_contract_version: "attacker" },
  ]) {
    const blocked = await call("phaseThreeSave", request("/x", { body: { token: "token-value", profile: { ...baseProfile, ...injected } } }));
    assert.equal(blocked.status, 422, JSON.stringify(injected));
  }
  let forwarded;
  const accepted = await call("phaseThreeSave", request("/x", { body: { token: "token-value", profile: baseProfile } }), async (_url, init) => {
    forwarded = JSON.parse(init.body);
    return okJson({ ok: true });
  });
  assert.equal(accepted.status, 200);
  assert.equal(forwarded.profile.privacy_contract_version, "2026-09-26");
  assert.equal(forwarded.profile.age_confirmed, true);
  assert.equal(forwarded.profile.terms_accepted, true);
});

test("valid two-segment activation proofs reach the authoritative bootstrap workflow", async () => {
  let fetches = 0;
  const result = await call("accountBootstrap", request("/api/account/bootstrap", {
    body: { activation_proof: activationProof() },
  }), async () => {
    fetches += 1;
    return okJson({ ok: true });
  });
  assert.equal(result.status, 200);
  assert.equal(fetches, 1);
});

test("shape-valid activation proofs with invalid signatures fail locally with a stable client error", async () => {
  let fetches = 0;
  const proof = activationProof();
  const invalidProof = `${proof.slice(0, proof.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
  const result = await call("accountBootstrap", request("/api/account/bootstrap", {
    body: { activation_proof: invalidProof },
  }), async () => {
    fetches += 1;
    throw new Error("must not fetch");
  });
  assert.equal(result.status, 422);
  assert.equal(fetches, 0);
  assert.equal((await result.json()).error, "invalid_body");
});

test("Edge adapter stream-reads and rejects over 16 KiB before upstream fetch", async () => {
  let fetches = 0;
  const handler = createEdgeHandler("phaseTwoEvent", {
    env: GOOD_ENV,
    fetch: async () => { fetches += 1; return okJson(); },
  });
  const response = await handler(request("/api/phase-two/event", {
    body: { event_type: "x", submissionId: "s", data: { value: "x".repeat(17 * 1024) } },
  }));
  assert.equal(response.status, 413);
  assert.equal(fetches, 0);
});

test("route body limits are 64 KiB for admin chat and 128 KiB for Phase Three save", async () => {
  assert.equal(ROUTES.accountAdminChat.bodyLimit, 64 * 1024);
  assert.equal(ROUTES.phaseThreeSave.bodyLimit, 128 * 1024);
  assert.equal(ROUTES.phaseTwoEvent.bodyLimit, 16 * 1024);
});

test("Node adapter safely handles parsed req.body and enforces UTF-8 byte length", async () => {
  let fetches = 0;
  const handler = createNodeHandler("phaseTwoSave", {
    env: GOOD_ENV,
    fetch: async () => { fetches += 1; return okJson(); },
  });
  const req = {
    method: "POST",
    url: "/api/phase-two/save",
    headers: { host: "app.example.test", origin: "https://app.example.test", "content-type": "application/json" },
    body: { token: "😀".repeat(5000) },
  };
  const res = mockNodeResponse();
  await handler(req, res);
  await res.done;
  assert.equal(res.statusCode, 413);
  assert.equal(fetches, 0);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
});

test("upstream headers are isolated and only the exact capped pkc_session cookie is forwarded", async () => {
  let captured;
  const response = await call("accountProfile", request("/api/account/profile", {
    method: "GET",
    body: undefined,
    headers: {
      cookie: "theme=dark; pkc_session=abc.DEF_123%3D~; other=secret",
      authorization: "Bearer attacker",
      "x-pkc-key": "attacker-key",
      "x-forwarded-for": "203.0.113.9",
      "x-random": "do-not-forward",
    },
    origin: undefined,
  }), async (url, init) => {
    captured = { url, init, headers: new Headers(init.headers) };
    return okJson();
  });
  assert.equal(response.status, 200);
  assert.equal(captured.headers.get("cookie"), "pkc_session=abc.DEF_123%3D~");
  assert.equal(captured.headers.get("x-pkc-key"), GOOD_ENV.PKC_AUTH_KEY);
  assert.equal(captured.headers.get("authorization"), null);
  assert.equal(captured.headers.get("x-forwarded-for"), null);
  assert.equal(captured.headers.get("x-random"), null);
  assert.deepEqual([...captured.headers.keys()].sort(), ["accept", "cookie", "x-pkc-key"]);
});

test("public auth routes never accept or forward a session cookie", async () => {
  for (const [routeId, payload] of [
    ["accountLogin", { username: "sampleuser", password: "correct-horse" }],
    ["accountBootstrap", { activation_proof: activationProof() }],
    ["accountBootstrapRedeem", { token: "t", username: "sampleuser", password: "correct-horse-battery" }],
    ["accountPasswordRequest", { email: "a@b.test" }],
    ["accountPasswordComplete", { token: "t", new_password: "correct-horse-battery" }],
  ]) {
    let cookie;
    const response = await call(routeId, request("/x", { body: payload, headers: { cookie: "pkc_session=stolen" } }), async (_url, init) => {
      cookie = new Headers(init.headers).get("cookie");
      return okJson();
    });
    assert.equal(response.status, 200, routeId);
    assert.equal(cookie, null, routeId);
  }
});

test("oversized, duplicate, or malformed session cookies fail closed", async () => {
  for (const cookie of [
    `pkc_session=${"x".repeat(4097)}`,
    "pkc_session=a; pkc_session=b",
    "pkc_session=bad value",
  ]) {
    let fetches = 0;
    const response = await call("accountProfile", request("/x", { method: "GET", body: undefined, origin: undefined, headers: { cookie } }), async () => {
      fetches += 1;
      return okJson();
    });
    assert.equal(response.status, 400, cookie.slice(0, 30));
    assert.equal(fetches, 0);
  }
});

test("logout accepts the existing bodyless client request as an empty JSON object", async () => {
  let capturedBody;
  const response = await call("accountLogout", request("/api/account/logout", {
    body: undefined,
    headers: { cookie: "pkc_session=current" },
  }), async (_url, init) => {
    capturedBody = init.body;
    return okJson();
  });
  assert.equal(response.status, 200);
  assert.equal(capturedBody, "{}");
});

test("only login, redeem, and logout sanitize an exact pkc_session Set-Cookie", async () => {
  const valid = "pkc_session=jwt-value; Path=/; HttpOnly; Secure; SameSite=Lax";
  for (const routeId of ["accountLogin", "accountBootstrapRedeem", "accountLogout"]) {
    const payload = routeId === "accountLogin"
      ? { username: "sampleuser", password: "correct-horse" }
      : routeId === "accountBootstrapRedeem"
        ? { token: "t", username: "sampleuser", password: "correct-horse-battery" }
        : {};
    const headers = routeId === "accountLogout" ? { cookie: "pkc_session=current" } : {};
    const response = await call(routeId, request("/x", { body: payload, headers }), async () => okJson({}, { headers: { "set-cookie": valid } }));
    assert.equal(response.headers.get("set-cookie"), "pkc_session=jwt-value; Path=/; HttpOnly; Secure; SameSite=Lax", routeId);
  }
  const response = await call("accountPasswordComplete", request("/x", { body: { token: "t", new_password: "correct-horse-battery" } }), async () => okJson({}, { headers: { "set-cookie": valid } }));
  assert.equal(response.headers.get("set-cookie"), null);
});

test("malformed, Domain-scoped, foreign, and multiple upstream cookies are rejected", async () => {
  for (const raw of [
    "pkc_session=jwt-value; Domain=evil.test; Path=/",
    "pkc_session=jwt-value; Secure, other=leak; Path=/",
    "other=leak; Path=/",
    "pkc_session=jwt-value\r\nX-Injected: yes",
  ]) {
    const response = await call("accountLogin", request("/x", {
      body: { username: "sampleuser", password: "correct-horse" },
    }), async () => okJson({}, { headers: { "set-cookie": raw } }));
    assert.equal(response.status, 502, raw);
    assert.equal(response.headers.get("set-cookie"), null, raw);
  }
});

test("logout preserves only safe deletion lifetime attributes", async () => {
  const response = await call("accountLogout", request("/x", { body: {}, headers: { cookie: "pkc_session=current" } }), async () => okJson({}, {
    headers: { "set-cookie": "pkc_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax" },
  }));
  assert.equal(response.headers.get("set-cookie"), "pkc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
});

test("timeout, non-JSON, invalid JSON, and oversized upstream responses are rejected", async () => {
  const req = request("/api/phase-two/verify", { body: { token: "t" } });
  const timeout = await call("phaseTwoVerify", req.clone(), (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }), { timeoutMs: 5 });
  assert.equal(timeout.status, 504);

  const slowBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      setTimeout(() => { controller.enqueue(new TextEncoder().encode("true}")); controller.close(); }, 30);
    },
  });
  const slow = await call("phaseTwoVerify", req.clone(), async () => new Response(slowBody, { headers: { "content-type": "application/json" } }), { timeoutMs: 5 });
  assert.equal(slow.status, 504);

  for (const upstream of [
    new Response("hello", { headers: { "content-type": "text/plain" } }),
    new Response("{bad", { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ data: "x".repeat(257 * 1024) }), { headers: { "content-type": "application/json" } }),
  ]) {
    const response = await call("phaseTwoVerify", req.clone(), async () => upstream);
    assert.equal(response.status, 502);
    assertSecurityHeaders(response);
  }
});

test("activity/admin response caps are 1 MiB and all other routes are 256 KiB", () => {
  for (const [id, route] of Object.entries(ROUTES)) {
    const expected = id === "accountActivity" || id.startsWith("accountAdmin") ? 1024 * 1024 : 256 * 1024;
    assert.equal(route.responseLimit, expected, id);
  }
});

test("every success and error response receives the full security header set", async () => {
  const success = await call("phaseTwoVerify", request("/x", { body: { token: "t" } }));
  const error = await call("phaseTwoVerify", request("/x", { body: { token: "t", extra: true } }));
  assertSecurityHeaders(success);
  assertSecurityHeaders(error);
});

test("admin routes require a bounded profile assertion and never forward session to the admin operation", async () => {
  let calls = [];
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers, signal: init.signal });
    if (url.endsWith("/webhook/pkc-accounts/profile")) return okJson({ profile: { username: "PK Blick", email: "projectkidcreations@gmail.com", is_admin: true } });
    return okJson({ rows: [] });
  };
  const response = await call("accountAdminList", request("/x", {
    body: { offset: 0, limit: 5, sort_by: "created_at", sort_dir: "desc" },
    headers: { cookie: "pkc_session=admin-token" },
  }), fetchImpl, { adminTimeoutMs: 20 });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/webhook/pkc-accounts/profile"));
  assert.equal(calls[0].headers.get("cookie"), "pkc_session=admin-token");
  assert.ok(calls[1].url.endsWith("/webhook/pkc-admin/accounts/list"));
  assert.equal(calls[1].headers.get("cookie"), null);

  calls = [];
  const denied = await call("accountAdminSearch", request("/x", { body: { q: "a" }, headers: { cookie: "pkc_session=user-token" } }), async (url, init) => {
    calls.push({ url, init });
    return okJson({ profile: { is_admin: false } });
  });
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 1);

  for (const profile of [
    { username: "customer", email: "customer@example.com", is_admin: true },
    { username: "PK Blick", email: "attacker@example.com", is_admin: true },
    { username: "pk blick", email: "projectkidcreations@gmail.com", is_admin: true },
    { username: "PK Blick", email: "projectkidcreations@gmail.com", is_admin: false },
  ]) {
    calls = [];
    const conflict = await call("accountAdminList", request("/x", {
      body: { offset: 0, limit: 5, sort_by: "created_at", sort_dir: "desc" },
      headers: { cookie: "pkc_session=conflict-token" },
    }), async (url, init) => {
      calls.push({ url, init });
      return okJson({ profile });
    });
    assert.equal(conflict.status, 403, JSON.stringify(profile));
    assert.equal(calls.length, 1, "admin operation must not execute");
  }
});

test("admin profile failures and timeouts block the operation", async () => {
  const req = request("/x", { body: { message: "hello", sessionId: "s" }, headers: { cookie: "pkc_session=admin-token" } });
  const bad = await call("accountAdminChat", req.clone(), async () => new Response("not-json", { headers: { "content-type": "text/plain" } }));
  assert.equal(bad.status, 502);
  const timed = await call("accountAdminChat", req.clone(), (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }), { adminTimeoutMs: 5 });
  assert.equal(timed.status, 504);
});

test("activity forwards only allowlisted limit/cursor query parameters", async () => {
  let fetchedUrl;
  const response = await call("accountActivity", request("/api/account/activity?limit=50&cursor=abc&admin=true", {
    method: "GET",
    body: undefined,
    origin: undefined,
    headers: { cookie: "pkc_session=s" },
  }), async (url) => { fetchedUrl = url; return okJson([]); });
  assert.equal(response.status, 400);
  assert.equal(fetchedUrl, undefined);

  const accepted = await call("accountActivity", request("/api/account/activity?limit=50&cursor=a%2Fb", {
    method: "GET",
    body: undefined,
    origin: undefined,
    headers: { cookie: "pkc_session=s" },
  }), async (url) => { fetchedUrl = url; return okJson([]); });
  assert.equal(accepted.status, 200);
  assert.equal(fetchedUrl, "https://n8n.example.test/webhook/pkc-accounts/activity?limit=50&cursor=a%2Fb");
});

test("source adapters stay separate and all route files delegate to one of them", () => {
  const edge = readFileSync(resolve(root, "server/proxy/edge.mjs"), "utf8");
  const node = readFileSync(resolve(root, "server/proxy/node.mjs"), "utf8");
  assert.match(edge, /createEdgeHandler/);
  assert.match(node, /createNodeHandler/);
  for (const route of Object.values(ROUTES)) {
    const source = readFileSync(resolve(root, route.file), "utf8");
    assert.match(source, route.runtime === "edge" ? /createEdgeHandler/ : /createNodeHandler/, route.file);
  }
});
