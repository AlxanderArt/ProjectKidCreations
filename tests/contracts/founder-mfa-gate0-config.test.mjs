import assert from "node:assert/strict";
import { test } from "node:test";

import { loadMfaConfig } from "../../server/mfa/config.mjs";
import { decryptWithKeyring, selectActiveKey, signWithKeyring, verifyWithKeyring } from "../../server/mfa/keyring.mjs";
import { encryptTotpSecret } from "../../server/mfa/crypto.mjs";

const b64 = (byte) => Buffer.alloc(32, byte).toString("base64");
const ring = (...entries) => JSON.stringify(Object.fromEntries(entries.map(([version, byte]) => [String(version), b64(byte)])));
const runtimePoolDsn = "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&application_name=pkc-mfa-runtime";
const directRuntimeDsn = "postgresql://pkc_mfa_runtime@direct.db.example.invalid/pkc_founder_mfa?sslmode=verify-full";
const base = {
  PKC_DATABASE_URL: runtimePoolDsn,
  PKC_DATABASE_NAME: "pkc_founder_mfa",
  PKC_DATABASE_USER: "pkc_mfa_runtime",
  PKC_DATABASE_ENVIRONMENT: "test",
  PKC_DATABASE_POOL_MAX: "4",
  PKC_DATABASE_CONNECTION_BUDGET: "20",
  PKC_TOTP_ENCRYPTION_KEYRING: ring([1, 1], [2, 2]),
  PKC_TOTP_ENCRYPTION_KEY_VERSION: "2",
  PKC_MFA_HANDOFF_KEYRING: ring([1, 3], [2, 4]),
  PKC_MFA_HANDOFF_KEY_VERSION: "2",
  PKC_MFA_FINALIZE_KEYRING: ring([1, 5], [2, 6]),
  PKC_MFA_FINALIZE_KEY_VERSION: "2",
  PKC_MFA_RECOVERY_PEPPER_KEYRING: ring([1, 7], [2, 8]),
  PKC_MFA_RECOVERY_PEPPER_VERSION: "2",
  PKC_PUBLIC_ALLOWED_ORIGINS: "https://projectkidcreations.io",
  PKC_N8N_BASE_URL: "https://n8n.example.invalid",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.invalid",
  PKC_FOUNDER_SUBJECT: "11111111-1111-4111-8111-111111111111",
  PKC_AUTH_KEY: "test-only-non-production-auth-key",
};

test("versioned keyrings write active versions and retain historical read authority", () => {
  const config = loadMfaConfig(base);
  assert.equal(config.keyVersions.encryption, 2);
  assert.deepEqual([...config.keyrings.encryption.keys()], [1, 2]);
  assert.throws(() => config.keyrings.encryption.set(3, Buffer.alloc(32, 9)), /read_only_keyring/);
  const aad = { founderId: "11111111-1111-4111-8111-111111111111", generation: 1, algorithm: "SHA1", envelopeVersion: 1 };
  const totpMaterial = Buffer.from("12345678901234567890", "ascii");
  const oldEnvelope = encryptTotpSecret(totpMaterial, config.keyrings.encryption.get(1), aad, { keyVersion: 1, nonce: Buffer.alloc(12, 9) });
  assert.deepEqual(decryptWithKeyring(oldEnvelope, config.keyrings.encryption, aad), totpMaterial);
  assert.throws(() => decryptWithKeyring({ ...oldEnvelope, keyVersion: 999 }, config.keyrings.encryption, aad), /unknown_key_version/);
  const signed = signWithKeyring({ purpose: "handoff" }, config.keyrings.handoff, 2);
  assert.equal(signed.keyVersion, 2);
  assert.deepEqual(verifyWithKeyring(signed, config.keyrings.handoff), { purpose: "handoff" });
  assert.throws(() => verifyWithKeyring({ ...signed, keyVersion: 99 }, config.keyrings.handoff), /unknown_key_version/);
});

