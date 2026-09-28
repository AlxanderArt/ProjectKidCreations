const PURPOSES = new Set(["enroll", "verify", "recover"]);

function assertPool(pool) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("invalid_pg_pool");
}

function bytes(value, length, name) {
  if (!Buffer.isBuffer(value) || value.byteLength !== length) throw new TypeError(`invalid_${name}`);
  return value;
}

function uuid(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError(`invalid_${name}`);
  }
  return value;
}

export class TransactionOutcomeUnknownError extends Error {
  constructor(stage, options = {}) {
    super("transaction_outcome_unknown", options);
    this.name = "TransactionOutcomeUnknownError";
    this.code = "outcome_unknown";
    this.stage = stage;
  }
}

function bounded(promise, milliseconds, stage) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TransactionOutcomeUnknownError(stage)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

export function createFounderMfaStore({ pool, totalDeadlineMs = 20_000, settlementDeadlineMs = 2_000 }) {
  assertPool(pool);
  if (!Number.isSafeInteger(totalDeadlineMs) || totalDeadlineMs < 100 || totalDeadlineMs > 60_000
      || !Number.isSafeInteger(settlementDeadlineMs) || settlementDeadlineMs < 100 || settlementDeadlineMs > 5_000) {
    throw new TypeError("invalid_transaction_deadline");
  }

  async function transaction(work) {
    let acquisitionExpired = false;
    let client;
    let poison = null;
    const acquisition = Promise.resolve().then(() => pool.connect()).then((connected) => {
      if (acquisitionExpired) {
        connected.release(new TransactionOutcomeUnknownError("acquire"));
        throw new TransactionOutcomeUnknownError("acquire");
      }
      return connected;
    });
    try {
      client = await bounded(acquisition, totalDeadlineMs, "acquire");
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknownError && error.stage === "acquire") {
        acquisitionExpired = true;
        acquisition.catch(() => {});
      }
      throw error;
    }
    try {
      try {
        for (const sql of [
          "BEGIN",
          "SET LOCAL statement_timeout = '5s'",
          "SET LOCAL lock_timeout = '2s'",
          "SET LOCAL idle_in_transaction_session_timeout = '10s'",
        ]) await bounded(Promise.resolve().then(() => client.query(sql)), settlementDeadlineMs, "setup");
      } catch (error) {
        poison = error instanceof Error ? error : new Error("setup_unknown");
        throw new TransactionOutcomeUnknownError("setup", { cause: poison });
      }
      const result = await bounded(Promise.resolve().then(() => work(client)), totalDeadlineMs, "work");
      try {
        await bounded(client.query("COMMIT"), settlementDeadlineMs, "commit");
      } catch (error) {
        poison = error instanceof Error ? error : new Error("commit_unknown");
        throw new TransactionOutcomeUnknownError("commit", { cause: poison });
      }
      return result;
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknownError && (error.stage === "commit" || error.stage === "setup")) throw error;
      if (error instanceof TransactionOutcomeUnknownError && error.stage === "work") poison = error;
      try {
        await bounded(client.query("ROLLBACK"), settlementDeadlineMs, "rollback");
      } catch (rollbackError) {
        poison = rollbackError instanceof Error ? rollbackError : new Error("rollback_unknown");
        throw new TransactionOutcomeUnknownError("rollback", { cause: poison });
      }
      throw error;
    } finally {
      client.release(poison || undefined);
    }
  }

  async function databaseNow(client) {
    return (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
  }

  async function readFactorAuthority(founderSubject) {
    uuid(founderSubject, "founder_subject");
    const result = await pool.query(
      `SELECT founder_subject, state, auth_epoch, revoked_before
       FROM pkc_auth.founder_mfa_factors WHERE founder_subject=$1`,
      [founderSubject],
    );
    if (result.rows.length !== 1) return null;
    const row = result.rows[0];
    const authEpoch = Number(row.auth_epoch);
    if (!Number.isSafeInteger(authEpoch) || authEpoch < 0) throw new Error("invalid_founder_authority");
    return Object.freeze({
      founderSubject: row.founder_subject,
      state: row.state,
      authEpoch,
      revokedBefore: row.revoked_before ? new Date(row.revoked_before) : null,
    });
  }

  async function lockFactor(client, founderSubject) {
    uuid(founderSubject, "founder_subject");
    await client.query(
      "INSERT INTO pkc_auth.founder_mfa_factors (founder_subject) VALUES ($1) ON CONFLICT (founder_subject) DO NOTHING",
      [founderSubject],
    );
    return (await client.query(
      "SELECT * FROM pkc_auth.founder_mfa_factors WHERE founder_subject=$1 FOR UPDATE",
      [founderSubject],
    )).rows[0];
  }

  async function lockChallenge(client, tokenHash, csrfHash) {
    bytes(tokenHash, 32, "token_hash");
    bytes(csrfHash, 32, "csrf_hash");
    const locator = (await client.query(
      "SELECT factor_id FROM pkc_auth.founder_mfa_challenges WHERE token_hash=$1",
      [tokenHash],
    )).rows[0];
    if (!locator) return null;
    const factor = (await client.query(
      "SELECT * FROM pkc_auth.founder_mfa_factors WHERE factor_id=$1 FOR UPDATE",
      [locator.factor_id],
    )).rows[0];
    const challenge = (await client.query(
      "SELECT * FROM pkc_auth.founder_mfa_challenges WHERE token_hash=$1 AND anti_csrf_hash=$2 FOR UPDATE",
      [tokenHash, csrfHash],
    )).rows[0];
    if (!challenge) return null;
    return { factor, challenge };
  }

  async function appendAudit(client, { factorId, challengeId = null, finalizeId = null, correlationId, eventType, outcomeClass, metadata = {} }) {
    uuid(correlationId, "correlation_id");
    await client.query(
      `INSERT INTO pkc_auth.founder_mfa_audit_events
       (factor_id, challenge_id, finalize_id, correlation_id, event_type, outcome_class, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [factorId, challengeId, finalizeId, correlationId, eventType, outcomeClass, JSON.stringify(metadata)],
    );
  }

  async function upsertChallenge(client, input) {
    if (!PURPOSES.has(input.purpose)) throw new TypeError("invalid_challenge_purpose");
    const factor = await lockFactor(client, input.founderSubject);
    const existing = (await client.query(
      `SELECT * FROM pkc_auth.founder_mfa_challenges
       WHERE factor_id=$1 AND (handoff_jti=$2 OR login_attempt_id=$3)
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [factor.factor_id, uuid(input.handoffJti, "handoff_jti"), uuid(input.loginAttemptId, "login_attempt_id")],
    )).rows[0];
    const values = [
      bytes(input.tokenHash, 32, "token_hash"),
      bytes(input.csrfHash, 32, "csrf_hash"),
      input.now,
      input.expiresAt,
    ];
    if (existing) {
      if (existing.state !== "pending" || new Date(existing.expires_at).getTime() < new Date(input.now).getTime()) {
        return { factor, challenge: existing, deduplicated: true, settled: true };
      }
      const challenge = (await client.query(
        `UPDATE pkc_auth.founder_mfa_challenges
         SET token_hash=$1, anti_csrf_hash=$2, handoff_jti=$5, state='pending', attempts_used=0,
             created_at=$3, expires_at=$4, verified_at=NULL, consumed_at=NULL, superseded_at=NULL
         WHERE challenge_id=$6 RETURNING *`,
        [...values, input.handoffJti, existing.challenge_id],
      )).rows[0];
      return { factor, challenge, deduplicated: true };
    }
    await client.query(
      `UPDATE pkc_auth.founder_mfa_challenges
       SET state='superseded', superseded_at=$2
       WHERE factor_id=$1 AND state='pending'`,
      [factor.factor_id, input.now],
    );
    const challenge = (await client.query(
      `INSERT INTO pkc_auth.founder_mfa_challenges
       (challenge_id, factor_id, token_hash, anti_csrf_hash, handoff_jti, login_attempt_id, purpose,
        password_authenticated_at, max_attempts, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,5,$9,$10) RETURNING *`,
      [uuid(input.challengeId, "challenge_id"), factor.factor_id, input.tokenHash, input.csrfHash,
        input.handoffJti, input.loginAttemptId, input.purpose, input.passwordAuthenticatedAt, input.now, input.expiresAt],
    )).rows[0];
    return { factor, challenge, deduplicated: false };
  }

  return Object.freeze({
    pool,
    transaction,
    databaseNow,
    readFactorAuthority,
    lockFactor,
    lockChallenge,
    appendAudit,
    upsertChallenge,
  });
}
