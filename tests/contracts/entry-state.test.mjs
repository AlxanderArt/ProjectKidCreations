import assert from "node:assert/strict";
import { test } from "node:test";

import { createEntryStateHandler } from "../../server/api/entry-state.mjs";

const ENV = Object.freeze({
  PKC_N8N_BASE_URL: "https://n8n.example.test",
  PKC_AUTH_KEY: "test-only-key",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test",
  PKC_FOUNDER_SUBJECT: "11111111-1111-4111-8111-111111111111",
});

function response() {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  return {
    statusCode: 200,
    headers: new Map(),
    payload: "",
    done,
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    end(value) { this.payload = String(value ?? ""); resolveDone(); },
  };
}

async function call(handler, req) {
  const res = response();
  await handler(req, res);
  await res.done;
  return { res, body: JSON.parse(res.payload) };
}

test("entry-state keeps GET-only public-session behavior without calling upstream", async () => {
  let fetches = 0;
  const handler = createEntryStateHandler({ env: ENV, fetch: async () => { fetches += 1; } });
  const publicResult = await call(handler, { method: "GET", headers: {} });
  assert.equal(publicResult.res.statusCode, 200);
  assert.deepEqual(publicResult.body, { ok: true, schema_version: 1, state: "public", authenticated: false });
  assert.equal(fetches, 0);

  const rejected = await call(handler, { method: "POST", headers: {} });
  assert.equal(rejected.res.statusCode, 405);
  assert.equal(rejected.res.headers.get("allow"), "GET");
  assert.deepEqual(rejected.body, { ok: false, error: "method_not_allowed" });
});

test("entry-state forwards only the exact session cookie and preserves founder authority checks", async () => {
  const requests = [];
  const handler = createEntryStateHandler({
    env: ENV,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        account: {
          account_id: ENV.PKC_FOUNDER_SUBJECT,
          username: "PK Blick",
          email: "changed-founder-address@example.test",
          display_name: "Founder",
          is_admin: true,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await call(handler, { method: "GET", headers: { cookie: "other=x; pkc_session=session-token" } });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.body.state, "owner_active");
  assert.equal(result.body.account.account_id, ENV.PKC_FOUNDER_SUBJECT);
  assert.deepEqual(result.body.capabilities, { account: true, admin: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://n8n.example.test/webhook/pkc-accounts/profile");
  assert.equal(requests[0].init.headers.Cookie, "pkc_session=session-token");
  assert.equal(JSON.stringify(requests[0]).includes("other=x"), false);

  const invalid = await call(handler, { method: "GET", headers: { cookie: "pkc_session=a; pkc_session=b" } });
  assert.equal(invalid.res.statusCode, 400);
  assert.deepEqual(invalid.body, { ok: false, error: "invalid_session" });
});