test("database configuration rejects unverified TLS, wrong identity, unsafe options, and over-budget pools", () => {
  const config = loadMfaConfig(base);
  assert.equal(config.database.expectedDatabase, "pkc_founder_mfa");
  assert.equal(config.database.expectedUser, "pkc_mfa_runtime");
  assert.equal(config.database.poolMax, 4);
  for (const url of [
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=disable",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=no-verify",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=require",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&sslmode=disable",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=disable&sslmode=verify-full",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&host=attacker.invalid",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&user=attacker",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&database=attacker",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&port=6543",
    "postgresql://wrong@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/wrong?sslmode=verify-full",
    "postgresql://pkc_mfa_runtime@pool.db.example.invalid/pkc_founder_mfa?sslmode=verify-full&options=-csearch_path%3Dpublic",
  ]) assert.throws(() => loadMfaConfig({ ...base, PKC_DATABASE_URL: url }), /invalid PKC_DATABASE_URL|database_/);
  assert.throws(() => loadMfaConfig({ ...base, PKC_DATABASE_POOL_MAX: "10", PKC_DATABASE_CONNECTION_BUDGET: "19" }), /connection_budget/);
  for (const name of ["PKC_DATABASE_NAME", "PKC_DATABASE_USER", "PKC_DATABASE_ENVIRONMENT"]) {
    const missing = { ...base };
    delete missing[name];
    assert.throws(() => loadMfaConfig(missing), new RegExp(name));
  }
  assert.throws(() => loadMfaConfig({ ...base, PKC_DATABASE_URL: directRuntimeDsn }), /database_pooler_required/);
});

test("all key purposes are byte-distinct across every retained version", () => {
  assert.throws(() => loadMfaConfig({ ...base, PKC_MFA_FINALIZE_KEYRING: ring([1, 1], [2, 6]) }), /key_reuse/);
});

test("read-only keyrings never expose mutable membership or key-byte aliases", () => {
  const config = loadMfaConfig(base);
  const keyring = config.keyrings.encryption;
  const expected = Buffer.alloc(32, 1);
  const mutate = (value) => value.fill(0xff);

  mutate(keyring.get(1));
  mutate([...keyring.values()][0]);
  mutate([...keyring.entries()][0][1]);
  mutate([...keyring][0][1]);
  keyring.forEach((value, key, target) => {
    assert.equal(target, keyring);
    mutate(value);
    assert.throws(() => target.clear(), /read_only_keyring/);
    assert.throws(() => target.set(key + 10, Buffer.alloc(32)), /read_only_keyring/);
    assert.throws(() => target.delete(key), /read_only_keyring/);
  });
  mutate(config.keys.encryption);
  mutate(selectActiveKey(keyring, 1));

  assert.deepEqual(keyring.get(1), expected);
  assert.deepEqual(config.keys.encryption, Buffer.alloc(32, 2));
  assert.deepEqual(selectActiveKey(keyring, 1), expected);
  assert.deepEqual([...keyring.keys()], [1, 2]);
});

test("keyring cryptography rejects forged Map-like keyring objects", () => {
  const forged = new Map([[1, Buffer.alloc(32, 1)]]);
  assert.throws(() => selectActiveKey(forged, 1), /invalid_keyring/);
  assert.throws(() => signWithKeyring({ purpose: "handoff" }, forged, 1), /invalid_keyring/);
});

test("enforced Production configuration requires provider deployment identity and rejects legacy authority", () => {
  const production = {
    ...base,
    PKC_DATABASE_ENVIRONMENT: "production",
    NODE_ENV: "production",
    PKC_FOUNDER_MFA_MODE: "enforced",
    PKC_SOURCE_COMMIT: "a".repeat(40),
    PKC_MFA_WORKFLOW_DIGEST: "b".repeat(64),
    VERCEL_DEPLOYMENT_ID: "dpl_provider_authority",
  };
  assert.deepEqual(loadMfaConfig(production).deployment, {
    sourceCommit: production.PKC_SOURCE_COMMIT,
    deploymentId: production.VERCEL_DEPLOYMENT_ID,
    workflowDigest: production.PKC_MFA_WORKFLOW_DIGEST,
  });
  const missingProviderIdentity = { ...production };
  delete missingProviderIdentity.VERCEL_DEPLOYMENT_ID;
  assert.throws(() => loadMfaConfig(missingProviderIdentity), /VERCEL_DEPLOYMENT_ID/);
  assert.throws(() => loadMfaConfig({ ...production, PKC_DEPLOYMENT_ID: "legacy-deployment" }), /PKC_DEPLOYMENT_ID.*forbidden/);
  assert.throws(() => loadMfaConfig({ ...production, PKC_MFA_ENROLLMENT_APPROVAL_ID: "legacy-approval" }), /PKC_MFA_ENROLLMENT_APPROVAL_ID.*forbidden/);
  assert.throws(() => loadMfaConfig(production, { nonVercelDeploymentId: "injected-deployment" }), /non-Vercel.*forbidden.*Production/i);
});
