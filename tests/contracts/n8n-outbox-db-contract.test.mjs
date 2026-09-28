import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  OUTBOX_DATABASE_INTEGRATION_CONTRACT,
  buildOutboxDispatcherWorkflow,
  classifyDeliveryOutcome,
} from "../../scripts/n8n-outbox-dispatcher.mjs";

const EXPECTED_FUNCTIONS = Object.freeze([
  Object.freeze({ name: "claim_founder_mfa_outbox", arguments: Object.freeze(["worker_id uuid", "batch_size integer"]), returns: Object.freeze(["outbox_id uuid", "operation_key text", "operation_type text", "payload jsonb", "lease_fence bigint", "attempts integer"]) }),
  Object.freeze({ name: "complete_founder_mfa_outbox", arguments: Object.freeze(["p_outbox_id uuid", "p_worker_id uuid", "p_lease_fence bigint", "p_operation_key text", "p_receipt_digest bytea"]), returns: Object.freeze(["state text"]) }),
  Object.freeze({ name: "mark_founder_mfa_outbox_unknown", arguments: Object.freeze(["p_outbox_id uuid", "p_worker_id uuid", "p_lease_fence bigint", "p_operation_key text", "p_error_class text"]), returns: Object.freeze(["state text"]) }),
  Object.freeze({ name: "claim_founder_mfa_outbox_reconciliation", arguments: Object.freeze(["worker_id uuid", "batch_size integer"]), returns: Object.freeze(["outbox_id uuid", "operation_key text", "operation_type text", "reconciliation_lease_fence bigint"]) }),
  Object.freeze({ name: "reconcile_founder_mfa_outbox", arguments: Object.freeze(["p_outbox_id uuid", "p_worker_id uuid", "p_reconciliation_lease_fence bigint", "p_operation_key text", "p_receipt_digest bytea"]), returns: Object.freeze(["state text"]) }),
  Object.freeze({ name: "defer_founder_mfa_outbox_reconciliation", arguments: Object.freeze(["p_outbox_id uuid", "p_worker_id uuid", "p_reconciliation_lease_fence bigint", "p_operation_key text"]), returns: Object.freeze(["state text"]) }),
]);
const EXPECTED_ERROR_CLASSES = Object.freeze(["delivery_outcome_unknown", "transport_unavailable", "receipt_mismatch"]);
const FORBIDDEN_FUNCTIONS = Object.freeze([
  "retry_founder_mfa_outbox",
  "terminal_founder_mfa_outbox",
  "claim_founder_mfa_reconciliation",
  "complete_founder_mfa_reconciliation",
]);
const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const outboxId = "11111111-1111-4111-8111-111111111111";
const operationKey = "revoke:11111111-1111-4111-8111-111111111111:4";

function node(workflow, name) {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(found, `missing node: ${name}`);
  return found;
}

function runCode(source, items, env = {}) {
  const lookup = (name) => ({ first: () => ({ json: { worker_id: env.PKC_MFA_OUTBOX_WORKER_ID, source: name } }) });
  return Function("$input", "$env", "$", source)({ all: () => structuredClone(items), first: () => structuredClone(items[0]) }, env, lookup);
}

function postgresCalls(workflow) {
  return workflow.nodes.filter((candidate) => candidate.type === "n8n-nodes-base.postgres");
}

test("portable outbox DB pin is independently literal and exact", async () => {
  const contract = await import("../../scripts/n8n-outbox-db-contract.mjs");
  assert.deepEqual(contract.FOUNDER_MFA_OUTBOX_DB_CONTRACT.functions, EXPECTED_FUNCTIONS);
  assert.deepEqual(contract.FOUNDER_MFA_OUTBOX_DB_CONTRACT.markUnknownErrorClasses, EXPECTED_ERROR_CLASSES);
  assert.deepEqual(contract.FOUNDER_MFA_OUTBOX_DB_CONTRACT.allowedFunctionNames, EXPECTED_FUNCTIONS.map(({ name }) => name));
  assert.equal(contract.FOUNDER_MFA_OUTBOX_DB_CONTRACT.schema, "pkc-founder-mfa-outbox-db-contract-v1");
});

test("migration parser compares a composed migration to the literal pin", async () => {
  const { assertFounderMfaOutboxMigrationContract } = await import("../../scripts/n8n-outbox-db-contract.mjs");
  const sql = EXPECTED_FUNCTIONS.map((entry) => `CREATE FUNCTION pkc_auth.${entry.name}(${entry.arguments.join(",")})\nRETURNS TABLE(${entry.returns.join(",")}) LANGUAGE sql AS $$ SELECT NULL $$;`).join("\n");
  assert.doesNotThrow(() => assertFounderMfaOutboxMigrationContract(sql));
  assert.throws(() => assertFounderMfaOutboxMigrationContract(sql.replace("p_worker_id uuid", "p_worker_id text")), /database contract mismatch/i);
  assert.throws(() => assertFounderMfaOutboxMigrationContract(`${sql}\nCREATE FUNCTION pkc_auth.retry_founder_mfa_outbox(x uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;`), /forbidden|database contract mismatch/i);
});

