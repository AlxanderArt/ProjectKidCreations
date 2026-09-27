import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  createOpaqueToken,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashOpaqueToken,
  hashRecoveryCode,
  verifyTotp as verifyTotpCode,
} from "./crypto.mjs";

const HANDOFF_FIELDS = Object.freeze([
  "aud", "exp", "iat", "iss", "jti", "kid", "login_attempt_id", "nbf",
  "password_authenticated_at", "purpose", "sub", "typ", "version",
]);
const FINALIZE_FIELDS = Object.freeze([
  "amr", "aud", "auth_epoch", "exp", "finalize_id", "iat", "iss", "jti", "kid",
  "login_attempt_id", "mfa_verified_at", "nbf", "password_authenticated_at", "purpose",
  "session_expires_at", "session_id", "session_issued_at", "sub", "typ", "version",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID_RE = /^[a-z][a-z0-9_-]{7,127}$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function encodeJson(value) {
  const ordered = {};
  for (const key of Object.keys(value).sort()) ordered[key] = value[key];
  return Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
}

function decodeJson(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw rejected();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw rejected();
  return JSON.parse(bytes.toString("utf8"));
}

function signJwt(claims, key) {
  const header = { alg: "HS256", typ: "JWT", kid: claims.kid };
  const input = `${encodeJson(header)}.${encodeJson(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input, "utf8").digest("base64url")}`;
}

function verifyHandoffJwt(token, key, policy) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts.some((part) => !part)) throw rejected();
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!exactKeys(header, ["alg", "kid", "typ"]) || header.alg !== "HS256" || header.typ !== "JWT") throw rejected();
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`, "utf8").digest();
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw rejected();
  if (!exactKeys(claims, HANDOFF_FIELDS) || claims.kid !== header.kid || claims.kid !== policy.kid
      || claims.iss !== "pkc-n8n-account-login" || claims.aud !== "pkc-vercel-founder-mfa"
      || claims.typ !== "pkc-founder-password-handoff+jwt" || claims.purpose !== "founder_mfa_challenge"
      || claims.version !== 1 || claims.sub !== policy.founderSubject || !STABLE_ID_RE.test(claims.jti)
      || !UUID_RE.test(claims.login_attempt_id)) throw rejected();
  for (const field of ["password_authenticated_at", "iat", "nbf", "exp"]) {
    if (!Number.isSafeInteger(claims[field]) || claims[field] < 0) throw rejected();
  }
  if (claims.nbf > policy.now + 5 || claims.iat > policy.now + 5 || claims.exp < policy.now
      || claims.exp - claims.iat > 120 || claims.password_authenticated_at > claims.iat) throw rejected();
  return claims;
}

function uuidFromStableId(value) {
  const digest = sha256(String(value));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function rejected() {
  return new Error("mfa_rejected");
}

export function isSafeFounderSessionCookie(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\r\n,]/.test(value)) return false;
  const parts = value.split(";").map((part) => part.trim());
  if (!/^pkc_session=[A-Za-z0-9._~-]+$/.test(parts.shift() || "")) return false;
  const attributes = new Map();
  for (const part of parts) {
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).toLowerCase();
    const attributeValue = separator < 0 ? true : part.slice(separator + 1);
    if (!name || attributes.has(name) || !["path", "secure", "httponly", "samesite", "max-age"].includes(name)) return false;
    attributes.set(name, attributeValue);
  }
  if (attributes.get("path") !== "/" || attributes.get("secure") !== true || attributes.get("httponly") !== true
      || String(attributes.get("samesite")).toLowerCase() !== "strict") return false;
  if (attributes.has("max-age") && !/^\d{1,8}$/.test(String(attributes.get("max-age")))) return false;
  return true;
}

function envelopeFromFactor(factor) {
  return {
    algorithm: factor.secret_algorithm,
    keyVersion: factor.secret_key_version,
    nonce: factor.secret_nonce,
    ciphertext: factor.secret_ciphertext,
    tag: factor.secret_tag,
  };
}

function aadFor(factor, generation = Number(factor.enrollment_generation)) {
  return {
    founderId: factor.founder_subject,
    generation,
    algorithm: "SHA1",
    envelopeVersion: 1,
  };
}

function usable(challenge, now, purposes) {
  return challenge
    && challenge.state === "pending"
    && purposes.includes(challenge.purpose)
    && Number(challenge.attempts_used) < Number(challenge.max_attempts)
    && new Date(challenge.expires_at).getTime() >= now.getTime();
}

export function createFounderMfaService(dependencies) {
  const { store, config } = dependencies || {};
  if (!store || typeof store.transaction !== "function") throw new TypeError("invalid_mfa_store");
  if (!config?.keys?.encryption || !config?.keys?.finalize || !config?.keys?.recovery) throw new TypeError("invalid_mfa_config");
  const clock = dependencies.clock;
  const makeUuid = dependencies.randomUuid || randomUUID;
  const makeToken = dependencies.randomToken || createOpaqueToken;
  const makeSecret = dependencies.randomSecret;
  const finalizer = dependencies.finalizer || (async () => ({ status: "unknown" }));

  async function nowFor(client) {
    return clock ? new Date(clock()) : new Date(await store.databaseNow(client));
  }

  async function failAttempt(client, locked, now, eventType) {
    const attempts = Number(locked.challenge.attempts_used) + 1;
    const state = attempts >= Number(locked.challenge.max_attempts) ? "exhausted" : "pending";
    await client.query(
      "UPDATE pkc_auth.founder_mfa_challenges SET attempts_used=$2, state=$3 WHERE challenge_id=$1",
      [locked.challenge.challenge_id, attempts, state],
    );
    await store.appendAudit(client, {
      factorId: locked.factor.factor_id,
      challengeId: locked.challenge.challenge_id,
      correlationId: makeUuid(),
      eventType,
      outcomeClass: "rejected",
      metadata: { attemptsUsed: attempts, exhausted: state === "exhausted" },
    });
  }

  async function beginChallenge(claims, options = {}) {
    if (!claims || typeof claims.sub !== "string") throw rejected();
    const token = makeToken();
    const csrf = makeToken();
    const challengeId = makeUuid();
    const result = await store.transaction(async (client) => {
      const now = await nowFor(client);
      const factor = await store.lockFactor(client, claims.sub);
      const purpose = options.purpose || (factor.state === "active" ? "verify" : "enroll");
      if (purpose === "recover" && factor.state !== "active") return { rejected: true };
      if (purpose === "verify" && factor.state !== "active") return { rejected: true };
      if (purpose === "enroll" && !["unenrolled", "pending", "recovery_required"].includes(factor.state)) return { rejected: true };
      const stored = await store.upsertChallenge(client, {
        founderSubject: claims.sub,
        handoffJti: claims.jti,
        loginAttemptId: claims.login_attempt_id,
        passwordAuthenticatedAt: new Date(Number(claims.password_authenticated_at) * 1000),
        purpose,
        tokenHash: hashOpaqueToken(token),
        csrfHash: hashOpaqueToken(csrf),
        challengeId,
        now,
        expiresAt: new Date(now.getTime() + 300_000),
      });
      if (stored.settled) return { rejected: true };
      await store.appendAudit(client, {
        factorId: stored.factor.factor_id,
        challengeId: stored.challenge.challenge_id,
        correlationId: makeUuid(),
        eventType: "challenge_created",
        outcomeClass: "accepted",
        metadata: { purpose, deduplicated: stored.deduplicated },
      });
      return { challengeId: stored.challenge.challenge_id, mode: stored.challenge.purpose };
    });
    if (result.rejected) throw rejected();
    return { status: "mfa_required", mode: result.mode, token, csrf, challengeId: result.challengeId, maxAgeSeconds: 300 };
  }

  async function beginFromSignedHandoff(handoff, options = {}) {
    const nowSeconds = Math.floor((clock ? clock() : Date.now()) / 1000);
    let claims;
    try {
      claims = verifyHandoffJwt(handoff, config.keys.handoff, {
        now: nowSeconds,
        kid: `handoff-v${config.keyVersions.handoff}`,
        founderSubject: config.founderSubject || "PK Blick",
      });
    } catch {
      throw rejected();
    }
    return beginChallenge({ ...claims, jti: uuidFromStableId(claims.jti) }, options);
  }

  async function discloseEnrollment({ token, csrf, issuer = "ProjectKidCreations", accountName = "Founder" }) {
    const secret = makeSecret ? makeSecret() : (await import("./crypto.mjs")).generateTotpSecret();
    const result = await store.transaction(async (client) => {
      const now = await nowFor(client);
      const locked = await store.lockChallenge(client, hashOpaqueToken(token), hashOpaqueToken(csrf));
      if (!locked || !usable(locked.challenge, now, ["enroll"]) || locked.challenge.secret_disclosed_at) return { rejected: true };
      const generation = Number(locked.factor.enrollment_generation) + 1;
      const envelope = encryptTotpSecret(secret, config.keys.encryption, aadFor(locked.factor, generation), {
        keyVersion: config.keyVersions.encryption,
      });
      await client.query(
        `UPDATE pkc_auth.founder_mfa_factors
         SET state='pending', enrollment_generation=$2, secret_algorithm=$3, secret_key_version=$4,
             secret_ciphertext=$5, secret_nonce=$6, secret_tag=$7, last_accepted_counter=NULL,
             updated_at=$8, row_version=row_version+1 WHERE factor_id=$1`,
        [locked.factor.factor_id, generation, envelope.algorithm, envelope.keyVersion, envelope.ciphertext, envelope.nonce, envelope.tag, now],
      );
      await client.query(
        "UPDATE pkc_auth.founder_mfa_challenges SET secret_disclosed_at=$2 WHERE challenge_id=$1",
        [locked.challenge.challenge_id, now],
      );
      await store.appendAudit(client, {
        factorId: locked.factor.factor_id,
        challengeId: locked.challenge.challenge_id,
        correlationId: makeUuid(),
        eventType: "enrollment_disclosed",
        outcomeClass: "accepted",
      });
      return { generation };
    });
    if (result.rejected) throw rejected();
    const encoded = base32(secret);
    const label = encodeURIComponent(`${issuer}:${accountName}`);
    const query = new URLSearchParams({ secret: encoded, issuer, algorithm: "SHA1", digits: "6", period: "30" });
    return { status: "enrollment_required", manualSecret: encoded, otpauthUri: `otpauth://totp/${label}?${query}` };
  }

  async function createFinalization(client, locked, now, counter, authEpoch) {
    const finalizeId = makeUuid();
    const sessionId = makeUuid();
    const grantJti = makeUuid();
    const issued = Math.floor(now.getTime() / 1000);
    const expires = issued + 3600;
    const claims = {
      iss: config.finalize?.issuer || "pkc-vercel-founder-mfa",
      aud: config.finalize?.audience || "pkc-n8n-founder-mfa-finalizer",
      typ: "pkc-founder-mfa-finalize+jwt",
      purpose: "founder_mfa_finalize",
      version: 1,
      kid: `finalize-v${config.keyVersions.finalize}`,
      sub: locked.factor.founder_subject,
      jti: `grant-${grantJti}`,
      login_attempt_id: locked.challenge.login_attempt_id,
      finalize_id: `finalize-${finalizeId}`,
      session_id: `session-${sessionId}`,
      password_authenticated_at: Math.floor(new Date(locked.challenge.password_authenticated_at).getTime() / 1000),
      mfa_verified_at: issued,
      auth_epoch: Number(authEpoch),
      amr: ["pwd", "otp"],
      session_issued_at: issued,
      session_expires_at: expires,
      iat: issued,
      nbf: issued,
      exp: issued + (config.finalize?.ttlSeconds || 60),
    };
    if (!exactKeys(claims, FINALIZE_FIELDS)) throw new Error("invalid_finalize_claims");
    const grant = signJwt(claims, config.keys.finalize);
    await client.query(
      `INSERT INTO pkc_auth.founder_mfa_finalizations
       (finalize_id, factor_id, challenge_id, grant_hash, grant_jti, session_id, session_issued_at,
        session_expires_at, mfa_verified_at, auth_epoch, claims, request_digest, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10::jsonb,$11,'pending')`,
      [finalizeId, locked.factor.factor_id, locked.challenge.challenge_id, sha256(grant), grantJti, sessionId,
        now, new Date(expires * 1000), authEpoch, JSON.stringify(claims), sha256(safeJson({ finalizeId, sessionId, grantJti }))],
    );
    return finalizeId;
  }

  async function verifyTotp({ token, csrf, code }) {
    let recoveryCodes;
    const result = await store.transaction(async (client) => {
      const now = await nowFor(client);
      const locked = await store.lockChallenge(client, hashOpaqueToken(token), hashOpaqueToken(csrf));
      if (!locked || !usable(locked.challenge, now, ["enroll", "verify"]) || !["pending", "active"].includes(locked.factor.state)) return { rejected: true };
      let secret;
      try {
        secret = decryptTotpSecret(envelopeFromFactor(locked.factor), config.keys.encryption, aadFor(locked.factor));
      } catch {
        await failAttempt(client, locked, now, "totp_rejected");
        return { rejected: true };
      }
      const checked = verifyTotpCode(code, secret, now.getTime(), {
        algorithm: "sha1",
        digits: Number(locked.factor.totp_digits),
        period: Number(locked.factor.totp_period_seconds),
        window: 1,
        lastAcceptedCounter: locked.factor.last_accepted_counter === null ? null : Number(locked.factor.last_accepted_counter),
      });
      if (!checked.valid) {
        await failAttempt(client, locked, now, "totp_rejected");
        return { rejected: true };
      }
      let authEpoch = Number(locked.factor.auth_epoch);
      if (locked.factor.state === "pending") {
        recoveryCodes = generateRecoveryCodes({ count: 10 });
        authEpoch += 1;
        await client.query(
          `UPDATE pkc_auth.founder_mfa_factors SET state='active', last_accepted_counter=$2,
           auth_epoch=$3, revoked_before=$4, enrolled_at=$4, updated_at=$4, row_version=row_version+1 WHERE factor_id=$1`,
          [locked.factor.factor_id, checked.counter, authEpoch, now],
        );
        await client.query("DELETE FROM pkc_auth.founder_mfa_recovery_codes WHERE factor_id=$1", [locked.factor.factor_id]);
        for (const recoveryCode of recoveryCodes) {
          await client.query(
            `INSERT INTO pkc_auth.founder_mfa_recovery_codes
             (recovery_code_id, factor_id, pepper_version, code_hash, created_at) VALUES ($1,$2,$3,$4,$5)`,
            [makeUuid(), locked.factor.factor_id, config.keyVersions.recovery, hashRecoveryCode(recoveryCode, config.keys.recovery), now],
          );
        }
        await client.query(
          `INSERT INTO pkc_auth.founder_mfa_outbox
           (outbox_id, operation_key, operation_type, factor_id, payload, state, created_at)
           VALUES ($1,$2,'revoke_founder_sessions',$3,$4::jsonb,'pending',$5)`,
          [makeUuid(), `enrollment:${locked.factor.factor_id}:${authEpoch}`, locked.factor.factor_id,
            JSON.stringify({ founderSubject: locked.factor.founder_subject, authEpoch, reason: "mfa_enrollment" }), now],
        );
        await client.query(
          `UPDATE pkc_auth.founder_mfa_challenges SET state='superseded', superseded_at=$2
           WHERE factor_id=$1 AND challenge_id<>$3 AND state='pending'`,
          [locked.factor.factor_id, now, locked.challenge.challenge_id],
        );
      } else {
        await client.query(
          `UPDATE pkc_auth.founder_mfa_factors SET last_accepted_counter=$2, updated_at=$3,
           row_version=row_version+1 WHERE factor_id=$1`,
          [locked.factor.factor_id, checked.counter, now],
        );
      }
      await client.query(
        "UPDATE pkc_auth.founder_mfa_challenges SET state='consumed', verified_at=$2, consumed_at=$2 WHERE challenge_id=$1",
        [locked.challenge.challenge_id, now],
      );
      const finalizeId = await createFinalization(client, locked, now, checked.counter, authEpoch);
      await store.appendAudit(client, {
        factorId: locked.factor.factor_id,
        challengeId: locked.challenge.challenge_id,
        finalizeId,
        correlationId: makeUuid(),
        eventType: locked.factor.state === "pending" ? "enrollment_activated" : "totp_verified",
        outcomeClass: "accepted",
        metadata: { authEpoch },
      });
      return { finalizeId };
    });
    if (result.rejected) throw rejected();
    return { status: "finalize_pending", finalizeId: result.finalizeId, ...(recoveryCodes ? { recoveryCodes } : {}) };
  }

  async function useRecoveryCode({ token, csrf, code }) {
    const result = await store.transaction(async (client) => {
      const now = await nowFor(client);
      const locked = await store.lockChallenge(client, hashOpaqueToken(token), hashOpaqueToken(csrf));
      if (!locked || !usable(locked.challenge, now, ["verify", "recover"]) || locked.factor.state !== "active") return { rejected: true };
      let codeHash;
      try {
        codeHash = hashRecoveryCode(code, config.keys.recovery);
      } catch {
        await failAttempt(client, locked, now, "recovery_rejected");
        return { rejected: true };
      }
      const recovery = (await client.query(
        `SELECT * FROM pkc_auth.founder_mfa_recovery_codes
         WHERE factor_id=$1 AND code_hash=$2 AND used_at IS NULL FOR UPDATE`,
        [locked.factor.factor_id, codeHash],
      )).rows[0];
      if (!recovery) {
        await failAttempt(client, locked, now, "recovery_rejected");
        return { rejected: true };
      }
      const authEpoch = Number(locked.factor.auth_epoch) + 1;
      await client.query(
        "UPDATE pkc_auth.founder_mfa_recovery_codes SET used_at=$2, used_by_challenge_id=$3 WHERE recovery_code_id=$1",
        [recovery.recovery_code_id, now, locked.challenge.challenge_id],
      );
      await client.query(
        `UPDATE pkc_auth.founder_mfa_factors SET state='recovery_required', secret_algorithm=NULL,
         secret_key_version=NULL, secret_ciphertext=NULL, secret_nonce=NULL, secret_tag=NULL,
         last_accepted_counter=NULL, enrolled_at=NULL, auth_epoch=$2, revoked_before=$3,
         updated_at=$3, row_version=row_version+1 WHERE factor_id=$1`,
        [locked.factor.factor_id, authEpoch, now],
      );
      await client.query(
        `UPDATE pkc_auth.founder_mfa_challenges SET state=CASE WHEN challenge_id=$2 THEN 'consumed' ELSE 'superseded' END,
         consumed_at=CASE WHEN challenge_id=$2 THEN $3 ELSE consumed_at END,
         superseded_at=CASE WHEN challenge_id<>$2 THEN $3 ELSE superseded_at END
         WHERE factor_id=$1 AND state IN ('pending','verified')`,
        [locked.factor.factor_id, locked.challenge.challenge_id, now],
      );
      await client.query(
        `UPDATE pkc_auth.founder_mfa_finalizations SET state='terminal_rejected', lease_owner=NULL,
         lease_expires_at=NULL, receipt_digest=NULL, finalized_at=NULL
         WHERE factor_id=$1 AND state<>'terminal_rejected'`,
        [locked.factor.factor_id],
      );
      await client.query(
        `INSERT INTO pkc_auth.founder_mfa_outbox
         (outbox_id, operation_key, operation_type, factor_id, payload, state, created_at)
         VALUES ($1,$2,'revoke_founder_sessions',$3,$4::jsonb,'pending',$5)`,
        [makeUuid(), `recovery:${locked.factor.factor_id}:${authEpoch}`, locked.factor.factor_id,
          JSON.stringify({ founderSubject: locked.factor.founder_subject, authEpoch, reason: "recovery_code" }), now],
      );
      await store.appendAudit(client, {
        factorId: locked.factor.factor_id,
        challengeId: locked.challenge.challenge_id,
        correlationId: makeUuid(),
        eventType: "recovery_consumed",
        outcomeClass: "accepted",
        metadata: { authEpoch },
      });
      return { accepted: true };
    });
    if (result.rejected) throw rejected();
    return { status: "reenrollment_required" };
  }

  async function finalize({ token, csrf, finalizeId }) {
    const claimed = await store.transaction(async (client) => {
      const now = await nowFor(client);
      const locked = await store.lockChallenge(client, hashOpaqueToken(token), hashOpaqueToken(csrf));
      if (!locked || locked.challenge.state !== "consumed") return { rejected: true };
      const row = (await client.query(
        "SELECT * FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1 AND challenge_id=$2 FOR UPDATE",
        [finalizeId, locked.challenge.challenge_id],
      )).rows[0];
      if (!row || row.state === "terminal_rejected") return { rejected: true };
      const claims = row.claims;
      if (locked.factor.state !== "active" || Number(locked.factor.auth_epoch) !== Number(row.auth_epoch)
        || Number(claims?.auth_epoch) !== Number(row.auth_epoch)) return { rejected: true };
      const grant = signJwt(claims, config.keys.finalize);
      if (!sha256(grant).equals(row.grant_hash)) return { rejected: true };
      const identity = { finalizeId: claims.finalize_id, sessionId: claims.session_id, grantJti: claims.jti };
      if (row.state === "succeeded") {
        return { grant, replaySucceeded: true, databaseFinalizeId: row.finalize_id, identity };
      }
      const owner = makeUuid();
      await client.query(
        `UPDATE pkc_auth.founder_mfa_finalizations SET state='dispatching', lease_owner=$2,
         lease_expires_at=$3, lease_fence=lease_fence+1, dispatch_attempts=dispatch_attempts+1 WHERE finalize_id=$1`,
        [row.finalize_id, owner, new Date(now.getTime() + 15_000)],
      );
      return {
        grant,
        owner,
        databaseFinalizeId: row.finalize_id,
        identity,
      };
    });
    if (claimed.rejected) throw rejected();

    let receipt;
    try {
      receipt = await finalizer({ grant: claimed.grant, identity: claimed.identity });
    } catch {
      receipt = null;
    }
    const matches = receipt?.status === "ok"
      && receipt.finalizeId === claimed.identity.finalizeId
      && receipt.sessionId === claimed.identity.sessionId
      && receipt.grantJti === claimed.identity.grantJti
      && isSafeFounderSessionCookie(receipt.setCookie);
    if (claimed.replaySucceeded) {
      if (!matches) return { status: "unknown" };
      const replayState = await store.transaction(async (client) => {
        const locator = (await client.query(
          "SELECT factor_id, challenge_id FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1",
          [claimed.databaseFinalizeId],
        )).rows[0];
        if (!locator) return "rejected";
        const factor = (await client.query(
          "SELECT factor_id, state, auth_epoch FROM pkc_auth.founder_mfa_factors WHERE factor_id=$1 FOR UPDATE",
          [locator.factor_id],
        )).rows[0];
        await client.query("SELECT challenge_id FROM pkc_auth.founder_mfa_challenges WHERE challenge_id=$1 FOR UPDATE", [locator.challenge_id]);
        const row = (await client.query(
          "SELECT state, auth_epoch, claims FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1 FOR UPDATE",
          [claimed.databaseFinalizeId],
        )).rows[0];
        if (!row || row.state !== "succeeded" || !factor || factor.state !== "active"
          || Number(factor.auth_epoch) !== Number(row.auth_epoch)
          || Number(row.claims?.auth_epoch) !== Number(row.auth_epoch)) return "rejected";
        return "authenticated";
      });
      return replayState === "authenticated"
        ? { status: "authenticated", setCookie: receipt.setCookie }
        : { status: "unknown" };
    }
    const state = await store.transaction(async (client) => {
      const locator = (await client.query(
        "SELECT factor_id, challenge_id FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1",
        [claimed.databaseFinalizeId],
      )).rows[0];
      if (!locator) return "unknown";
      const factor = (await client.query(
        "SELECT factor_id, state, auth_epoch FROM pkc_auth.founder_mfa_factors WHERE factor_id=$1 FOR UPDATE",
        [locator.factor_id],
      )).rows[0];
      await client.query("SELECT challenge_id FROM pkc_auth.founder_mfa_challenges WHERE challenge_id=$1 FOR UPDATE", [locator.challenge_id]);
      const row = (await client.query(
        "SELECT * FROM pkc_auth.founder_mfa_finalizations WHERE finalize_id=$1 FOR UPDATE",
        [claimed.databaseFinalizeId],
      )).rows[0];
      if (!row || row.lease_owner !== claimed.owner || row.state !== "dispatching") return "unknown";
      if (!factor || factor.state !== "active" || Number(factor.auth_epoch) !== Number(row.auth_epoch)) {
        await client.query(
          `UPDATE pkc_auth.founder_mfa_finalizations SET state='terminal_rejected', lease_owner=NULL,
           lease_expires_at=NULL, receipt_digest=NULL, finalized_at=NULL WHERE finalize_id=$1`,
          [row.finalize_id],
        );
        return "rejected";
      }
      if (!matches) {
        await client.query(
          "UPDATE pkc_auth.founder_mfa_finalizations SET state='unknown', lease_owner=NULL, lease_expires_at=NULL WHERE finalize_id=$1",
          [row.finalize_id],
        );
        return "unknown";
      }
      await client.query(
        `UPDATE pkc_auth.founder_mfa_finalizations SET state='succeeded', lease_owner=NULL,
         lease_expires_at=NULL, receipt_digest=$2, finalized_at=clock_timestamp() WHERE finalize_id=$1`,
        [row.finalize_id, sha256(safeJson({ finalizeId: receipt.finalizeId, sessionId: receipt.sessionId, grantJti: receipt.grantJti }))],
      );
      return "authenticated";
    });
    return state === "authenticated" ? { status: state, setCookie: receipt.setCookie } : { status: "unknown" };
  }

  return Object.freeze({ beginChallenge, beginFromSignedHandoff, discloseEnrollment, verifyTotp, useRecoveryCode, finalize });
}
