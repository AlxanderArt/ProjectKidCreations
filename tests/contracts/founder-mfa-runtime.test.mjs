import assert from "node:assert/strict";
import { test } from "node:test";

import { createFounderMfaRuntimeFactory } from "../../server/mfa/routes.mjs";

const runtimePoolDsn = "postgresql://runtime@pool.invalid/pkc?sslmode=verify-full";
const config = Object.freeze({
  databaseUrl: runtimePoolDsn,
  database: Object.freeze({
    expectedDatabase: "pkc", expectedUser: "runtime", environment: "test", poolMax: 4,
    connectionTimeoutMs: 5000, queryTimeoutMs: 6000, statementTimeoutMs: 5000, idleTransactionTimeoutMs: 10000,
  }),
  publicOrigins: new Set(["https://projectkidcreations.io"]), n8nBaseUrl: "https://n8n.invalid", authKey: "test",
});

test("cold concurrent runtime initialization creates one pool and one readiness attempt", async () => {
  const pools = [];
  let readinessCalls = 0;
  let releaseReadiness;
  const readiness = new Promise((resolve) => { releaseReadiness = resolve; });
  class Pool { constructor(options) { this.options = options; pools.push(this); } async end() { this.ended = true; } }
  const runtime = createFounderMfaRuntimeFactory({
    Pool, loadConfig: () => config,
    attest: async () => { readinessCalls += 1; await readiness; },
    createStore: () => ({ readFactorAuthority: async () => null }), createService: () => ({}), createRoutes: () => ({ marker: true }),
  });
  const first = runtime({}, fetch);
  const second = runtime({}, fetch);
  assert.equal(pools.length, 1);
  assert.equal(readinessCalls, 1);
  releaseReadiness();
  assert.equal(await first, await second);
  assert.deepEqual(pools[0].options, {
    connectionString: config.databaseUrl, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000,
    query_timeout: 6_000, statement_timeout: 5_000, idle_in_transaction_session_timeout: 10_000,
  });
});

test("readiness failure closes the newly created pool and permits a fresh retry", async () => {
  const pools = [];
  let attempts = 0;
  class Pool { constructor() { pools.push(this); } async end() { this.ended = true; } }
  const runtime = createFounderMfaRuntimeFactory({
    Pool, loadConfig: () => config,
    attest: async () => { attempts += 1; if (attempts === 1) throw new Error("not ready"); },
    createStore: () => ({}), createService: () => ({}), createRoutes: () => ({}),
  });
  await assert.rejects(() => Promise.all([runtime({}, fetch), runtime({}, fetch)]), /not ready/);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].ended, true);
  await runtime({}, fetch);
  assert.equal(pools.length, 2);
  assert.equal(attempts, 2);
});