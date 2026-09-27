import assert from "node:assert/strict";
import { test } from "node:test";

import { loadMfaConfig } from "../../server/mfa/config.mjs";
import {
  clearMfaCookie,
  mfaJson,
  parseMfaCookie,
  serializeMfaCookie,
  validateMfaMutationRequest,
} from "../../server/mfa/http.mjs";

const opaque = "A".repeat(43);
const originEnv = "https://projectkidcreations.io,https://www.projectkidcreations.io";

test("MFA configuration is strict, key-separated, and loaded only on demand", () => {
  const base = {
    PKC_DATABASE_URL: "postgresql://runtime@db.example.invalid/pkc?sslmode=require",
    PKC_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    PKC_MFA_HANDOFF_KEY: Buffer.alloc(32, 2).toString("base64"),
    PKC_MFA_FINALIZE_KEY: Buffer.alloc(32, 3).toString("base64"),
    PKC_MFA_RECOVERY_PEPPER: Buffer.alloc(32, 4).toString("base64"),
    PKC_PUBLIC_ALLOWED_ORIGINS: originEnv,
    PKC_N8N_BASE_URL: "https://n8n.example.invalid",
    PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.invalid",
    PKC_AUTH_KEY: "internal-auth-key",
  };
  const config = loadMfaConfig(base);
  assert.equal(config.keyVersions.encryption, 1);
  assert.equal(config.keys.encryption.byteLength, 32);
  assert.equal(config.keys.handoff.byteLength, 32);
  assert.equal(config.keys.finalize.byteLength, 32);
  assert.equal(config.keys.recovery.byteLength, 32);
  assert.notDeepEqual(config.keys.encryption, config.keys.handoff);
  assert.equal(config.databaseUrl, base.PKC_DATABASE_URL);
  assert.deepEqual([...config.publicOrigins].sort(), originEnv.split(",").sort());

  for (const name of ["PKC_DATABASE_URL", "PKC_TOTP_ENCRYPTION_KEY", "PKC_MFA_HANDOFF_KEY", "PKC_MFA_FINALIZE_KEY", "PKC_MFA_RECOVERY_PEPPER"]) {
    const broken = { ...base };
    delete broken[name];
    assert.throws(() => loadMfaConfig(broken), new RegExp(name));
  }
  assert.throws(() => loadMfaConfig({ ...base, PKC_MFA_HANDOFF_KEY: base.PKC_TOTP_ENCRYPTION_KEY }), /key_reuse/);
});

test("pre-auth cookies are strict host-only opaque values and duplicates fail closed", () => {
  assert.equal(
    serializeMfaCookie(opaque, 300),
    `__Host-pkc_mfa=${opaque}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`,
  );
  assert.equal(parseMfaCookie(`other=x; __Host-pkc_mfa=${opaque}`), opaque);
  assert.equal(parseMfaCookie("other=x"), null);
  assert.throws(() => parseMfaCookie(`__Host-pkc_mfa=${opaque}; __Host-pkc_mfa=${opaque}`), /duplicate_mfa_cookie/);
  assert.throws(() => parseMfaCookie("__Host-pkc_mfa=attacker-fixed"), /invalid_mfa_cookie/);
  assert.equal(clearMfaCookie(), "__Host-pkc_mfa=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
});

test("MFA mutations require exact origin, same-site metadata, JSON, and challenge CSRF", async () => {
  const request = (headers = {}, body = { csrf: opaque }) => new Request("https://projectkidcreations.io/api/account/mfa/verify", {
    method: "POST",
    headers: {
      origin: "https://projectkidcreations.io",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const allowed = new Set(originEnv.split(","));
  assert.deepEqual(await validateMfaMutationRequest(request(), allowed, { allowedFields: ["csrf"], requiredFields: ["csrf"] }), { csrf: opaque });

  for (const headers of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
  ]) await assert.rejects(() => validateMfaMutationRequest(request(headers), allowed, { allowedFields: ["csrf"], requiredFields: ["csrf"] }));

  await assert.rejects(() => validateMfaMutationRequest(request({}, { csrf: opaque, extra: true }), allowed, { allowedFields: ["csrf"], requiredFields: ["csrf"] }), /unknown_field/);
  await assert.rejects(() => validateMfaMutationRequest(request({}, { csrf: "short" }), allowed, { allowedFields: ["csrf"], requiredFields: ["csrf"] }), /invalid_csrf/);
});

test("MFA responses are no-store, no-referrer, frame-denied, and JSON only", async () => {
  const response = mfaJson({ status: "mfa_required" }, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { status: "mfa_required" });
});
