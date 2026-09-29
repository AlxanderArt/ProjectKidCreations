import assert from "node:assert/strict";
import { test } from "node:test";

import { createFounderMfaStore, TransactionOutcomeUnknownError } from "../../server/mfa/store.mjs";

function fakePool(behavior = {}) {
  const queries = [];
  let released;
  const client = {
    query: async (text) => {
      queries.push(text);
      if (text === "COMMIT" && behavior.commitReject) throw new Error("commit ack lost");
      if (text === "ROLLBACK" && behavior.rollbackReject) throw new Error("rollback ack lost");
      return { rows: [{ now: new Date() }] };
    },
    release: (poison) => { released = poison; },
  };
  return { pool: { connect: async () => client, query: client.query }, queries, released: () => released };
}

test("pool acquisition is bounded and a late client is poisoned", async () => {
  let resolveConnect;
  let released;
  const client = { query: async () => ({ rows: [] }), release: (poison) => { released = poison; } };
  const pool = { connect: () => new Promise((resolve) => { resolveConnect = resolve; }), query: client.query };
  const store = createFounderMfaStore({ pool, totalDeadlineMs: 100, settlementDeadlineMs: 100 });
  await assert.rejects(() => store.transaction(async () => "never"), (error) => error instanceof TransactionOutcomeUnknownError && error.stage === "acquire");
  resolveConnect(client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(released);
});

test("timed-out work poisons the client before late work can escape its transaction", async () => {
  let releasedWith;
  let allowLateQuery;
  const queries = [];
  const client = {
    async query(sql) { queries.push(sql); return { rows: [], rowCount: 0 }; },
    release(error) { releasedWith = error; },
  };
  const pool = { connect: async () => client, query: client.query };
  const store = createFounderMfaStore({ pool, totalDeadlineMs: 100, settlementDeadlineMs: 100 });
  const late = new Promise((resolve) => { allowLateQuery = resolve; });

  await assert.rejects(
    () => store.transaction(async (tx) => { await late; await tx.query("SELECT 'late'"); }),
    (error) => error instanceof TransactionOutcomeUnknownError && error.stage === "work",
  );
  assert.ok(releasedWith instanceof Error);
  allowLateQuery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queries.slice(-1), ["ROLLBACK"]);
  assert.equal(queries.includes("SELECT 'late'"), false);
});

test("transactions install local deadlines before work and commit", async () => {
  const fake = fakePool();
  const store = createFounderMfaStore({ pool: fake.pool, totalDeadlineMs: 20_000 });
  assert.equal(await store.transaction(async () => "ok"), "ok");
  assert.deepEqual(fake.queries.slice(0, 5), [
    "BEGIN",
    "SET LOCAL statement_timeout = '5s'",
    "SET LOCAL lock_timeout = '2s'",
    "SET LOCAL idle_in_transaction_session_timeout = '10s'",
    "COMMIT",
  ]);
});

test("lost commit acknowledgement is outcome_unknown and poisons the client", async () => {
  const fake = fakePool({ commitReject: true });
  const store = createFounderMfaStore({ pool: fake.pool });
  await assert.rejects(() => store.transaction(async () => "written"), TransactionOutcomeUnknownError);
  assert.ok(fake.released());
});

test("rollback failure poisons the client and reports bounded unknown disposition", async () => {
  const fake = fakePool({ rollbackReject: true });
  const store = createFounderMfaStore({ pool: fake.pool });
  await assert.rejects(() => store.transaction(async () => { throw new Error("work failed"); }), TransactionOutcomeUnknownError);
  assert.ok(fake.released());
});

test("BEGIN and transaction setup stalls are bounded and poison uncertain clients", async () => {
  for (const stalledSql of [
    "BEGIN",
    "SET LOCAL statement_timeout = '5s'",
    "SET LOCAL lock_timeout = '2s'",
    "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  ]) {
    let releasedWith;
    const client = {
      query: async (sql) => sql === stalledSql ? new Promise(() => {}) : { rows: [] },
      release(error) { releasedWith = error; },
    };
    const store = createFounderMfaStore({ pool: { connect: async () => client }, totalDeadlineMs: 100, settlementDeadlineMs: 100 });
    await assert.rejects(
      () => store.transaction(async () => "unreachable"),
      (error) => error instanceof TransactionOutcomeUnknownError && error.stage === "setup",
    );
    assert.ok(releasedWith instanceof Error);
  }
});
