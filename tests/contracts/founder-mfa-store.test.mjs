import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";

import pg from "pg";

import { totpAt } from "../../server/mfa/crypto.mjs";
import { createReadOnlyKeyring } from "../../server/mfa/keyring.mjs";
import { createFounderMfaService } from "../../server/mfa/service.mjs";
import { createFounderMfaStore } from "../../server/mfa/store.mjs";

const databaseUrl = process.env.PKC_MFA_TEST_DATABASE_URL;
const native = databaseUrl ? test : test.skip;
const key = (byte) => Buffer.alloc(32, byte);
const config = Object.freeze({
  keys: Object.freeze({ encryption: key(1), handoff: key(4), finalize: key(2), recovery: key(3) }),
  keyrings: Object.freeze({
    encryption: createReadOnlyKeyring([[1, key(1)]]), handoff: createReadOnlyKeyring([[1, key(4)]]),
    finalize: createReadOnlyKeyring([[1, key(2)]]), recovery: createReadOnlyKeyring([[1, key(3)]]),
  }),
  keyVersions: Object.freeze({ encryption: 1, handoff: 1, finalize: 1, recovery: 1 }),
  founderSubject: "11111111-1111-4111-8111-111111111111",
  mode: "enforced",
  deployment: Object.freeze({ sourceCommit: "a".repeat(40), deploymentId: "deployment-test-0001", workflowDigest: "b".repeat(64) }),
  handoff: Object.freeze({ issuer: "pkc-n8n-account-login", audience: "pkc-vercel-founder-mfa" }),
  finalize: Object.freeze({ issuer: "pkc-vercel-founder-mfa", audience: "pkc-n8n-founder-mfa-finalizer", ttlSeconds: 60 }),
});
const founder = "11111111-1111-4111-8111-111111111111";
const nowMs = Date.parse("2026-09-27T12:00:00.000Z");
const totpFixtureBytes = Buffer.from("12345678901234567890", "ascii");
const runtimeSecretFactory = () => Buffer.from(totpFixtureBytes);

async function fixture(t, finalizer = async () => ({ status: "unknown" })) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  t.after(async () => pool.end());
  await pool.query("ALTER TABLE pkc_auth.founder_mfa_audit_events DISABLE TRIGGER USER");
  try {
    await pool.query("TRUNCATE pkc_auth.founder_mfa_audit_events, pkc_auth.founder_mfa_outbox, pkc_auth.founder_mfa_recovery_operations, pkc_auth.founder_mfa_enrollment_authorizations, pkc_auth.founder_mfa_recovery_codes, pkc_auth.founder_mfa_finalizations, pkc_auth.founder_mfa_challenges, pkc_auth.founder_mfa_factors CASCADE");
  } finally {
    await pool.query("ALTER TABLE pkc_auth.founder_mfa_audit_events ENABLE TRIGGER USER");
  }
  let uuidCounter = 0;
  const randomUuid = () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  };
  const store = createFounderMfaStore({ pool });
  const serviceCore = createFounderMfaService({
    store,
    config,
    clock: () => nowMs,
    randomUuid,
    randomSecret: runtimeSecretFactory,
    finalizer,
  });
  const beginChallenge = async (...args) => {
    const result = await serviceCore.beginChallenge(...args);
    const factor = (await pool.query("SELECT founder_subject,state,auth_epoch FROM pkc_auth.founder_mfa_factors WHERE founder_subject=$1", [founder])).rows[0];
    if (factor && ["unenrolled", "recovery_required"].includes(factor.state)) {
      await pool.query(
        `INSERT INTO pkc_auth.founder_mfa_enrollment_authorizations
         (founder_subject,source_commit,deployment_id,workflow_digest,approval_id,issued_at,expires_at,expected_factor_state,expected_auth_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (founder_subject) WHERE consumed_at IS NULL DO NOTHING`,
        [founder, config.deployment.sourceCommit, config.deployment.deploymentId, config.deployment.workflowDigest,
          "approval-test-0001", new Date(nowMs - 1_000), new Date(nowMs + 600_000), factor.state, factor.auth_epoch],
      );
    }
    return result;
  };
  const service = Object.freeze({ ...serviceCore, beginChallenge });
  return { pool, store, service };
}

