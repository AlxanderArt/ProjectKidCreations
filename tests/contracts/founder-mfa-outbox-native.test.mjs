import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

const adminUrl = process.env.PKC_MFA_TEST_DATABASE_URL;
const workerUrl = process.env.PKC_MFA_WORKER_TEST_DATABASE_URL;
const native = adminUrl && workerUrl ? test : test.skip;

async function pools(t) {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  const worker = new pg.Pool({ connectionString: workerUrl, max: 4 });
  t.after(async () => Promise.all([admin.end(), worker.end()]));
  await admin.query("ALTER TABLE pkc_auth.founder_mfa_audit_events DISABLE TRIGGER USER");
  try {
    await admin.query("TRUNCATE pkc_auth.founder_mfa_audit_events,pkc_auth.founder_mfa_outbox,pkc_auth.founder_mfa_finalizations,pkc_auth.founder_mfa_challenges,pkc_auth.founder_mfa_factors CASCADE");
  } finally {
    await admin.query("ALTER TABLE pkc_auth.founder_mfa_audit_events ENABLE TRIGGER USER");
  }
  const factorId = randomUUID();
  await admin.query("INSERT INTO pkc_auth.founder_mfa_factors(factor_id,founder_subject) VALUES($1,$2)", [factorId, randomUUID()]);
  return { admin, worker, factorId };
}

async function enqueue(admin, factorId, suffix = "1", options = {}) {
  const outboxId = randomUUID();
  const operationKey = `revoke:${factorId}:${suffix}`;
  await admin.query(`INSERT INTO pkc_auth.founder_mfa_outbox(outbox_id,operation_key,operation_type,factor_id,payload,max_attempts)
    VALUES($1,$2,'revoke_founder_sessions',$3,$4::jsonb,$5)`,
  [outboxId, operationKey, factorId, JSON.stringify({ founderSubject: factorId, authEpoch: Number(suffix), reason: "mfa_enrollment" }), options.maxAttempts ?? 5]);
  return { outboxId, operationKey };
}

native("worker has function-only authority and cannot read or mutate tables", async (t) => {
  const { worker } = await pools(t);
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.founder_mfa_factors"), (error) => error.code === "42501");
  await assert.rejects(() => worker.query("INSERT INTO pkc_auth.founder_mfa_outbox(operation_key) VALUES('attacker')"), (error) => error.code === "42501");
  await assert.rejects(() => worker.query("SET ROLE pkc_mfa_owner"), (error) => error.code === "42501");
  await worker.query("SET search_path=public");
  const monitor = await worker.query("SELECT * FROM pkc_auth.founder_mfa_outbox_monitor()");
  assert.equal(monitor.rows.length, 1);
});

native("SKIP LOCKED gives one live lease and stale fences cannot settle", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId);
  const workerA = randomUUID();
  const workerB = randomUUID();
  const [a, b] = await Promise.all([
    worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [workerA]),
    worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [workerB]),
  ]);
  assert.equal(a.rows.length + b.rows.length, 1);
  const winner = a.rows[0] ? { id: workerA, row: a.rows[0] } : { id: workerB, row: b.rows[0] };
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, winner.id, Number(winner.row.lease_fence) - 1, item.operationKey, Buffer.alloc(32)]), /stale_outbox_fence/);
  const complete = await worker.query("SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, winner.id, winner.row.lease_fence, item.operationKey, Buffer.alloc(32, 1)]);
  assert.equal(complete.rows[0].state, "succeeded");
});

native("expired dispatch leases never return to delivery claim and become unknown with stable identity", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId, "2", { maxAttempts: 2 });
  const firstWorker = randomUUID();
  const first = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [firstWorker])).rows[0];
  const before = (await admin.query("SELECT operation_key,payload FROM pkc_auth.founder_mfa_outbox WHERE outbox_id=$1", [item.outboxId])).rows[0];
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, firstWorker, first.lease_fence, item.operationKey, Buffer.alloc(32)]), /stale_outbox_fence/);
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)",
    [item.outboxId, firstWorker, first.lease_fence, item.operationKey, "delivery_outcome_unknown"]), /stale_outbox_fence/);
  const secondWorker = randomUUID();
  assert.equal((await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [secondWorker])).rows.length, 0);
  const after = (await admin.query("SELECT state,attempts,operation_key,payload,last_error_class FROM pkc_auth.founder_mfa_outbox WHERE outbox_id=$1", [item.outboxId])).rows[0];
  assert.equal(after.state, "unknown");
  assert.equal(Number(after.attempts), 1);
  assert.equal(after.operation_key, before.operation_key);
  assert.deepEqual(after.payload, before.payload);
  assert.equal(after.last_error_class, "delivery_outcome_unknown");
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, firstWorker, first.lease_fence, item.operationKey, Buffer.alloc(32)]), /stale_outbox_fence/);
});

native("an expired final outbox claim becomes unknown for reconciliation without exceeding its ceiling", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId, "final", { maxAttempts: 1 });
  await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [randomUUID()]);
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  assert.equal((await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [randomUUID()])).rows.length, 0);
  const row = (await admin.query("SELECT state,attempts,last_error_class FROM pkc_auth.founder_mfa_outbox WHERE outbox_id=$1", [item.outboxId])).rows[0];
  assert.equal(row.state, "unknown");
  assert.equal(Number(row.attempts), 1);
  assert.equal(row.last_error_class, "delivery_outcome_unknown");
});

native("reconciliation-claim worker function rejects NULL authority and batch bounds", async (t) => {
  const { worker } = await pools(t);
  await assert.rejects(
    () => worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation(NULL,1)"),
    /invalid_reconciliation_claim_arguments/,
  );
  await assert.rejects(
    () => worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,NULL)", [randomUUID()]),
    /invalid_reconciliation_claim_arguments/,
  );
});

