import assert from "node:assert/strict";
import { test } from "node:test";

import { createFounderLoginUpstreamTransform } from "../../server/mfa/login-integration.mjs";

const handoff = "signed-handoff-placeholder-value-long-enough";
const csrf = "B".repeat(43);
const token = "A".repeat(43);

function upstream(body, headers = {}) {
  return {
    upstream: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } }),
    data: body,
  };
}

test("trusted founder handoff is consumed inside Vercel and never reaches the browser", async () => {
  let received;
  const transform = createFounderLoginUpstreamTransform({
    beginFounderMfa: async (value) => {
      received = value;
      return { status: "mfa_required", csrf, token, mode: "enroll", maxAgeSeconds: 300 };
    },
  });
  const response = await transform(upstream({
    ok: true,
    status: "mfa_required",
    request_id: "req-1",
    login_attempt_id: "11111111-1111-4111-8111-111111111111",
    handoff,
  }));
  assert.equal(received, handoff);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /^__Host-pkc_mfa=.*HttpOnly; Secure; SameSite=Strict/);
  const data = await response.json();
  assert.deepEqual(data, { ok: true, status: "mfa_required", mode: "enroll", csrf });
  assert.equal(JSON.stringify(data).includes(handoff), false);
});

test("founder MFA branch rejects any upstream session cookie before MFA", async () => {
  let begins = 0;
  const transform = createFounderLoginUpstreamTransform({ beginFounderMfa: async () => { begins += 1; } });
  const response = await transform(upstream({
    ok: true,
    status: "mfa_required",
    request_id: "req-1",
    login_attempt_id: "11111111-1111-4111-8111-111111111111",
    handoff,
  }, { "set-cookie": "pkc_session=forbidden; Path=/; HttpOnly; Secure" }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { error: "invalid_upstream_response" });
  assert.equal(begins, 0);
});

test("handoff is forbidden outside the exact closed MFA-required response", async () => {
  const transform = createFounderLoginUpstreamTransform({ beginFounderMfa: async () => { throw new Error("must not run"); } });
  const smuggled = await transform(upstream({ ok: true, status: "authenticated", handoff }));
  assert.equal(smuggled.status, 502);
  assert.deepEqual(await smuggled.json(), { error: "invalid_upstream_response" });

  const extra = await transform(upstream({
    ok: true,
    status: "mfa_required",
    request_id: "req-1",
    login_attempt_id: "11111111-1111-4111-8111-111111111111",
    handoff,
    extra: true,
  }));
  assert.equal(extra.status, 502);
});

test("ordinary customer responses bypass MFA byte handling", async () => {
  const transform = createFounderLoginUpstreamTransform({ beginFounderMfa: async () => { throw new Error("must not run"); } });
  assert.equal(await transform(upstream({ ok: true, status: "authenticated", username: "customer" })), null);
  assert.equal(await transform(upstream({ error: "invalid_credentials" })), null);
});

test("malformed internal challenge material fails closed without setting a cookie", async () => {
  const transform = createFounderLoginUpstreamTransform({
    beginFounderMfa: async () => ({ status: "mfa_required", mode: "verify", token, csrf: "bad", maxAgeSeconds: 300 }),
  });
  const response = await transform(upstream({
    ok: true,
    status: "mfa_required",
    request_id: "req-1",
    login_attempt_id: "11111111-1111-4111-8111-111111111111",
    handoff,
  }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("set-cookie"), null);
});