function handoff(overrides = {}) {
  return {
    sub: founder,
    username: "PK Blick",
    is_admin: true,
    jti: randomUUID(),
    login_attempt_id: randomUUID(),
    password_authenticated_at: Math.floor(nowMs / 1000),
    ...overrides,
  };
}

function signedHandoff(claims) {
  const header = { alg: "HS256", typ: "JWT", kid: "handoff-v1" };
  const body = {
    iss: "pkc-n8n-account-login",
    aud: "pkc-vercel-founder-mfa",
    typ: "pkc-founder-password-handoff+jwt",
    purpose: "founder_mfa_challenge",
    version: 1,
    kid: "handoff-v1",
    sub: founder,
    username: "PK Blick",
    is_admin: true,
    jti: `handoff-${"a".repeat(48)}`,
    login_attempt_id: randomUUID(),
    password_authenticated_at: Math.floor(nowMs / 1000),
    iat: Math.floor(nowMs / 1000),
    nbf: Math.floor(nowMs / 1000) - 2,
    exp: Math.floor(nowMs / 1000) + 60,
    ...claims,
  };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `${input}.${createHmac("sha256", config.keys.handoff).update(input).digest("base64url")}`;
}

test("store founder subject inputs are canonical UUIDs", async () => {
  let queries = 0;
  const pool = {
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    query: async () => { queries += 1; return { rows: [] }; },
  };
  const store = createFounderMfaStore({ pool });
  for (const value of ["PK Blick", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ` ${founder}`, `${founder} `]) {
    await assert.rejects(() => store.readFactorAuthority(value), /invalid_founder_subject/);
    await assert.rejects(() => store.lockFactor({ query: async () => { queries += 1; } }, value), /invalid_founder_subject/);
  }
  assert.equal(queries, 0);
});

test("service rejects noncanonical configured founder subjects before store access", () => {
  const store = { transaction: async () => { throw new Error("must_not_reach_store"); } };
  for (const founderSubject of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ` ${founder}`, `${founder} `, "malformed"]) {
    assert.throws(() => createFounderMfaService({ store, config: { ...config, founderSubject } }), /invalid_mfa_config/);
  }
});

test("signed handoff rejects noncanonical founder sub before store access", async () => {
  const store = { transaction: async () => { throw new Error("must_not_reach_store"); } };
  const service = createFounderMfaService({ store, config, clock: () => nowMs });
  for (const sub of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ` ${founder}`, `${founder} `]) {
    await assert.rejects(() => service.beginFromSignedHandoff(signedHandoff({ sub })), /mfa_rejected/);
  }
});

native("signed founder handoffs use the dormant n8n JWT contract", async (t) => {
  const { service } = await fixture(t);
  const result = await service.beginFromSignedHandoff(signedHandoff());
  assert.equal(result.status, "mfa_required");
  await assert.rejects(() => service.beginFromSignedHandoff(`${signedHandoff()}x`), /mfa_rejected/);
});

native("native Postgres stores only hashes and deduplicates a login attempt while preserving factor→challenge lock order", async (t) => {
  const { pool, service } = await fixture(t);
  const proof = handoff();
  const first = await service.beginChallenge(proof);
  const retry = await service.beginChallenge({ ...proof, jti: randomUUID() });

  assert.equal(retry.challengeId, first.challengeId);
  assert.notEqual(retry.token, first.token);
  assert.notEqual(retry.csrf, first.csrf);
  assert.equal(first.status, "mfa_required");
  const row = (await pool.query("SELECT token_hash, anti_csrf_hash, EXTRACT(EPOCH FROM (expires_at-created_at)) AS ttl_seconds, max_attempts FROM pkc_auth.founder_mfa_challenges")).rows[0];
  assert.equal(row.token_hash.length, 32);
  assert.equal(row.anti_csrf_hash.length, 32);
  assert.equal(row.max_attempts, 5);
  assert.equal(Math.round(Number(row.ttl_seconds)), 300);
  assert.equal(JSON.stringify(row).includes(first.token), false);
  assert.equal(JSON.stringify(row).includes(first.csrf), false);
});

