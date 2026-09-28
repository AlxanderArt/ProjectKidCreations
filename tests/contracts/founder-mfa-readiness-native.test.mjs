import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

import { attestFounderMfaDatabase } from "../../db/readiness.mjs";

const adminUrl = process.env.PKC_MFA_TEST_DATABASE_URL;
const native = adminUrl ? test : test.skip;

async function mutatedReadiness(t, mutation) {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  t.after(async () => pool.end());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE pkc_mfa_verifier");
    const rolePool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
    assert.equal((await attestFounderMfaDatabase({ pool: rolePool, expectedDatabase: "pkc_founder_mfa", expectedUser: "pkc_mfa_verifier", expectedEnvironment: "test", expectedTls: false })).ready, true);
    await client.query("RESET ROLE");
    await client.query(mutation);
    await client.query("SET LOCAL ROLE pkc_mfa_verifier");
    await assert.rejects(
      () => attestFounderMfaDatabase({ pool: rolePool, expectedDatabase: "pkc_founder_mfa", expectedUser: "pkc_mfa_verifier", expectedEnvironment: "test", expectedTls: false }),
      /readiness_failed:/,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

native("readiness rejects table ACL drift granted to the worker", async (t) => {
  await mutatedReadiness(t, "GRANT SELECT ON pkc_auth.founder_mfa_factors TO pkc_mfa_outbox_worker");
});

native("readiness rejects role membership option drift", async (t) => {
  await mutatedReadiness(t, "GRANT pkc_mfa_owner TO pkc_mfa_migrator WITH ADMIN OPTION");
});

native("readiness rejects same-name weakened constraints", async (t) => {
  await mutatedReadiness(t, "ALTER TABLE pkc_auth.founder_mfa_outbox DROP CONSTRAINT founder_mfa_outbox_attempts_check, ADD CONSTRAINT founder_mfa_outbox_attempts_check CHECK (true)");
});

native("readiness rejects function semantic and overload drift", async (t) => {
  await mutatedReadiness(t, "ALTER FUNCTION pkc_auth.founder_mfa_outbox_monitor() VOLATILE; CREATE FUNCTION pkc_auth.founder_mfa_outbox_monitor(integer) RETURNS integer LANGUAGE sql AS 'SELECT 1'");
});

native("readiness rejects disabled immutable-audit triggers", async (t) => {
  await mutatedReadiness(t, "ALTER TABLE pkc_auth.founder_mfa_audit_events DISABLE TRIGGER founder_mfa_audit_append_only");
});

native("readiness rejects a dropped standalone partial-unique challenge index", async (t) => {
  await mutatedReadiness(t, "DROP INDEX pkc_auth.founder_mfa_challenges_one_pending_per_factor");
});

native("readiness rejects a same-name weakened outbox dispatch index", async (t) => {
  await mutatedReadiness(t, `DROP INDEX pkc_auth.founder_mfa_outbox_dispatch;
    CREATE INDEX founder_mfa_outbox_dispatch ON pkc_auth.founder_mfa_outbox(state)`);
});
