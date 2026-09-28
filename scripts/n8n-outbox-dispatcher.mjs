import {
  FOUNDER_MFA_OUTBOX_DB_CONTRACT,
  OUTBOX_SQL_CALLS,
} from "./n8n-outbox-db-contract.mjs";

const RETENTION = Object.freeze({ saveDataErrorExecution: "none", saveDataSuccessExecution: "none", saveExecutionProgress: false, saveManualExecutions: false });
const PG_BIGINT_MAX = "9223372036854775807";
const RECEIPT_HEX = /^[0-9a-f]{64}$/;

export const OUTBOX_DATABASE_INTEGRATION_CONTRACT = Object.freeze({
  ...FOUNDER_MFA_OUTBOX_DB_CONTRACT,
  status: "READY",
});

export function classifyDeliveryOutcome(result, expectedOperationKey) {
  const receiptDigest = typeof result?.receiptDigest === "string" && RECEIPT_HEX.test(result.receiptDigest) ? result.receiptDigest : null;
  if (result?.status === "confirmed" && result.operationKey === expectedOperationKey && receiptDigest) {
    return { state: "success", receiptDigest, errorClass: null };
  }
  const errorClass = result?.status === "transport_unavailable"
    ? "transport_unavailable"
    : result?.status === "confirmed"
      ? "receipt_mismatch"
      : "delivery_outcome_unknown";
  return { state: "unknown", receiptDigest: null, errorClass };
}

const workerCredential = Object.freeze({ postgres: { name: "PKC MFA Outbox Worker" } });
const sqlCall = (name) => {
  const call = OUTBOX_SQL_CALLS.find((candidate) => candidate.node === name);
  if (!call) throw new Error(`unknown outbox SQL call: ${name}`);
  return {
    name,
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.6,
    credentials: structuredClone(workerCredential),
    parameters: { operation: "executeQuery", query: call.query, options: { queryBatching: "single", queryReplacement: [...call.replacements] } },
  };
};
const code = (name, jsCode) => ({ name, type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { language: "javaScript", jsCode } });
const edge = (node, index = 0) => ({ node, type: "main", index });
const schedule = (name, seconds) => ({ name, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.3, parameters: { rule: { interval: [{ field: "seconds", secondsInterval: seconds }] } } });
const route = (name, states) => ({
  name,
  type: "n8n-nodes-base.switch",
  typeVersion: 3.2,
  parameters: {
    rules: { values: states.map((state) => ({ outputKey: state, renameOutput: true, conditions: { combinator: "and", conditions: [{ leftValue: "={{ $json.state }}", rightValue: state, operator: { type: "string", operation: "equals" } }], options: { caseSensitive: true, typeValidation: "strict", version: 2 } } })) },
    options: {},
  },
});