native("enrollment secret is disclosed once and activation atomically advances epoch, stores recovery hashes, outbox, and safe audit", async (t) => {
  const { pool, store, service } = await fixture(t);
  const challenge = await service.beginChallenge(handoff());
  const disclosed = await service.discloseEnrollment({ token: challenge.token, csrf: challenge.csrf, issuer: "ProjectKidCreations", accountName: "Founder" });
  assert.equal(disclosed.status, "enrollment_required");
  assert.match(disclosed.manualSecret, /^[A-Z2-7]+$/);
  assert.match(disclosed.otpauthUri, /^otpauth:\/\/totp\//);
  await assert.rejects(() => service.discloseEnrollment({ token: challenge.token, csrf: challenge.csrf }), /mfa_rejected/);

  const activated = await service.verifyTotp({ token: challenge.token, csrf: challenge.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  assert.equal(activated.status, "finalize_pending");
  assert.equal(activated.recoveryCodes.length, 10);
  assert.equal(new Set(activated.recoveryCodes).size, 10);

  const factor = (await pool.query("SELECT state, auth_epoch, revoked_before, last_accepted_counter, secret_ciphertext FROM pkc_auth.founder_mfa_factors")).rows[0];
  assert.equal(factor.state, "active");
  assert.equal(factor.auth_epoch, "1");
  assert.ok(factor.revoked_before);
  assert.ok(factor.secret_ciphertext.length > 0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM pkc_auth.founder_mfa_recovery_codes WHERE used_at IS NULL")).rows[0].count), 10);
  assert.equal(Number((await pool.query("SELECT count(*) FROM pkc_auth.founder_mfa_outbox WHERE operation_type='revoke_founder_sessions'")).rows[0].count), 1);
  const persisted = JSON.stringify((await pool.query("SELECT metadata FROM pkc_auth.founder_mfa_audit_events UNION ALL SELECT payload FROM pkc_auth.founder_mfa_outbox")).rows);
  assert.equal(persisted.includes(disclosed.manualSecret), false);
  assert.equal(persisted.includes(activated.recoveryCodes[0]), false);
  assert.equal(persisted.includes(totpAt(totpFixtureBytes, nowMs)), false);
  assert.deepEqual(await store.readFactorAuthority(founder), {
    founderSubject: founder,
    state: "active",
    authEpoch: "1",
    revokedBefore: new Date(factor.revoked_before),
  });
});

native("invented caller approval labels cannot invoke no-code recovery through the service API", async (t) => {
  const { pool, service } = await fixture(t);
  const enrollment = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enrollment.token, csrf: enrollment.csrf });
  await service.verifyTotp({ token: enrollment.token, csrf: enrollment.csrf, code: totpAt(totpFixtureBytes, nowMs) });

  const pending = await service.beginChallenge(handoff());
  const inventedRequest = {
    operationId: "recovery-op-native-0001",
    founderSubject: founder,
    operator: { principalId: "operator-native-01", approvalId: "approval-operator-native-01" },
    verifier: { principalId: "verifier-native-02", approvalId: "approval-verifier-native-02" },
    reasonCode: "FACTOR_LOST",
  };
  assert.equal(service.noCodeRecovery, undefined);
  assert.equal(service.reconcileNoCodeRecovery, undefined);
  assert.throws(() => service.noCodeRecovery(inventedRequest), TypeError);
  const factor = (await pool.query("SELECT state,auth_epoch,secret_ciphertext FROM pkc_auth.founder_mfa_factors WHERE founder_subject=$1", [founder])).rows[0];
  assert.equal(factor.state, "active");
  assert.equal(String(factor.auth_epoch), "1");
  assert.ok(factor.secret_ciphertext);
  assert.equal((await pool.query("SELECT state FROM pkc_auth.founder_mfa_challenges WHERE challenge_id=$1", [pending.challengeId])).rows[0].state, "pending");
  assert.equal(Number((await pool.query("SELECT count(*) FROM pkc_auth.founder_mfa_recovery_operations")).rows[0].count), 0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM pkc_auth.founder_mfa_audit_events WHERE event_type='no_code_recovery'")).rows[0].count), 0);
});

native("finalization fails closed when the Postgres epoch changes before dispatch", async (t) => {
  let finalizerCalls = 0;
  const { pool, service } = await fixture(t, async () => {
    finalizerCalls += 1;
    return { status: "unknown" };
  });
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  await pool.query("UPDATE pkc_auth.founder_mfa_factors SET auth_epoch=auth_epoch+1, revoked_before=clock_timestamp()");
  await assert.rejects(
    () => service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }),
    /mfa_rejected/,
  );
  assert.equal(finalizerCalls, 0);
});

native("finalization rejects a receipt when the Postgres epoch changes during dispatch", async (t) => {
  let poolRef;
  const finalizer = async ({ identity }) => {
    await poolRef.query("UPDATE pkc_auth.founder_mfa_factors SET auth_epoch=auth_epoch+1, revoked_before=clock_timestamp()");
    return {
      status: "ok",
      finalizeId: identity.finalizeId,
      sessionId: identity.sessionId,
      grantJti: identity.grantJti,
      setCookie: "pkc_session=stale-epoch; Path=/; Secure; HttpOnly; SameSite=Strict",
    };
  };
  const fixtureValue = await fixture(t, finalizer);
  poolRef = fixtureValue.pool;
  const { pool, service } = fixtureValue;
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  assert.deepEqual(
    await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }),
    { status: "unknown" },
  );
  assert.equal((await pool.query("SELECT state FROM pkc_auth.founder_mfa_finalizations")).rows[0].state, "terminal_rejected");
});