test("integrated repository migration matches the independently literal portable pin", async () => {
  const { assertFounderMfaOutboxMigrationFile } = await import("../../scripts/n8n-outbox-db-contract.mjs");
  const migrationPath = new URL("../../db/migrations/001_founder_mfa.sql", import.meta.url);
  assert.doesNotThrow(() => assertFounderMfaOutboxMigrationFile(migrationPath.pathname));
});

test("dispatcher contract advertises READY authority with no hardcoded worker", () => {
  assert.equal(OUTBOX_DATABASE_INTEGRATION_CONTRACT.status, "READY");
  assert.deepEqual(OUTBOX_DATABASE_INTEGRATION_CONTRACT.functions, EXPECTED_FUNCTIONS);
  assert.deepEqual(OUTBOX_DATABASE_INTEGRATION_CONTRACT.markUnknownErrorClasses, EXPECTED_ERROR_CLASSES);
  assert.equal("workerId" in OUTBOX_DATABASE_INTEGRATION_CONTRACT, false);
});

test("dispatcher uses exactly the six DB-authorized functions and rejects obsolete names", async () => {
  const workflow = buildOutboxDispatcherWorkflow();
  const { assertOutboxWorkflowDatabaseContract } = await import("../../scripts/n8n-outbox-db-contract.mjs");
  assert.doesNotThrow(() => assertOutboxWorkflowDatabaseContract(workflow));
  const serialized = JSON.stringify(workflow);
  for (const forbidden of FORBIDDEN_FUNCTIONS) assert.doesNotMatch(serialized, new RegExp(`\\b${forbidden}\\b`));
  assert.equal(postgresCalls(workflow).length, 6);
  for (const forbidden of FORBIDDEN_FUNCTIONS) {
    const drift = structuredClone(workflow);
    drift.nodes.find((candidate) => candidate.type === "n8n-nodes-base.postgres").parameters.query = `SELECT pkc_auth.${forbidden}($1::uuid);`;
    drift.nodes.find((candidate) => candidate.type === "n8n-nodes-base.postgres").parameters.options.queryReplacement = ["={{ $json.outbox_id }}"];
    assert.throws(() => assertOutboxWorkflowDatabaseContract(drift), /forbidden|database contract/i);
  }
});

test("worker UUID comes from explicit environment configuration and is validated before either claim", () => {
  const workflow = buildOutboxDispatcherWorkflow();
  for (const [identityName, claimName] of [["Worker Identity", "Claim Safe Projection Batch"], ["Reconciliation Worker Identity", "Claim Unknown Reconciliation"]]) {
    const source = node(workflow, identityName).parameters.jsCode;
    assert.match(source, /PKC_MFA_OUTBOX_WORKER_ID/);
    assert.doesNotMatch(source, /pkc-n8n-outbox-v1/);
    assert.deepEqual(runCode(source, [], { PKC_MFA_OUTBOX_WORKER_ID: workerId }), [{ json: { worker_id: workerId, batch_size: 25 } }]);
    for (const invalid of ["", workerId.toUpperCase(), "not-a-uuid", "33333333-3333-4333-8333-33333333333Z"]) {
      assert.throws(() => runCode(source, [], { PKC_MFA_OUTBOX_WORKER_ID: invalid }), /invalid_outbox_worker_id/);
    }
    assert.deepEqual(workflow.connections[identityName].main[0], [{ node: claimName, type: "main", index: 0 }]);
  }
});

test("claim envelopes preserve canonical decimal bigint fences without Number conversion", () => {
  const workflow = buildOutboxDispatcherWorkflow();
  const dispatchSource = node(workflow, "Validate Safe Projection Claim").parameters.jsCode;
  const dispatch = runCode(dispatchSource, [{ json: { outbox_id: outboxId, operation_key: operationKey, operation_type: "revoke_founder_sessions", payload: { founderSubject: outboxId }, lease_fence: "9007199254740993", attempts: 1 } }], { PKC_MFA_OUTBOX_WORKER_ID: workerId });
  assert.equal(dispatch[0].json.lease_fence, "9007199254740993");
  assert.equal(dispatch[0].json.worker_id, workerId);
  for (const invalid of [1, "01", "+1", "-1", "9223372036854775808"]) {
    assert.throws(() => runCode(dispatchSource, [{ json: { outbox_id: outboxId, operation_key: operationKey, operation_type: "revoke_founder_sessions", payload: {}, lease_fence: invalid, attempts: 1 } }]), /invalid_(?:outbox_claim|fence)/);
  }
  const reconciliationSource = node(workflow, "Validate Reconciliation Claim").parameters.jsCode;
  const reconciliation = runCode(reconciliationSource, [{ json: { outbox_id: outboxId, operation_key: operationKey, operation_type: "revoke_founder_sessions", reconciliation_lease_fence: "9223372036854775807" } }], { PKC_MFA_OUTBOX_WORKER_ID: workerId });
  assert.equal(reconciliation[0].json.reconciliation_lease_fence, "9223372036854775807");
  assert.equal(reconciliation[0].json.worker_id, workerId);
});

