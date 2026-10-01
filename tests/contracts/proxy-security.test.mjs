import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { test } from "node:test";

import { ROUTES } from "../../server/proxy/manifest.mjs";
import { handleProxy } from "../../server/proxy/core.mjs";
import { createEdgeHandler } from "../../server/proxy/edge.mjs";
import { createNodeHandler } from "../../server/proxy/node.mjs";

const root = resolve(import.meta.dirname, "../..");
const FOUNDER_SUBJECT = "11111111-1111-4111-8111-111111111111";
const samplePasswordFixture = ["correct", "horse"].join("-");
const sampleLongPasswordFixture = ["correct", "horse", "battery"].join("-");
const tokenFixture = "t";
const longTokenFixture = "token-value";
const authorizationFixture = "Bearer attacker";
const invalidPasswordFixture = 123;
const oversizedTokenFixture = "😀".repeat(5000);

test("package declares ESM so Vercel Node wrappers can import the shared core", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
});

const GOOD_ENV = Object.freeze({
  PKC_N8N_BASE_URL: "https://n8n.example.test",
  PKC_AUTH_KEY: "server-secret",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test,https://standby.example.test",
  PKC_PUBLIC_ALLOWED_ORIGINS: "https://app.example.test,https://www.example.test",
  PKC_FOUNDER_SUBJECT: FOUNDER_SUBJECT,
  PKC_FOUNDER_MFA_MODE: "enforced",
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

function onboardingBody(overrides = {}) {
  return {
    version: "1.6.0",
    submissionId: "33333333-3333-4333-8333-333333333333",
    data: { firstName: "Sample", lastName: "Maker", email: "sample@example.test" },
    consent: {
      adultConfirmed: true,
      termsAccepted: true,
      privacyAcknowledged: true,
      policyVersion: "pkc-onboarding-launch-v1",
    },
    ...overrides,
  };
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

test("inventory preserves nine Edge wrappers and consolidates every Node URL into one rewritten function", async () => {
  const files = routeFiles();
  const edgeRoutes = Object.entries(ROUTES).filter(([, route]) => route.runtime === "edge");
  const nodeRoutes = Object.entries(ROUTES).filter(([, route]) => route.runtime === "nodejs");
  assert.equal(files.length, 10);
  assert.equal(edgeRoutes.length, 9);
  assert.equal(nodeRoutes.length, 14);
  assert.deepEqual(files, [
    ...edgeRoutes.map(([, route]) => route.file),
    "api/node.js",
  ].sort());
  assert.equal(files.includes("api/account/mfa-start.js"), false);
  for (const [id, route] of edgeRoutes) {
    const mod = await import(`../../${route.file}?inventory=${encodeURIComponent(id)}`);
    assert.equal(mod.config.runtime, "edge", route.file);
  }
  const consolidated = await import("../../api/node.js?inventory=node-rewrite-target");
  assert.equal(consolidated.config.runtime, "nodejs");
  assert.equal(consolidated.config.maxDuration, 60);
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
  for (const id of ["onboarding", "phaseTwoVerify", "phaseTwoSave", "phaseTwoEvent", "phaseThreeVerify", "phaseThreeSave", "phaseThreeEvent", "phaseThreeCheckUsername"]) {
    assert.equal(ROUTES[id].founderConfigurationRequired, false, id);
  }
  for (const [id, route] of Object.entries(ROUTES).filter(([routeId]) => routeId.startsWith("account"))) {
    assert.equal(route.founderConfigurationRequired, true, id);
  }
});

test("public onboarding forwards with core proxy configuration even when founder authority is absent", async () => {
  const env = { ...GOOD_ENV };
  delete env.PKC_FOUNDER_SUBJECT;
  delete env.PKC_FOUNDER_MFA_MODE;
  let fetches = 0;
  const response = await handleProxy("onboarding", request("/api/onboarding", {
    body: onboardingBody(),
  }), {
    env,
    fetch: async () => { fetches += 1; return okJson({ ok: true, persisted: true }); },
  });
  assert.equal(response.status, 200);
  assert.equal(fetches, 1);
});

test("onboarding alone receives the extended upstream timeout", async () => {
  const observedTimeouts = [];
  const captureTimeout = async (operation, timeoutMs) => {
    observedTimeouts.push(timeoutMs);
    return operation(new AbortController().signal);
  };

  const onboarding = await call("onboarding", request("/api/onboarding", {
    body: onboardingBody(),
  }), async () => okJson({ ok: true, persisted: true }), { timedOperation: captureTimeout });
  assert.equal(onboarding.status, 200);

  const phaseTwo = await call("phaseTwoVerify", request("/api/phase-two/verify", {
    body: { token: tokenFixture },
  }), async () => okJson(), { timedOperation: captureTimeout });
  assert.equal(phaseTwo.status, 200);

  assert.deepEqual(observedTimeouts, [45_000, 20_000]);
});

test("onboarding validates nested consent and emits the exact active-workflow schema", async () => {
  let forwarded;
  const response = await call("onboarding", request("/api/onboarding", { body: onboardingBody() }), async (_url, init) => {
    forwarded = JSON.parse(init.body);
    return okJson({ ok: true, persisted: true });
  });
  assert.equal(response.status, 200);
  const expectedHash = createHash("sha256")
    .update(["Sample", "Maker", "sample@example.test", "33333333-3333-4333-8333-333333333333", "1.6.0"].join("|"), "utf8")
    .digest("hex");
  assert.deepEqual(forwarded, {
    version: "1.6.0",
    submissionId: "33333333-3333-4333-8333-333333333333",
    firstName: "Sample",
    lastName: "Maker",
    email: "sample@example.test",
    adultConfirmed: true,
    termsAccepted: true,
    privacyAcknowledged: true,
    policyVersion: "pkc-onboarding-launch-v1",
    hash: expectedHash,
  });

  const hostile = [
    onboardingBody({ data: { firstName: "Sample", lastName: "Maker", email: "sample@example.test", role: "admin" } }),
    onboardingBody({ data: { firstName: "<Sample>", lastName: "Maker", email: "sample@example.test" } }),
    onboardingBody({ data: { firstName: "Sample", lastName: "Maker", email: "SAMPLE@example.test" } }),
    onboardingBody({ consent: { adultConfirmed: false, termsAccepted: true, privacyAcknowledged: true, policyVersion: "pkc-onboarding-launch-v1" } }),
    onboardingBody({ consent: { adultConfirmed: true, termsAccepted: true, privacyAcknowledged: true, policyVersion: "other" } }),
    { ...onboardingBody(), mode: "prod" },
    { ...onboardingBody(), perf: {} },
  ];
  for (const candidate of hostile) {
    let fetches = 0;
    const denied = await call("onboarding", request("/api/onboarding", { body: candidate }), async () => { fetches += 1; return okJson(); });
    assert.equal(denied.status, 422);
    assert.equal(fetches, 0);
  }
});

test("every account proxy route remains founder-configuration-bound", async () => {
  const env = { ...GOOD_ENV };
  delete env.PKC_FOUNDER_SUBJECT;
  delete env.PKC_FOUNDER_MFA_MODE;
  for (const [routeId, route] of Object.entries(ROUTES).filter(([id]) => id.startsWith("account"))) {
    let fetches = 0;
    const method = route.methods[0];
    const response = await handleProxy(routeId, request(route.publicPath, {
      method,
      body: method === "GET" ? undefined : {},
    }), {
      env,
      fetch: async () => { fetches += 1; return okJson(); },
    });
    assert.equal(response.status, 503, routeId);
    assert.equal(fetches, 0, routeId);
  }
});

test("public configuration fails closed before fetch for every missing or blank core value", async () => {
  for (const key of ["PKC_N8N_BASE_URL", "PKC_AUTH_KEY", "PKC_N8N_ALLOWED_ORIGINS", "PKC_PUBLIC_ALLOWED_ORIGINS"]) {
    for (const value of [undefined, "", "   "]) {
      let fetches = 0;
      const env = { ...GOOD_ENV };
      env[key] = value;
      const response = await handleProxy("onboarding", request("/api/onboarding", { body: onboardingBody() }), {
        env,
        fetch: async () => { fetches += 1; return okJson(); },
      });
      assert.equal(response.status, 503, `${key}=${String(value)}`);
      assert.equal(fetches, 0, key);
      assertSecurityHeaders(response);
    }
  }
});

test("proxy configuration rejects noncanonical founder UUID text before fetch", async () => {
  for (const value of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ` ${FOUNDER_SUBJECT}`, `${FOUNDER_SUBJECT} `, "not-a-uuid"]) {
    let fetches = 0;
    const response = await handleProxy("accountLogin", request("/api/account/login", { body: { username: "sampleuser", password: samplePasswordFixture } }), {
      env: { ...GOOD_ENV, PKC_FOUNDER_SUBJECT: value },
      fetch: async () => { fetches += 1; return okJson(); },
    });
    assert.equal(response.status, 503, value);
    assert.equal(fetches, 0, value);
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
    const response = await handleProxy("phaseTwoVerify", request("/api/phase-two/verify", { body: { token: tokenFixture } }), {
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
    const response = await call("phaseTwoVerify", request("/api/phase-two/verify", { body: { token: tokenFixture }, origin }), async () => {
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
    body: { username: "sampleuser", password: samplePasswordFixture },
    headers: { "sec-fetch-site": "cross-site" },
  }), async () => {
    fetches += 1;
    return okJson();
  });
  assert.equal(response.status, 403);
  assert.equal(fetches, 0);
});

test("JSON bodies must be objects with route-specific fields and reject unknown keys", async () => {
  for (const [raw, expected] of [
    ["[]", 400],
    ["null", 400],
    ["{bad", 400],
    [JSON.stringify({ token: tokenFixture, smuggled: true }), 422],
  ]) {
    let fetches = 0;
    const response = await call("phaseTwoVerify", request("/api/phase-two/verify", { body: raw }), async () => {
      fetches += 1;
      return okJson();
    });
    assert.equal(response.status, expected, raw);
    assert.equal(fetches, 0);
  }
});

test("required fields, primitive types, lengths, and confirmation flags are validated", async () => {
  const cases = [
    ["accountLogin", {}, 422],
    ["accountLogin", { username: "sampleuser", password: invalidPasswordFixture }, 422],
    ["accountLogin", { username: "x".repeat(65), password: samplePasswordFixture }, 422],
    ["accountBootstrap", { activation_proof: "short" }, 422],
    ["accountDelete", { current_password: samplePasswordFixture, i_am_sure: false }, 422],
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
    const blocked = await call("phaseThreeSave", request("/x", { body: { token: longTokenFixture, profile: { ...baseProfile, ...injected } } }));
    assert.equal(blocked.status, 422, JSON.stringify(injected));
  }
  let forwarded;
  const accepted = await call("phaseThreeSave", request("/x", { body: { token: longTokenFixture, profile: baseProfile } }), async (_url, init) => {
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
    body: { token: oversizedTokenFixture },
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
      authorization: authorizationFixture,
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
    ["accountLogin", { username: "sampleuser", password: samplePasswordFixture }],
    ["accountBootstrap", { activation_proof: activationProof() }],
    ["accountBootstrapRedeem", { token: tokenFixture, username: "sampleuser", password: sampleLongPasswordFixture }],
    ["accountPasswordRequest", { email: "a@b.test" }],
    ["accountPasswordComplete", { token: tokenFixture, new_password: sampleLongPasswordFixture }],
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
      ? { username: "sampleuser", password: samplePasswordFixture }
      : routeId === "accountBootstrapRedeem"
        ? { token: tokenFixture, username: "sampleuser", password: sampleLongPasswordFixture }
        : {};
    const headers = routeId === "accountLogout" ? { cookie: "pkc_session=current" } : {};
    const response = await call(routeId, request("/x", { body: payload, headers }), async () => okJson({}, { headers: { "set-cookie": valid } }));
    assert.equal(response.headers.get("set-cookie"), "pkc_session=jwt-value; Path=/; HttpOnly; Secure; SameSite=Lax", routeId);
  }
  const response = await call("accountPasswordComplete", request("/x", { body: { token: tokenFixture, new_password: sampleLongPasswordFixture } }), async () => okJson({}, { headers: { "set-cookie": valid } }));
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
      body: { username: "sampleuser", password: samplePasswordFixture },
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
  const req = request("/api/phase-two/verify", { body: { token: tokenFixture } });
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
  const success = await call("phaseTwoVerify", request("/x", { body: { token: tokenFixture } }));
  const error = await call("phaseTwoVerify", request("/x", { body: { token: tokenFixture, extra: true } }));
  assertSecurityHeaders(success);
  assertSecurityHeaders(error);
});

test("all founder session routes except logout use Node authority and reject stale Postgres epochs", async () => {
  const guarded = Object.entries(ROUTES).filter(([id, route]) => route.session && id !== "accountLogout");
  assert.ok(guarded.length > 0);
  for (const [id, route] of guarded) assert.equal(route.runtime, "nodejs", id);

  const staleMfa = Math.floor(Date.now() / 1000) - 3600;
  const profile = {
    account_id: FOUNDER_SUBJECT, username: "PK Blick", email: "any-address@example.test", is_admin: true,
    founder_assurance: { amr: ["pwd", "otp"], auth_epoch: "3", mfa_verified_at: staleMfa },
  };
  let calls = 0;
  const denied = await call("accountProfile", request("/x", {
    method: "GET", body: undefined, origin: undefined, headers: { cookie: "pkc_session=old-founder" },
  }), async () => { calls += 1; return okJson({ profile }); }, {
    founderAuthority: async (subject) => { assert.equal(subject, FOUNDER_SUBJECT); return { founderSubject: FOUNDER_SUBJECT, state: "active", authEpoch: "4", revokedBefore: new Date() }; },
  });
  assert.equal(denied.status, 403);
  assert.equal(calls, 1);

  calls = 0;
  const accepted = await call("accountProfile", request("/x", {
    method: "GET", body: undefined, origin: undefined, headers: { cookie: "pkc_session=current-founder" },
  }), async () => { calls += 1; return okJson({ profile }); }, {
    founderAuthority: async (subject) => { assert.equal(subject, FOUNDER_SUBJECT); return { founderSubject: FOUNDER_SUBJECT, state: "active", authEpoch: "3", revokedBefore: null }; },
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls, 2, "non-sensitive founder profile permits older MFA only when the Postgres epoch is current");
});

test("founder-sensitive account mutations preserve customers and require current Postgres-backed recent MFA", async () => {
  const freshMfa = Math.floor(Date.now() / 1000) - 30;
  const routes = [
    ["accountPasswordChange", { current_password: samplePasswordFixture, new_password: sampleLongPasswordFixture }],
    ["accountEmailChange", { current_password: samplePasswordFixture, new_email: "new@example.test" }],
    ["accountDelete", { current_password: samplePasswordFixture, i_am_sure: true }],
    ["accountSessions", { session_id: "session-to-revoke" }],
  ];
  const founder = (assurance) => ({
    account_id: FOUNDER_SUBJECT, username: "PK Blick", email: "irrelevant@example.test", is_admin: true,
    founder_assurance: assurance,
  });
  const activeAuthority = { founderSubject: FOUNDER_SUBJECT, state: "active", authEpoch: "7", revokedBefore: null };

  for (const [routeId, body] of routes) {
    let calls = 0;
    const customer = await call(routeId, request("/x", { body, headers: { cookie: "pkc_session=customer-token" } }), async (url) => {
      calls += 1;
      return url.endsWith("/webhook/pkc-accounts/profile")
        ? okJson({ profile: { username: "customer", email: "customer@example.test", is_admin: false } })
        : okJson({ ok: true });
    }, { founderAuthority: async () => { throw new Error("must_not_run_for_customer"); } });
    assert.equal(customer.status, 200, routeId);
    assert.equal(calls, 2, routeId);

    for (const [label, assurance, authority = activeAuthority] of [
      ["missing", undefined],
      ["wrong-amr", { amr: ["pwd"], auth_epoch: "7", mfa_verified_at: freshMfa }],
      ["stale", { amr: ["pwd", "otp"], auth_epoch: "7", mfa_verified_at: freshMfa - 901 }],
      ["future", { amr: ["pwd", "otp"], auth_epoch: "7", mfa_verified_at: freshMfa + 120 }],
      ["wrong-epoch", { amr: ["pwd", "otp"], auth_epoch: "6", mfa_verified_at: freshMfa }],
      ["disabled-factor", { amr: ["pwd", "otp"], auth_epoch: "7", mfa_verified_at: freshMfa }, { ...activeAuthority, state: "recovery_required" }],
    ]) {
      calls = 0;
      const denied = await call(routeId, request("/x", { body, headers: { cookie: "pkc_session=founder-token" } }), async () => {
        calls += 1;
        return okJson({ profile: founder(assurance) });
      }, { founderAuthority: async () => authority });
      assert.equal(denied.status, 403, `${routeId}:${label}`);
      assert.equal(calls, 1, `${routeId}:${label}:operation must not execute`);
    }

    calls = 0;
    const accepted = await call(routeId, request("/x", { body, headers: { cookie: "pkc_session=founder-token" } }), async (url) => {
      calls += 1;
      return url.endsWith("/webhook/pkc-accounts/profile")
        ? okJson({ profile: founder({ amr: ["pwd", "otp"], auth_epoch: "7", mfa_verified_at: freshMfa }) })
        : okJson({ ok: true });
    }, { founderAuthority: async () => activeAuthority });
    assert.equal(accepted.status, 200, routeId);
    assert.equal(calls, 2, routeId);
  }
});

test("admin routes require a bounded profile assertion and never forward session to the admin operation", async () => {
  const freshMfa = Math.floor(Date.now() / 1000) - 30;
  const activeAuthority = async (subject) => { assert.equal(subject, FOUNDER_SUBJECT); return { founderSubject: FOUNDER_SUBJECT, state: "active", authEpoch: "4", revokedBefore: null }; };
  let calls = [];
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers, signal: init.signal });
    if (url.endsWith("/webhook/pkc-accounts/profile")) return okJson({ profile: {
      account_id: FOUNDER_SUBJECT, username: "PK Blick", email: "changed@example.test", is_admin: true,
      auth_epoch: "4", founder_assurance: { amr: ["pwd", "otp"], auth_epoch: "4", mfa_verified_at: freshMfa },
    } });
    return okJson({ rows: [] });
  };
  const response = await call("accountAdminList", request("/x", {
    body: { offset: 0, limit: 5, sort_by: "created_at", sort_dir: "desc" },
    headers: { cookie: "pkc_session=admin-token" },
  }), fetchImpl, { adminTimeoutMs: 20, founderAuthority: activeAuthority });
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
    { account_id: FOUNDER_SUBJECT, username: "customer", email: "founder@example.com", is_admin: true },
    { account_id: "22222222-2222-4222-8222-222222222222", username: "PK Blick", email: "founder@example.com", is_admin: true },
    { account_id: FOUNDER_SUBJECT, username: "pk blick", email: "founder@example.com", is_admin: true },
    { account_id: FOUNDER_SUBJECT, username: "PK Blick", email: "founder@example.com", is_admin: false },
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

  for (const profile of [
    { account_id: FOUNDER_SUBJECT, username: "PK Blick", is_admin: true },
    { account_id: FOUNDER_SUBJECT, username: "PK Blick", is_admin: true, auth_epoch: 4, founder_assurance: { amr: ["pwd"], auth_epoch: 4, mfa_verified_at: freshMfa } },
    { account_id: FOUNDER_SUBJECT, username: "PK Blick", is_admin: true, auth_epoch: 4, founder_assurance: { amr: ["pwd", "otp"], auth_epoch: 3, mfa_verified_at: freshMfa } },
    { account_id: FOUNDER_SUBJECT, username: "PK Blick", is_admin: true, auth_epoch: 4, founder_assurance: { amr: ["pwd", "otp"], auth_epoch: 4, mfa_verified_at: freshMfa - 901 } },
    { account_id: FOUNDER_SUBJECT, username: "PK Blick", is_admin: true, auth_epoch: 4, founder_assurance: { amr: ["pwd", "otp"], auth_epoch: 4, mfa_verified_at: freshMfa + 120 } },
  ]) {
    calls = [];
    const stale = await call("accountAdminList", request("/x", {
      body: { offset: 0, limit: 5, sort_by: "created_at", sort_dir: "desc" },
      headers: { cookie: "pkc_session=stale-founder-token" },
    }), async (url, init) => {
      calls.push({ url, init });
      return okJson({ profile });
    }, { founderAuthority: activeAuthority });
    assert.equal(stale.status, 403, JSON.stringify(profile));
    assert.equal(calls.length, 1, "sensitive admin operation must not execute");
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

test("source adapters stay separate while only Edge routes retain wrappers", () => {
  const edge = readFileSync(resolve(root, "server/proxy/edge.mjs"), "utf8");
  const node = readFileSync(resolve(root, "server/proxy/node.mjs"), "utf8");
  const consolidated = readFileSync(resolve(root, "api/node.js"), "utf8");
  assert.match(edge, /createEdgeHandler/);
  assert.match(node, /createNodeHandler/);
  assert.match(consolidated, /createVercelNodeHandler/);
  for (const route of Object.values(ROUTES).filter((entry) => entry.runtime === "edge")) {
    const source = readFileSync(resolve(root, route.file), "utf8");
    assert.match(source, /createEdgeHandler/, route.file);
  }
});
