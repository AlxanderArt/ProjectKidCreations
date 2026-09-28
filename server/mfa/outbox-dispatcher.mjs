const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BATCH_MAX = 25;

function safeReceipt(value, operationKey) {
  return value?.status === "confirmed"
    && value.operationKey === operationKey
    && Buffer.isBuffer(value.receiptDigest)
    && value.receiptDigest.byteLength === 32;
}

function validateDependencies({ repository, transport, workerId, readback }) {
  if (!repository || typeof repository.claim !== "function" || typeof repository.complete !== "function"
      || typeof repository.markUnknown !== "function" || typeof repository.reconcile !== "function") throw new TypeError("invalid_outbox_repository");
  if (typeof transport !== "function" || !UUID_RE.test(workerId)) throw new TypeError("invalid_outbox_dispatcher");
  if (readback !== undefined && typeof readback !== "function") throw new TypeError("invalid_outbox_readback");
  if (readback !== undefined && (typeof repository.claimReconciliation !== "function" || typeof repository.deferReconciliation !== "function")) {
    throw new TypeError("invalid_outbox_repository");
  }
}

export function createOutboxDispatcher(dependencies) {
  validateDependencies(dependencies);
  const { repository, transport, workerId, readback } = dependencies;

  async function dispatchOnce({ batchSize = BATCH_MAX } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > BATCH_MAX) throw new RangeError("invalid_batch_size");
    const events = await repository.claim({ workerId, batchSize });
    const summary = { claimed: events.length, succeeded: 0, unknown: 0, terminal: 0 };
    for (const event of events) {
      let receipt;
      try {
        receipt = await transport(Object.freeze({
          operationKey: event.operationKey,
          idempotencyKey: event.operationKey,
          operationType: event.operationType,
          payload: event.payload,
        }));
      } catch {
        receipt = null;
      }
      if (safeReceipt(receipt, event.operationKey)) {
        await repository.complete({ outboxId: event.outboxId, workerId, leaseFence: event.leaseFence, operationKey: event.operationKey, receiptDigest: receipt.receiptDigest });
        summary.succeeded += 1;
      } else {
        const outcome = await repository.markUnknown({ outboxId: event.outboxId, workerId, leaseFence: event.leaseFence, operationKey: event.operationKey, errorClass: "delivery_outcome_unknown" });
        if (outcome?.state === "terminal_rejected") summary.terminal += 1;
        else summary.unknown += 1;
      }
    }
    return Object.freeze(summary);
  }

  async function reconcileOnce({ batchSize = BATCH_MAX } = {}) {
    if (typeof repository.claimReconciliation !== "function" || typeof repository.deferReconciliation !== "function" || typeof readback !== "function") throw new Error("reconciliation_not_configured");
    const events = await repository.claimReconciliation({ workerId, batchSize });
    const summary = { inspected: events.length, succeeded: 0, unresolved: 0, terminal: 0 };
    for (const event of events) {
      let receipt;
      try { receipt = await readback({ operationKey: event.operationKey, operationType: event.operationType }); } catch { receipt = null; }
      if (safeReceipt(receipt, event.operationKey)) {
        const result = await repository.reconcile({
          outboxId: event.outboxId, workerId, reconciliationLeaseFence: event.reconciliationLeaseFence,
          operationKey: event.operationKey, receiptDigest: receipt.receiptDigest,
        });
        if (result?.state === "terminal_rejected") summary.terminal += 1;
        else summary.succeeded += 1;
      } else {
        const result = await repository.deferReconciliation({
          outboxId: event.outboxId, workerId, reconciliationLeaseFence: event.reconciliationLeaseFence, operationKey: event.operationKey,
        });
        if (result?.state === "terminal_rejected") summary.terminal += 1;
        else summary.unresolved += 1;
      }
    }
    return Object.freeze(summary);
  }

  async function readiness() {
    const monitor = await repository.monitor();
    return Object.freeze({ ready: Number(monitor.terminal || 0) === 0, ...monitor });
  }

  return Object.freeze({ dispatchOnce, reconcileOnce, readiness });
}
