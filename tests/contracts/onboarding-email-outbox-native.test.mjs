import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

const adminUrl = process.env.PKC_MFA_TEST_DATABASE_URL;
const runtimeUrl = process.env.PKC_ONBOARDING_RUNTIME_TEST_DATABASE_URL;
const workerUrl = process.env.PKC_ONBOARDING_EMAIL_WORKER_TEST_DATABASE_URL;
const reconcilerUrl = process.env.PKC_ONBOARDING_EMAIL_RECONCILER_TEST_DATABASE_URL;
const native = adminUrl && runtimeUrl && workerUrl && reconcilerUrl ? test : test.skip;
const digest = (value) => createHash("sha256").update(value).digest();

async function fixture(t) {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  const worker = new pg.Pool({ connectionString: workerUrl, max: 4 });
  const reconciler = new pg.Pool({ connectionString: reconcilerUrl, max: 4 });
  t.after(async () => Promise.all([admin.end(), runtime.end(), worker.end(), reconciler.end()]));
  await admin.query("TRUNCATE pkc_auth.onboarding_email_outbox,pkc_auth.onboarding_submission_claims CASCADE");
  return { admin, runtime, worker, reconciler };
}

async function claimAndPersist(runtime, id, requestDigest, email = "person@example.test") {
  const persistenceWorker = randomUUID();
  const claimed = await runtime.query("SELECT * FROM pkc_auth.claim_onboarding_submission($1,$2,$3,$4)", [id, requestDigest, email, persistenceWorker]);
  assert.equal(claimed.rows[0].claim_state, "claimed");
  assert.equal(claimed.rows[0].email_state, "blocked");
  assert.equal(typeof claimed.rows[0].persistence_fence, "string");
  const persisted = await runtime.query("SELECT * FROM pkc_auth.mark_onboarding_submission_persisted($1,$2,$3,$4)", [id, requestDigest, persistenceWorker, claimed.rows[0].persistence_fence]);
  assert.equal(persisted.rows[0].claim_state, "persisted");
  assert.equal(persisted.rows[0].email_state, "pending");
}

native("runtime claim gives one concurrent persistence lease, exact replay is bounded, and changed input is rejected", async (t) => {
  const { admin, runtime } = await fixture(t);
  const id = `submission-${randomUUID()}`;
  const requestDigest = digest("request-one");
  const workerA = randomUUID();
  const workerB = randomUUID();
  const [first, replay] = await Promise.all([
    runtime.query("SELECT * FROM pkc_auth.claim_onboarding_submission($1,$2,$3,$4)", [id, requestDigest, "person@example.test", workerA]),
    runtime.query("SELECT * FROM pkc_auth.claim_onboarding_submission($1,$2,$3,$4)", [id, requestDigest, "person@example.test", workerB]),
  ]);
  assert.equal(first.rows[0].outbox_id, replay.rows[0].outbox_id);
  assert.deepEqual([first.rows[0].claim_state, replay.rows[0].claim_state].sort(), ["claimed", "in_progress"]);
  const winner = first.rows[0].claim_state === "claimed" ? { row: first.rows[0], worker: workerA } : { row: replay.rows[0], worker: workerB };
  const loserWorker = winner.worker === workerA ? workerB : workerA;
  await assert.rejects(
    () => runtime.query("SELECT * FROM pkc_auth.mark_onboarding_submission_persisted($1,$2,$3,$4)", [id, requestDigest, loserWorker, winner.row.persistence_fence]),
    /stale_onboarding_persistence_fence/,
  );
  assert.equal((await admin.query("SELECT count(*) FROM pkc_auth.onboarding_email_outbox WHERE submission_id=$1", [id])).rows[0].count, "1");
  await assert.rejects(() => runtime.query("SELECT * FROM pkc_auth.claim_onboarding_submission($1,$2,$3,$4)", [id, digest("different"), "person@example.test", randomUUID()]), /request_digest_mismatch/);
  await assert.rejects(() => runtime.query("SELECT * FROM pkc_auth.onboarding_submission_claims"), (error) => error.code === "42501");
  await assert.rejects(() => admin.query("SELECT * FROM pkc_auth.claim_onboarding_submission($1,$2,$3,$4)", [id, requestDigest, "person@example.test", randomUUID()]), /invalid_onboarding_runtime/);
});