const WORKER_IDENTITY_SOURCE = `const worker_id=String($env.PKC_MFA_OUTBOX_WORKER_ID||'');
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(worker_id))throw new Error('invalid_outbox_worker_id');
return [{json:{worker_id,batch_size:25}}];`;
const CLAIM_VALIDATOR_SOURCE = `const max='${PG_BIGINT_MAX}';const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;const fence=value=>{if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value)||value.length>max.length||(value.length===max.length&&value>max))throw new Error('invalid_fence');return value;};
const allowed=['attempts','lease_fence','operation_key','operation_type','outbox_id','payload'];return $input.all().map(({json})=>{if(!json||JSON.stringify(Object.keys(json).sort())!==JSON.stringify(allowed)||!uuid.test(String(json.outbox_id||''))||typeof json.operation_key!=='string'||json.operation_key.length<8||json.operation_key.length>200||json.operation_type!=='revoke_founder_sessions'||!json.payload||typeof json.payload!=='object'||Array.isArray(json.payload)||!Number.isInteger(json.attempts)||json.attempts<1)throw new Error('invalid_outbox_claim');const lease_fence=fence(json.lease_fence);const worker_id=$('Worker Identity').first()?.json?.worker_id;if(!uuid.test(String(worker_id||'')))throw new Error('invalid_outbox_worker_id');return {json:{...json,lease_fence,worker_id}};});`;
const RECONCILIATION_CLAIM_VALIDATOR_SOURCE = `const max='${PG_BIGINT_MAX}';const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;const allowed=['operation_key','operation_type','outbox_id','reconciliation_lease_fence'];return $input.all().map(({json})=>{const fence=json?.reconciliation_lease_fence;if(!json||JSON.stringify(Object.keys(json).sort())!==JSON.stringify(allowed)||!uuid.test(String(json.outbox_id||''))||typeof json.operation_key!=='string'||json.operation_key.length<8||json.operation_key.length>200||json.operation_type!=='revoke_founder_sessions'||typeof fence!=='string'||!/^[1-9][0-9]*$/.test(fence)||fence.length>max.length||(fence.length===max.length&&fence>max))throw new Error('invalid_reconciliation_claim');const worker_id=$('Reconciliation Worker Identity').first()?.json?.worker_id;if(!uuid.test(String(worker_id||'')))throw new Error('invalid_outbox_worker_id');return {json:{...json,reconciliation_lease_fence:fence,worker_id}};});`;
const DELIVERY_RESULT_SOURCE = `const hex=/^[0-9a-f]{64}$/;return $input.all().map(({json})=>{if(!json||typeof json.outbox_id!=='string'||typeof json.worker_id!=='string'||typeof json.operation_key!=='string'||typeof json.lease_fence!=='string')throw new Error('invalid_adapter_envelope');const r=json.adapter_result;const digest=typeof r?.receiptDigest==='string'&&hex.test(r.receiptDigest)?r.receiptDigest:null;const success=r?.status==='confirmed'&&r.operationKey===json.operation_key&&digest!==null;const error_class=success?null:r?.status==='transport_unavailable'?'transport_unavailable':r?.status==='confirmed'?'receipt_mismatch':'delivery_outcome_unknown';return {json:{outbox_id:json.outbox_id,worker_id:json.worker_id,lease_fence:json.lease_fence,operation_key:json.operation_key,state:success?'success':'unknown',receipt_digest:success?digest:null,error_class}};});`;
const RECONCILIATION_RESULT_SOURCE = `const hex=/^[0-9a-f]{64}$/;return $input.all().map(({json})=>{if(!json||typeof json.outbox_id!=='string'||typeof json.worker_id!=='string'||typeof json.operation_key!=='string'||typeof json.reconciliation_lease_fence!=='string')throw new Error('invalid_reconciliation_envelope');const r=json.reconciliation_result;const digest=typeof r?.receiptDigest==='string'&&hex.test(r.receiptDigest)?r.receiptDigest:null;const success=r?.status==='confirmed'&&r.operationKey===json.operation_key&&digest!==null;return {json:{outbox_id:json.outbox_id,worker_id:json.worker_id,reconciliation_lease_fence:json.reconciliation_lease_fence,operation_key:json.operation_key,state:success?'success':'defer',receipt_digest:success?digest:null}};});`;

