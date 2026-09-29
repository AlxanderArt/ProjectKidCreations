import assert from "node:assert/strict";
import { test } from "node:test";

import { createOutboxDispatcher } from "../../server/mfa/outbox-dispatcher.mjs";
import { createOutboxRepository } from "../../server/mfa/outbox-repository.mjs";

const event = Object.freeze({
  outboxId: "11111111-1111-4111-8111-111111111111",
  operationKey: "revoke:11111111-1111-4111-8111-111111111111:4",
  operationType: "revoke_founder_sessions",
  leaseFence: 8,
  attempts: 1,
  reconciliationLeaseFence: 13,
  payload: Object.freeze({ founderSubject: "22222222-2222-4222-8222-222222222222", authEpoch: 4, reason: "mfa_enrollment" }),
});

test("dispatcher passes deterministic operation identity and completes only matching readback", async () => {
  const calls = [];
  const repository = {
    claim: async () => [event],
    complete: async (value) => calls.push(["complete", value]),
    markUnknown: async (value) => calls.push(["unknown", value]),
    reconcile: async () => [],
    monitor: async () => ({ pending: 0, unknown: 0, terminal: 0, oldestPendingSeconds: 0 }),
  };
  const transport = async (request) => {
    calls.push(["transport", request]);
    return { status: "confirmed", operationKey: request.operationKey, receiptDigest: Buffer.alloc(32, 9) };
  };
  const result = await createOutboxDispatcher({ repository, transport, workerId: "33333333-3333-4333-8333-333333333333" }).dispatchOnce();
  assert.deepEqual(result, { claimed: 1, succeeded: 1, unknown: 0, terminal: 0 });
  assert.equal(calls[0][1].idempotencyKey, event.operationKey);
  assert.equal(calls[1][1].leaseFence, 8);
});

test("timeouts and malformed/mismatched delivery are unknown and never blindly completed", async () => {
  for (const transport of [
    async () => { throw new Error("secret-bearing transport detail"); },
    async () => ({ status: "confirmed", operationKey: "wrong", receiptDigest: Buffer.alloc(32) }),
  ]) {
    const calls = [];
    const repository = {
      claim: async () => [event], complete: async () => calls.push("complete"),
      markUnknown: async (value) => calls.push(value), reconcile: async () => [], monitor: async () => ({}),
    };
    const result = await createOutboxDispatcher({ repository, transport, workerId: "33333333-3333-4333-8333-333333333333" }).dispatchOnce();
    assert.equal(result.unknown, 1);
    assert.equal(calls.includes("complete"), false);
    assert.equal(calls[0].errorClass, "delivery_outcome_unknown");
    assert.equal(calls[0].operationKey, event.operationKey);
    assert.equal(JSON.stringify(calls).includes("secret-bearing"), false);
  }
});

test("reconciler settles confirmed readback under its own worker and fence lease", async () => {
  const settled = [];
  const repository = {
    claim: async () => [], complete: async () => {}, markUnknown: async () => {},
    reconcile: async (value) => settled.push(value), monitor: async () => ({}),
    claimReconciliation: async () => [event],
    deferReconciliation: async () => ({ state: "unknown" }),
  };
  const readback = async ({ operationKey }) => ({ status: "confirmed", operationKey, receiptDigest: Buffer.alloc(32, 4) });
  const result = await createOutboxDispatcher({ repository, transport: async () => null, readback, workerId: "33333333-3333-4333-8333-333333333333" }).reconcileOnce();
  assert.deepEqual(result, { inspected: 1, succeeded: 1, unresolved: 0, terminal: 0 });
  assert.equal(settled[0].operationKey, event.operationKey);
  assert.equal(settled[0].workerId, "33333333-3333-4333-8333-333333333333");
  assert.equal(settled[0].reconciliationLeaseFence, 13);
});

test("reconciler durably defers absent readback and surfaces terminal exhaustion", async () => {
  const deferred = [];
  const repository = {
    claim: async () => [], complete: async () => {}, markUnknown: async () => {}, reconcile: async () => {}, monitor: async () => ({}),
    claimReconciliation: async () => [event],
    deferReconciliation: async (value) => { deferred.push(value); return { state: "terminal_rejected" }; },
  };
  const dispatcher = createOutboxDispatcher({
    repository,
    transport: async () => null,
    readback: async () => null,
    workerId: "33333333-3333-4333-8333-333333333333",
  });
  const result = await dispatcher.reconcileOnce();
  assert.deepEqual(result, { inspected: 1, succeeded: 0, unresolved: 0, terminal: 1 });
  assert.deepEqual(deferred, [{
    outboxId: event.outboxId,
    workerId: "33333333-3333-4333-8333-333333333333",
    reconciliationLeaseFence: 13,
    operationKey: event.operationKey,
  }]);
});

