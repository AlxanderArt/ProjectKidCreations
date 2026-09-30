import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowseGateMiddleware } from "../../middleware.js";

const ENV = Object.freeze({
  PKC_N8N_BASE_URL: "https://n8n.example.test",
  PKC_AUTH_KEY: "test-only-key",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test",
  PKC_FOUNDER_SUBJECT: "11111111-1111-4111-8111-111111111111",
});
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const PROTECTED_PATHS = ["/landing.html", "/landing", "/landing/", "/dist/landing.js", "/dist/landing.js.map"];

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
    next: ({ headers }) => new Response("allowed", { status: 200, headers }),
  });
}

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