native("unknown delivery can reconcile only by immutable operation key", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId, "3");
  const workerId = randomUUID();
  const claim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [workerId])).rows[0];
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)",
    [item.outboxId, workerId, claim.lease_fence, `${item.operationKey}:wrong`, "delivery_outcome_unknown"]), /stale_outbox_fence/);
  await worker.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)", [item.outboxId, workerId, claim.lease_fence, item.operationKey, "delivery_outcome_unknown"]);
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET next_reconcile_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  const reconciler = randomUUID();
  const reconcileClaim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,1)", [reconciler])).rows[0];
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, reconciler, reconcileClaim.reconciliation_lease_fence, `${item.operationKey}:wrong`, Buffer.alloc(32)]), /reconcile_state_mismatch/);
  const reconciled = await worker.query("SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, reconciler, reconcileClaim.reconciliation_lease_fence, item.operationKey, Buffer.alloc(32, 2)]);
  assert.equal(reconciled.rows[0].state, "succeeded");
});

native("unknown delivery is never redispatched and absent readback exhausts into terminal state", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId, "4", { maxAttempts: 2 });
  const workerId = randomUUID();
  const claim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [workerId])).rows[0];
  await worker.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)", [item.outboxId, workerId, claim.lease_fence, item.operationKey, "delivery_outcome_unknown"]);
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET next_attempt_at=clock_timestamp()-interval '1 second',next_reconcile_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  assert.equal((await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [randomUUID()])).rows.length, 0);
  const firstWorker = randomUUID();
  const firstClaim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,1)", [firstWorker])).rows[0];
  const first = await worker.query("SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1,$2,$3,$4)",
    [item.outboxId, firstWorker, firstClaim.reconciliation_lease_fence, item.operationKey]);
  assert.equal(first.rows[0].state, "unknown");
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET next_reconcile_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  const secondWorker = randomUUID();
  const secondClaim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,1)", [secondWorker])).rows[0];
  const second = await worker.query("SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1,$2,$3,$4)",
    [item.outboxId, secondWorker, secondClaim.reconciliation_lease_fence, item.operationKey]);
  assert.equal(second.rows[0].state, "terminal_rejected");
});

native("concurrent reconciliation claims lease one scheduled check and stale fences cannot settle", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId, "race", { maxAttempts: 2 });
  const deliveryWorker = randomUUID();
  const deliveryClaim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [deliveryWorker])).rows[0];
  await worker.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)",
    [item.outboxId, deliveryWorker, deliveryClaim.lease_fence, item.operationKey, "delivery_outcome_unknown"]);
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET next_reconcile_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  const workerA = randomUUID();
  const workerB = randomUUID();
  const [a, b] = await Promise.all([
    worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,1)", [workerA]),
    worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,1)", [workerB]),
  ]);
  assert.equal(a.rows.length + b.rows.length, 1);
  const winner = a.rows[0] ? { id: workerA, row: a.rows[0] } : { id: workerB, row: b.rows[0] };
  const loser = a.rows[0] ? workerB : workerA;
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1,$2,$3,$4)",
    [item.outboxId, loser, winner.row.reconciliation_lease_fence, item.operationKey]), /stale_reconciliation_fence/);
  const row = (await admin.query("SELECT reconciliation_attempts,state FROM pkc_auth.founder_mfa_outbox WHERE outbox_id=$1", [item.outboxId])).rows[0];
  assert.equal(Number(row.reconciliation_attempts), 0);
  assert.equal(row.state, "unknown");
  const settled = await worker.query("SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, winner.id, winner.row.reconciliation_lease_fence, item.operationKey, Buffer.alloc(32, 7)]);
  assert.equal(settled.rows[0].state, "succeeded");
});

native("expired reconciliation authority cannot settle or defer before a reclaim sweep", async (t) => {
  const { admin, worker, factorId } = await pools(t);
  const item = await enqueue(admin, factorId, "expired-reconciliation");
  const deliveryWorker = randomUUID();
  const deliveryClaim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,1)", [deliveryWorker])).rows[0];
  await worker.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)",
    [item.outboxId, deliveryWorker, deliveryClaim.lease_fence, item.operationKey, "delivery_outcome_unknown"]);
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET next_reconcile_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  const reconciler = randomUUID();
  const claim = (await worker.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,1)", [reconciler])).rows[0];
  await admin.query("UPDATE pkc_auth.founder_mfa_outbox SET reconciliation_lease_expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [item.outboxId]);
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1,$2,$3,$4,$5)",
    [item.outboxId, reconciler, claim.reconciliation_lease_fence, item.operationKey, Buffer.alloc(32)]), /reconcile_state_mismatch/);
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1,$2,$3,$4)",
    [item.outboxId, reconciler, claim.reconciliation_lease_fence, item.operationKey]), /stale_reconciliation_fence/);
});

native("audit authority rejects UPDATE DELETE and TRUNCATE", async (t) => {
  const { admin, factorId } = await pools(t);
  await admin.query("INSERT INTO pkc_auth.founder_mfa_audit_events(factor_id,correlation_id,event_type,outcome_class) VALUES($1,$2,'test','accepted')", [factorId, randomUUID()]);
  for (const sql of [
    "UPDATE pkc_auth.founder_mfa_audit_events SET event_type='changed'",
    "DELETE FROM pkc_auth.founder_mfa_audit_events",
    "TRUNCATE pkc_auth.founder_mfa_audit_events",
  ]) await assert.rejects(() => admin.query(sql), /audit_append_only/);
});