native("Sheets persistence releases pending and one worker receives a text fence plus minimized generic projection", async (t) => {
  const { runtime, worker } = await fixture(t);
  const id = `submission-${randomUUID()}`;
  const requestDigest = digest("request-two");
  await claimAndPersist(runtime, id, requestDigest);
  const workerA = randomUUID();
  const workerB = randomUUID();
  const [a, b] = await Promise.all([
    worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [workerA]),
    worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [workerB]),
  ]);
  assert.equal(a.rows.length + b.rows.length, 1);
  const row = a.rows[0] || b.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ["email_body", "email_subject", "lease_fence", "operation_key", "outbox_id", "recipient_email", "request_digest_hex"]);
  assert.equal(typeof row.lease_fence, "string");
  assert.equal(row.email_subject, "Welcome to ProjectKidCreations");
  assert.equal(row.email_body, "Welcome aboard from ProjectKidCreations.");
  assert.equal(JSON.stringify(row).includes("firstName"), false);
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.onboarding_email_outbox"), (error) => error.code === "42501");
});

native("armed exact request has one outcome and can never be redispatched", async (t) => {
  const { runtime, worker } = await fixture(t);
  const id = `submission-${randomUUID()}`;
  await claimAndPersist(runtime, id, digest("request-three"));
  const workerId = randomUUID();
  const row = (await worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [workerId])).rows[0];
  const requestSha = digest("exact raw Gmail API request bytes");
  const armed = await worker.query("SELECT * FROM pkc_auth.arm_onboarding_email_outbox($1,$2,$3,$4)", [row.outbox_id, workerId, row.lease_fence, requestSha]);
  assert.equal(armed.rows[0].state, "transmitting");
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.accept_onboarding_email_outbox($1,$2,$3,$4,$5)", [row.outbox_id, workerId, row.lease_fence, digest("wrong"), "gmail-message-id"]), /stale_onboarding_email_fence/);
  const accepted = await worker.query("SELECT * FROM pkc_auth.accept_onboarding_email_outbox($1,$2,$3,$4,$5)", [row.outbox_id, workerId, row.lease_fence, requestSha, "gmail-message-id"]);
  assert.equal(accepted.rows[0].state, "accepted");
  assert.equal((await worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [randomUUID()])).rows.length, 0);
});

native("expired unarmed claim is fenced and may be dispatched again", async (t) => {
  const { admin, runtime, worker } = await fixture(t);
  await claimAndPersist(runtime, `submission-${randomUUID()}`, digest("request-unarmed-expiry"));
  const first = (await worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [randomUUID()])).rows[0];
  await admin.query("UPDATE pkc_auth.onboarding_email_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [first.outbox_id]);
  const second = (await worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [randomUUID()])).rows[0];
  assert.equal(second.outbox_id, first.outbox_id);
  assert.equal(BigInt(second.lease_fence) > BigInt(first.lease_fence), true);
  assert.equal((await admin.query("SELECT state,request_sha256 IS NULL AS unarmed FROM pkc_auth.onboarding_email_outbox WHERE outbox_id=$1", [first.outbox_id])).rows[0].unarmed, true);
});

native("expired armed transmission becomes ambiguous and only the reconciler login can settle it", async (t) => {
  const { admin, runtime, worker, reconciler } = await fixture(t);
  const id = `submission-${randomUUID()}`;
  await claimAndPersist(runtime, id, digest("request-four"));
  const deliveryWorker = randomUUID();
  const row = (await worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [deliveryWorker])).rows[0];
  const requestSha = digest("exact raw request four");
  await worker.query("SELECT * FROM pkc_auth.arm_onboarding_email_outbox($1,$2,$3,$4)", [row.outbox_id, deliveryWorker, row.lease_fence, requestSha]);
  await admin.query("UPDATE pkc_auth.onboarding_email_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [row.outbox_id]);
  assert.equal((await worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [randomUUID()])).rows.length, 0);
  assert.equal((await admin.query("SELECT state FROM pkc_auth.onboarding_email_outbox WHERE outbox_id=$1", [row.outbox_id])).rows[0].state, "ambiguous");
  const reconciliationWorker = randomUUID();
  await assert.rejects(() => worker.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox_reconciliation($1,1)", [reconciliationWorker]), /permission denied for function claim_onboarding_email_outbox_reconciliation/);
  const reconciliation = (await reconciler.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox_reconciliation($1,1)", [reconciliationWorker])).rows[0];
  assert.equal(typeof reconciliation.reconciliation_lease_fence, "string");
  const settled = await reconciler.query("SELECT * FROM pkc_auth.reconcile_onboarding_email_accepted($1,$2,$3,$4,$5)", [row.outbox_id, reconciliationWorker, reconciliation.reconciliation_lease_fence, requestSha, "gmail-message-id"]);
  assert.equal(settled.rows[0].state, "accepted");
  await assert.rejects(() => reconciler.query("SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1,1)", [randomUUID()]), /permission denied for function claim_onboarding_email_outbox/);
});
