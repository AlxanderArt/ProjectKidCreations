import assert from "node:assert/strict";
import { test } from "node:test";

import { createFounderMfaRoutes } from "../../server/mfa/routes.mjs";

const token = "A".repeat(43);
const csrf = "B".repeat(43);
const origin = "https://projectkidcreations.io";

function request(path, body, cookie = true) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...(cookie ? { cookie: `__Host-pkc_mfa=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function routes(service, factory = async () => service) {
  return createFounderMfaRoutes({ serviceFactory: factory, publicOrigins: new Set([origin]) });
}

test("route configuration is lazy and start is founder-handoff-only", async () => {
  let loads = 0;
  const handler = routes(null, async () => {
    loads += 1;
    return { beginFromSignedHandoff: async () => { throw new Error("invalid founder handoff"); } };
  });
  assert.equal(loads, 0);
  const rejected = await handler.start(request("/api/account/mfa-start", { handoff: "customer-or-invalid" }, false));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("set-cookie"), null);
  assert.deepEqual(await rejected.json(), { status: "mfa_failed" });
  assert.equal(loads, 1);
});

test("start sets only the pre-auth cookie after a trusted founder handoff and never exposes proof", async () => {
  const handler = routes({
    beginFromSignedHandoff: async () => ({ status: "mfa_required", token, csrf, maxAgeSeconds: 300 }),
  });
  const response = await handler.start(request("/api/account/mfa-start", { handoff: "signed-founder-handoff" }, false));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /^__Host-pkc_mfa=.*HttpOnly; Secure; SameSite=Strict/);
  assert.deepEqual(await response.json(), { status: "mfa_required", csrf });
});

test("enrollment, verify, and recovery mutations require the matching cookie and challenge CSRF and return generic failures", async () => {
  const handler = routes({
    discloseEnrollment: async () => { throw new Error("seed decrypt detail"); },
    verifyTotp: async () => { throw new Error("replayed counter 123"); },
    useRecoveryCode: async () => { throw new Error("recovery hash mismatch"); },
  });
  for (const [method, path, body] of [
    ["enrollment", "/api/account/mfa-enrollment", { csrf }],
    ["verify", "/api/account/mfa-verify", { csrf, code: "123456" }],
    ["recovery", "/api/account/mfa-recovery", { csrf, code: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG" }],
  ]) {
    const response = await handler[method](request(path, body));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { status: "mfa_failed" });
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("no founder session cookie is emitted before a matching successful finalizer receipt", async () => {
  let outcome = { status: "unknown" };
  const handler = routes({ finalize: async () => outcome });
  const pending = await handler.finalize(request("/api/account/mfa-finalize", { csrf, finalizeId: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get("set-cookie"), null);
  assert.deepEqual(await pending.json(), { status: "unknown" });

  outcome = { status: "authenticated", setCookie: "pkc_session=verified; Path=/; Secure; HttpOnly; SameSite=Strict" };
  const success = await handler.finalize(request("/api/account/mfa-finalize", { csrf, finalizeId: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("set-cookie"), outcome.setCookie);
  assert.deepEqual(await success.json(), { status: "authenticated" });

  outcome = { status: "authenticated", setCookie: "pkc_session=unsafe; Domain=evil.example; Secure; HttpOnly" };
  const unsafe = await handler.finalize(request("/api/account/mfa-finalize", { csrf, finalizeId: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(unsafe.status, 401);
  assert.equal(unsafe.headers.get("set-cookie"), null);
  assert.deepEqual(await unsafe.json(), { status: "mfa_failed" });
});

test("missing MFA configuration fails closed only on an MFA route", async () => {
  const handler = routes(null, async () => { throw new Error("missing PKC_DATABASE_URL"); });
  const response = await handler.verify(request("/api/account/mfa-verify", { csrf, code: "123456" }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "not_configured" });
  assert.equal(response.headers.get("set-cookie"), null);
});