native("finalization succeeds with an exact above-safe-integer PostgreSQL lease fence", async (t) => {
  const finalizer = async ({ identity }) => ({
    status: "ok",
    finalizeId: identity.finalizeId,
    sessionId: identity.sessionId,
    grantJti: identity.grantJti,
    setCookie: "pkc_session=large-fence; Path=/; Secure; HttpOnly; SameSite=Strict",
  });
  const { pool, service } = await fixture(t, finalizer);
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  await pool.query(
    "UPDATE pkc_auth.founder_mfa_finalizations SET lease_fence=$2 WHERE finalize_id=$1",
    [verified.finalizeId, "9007199254740992"],
  );

  assert.equal(
    (await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId })).status,
    "authenticated",
  );
  const row = (await pool.query(
    "SELECT lease_fence::text AS lease_fence, state FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1",
    [verified.finalizeId],
  )).rows[0];
  assert.deepEqual(row, { lease_fence: "9007199254740993", state: "succeeded" });
});

native("finalization rejects an adjacent above-safe-integer PostgreSQL lease fence without aliasing", async (t) => {
  let pool;
  const finalizer = async ({ identity }) => {
    await pool.query(
      "UPDATE pkc_auth.founder_mfa_finalizations SET lease_fence=$1 WHERE finalize_id=$2",
      ["9007199254740992", identity.finalizeId.replace(/^finalize-/, "")],
    );
    return {
      status: "ok",
      finalizeId: identity.finalizeId,
      sessionId: identity.sessionId,
      grantJti: identity.grantJti,
      setCookie: "pkc_session=stale-fence; Path=/; Secure; HttpOnly; SameSite=Strict",
    };
  };
  const fixtureValue = await fixture(t, finalizer);
  pool = fixtureValue.pool;
  const { service } = fixtureValue;
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  await pool.query(
    "UPDATE pkc_auth.founder_mfa_finalizations SET lease_fence=$2 WHERE finalize_id=$1",
    [verified.finalizeId, "9007199254740992"],
  );

  assert.deepEqual(
    await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }),
    { status: "unknown" },
  );
  const row = (await pool.query(
    "SELECT lease_fence::text AS lease_fence, state FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1",
    [verified.finalizeId],
  )).rows[0];
  assert.deepEqual(row, { lease_fence: "9007199254740992", state: "dispatching" });
});

