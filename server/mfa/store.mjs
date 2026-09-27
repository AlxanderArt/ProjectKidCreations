const PURPOSES = new Set(["enroll", "verify", "recover"]);

function assertPool(pool) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("invalid_pg_pool");
}

function bytes(value, length, name) {
  if (!Buffer.isBuffer(value) || value.byteLength !== length) throw new TypeError(`invalid_${name}`);
  return value;
}

function uuid(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`invalid_${name}`);
  }
  return value;
}

export function createFounderMfaStore({ pool }) {
  assertPool(pool);

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function databaseNow(client) {
    return (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
  }

  async function readFactorAuthority(founderSubject) {
    if (typeof founderSubject !== "string" || founderSubject.length < 1 || founderSubject.length > 255) throw new TypeError("invalid_founder_subject");
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
    if (typeof founderSubject !== "string" || founderSubject.length < 1 || founderSubject.length > 255) throw new TypeError("invalid_founder_subject");
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
