import fs from "node:fs";

const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

const functions = [
  { name: "claim_founder_mfa_outbox", arguments: ["worker_id uuid", "batch_size integer"], returns: ["outbox_id uuid", "operation_key text", "operation_type text", "payload jsonb", "lease_fence bigint", "attempts integer"] },
  { name: "complete_founder_mfa_outbox", arguments: ["p_outbox_id uuid", "p_worker_id uuid", "p_lease_fence bigint", "p_operation_key text", "p_receipt_digest bytea"], returns: ["state text"] },
  { name: "mark_founder_mfa_outbox_unknown", arguments: ["p_outbox_id uuid", "p_worker_id uuid", "p_lease_fence bigint", "p_operation_key text", "p_error_class text"], returns: ["state text"] },
  { name: "claim_founder_mfa_outbox_reconciliation", arguments: ["worker_id uuid", "batch_size integer"], returns: ["outbox_id uuid", "operation_key text", "operation_type text", "reconciliation_lease_fence bigint"] },
  { name: "reconcile_founder_mfa_outbox", arguments: ["p_outbox_id uuid", "p_worker_id uuid", "p_reconciliation_lease_fence bigint", "p_operation_key text", "p_receipt_digest bytea"], returns: ["state text"] },
  { name: "defer_founder_mfa_outbox_reconciliation", arguments: ["p_outbox_id uuid", "p_worker_id uuid", "p_reconciliation_lease_fence bigint", "p_operation_key text"], returns: ["state text"] },
];

export const FORBIDDEN_OUTBOX_FUNCTION_NAMES = freeze([
  "retry_founder_mfa_outbox",
  "terminal_founder_mfa_outbox",
  "claim_founder_mfa_reconciliation",
  "complete_founder_mfa_reconciliation",
]);

export const OUTBOX_SQL_CALLS = freeze([
  {
    node: "Claim Safe Projection Batch",
    functionName: "claim_founder_mfa_outbox",
    query: "SELECT * FROM pkc_auth.claim_founder_mfa_outbox($1::uuid,$2::integer);",
    replacements: ["={{ $json.worker_id }}", "={{ $json.batch_size }}"],
  },
  {
    node: "Complete With Fence",
    functionName: "complete_founder_mfa_outbox",
    query: "SELECT * FROM pkc_auth.complete_founder_mfa_outbox($1::uuid,$2::uuid,$3::bigint,$4::text,pg_catalog.decode($5::text,'hex'));",
    replacements: ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.lease_fence }}", "={{ $json.operation_key }}", "={{ $json.receipt_digest }}"],
  },
  {
    node: "Mark Unknown With Fence",
    functionName: "mark_founder_mfa_outbox_unknown",
    query: "SELECT * FROM pkc_auth.mark_founder_mfa_outbox_unknown($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text);",
    replacements: ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.lease_fence }}", "={{ $json.operation_key }}", "={{ $json.error_class }}"],
  },
  {
    node: "Claim Unknown Reconciliation",
    functionName: "claim_founder_mfa_outbox_reconciliation",
    query: "SELECT * FROM pkc_auth.claim_founder_mfa_outbox_reconciliation($1::uuid,$2::integer);",
    replacements: ["={{ $json.worker_id }}", "={{ $json.batch_size }}"],
  },
  {
    node: "Reconcile Confirmed Delivery",
    functionName: "reconcile_founder_mfa_outbox",
    query: "SELECT * FROM pkc_auth.reconcile_founder_mfa_outbox($1::uuid,$2::uuid,$3::bigint,$4::text,pg_catalog.decode($5::text,'hex'));",
    replacements: ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.reconciliation_lease_fence }}", "={{ $json.operation_key }}", "={{ $json.receipt_digest }}"],
  },
  {
    node: "Defer Unconfirmed Reconciliation",
    functionName: "defer_founder_mfa_outbox_reconciliation",
    query: "SELECT * FROM pkc_auth.defer_founder_mfa_outbox_reconciliation($1::uuid,$2::uuid,$3::bigint,$4::text);",
    replacements: ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.reconciliation_lease_fence }}", "={{ $json.operation_key }}"],
  },
]);