native("active TOTP accepts one monotonic counter under row lock and a concurrent replay cannot mint a second finalization", async (t) => {
  const { pool, service } = await fixture(t);
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });

  const verify = await service.beginChallenge(handoff());
  const code = totpAt(totpFixtureBytes, nowMs + 30_000);
  const outcomes = await Promise.allSettled([
    service.verifyTotp({ token: verify.token, csrf: verify.csrf, code }),
    service.verifyTotp({ token: verify.token, csrf: verify.csrf, code }),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM pkc_auth.founder_mfa_finalizations")).rows[0].count), 2);
});

native("five failed attempts exhaust a five-minute challenge and failures remain generic", async (t) => {
  const { pool, service } = await fixture(t);
  const challenge = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: challenge.token, csrf: challenge.csrf });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(() => service.verifyTotp({ token: challenge.token, csrf: challenge.csrf, code: "000000" }), /mfa_rejected/);
  }
  await assert.rejects(() => service.verifyTotp({ token: challenge.token, csrf: challenge.csrf, code: totpAt(totpFixtureBytes, nowMs) }), /mfa_rejected/);
  const row = (await pool.query("SELECT state, attempts_used FROM pkc_auth.founder_mfa_challenges")).rows[0];
  assert.equal(row.state, "exhausted");
  assert.equal(row.attempts_used, 5);
});

native("a recovery code is consumed atomically, disables the seed, increments epoch, invalidates outstanding authority, and forces re-enrollment", async (t) => {
  const { pool, service } = await fixture(t);
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const activated = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  const recoveryCode = activated.recoveryCodes[0];

  const recovery = await service.beginChallenge(handoff());
  assert.equal((await pool.query("SELECT purpose FROM pkc_auth.founder_mfa_challenges WHERE challenge_id=$1", [recovery.challengeId])).rows[0].purpose, "verify");
  const result = await service.useRecoveryCode({ token: recovery.token, csrf: recovery.csrf, code: recoveryCode });
  assert.deepEqual(result, { status: "reenrollment_required" });
  await assert.rejects(() => service.useRecoveryCode({ token: recovery.token, csrf: recovery.csrf, code: recoveryCode }), /mfa_rejected/);

  const factor = (await pool.query("SELECT state, auth_epoch, secret_ciphertext, last_accepted_counter FROM pkc_auth.founder_mfa_factors")).rows[0];
  assert.equal(factor.state, "recovery_required");
  assert.equal(factor.auth_epoch, "2");
  assert.equal(factor.secret_ciphertext, null);
  assert.equal(factor.last_accepted_counter, null);
  assert.equal(Number((await pool.query("SELECT count(*) FROM pkc_auth.founder_mfa_finalizations WHERE state NOT IN ('terminal_rejected','succeeded')")).rows[0].count), 0);
});