const deliveryAdapter = {
  name: "Invoke Delivery Adapter",
  type: "n8n-nodes-base.executeWorkflow",
  typeVersion: 1.3,
  onError: "continueRegularOutput",
  parameters: {
    workflowId: { __rl: true, mode: "id", value: "={{ $env.PKC_MFA_DELIVERY_ADAPTER_WORKFLOW_ID }}" },
    workflowInputs: { mappingMode: "defineBelow", value: {
      outbox_id: "={{ $json.outbox_id }}",
      operation_key: "={{ $json.operation_key }}",
      operation_type: "={{ $json.operation_type }}",
      payload: "={{ $json.payload }}",
      lease_fence: "={{ $json.lease_fence }}",
      attempts: "={{ $json.attempts }}",
      worker_id: "={{ $('Worker Identity').first().json.worker_id }}",
    }, matchingColumns: [], schema: [] },
    mode: "each",
    options: { waitForSubWorkflow: true },
  },
};
const reconciliationAdapter = {
  name: "Invoke Reconciliation Adapter",
  type: "n8n-nodes-base.executeWorkflow",
  typeVersion: 1.3,
  onError: "continueRegularOutput",
  parameters: {
    workflowId: { __rl: true, mode: "id", value: "={{ $env.PKC_MFA_RECONCILIATION_ADAPTER_WORKFLOW_ID }}" },
    workflowInputs: { mappingMode: "defineBelow", value: {
      outbox_id: "={{ $json.outbox_id }}",
      operation_key: "={{ $json.operation_key }}",
      operation_type: "={{ $json.operation_type }}",
      reconciliation_lease_fence: "={{ $json.reconciliation_lease_fence }}",
      worker_id: "={{ $('Reconciliation Worker Identity').first().json.worker_id }}",
    }, matchingColumns: [], schema: [] },
    mode: "each",
    options: { waitForSubWorkflow: true },
  },
};

export function buildOutboxDispatcherWorkflow() {
  const nodes = [
    schedule("Dispatch Schedule", 60),
    code("Worker Identity", WORKER_IDENTITY_SOURCE),
    sqlCall("Claim Safe Projection Batch"),
    code("Validate Safe Projection Claim", CLAIM_VALIDATOR_SOURCE),
    deliveryAdapter,
    code("Classify Adapter Result", DELIVERY_RESULT_SOURCE),
    route("Route Outcome", ["success", "unknown"]),
    sqlCall("Complete With Fence"),
    sqlCall("Mark Unknown With Fence"),
    schedule("Reconciliation Schedule", 300),
    code("Reconciliation Worker Identity", WORKER_IDENTITY_SOURCE),
    sqlCall("Claim Unknown Reconciliation"),
    code("Validate Reconciliation Claim", RECONCILIATION_CLAIM_VALIDATOR_SOURCE),
    reconciliationAdapter,
    code("Validate Reconciliation Result", RECONCILIATION_RESULT_SOURCE),
    route("Route Reconciliation Outcome", ["success", "defer"]),
    sqlCall("Reconcile Confirmed Delivery"),
    sqlCall("Defer Unconfirmed Reconciliation"),
  ];
  return {
    name: "PKC — Founder MFA Outbox Dispatcher-Reconciler v1 (Inactive Candidate)",
    active: false,
    settings: { executionOrder: "v1", ...RETENTION },
    nodes,
    connections: {
      "Dispatch Schedule": { main: [[edge("Worker Identity")]] },
      "Worker Identity": { main: [[edge("Claim Safe Projection Batch")]] },
      "Claim Safe Projection Batch": { main: [[edge("Validate Safe Projection Claim")]] },
      "Validate Safe Projection Claim": { main: [[edge("Invoke Delivery Adapter")]] },
      "Invoke Delivery Adapter": { main: [[edge("Classify Adapter Result")]] },
      "Classify Adapter Result": { main: [[edge("Route Outcome")]] },
      "Route Outcome": { main: [[edge("Complete With Fence")], [edge("Mark Unknown With Fence")]] },
      "Reconciliation Schedule": { main: [[edge("Reconciliation Worker Identity")]] },
      "Reconciliation Worker Identity": { main: [[edge("Claim Unknown Reconciliation")]] },
      "Claim Unknown Reconciliation": { main: [[edge("Validate Reconciliation Claim")]] },
      "Validate Reconciliation Claim": { main: [[edge("Invoke Reconciliation Adapter")]] },
      "Invoke Reconciliation Adapter": { main: [[edge("Validate Reconciliation Result")]] },
      "Validate Reconciliation Result": { main: [[edge("Route Reconciliation Outcome")]] },
      "Route Reconciliation Outcome": { main: [[edge("Reconcile Confirmed Delivery")], [edge("Defer Unconfirmed Reconciliation")]] },
    },
  };
}