test("reconciler requires atomic reconciliation-claim authority", () => {
  assert.throws(() => createOutboxDispatcher({
    repository: { claim: async () => [], complete: async () => {}, markUnknown: async () => {}, reconcile: async () => {} },
    transport: async () => null,
    readback: async () => null,
    workerId: "33333333-3333-4333-8333-333333333333",
  }), /invalid_outbox_repository/);
});

test("PostgreSQL bigint fences remain canonical decimal strings through dispatch SQL parameters", async () => {
  const leaseFence = "9007199254740993";
  const reconciliationLeaseFence = "9223372036854775807";
  const sqlCalls = [];
  const pool = {
    async query(sql, parameters) {
      sqlCalls.push([sql, parameters]);
      if (sql.includes("claim_founder_mfa_outbox_reconciliation")) return { rows: [{
        outbox_id: event.outboxId,
        operation_key: event.operationKey,
        operation_type: event.operationType,
        reconciliation_lease_fence: reconciliationLeaseFence,
      }] };
      if (sql.includes("claim_founder_mfa_outbox")) return { rows: [{
        outbox_id: event.outboxId,
        operation_key: event.operationKey,
        operation_type: event.operationType,
        payload: event.payload,
        lease_fence: leaseFence,
        attempts: 1,
      }] };
      return { rows: [{ state: "succeeded" }] };
    },
  };
  const repository = createOutboxRepository({ pool });
  const dispatcher = createOutboxDispatcher({
    repository,
    workerId: "33333333-3333-4333-8333-333333333333",
    transport: async ({ operationKey }) => ({ status: "confirmed", operationKey, receiptDigest: Buffer.alloc(32, 1) }),
    readback: async ({ operationKey }) => ({ status: "confirmed", operationKey, receiptDigest: Buffer.alloc(32, 2) }),
  });

  await dispatcher.dispatchOnce();
  await dispatcher.reconcileOnce();

  const completion = sqlCalls.find(([sql]) => sql.includes("complete_founder_mfa_outbox"));
  const reconciliation = sqlCalls.find(([sql]) => sql.includes("reconcile_founder_mfa_outbox("));
  assert.equal(completion[1][2], leaseFence);
  assert.equal(typeof completion[1][2], "string");
  assert.equal(reconciliation[1][2], reconciliationLeaseFence);
  assert.equal(typeof reconciliation[1][2], "string");
});

test("repository rejects noncanonical or out-of-range PostgreSQL bigint fences before SQL", async () => {
  let sqlCalls = 0;
  const repository = createOutboxRepository({ pool: { query: async () => { sqlCalls += 1; return { rows: [{ state: "succeeded" }] }; } } });
  for (const leaseFence of [-1, 1, "01", "+1", "9223372036854775808"]) {
    await assert.rejects(() => repository.complete({
      outboxId: event.outboxId,
      workerId: "33333333-3333-4333-8333-333333333333",
      leaseFence,
      operationKey: event.operationKey,
      receiptDigest: Buffer.alloc(32),
    }), /invalid_bigint_fence/);
  }
  assert.equal(sqlCalls, 0);
});

test("readiness requires a raw canonical PostgreSQL bigint terminal count", async () => {
  const base = {
    claim: async () => [], complete: async () => {}, markUnknown: async () => {}, reconcile: async () => [],
  };
  const dispatcher = (terminal) => createOutboxDispatcher({
    repository: { ...base, monitor: async () => ({ pending: "0", unknown: "0", terminal, oldest_pending_seconds: "0" }) },
    transport: async () => null,
    workerId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal((await dispatcher("0").readiness()).ready, true);
  assert.equal((await dispatcher("9223372036854775807").readiness()).ready, false);
  for (const hostile of [0, 9007199254740993, "", "00", "+0", "9223372036854775808", null]) {
    await assert.rejects(() => dispatcher(hostile).readiness(), /invalid_outbox_terminal_count/);
  }
});