test("only confirmed matching delivery completes and every other result marks unknown with a DB class", () => {
  assert.deepEqual(classifyDeliveryOutcome({ status: "confirmed", operationKey, receiptDigest: "a".repeat(64) }, operationKey), { state: "success", receiptDigest: "a".repeat(64), errorClass: null });
  assert.deepEqual(classifyDeliveryOutcome({ status: "confirmed", operationKey: `${operationKey}:wrong`, receiptDigest: "a".repeat(64) }, operationKey), { state: "unknown", receiptDigest: null, errorClass: "receipt_mismatch" });
  assert.deepEqual(classifyDeliveryOutcome({ status: "transport_unavailable" }, operationKey), { state: "unknown", receiptDigest: null, errorClass: "transport_unavailable" });
  assert.deepEqual(classifyDeliveryOutcome({ status: "rejected", errorClass: "delivery_exhausted" }, operationKey), { state: "unknown", receiptDigest: null, errorClass: "delivery_outcome_unknown" });
  const workflow = buildOutboxDispatcherWorkflow();
  assert.deepEqual(node(workflow, "Route Outcome").parameters.rules.values.map((entry) => entry.outputKey), ["success", "unknown"]);
  assert.deepEqual(workflow.connections["Route Outcome"].main, [[{ node: "Complete With Fence", type: "main", index: 0 }], [{ node: "Mark Unknown With Fence", type: "main", index: 0 }]]);
});

test("dispatcher SQL parameter order, casts, digest decoding, and replacement cardinality match the pin", () => {
  const workflow = buildOutboxDispatcherWorkflow();
  const expected = new Map([
    ["Claim Safe Projection Batch", "SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1::uuid,$2::integer);"],
    ["Complete With Fence", "SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1::uuid,$2::uuid,$3::bigint,$4::text,pg_catalog.decode($5::text,'hex'));"],
    ["Mark Unknown With Fence", "SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text);"],
    ["Claim Unknown Reconciliation", "SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1::uuid,$2::integer);"],
    ["Reconcile Confirmed Delivery", "SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1::uuid,$2::uuid,$3::bigint,$4::text,pg_catalog.decode($5::text,'hex'));"],
    ["Defer Unconfirmed Reconciliation", "SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1::uuid,$2::uuid,$3::bigint,$4::text);"],
  ]);
  for (const call of postgresCalls(workflow)) {
    assert.equal(call.parameters.query, expected.get(call.name), call.name);
    const highest = [...call.parameters.query.matchAll(/\$(\d+)/g)].reduce((maximum, match) => Math.max(maximum, Number(match[1])), 0);
    assert.equal(call.parameters.options.queryReplacement.length, highest, call.name);
  }
  assert.deepEqual([...expected.keys()], postgresCalls(workflow).map(({ name }) => name));
});

test("reconciliation confirms through reconcile and defers every absent or unconfirmed readback", () => {
  const workflow = buildOutboxDispatcherWorkflow();
  const source = node(workflow, "Validate Reconciliation Result").parameters.jsCode;
  const base = { outbox_id: outboxId, operation_key: operationKey, operation_type: "revoke_founder_sessions", reconciliation_lease_fence: "9007199254740993", worker_id: workerId };
  const success = runCode(source, [{ json: { ...base, reconciliation_result: { status: "confirmed", operationKey, receiptDigest: "b".repeat(64) } } }]);
  assert.equal(success[0].json.state, "success");
  assert.equal(success[0].json.receipt_digest, "b".repeat(64));
  for (const reconciliation_result of [null, { status: "absent" }, { status: "confirmed", operationKey: `${operationKey}:wrong`, receiptDigest: "b".repeat(64) }, { status: "confirmed", operationKey, receiptDigest: "B".repeat(64) }]) {
    const result = runCode(source, [{ json: { ...base, reconciliation_result } }]);
    assert.equal(result[0].json.state, "defer");
    assert.equal(result[0].json.receipt_digest, null);
  }
  assert.deepEqual(node(workflow, "Route Reconciliation Outcome").parameters.rules.values.map((entry) => entry.outputKey), ["success", "defer"]);
  assert.deepEqual(workflow.connections["Route Reconciliation Outcome"].main, [[{ node: "Reconcile Confirmed Delivery", type: "main", index: 0 }], [{ node: "Defer Unconfirmed Reconciliation", type: "main", index: 0 }]]);
});

test("shared n8n gate assertion validates the dispatcher contract", () => {
  const source = fs.readFileSync(new URL("../support/n8n-gate-assertions.mjs", import.meta.url), "utf8");
  assert.match(source, /assertOutboxWorkflowDatabaseContract/);
  assert.match(source, /role\s*===\s*["']dispatcher["']/);
});
