import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createOpaqueToken,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  hashRecoveryCode,
  normalizeRecoveryCode,
  signArtifact,
  totpAt,
  verifyArtifact,
  verifyTotp,
} from "../../server/mfa/crypto.mjs";

const key = Buffer.alloc(32, 0x41);
const otherKey = Buffer.alloc(32, 0x42);
const aad = Object.freeze({ founderId: "acct-founder-1", generation: 7, algorithm: "SHA1", envelopeVersion: 1 });

test("TOTP secret envelopes require the exact key and authenticated context", () => {
  const generatedTotpMaterial = generateTotpSecret();
  const secret = generatedTotpMaterial;
  assert.ok(Buffer.isBuffer(secret));
  assert.ok(secret.byteLength >= 20);

  const envelope = encryptTotpSecret(secret, key, aad, { nonce: Buffer.alloc(12, 0x11), keyVersion: 3 });
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(envelope.keyVersion, 3);
  assert.deepEqual(decryptTotpSecret(envelope, key, aad), secret);

  assert.throws(() => decryptTotpSecret(envelope, otherKey, aad));
  assert.throws(() => decryptTotpSecret(envelope, key, { ...aad, generation: 8 }));
  assert.throws(() => decryptTotpSecret({ ...envelope, tag: Buffer.alloc(16) }, key, aad));
});

test("signed MFA artifacts reject tampering, wrong purpose, unknown fields, and clock drift", () => {
  const claims = {
    v: 1,
    iss: "pkc-n8n",
    aud: "pkc-vercel",
    typ: "pkc+mfa-handoff",
    purpose: "founder-password-verified",
    kid: "handoff-v1",
    sub: "acct-founder-1",
    jti: "11111111-1111-4111-8111-111111111111",
    login_attempt_id: "22222222-2222-4222-8222-222222222222",
    password_authenticated_at: 1_700_000_000,
    iat: 1_700_000_000,
    nbf: 1_700_000_000,
    exp: 1_700_000_060,
  };
  const schema = Object.keys(claims).sort();
  const signedArtifact = signArtifact(claims, key);
  const token = signedArtifact;
  assert.deepEqual(verifyArtifact(token, key, {
    now: 1_700_000_030,
    issuer: "pkc-n8n",
    audience: "pkc-vercel",
    type: "pkc+mfa-handoff",
    purpose: "founder-password-verified",
    allowedFields: schema,
  }), claims);

  const [payload, signature] = token.split(".");
  assert.throws(() => verifyArtifact(`${payload}.${signature.slice(0, -1)}A`, key, {
    now: 1_700_000_030, issuer: claims.iss, audience: claims.aud, type: claims.typ, purpose: claims.purpose, allowedFields: schema,
  }));
  assert.throws(() => verifyArtifact(token, key, {
    now: 1_700_000_030, issuer: claims.iss, audience: claims.aud, type: claims.typ, purpose: "different", allowedFields: schema,
  }));
  assert.throws(() => verifyArtifact(signArtifact({ ...claims, unexpected: true }, key), key, {
    now: 1_700_000_030, issuer: claims.iss, audience: claims.aud, type: claims.typ, purpose: claims.purpose, allowedFields: schema,
  }));
  assert.throws(() => verifyArtifact(token, key, {
    now: claims.exp + 1, issuer: claims.iss, audience: claims.aud, type: claims.typ, purpose: claims.purpose, allowedFields: schema,
  }));
  assert.throws(() => verifyArtifact(token, key, {
    now: claims.nbf - 1, issuer: claims.iss, audience: claims.aud, type: claims.typ, purpose: claims.purpose, allowedFields: schema,
  }));
});

test("RFC 6238 SHA-1 codes preserve leading zeroes and enforce monotonic counters", () => {
  const rfcFixtureBytes = Buffer.from("12345678901234567890", "ascii");
  assert.equal(totpAt(rfcFixtureBytes, 59_000, { digits: 8 }), "94287082");
  assert.equal(totpAt(rfcFixtureBytes, 1_111_111_109_000, { digits: 8 }), "07081804");

  const currentCounter = Math.floor(59 / 30);
  const code = totpAt(rfcFixtureBytes, 59_000);
  assert.deepEqual(verifyTotp(code, rfcFixtureBytes, 59_000, { lastAcceptedCounter: null }), { valid: true, counter: String(currentCounter) });
  assert.deepEqual(verifyTotp(code, rfcFixtureBytes, 59_000, { lastAcceptedCounter: String(currentCounter) }), { valid: false, reason: "replayed" });
  assert.deepEqual(verifyTotp("not-six", rfcFixtureBytes, 59_000), { valid: false, reason: "malformed" });
  assert.deepEqual(verifyTotp(totpAt(rfcFixtureBytes, 119_000), rfcFixtureBytes, 59_000), { valid: false, reason: "invalid" });
});

test("opaque challenges and recovery codes expose entropy but persist only hashes", () => {
  const generatedOpaqueCredential = createOpaqueToken();
  const token = generatedOpaqueCredential;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hashOpaqueToken(token).byteLength, 32);
  assert.notDeepEqual(hashOpaqueToken(token), hashOpaqueToken(createOpaqueToken()));

  const codes = generateRecoveryCodes({ count: 10 });
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){6}$/);
    assert.equal(normalizeRecoveryCode(` ${code.toLowerCase()} `), code.replaceAll("-", ""));
    assert.equal(hashRecoveryCode(code, key).byteLength, 32);
    assert.notDeepEqual(hashRecoveryCode(code, key), hashRecoveryCode(code, otherKey));
  }
});
