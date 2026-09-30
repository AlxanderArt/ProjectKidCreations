import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowseGateMiddleware } from "../../middleware.js";
import { BROWSE_GATE_MATCHERS, isProtectedBrowsePath, isPublicAnonymousPath } from "../../server/auth/browse-paths.mjs";

const ENV = Object.freeze({
  PKC_N8N_BASE_URL: "https://n8n.example.test",
  PKC_AUTH_KEY: "test-only-key",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test",
  PKC_FOUNDER_SUBJECT: "11111111-1111-4111-8111-111111111111",
});
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const PROTECTED_PATHS = [
  "/landing.html",
  "/landing",
  "/landing/",
  "/dist/landing.js",
  "/dist/landing.js.map",
  "/dist/landing.css",
  "/dist/landing.css.map",
  "/dist/landing.meta.json",
  "/dist/chunk-FW4363Y4.js",
  "/dist/chunk-FW4363Y4.js.map",
  "/dist/hero3d-DNDWLFDQ.js",
  "/dist/hero3d-DNDWLFDQ.js.map",
  "/assets/models/splatrball-400.glb",
  "/src/data/products.js",
  "/src/components/Products.jsx",
  "/assets/og/landing.png",
  "/dist/pkc-motion.js.map",
  "/assets/pkc-motion/contract.json",
  "/assets/pkc-motion/launch-entries.json",
  "/account/admin/",
  "/unknown-new-surface.html",
];

const PUBLIC_PATHS = [
  "/", "/index.html", "/onboarding", "/onboarding/",
  "/phase-one/app.js", "/phase-one/styles.css",
  "/phase-two/app.js", "/phase-three/app.js",
  "/account/login/", "/account/login/config.js", "/dist/account-login.js",
  "/account/forgot/", "/account/reset/", "/account/bootstrap/",
  "/privacy/", "/terms/", "/legal.css", "/tokens.css", "/root-router.js",
  "/dist/pkc-motion.js", "/dist/pkc-boot-renderer.js", "/dist/pkc-land-topology.json",
  "/assets/pkc-motion/boot/pkc-boot-frame.html", "/assets/fonts/archivo-black-latin.woff2",
];

function request(path = "/landing.html", { cookie, method = "GET" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`https://projectkidcreations.io${path}`, { method, headers });
}

function upstream(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gate(fetchImpl) {
  return createBrowseGateMiddleware({
    env: ENV,
    fetch: fetchImpl,
    next: ({ headers } = {}) => new Response("allowed", { status: 200, headers }),
  });
}

test("anonymous publication is default-deny with an explicit onboarding and sign-in allowlist", () => {
  for (const path of PROTECTED_PATHS) assert.equal(isProtectedBrowsePath(path), true, path);
  for (const path of PUBLIC_PATHS) {
    assert.equal(isPublicAnonymousPath(path), true, path);
    assert.equal(isProtectedBrowsePath(path), false, path);
  }
  assert.equal(isProtectedBrowsePath("/api/onboarding"), false);
  assert.deepEqual(BROWSE_GATE_MATCHERS, ["/((?!api/).*)"]);
});

test("public allowlisted paths bypass session lookup", async () => {
  let fetches = 0;
  const handler = gate(async () => { fetches += 1; return upstream(null, 401); });
  for (const path of PUBLIC_PATHS) {
    const response = await handler(request(path));
    assert.equal(response.status, 200, path);
  }
  assert.equal(fetches, 0);
});

test("browse gate redirects missing, duplicate, and rejected sessions to the fixed root", async () => {
  let fetches = 0;
  const handler = gate(async () => { fetches += 1; return upstream(null, 401); });

  for (const path of PROTECTED_PATHS) {
    const response = await handler(request(`${path}?entry=browse`));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://projectkidcreations.io/?reason=account_required");
    assert.match(response.headers.get("cache-control"), /private/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("vary"), "Cookie");
  }
  assert.equal(fetches, 0);

  for (const path of PROTECTED_PATHS) {
    const response = await handler(request(path, { cookie: "pkc_session=rejected" }));
    assert.equal(response.status, 307);
  }
  assert.equal(fetches, PROTECTED_PATHS.length);

  const duplicate = await handler(request("/landing.html", { cookie: "pkc_session=a; pkc_session=b" }));
  assert.equal(duplicate.status, 307);
  assert.equal(fetches, PROTECTED_PATHS.length);
});

test("browse gate allows only authoritative customer and exact founder sessions", async () => {
  const profiles = [
    { account: { account_id: CUSTOMER_ID, username: "kidmaker", display_name: "Kid Maker", is_admin: false } },
    { account: { account_id: ENV.PKC_FOUNDER_SUBJECT, username: "PK Blick", display_name: "Founder", is_admin: true } },
  ];
  let index = 0;
  const handler = gate(async () => upstream(profiles[index++]));

  for (const path of ["/landing.html", "/dist/landing.js"]) {
    const response = await handler(request(path, { cookie: `pkc_session=session-${index}` }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "allowed");
    assert.match(response.headers.get("cache-control"), /private/);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  assert.equal(index, 2);
});

test("browse gate fails closed on upstream errors, malformed profiles, and founder tuple conflicts", async () => {
  const responses = [
    upstream({ error: "unavailable" }, 503),
    upstream({ account: { account_id: "not-a-uuid", username: "kidmaker", is_admin: false } }),
    upstream({ account: { account_id: CUSTOMER_ID, username: "PK Blick", is_admin: false } }),
  ];
  let index = 0;
  const handler = gate(async () => responses[index++]);

  for (let count = 0; count < responses.length; count += 1) {
    const response = await handler(request("/landing.html", { cookie: `pkc_session=unsafe-${count}` }));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://projectkidcreations.io/?reason=account_required");
  }
});

test("browse gate supports authenticated HEAD and rejects mutation methods", async () => {
  const handler = gate(async () => upstream({
    account: { account_id: CUSTOMER_ID, username: "kidmaker", display_name: "Kid Maker", is_admin: false },
  }));
  const head = await handler(request("/landing.html", { cookie: "pkc_session=valid", method: "HEAD" }));
  assert.equal(head.status, 200);

  const post = await handler(request("/landing.html", { cookie: "pkc_session=valid", method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});
