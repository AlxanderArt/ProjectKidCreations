function row(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) throw new Error("outbox_repository_unavailable");
  return result.rows[0];
}

const PG_BIGINT_MAX = "9223372036854775807";

function bigintFence(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)
      || value.length > PG_BIGINT_MAX.length
      || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
    throw new TypeError("invalid_bigint_fence");
  }
  return value;
}

export function createOutboxRepository({ pool }) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("invalid_pg_pool");
  return Object.freeze({
    async claim({ workerId, batchSize }) {
      const result = await pool.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1,$2)", [workerId, batchSize]);
      return result.rows.map((entry) => Object.freeze({
        outboxId: entry.outbox_id, operationKey: entry.operation_key, operationType: entry.operation_type,
        payload: entry.payload, leaseFence: bigintFence(entry.lease_fence), attempts: Number(entry.attempts),
      }));
    },
    async complete(value) {
      return row(await pool.query("SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1,$2,$3,$4,$5)",
        [value.outboxId, value.workerId, bigintFence(value.leaseFence), value.operationKey, value.receiptDigest]));
    },
    async markUnknown(value) {
      return row(await pool.query("SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1,$2,$3,$4,$5)",
        [value.outboxId, value.workerId, bigintFence(value.leaseFence), value.operationKey, value.errorClass]));
    },
    async reconcile(value) {
      return row(await pool.query("SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1,$2,$3,$4,$5)",
        [value.outboxId, value.workerId, bigintFence(value.reconciliationLeaseFence), value.operationKey, value.receiptDigest]));
    },
    async claimReconciliation({ workerId, batchSize }) {
      const result = await pool.query("SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1,$2)", [workerId, batchSize]);
      return result.rows.map((entry) => Object.freeze({
        outboxId: entry.outbox_id,
        operationKey: entry.operation_key,
        operationType: entry.operation_type,
        reconciliationLeaseFence: bigintFence(entry.reconciliation_lease_fence),
      }));
    },
    async deferReconciliation(value) {
      return row(await pool.query("SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1,$2,$3,$4)",
        [value.outboxId, value.workerId, bigintFence(value.reconciliationLeaseFence), value.operationKey]));
    },
    async monitor() {
      return row(await pool.query("SELECT * FROM pkc_auth.founder_mfa_outbox_monitor()"));
    },
  });
}