native("finalization retries use one stable identity, unknown outcomes stay unknown, and only a matching receipt succeeds", async (t) => {
  const calls = [];
  let attempt = 0;
  const finalizer = async ({ grant, identity }) => {
    calls.push({ grant, identity });
    attempt += 1;
    if (attempt === 1) throw new Error("timeout");
    if (attempt === 2) return { status: "ok", finalizeId: randomUUID(), sessionId: identity.sessionId, grantJti: identity.grantJti, setCookie: "pkc_session=attacker" };
    return { status: "ok", finalizeId: identity.finalizeId, sessionId: identity.sessionId, grantJti: identity.grantJti, setCookie: "pkc_session=verified; Path=/; Secure; HttpOnly; SameSite=Strict" };
  };
  const { pool, service } = await fixture(t, finalizer);
  const loginProof = handoff();
  const enroll = await service.beginChallenge(loginProof);
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });

  assert.deepEqual(await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }), { status: "unknown" });
  assert.deepEqual(await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }), { status: "unknown" });
  const success = await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId });
  assert.equal(success.status, "authenticated");
  assert.match(success.setCookie, /^pkc_session=verified/);
  const recovered = await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId });
  assert.equal(recovered.status, "authenticated");
  assert.equal(recovered.setCookie, success.setCookie, "a lost successful response must replay the same deterministic session cookie");
  assert.equal(new Set(calls.map((call) => call.grant)).size, 1);
  const persistedClaims = JSON.parse(Buffer.from(calls[0].grant.split(".")[1], "base64url").toString("utf8"));
  assert.equal(persistedClaims.sub, founder);
  assert.equal(new Set(calls.map((call) => JSON.stringify(call.identity))).size, 1);
  assert.equal((await pool.query("SELECT state FROM pkc_auth.founder_mfa_finalizations")).rows[0].state, "succeeded");
  await assert.rejects(() => service.beginChallenge({ ...loginProof, jti: randomUUID() }), /mfa_rejected/);
});

native("an expired finalization at its retry ceiling becomes terminal before reclaim", async (t) => {
  const { pool, service } = await fixture(t);
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });
  await pool.query(
    `UPDATE pkc_auth.founder_mfa_finalizations SET state='dispatching',lease_owner=$2,
     lease_expires_at=$3,lease_fence=5,dispatch_attempts=5 WHERE finalize_id=$1`,
    [verified.finalizeId, randomUUID(), new Date(nowMs - 1_000)],
  );
  await assert.rejects(() => service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }), /mfa_rejected/);
  assert.equal((await pool.query("SELECT state FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1", [verified.finalizeId])).rows[0].state, "terminal_rejected");
});

native("a succeeded replay rechecks factor epoch after dispatch and cannot return a stale session", async (t) => {
  let attempt = 0;
  let pool;
  const finalizer = async ({ identity }) => {
    attempt += 1;
    if (attempt === 2) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE pkc_auth.founder_mfa_factors
           SET state='recovery_required', auth_epoch=auth_epoch+1, secret_algorithm=NULL, secret_ciphertext=NULL,
               secret_nonce=NULL, secret_tag=NULL, secret_key_version=NULL, last_accepted_counter=NULL`,
        );
        await client.query(
          `UPDATE pkc_auth.founder_mfa_finalizations
           SET state='terminal_rejected', lease_owner=NULL, lease_expires_at=NULL,
               receipt_digest=NULL, finalized_at=NULL`,
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return {
      status: "ok",
      finalizeId: identity.finalizeId,
      sessionId: identity.sessionId,
      grantJti: identity.grantJti,
      setCookie: "pkc_session=verified; Path=/; Secure; HttpOnly; SameSite=Strict",
    };
  };
  const fixtureState = await fixture(t, finalizer);
  pool = fixtureState.pool;
  const { service } = fixtureState;
  const enroll = await service.beginChallenge(handoff());
  await service.discloseEnrollment({ token: enroll.token, csrf: enroll.csrf });
  const verified = await service.verifyTotp({ token: enroll.token, csrf: enroll.csrf, code: totpAt(totpFixtureBytes, nowMs) });

  assert.equal((await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId })).status, "authenticated");
  assert.deepEqual(
    await service.finalize({ token: enroll.token, csrf: enroll.csrf, finalizeId: verified.finalizeId }),
    { status: "unknown" },
  );
  const factor = (await pool.query("SELECT state, auth_epoch FROM pkc_auth.founder_mfa_factors")).rows[0];
  assert.equal(factor.state, "recovery_required");
  assert.equal(factor.auth_epoch, "2");
});