export const FOUNDER_MFA_OUTBOX_DB_CONTRACT = freeze({
  schema: "pkc-founder-mfa-outbox-db-contract-v1",
  functions,
  allowedFunctionNames: functions.map(({ name }) => name),
  markUnknownErrorClasses: ["delivery_outcome_unknown", "transport_unavailable", "receipt_mismatch"],
});

function normalizeList(source) {
  return source.split(",").map((item) => item.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}

export function parseFounderMfaOutboxMigrationContract(sql) {
  if (typeof sql !== "string") throw new TypeError("migration SQL must be a string");
  const found = new Map();
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+pkc_auth\.([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*RETURNS\s+TABLE\s*\(([^)]*)\)/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (FOUNDER_MFA_OUTBOX_DB_CONTRACT.allowedFunctionNames.includes(name) || FORBIDDEN_OUTBOX_FUNCTION_NAMES.includes(name)) {
      if (found.has(name)) throw new Error(`database contract mismatch: duplicate ${name}`);
      found.set(name, { name, arguments: normalizeList(match[2]), returns: normalizeList(match[3]) });
    }
  }
  return freeze([...found.values()]);
}

export function assertFounderMfaOutboxMigrationContract(sql) {
  if (typeof sql !== "string") throw new TypeError("migration SQL must be a string");
  for (const forbidden of FORBIDDEN_OUTBOX_FUNCTION_NAMES) {
    if (new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+pkc_auth\\.${forbidden}\\s*\\(`, "i").test(sql)) {
      throw new Error(`forbidden database contract function: ${forbidden}`);
    }
  }
  const parsed = parseFounderMfaOutboxMigrationContract(sql);
  const actual = parsed.filter(({ name }) => FOUNDER_MFA_OUTBOX_DB_CONTRACT.allowedFunctionNames.includes(name));
  if (JSON.stringify(actual) !== JSON.stringify(FOUNDER_MFA_OUTBOX_DB_CONTRACT.functions)) {
    throw new Error(`database contract mismatch: expected ${FOUNDER_MFA_OUTBOX_DB_CONTRACT.allowedFunctionNames.join(",")}`);
  }
  return true;
}

export function assertFounderMfaOutboxMigrationFile(migrationPath) {
  if (typeof migrationPath !== "string" || migrationPath.length === 0) throw new TypeError("migration path required");
  return assertFounderMfaOutboxMigrationContract(fs.readFileSync(migrationPath, "utf8"));
}

export function assertOutboxWorkflowDatabaseContract(workflow) {
  if (!workflow || !Array.isArray(workflow.nodes)) throw new Error("outbox workflow database contract: invalid workflow");
  const serialized = JSON.stringify(workflow);
  for (const forbidden of FORBIDDEN_OUTBOX_FUNCTION_NAMES) {
    if (new RegExp(`\\b${forbidden}\\b`).test(serialized)) throw new Error(`forbidden outbox function: ${forbidden}`);
  }
  const postgresNodes = workflow.nodes.filter(({ type }) => type === "n8n-nodes-base.postgres");
  if (postgresNodes.length !== OUTBOX_SQL_CALLS.length) throw new Error("outbox workflow database contract: SQL call count mismatch");
  for (let index = 0; index < OUTBOX_SQL_CALLS.length; index += 1) {
    const expected = OUTBOX_SQL_CALLS[index];
    const actual = postgresNodes[index];
    if (actual.name !== expected.node || actual.parameters?.query !== expected.query
        || JSON.stringify(actual.parameters?.options?.queryReplacement) !== JSON.stringify(expected.replacements)) {
      throw new Error(`outbox workflow database contract mismatch: ${expected.node}`);
    }
    const placeholders = [...expected.query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    if (Math.max(0, ...placeholders) !== expected.replacements.length) throw new Error(`${expected.node}: queryReplacement cardinality mismatch`);
  }
  return true;
}
