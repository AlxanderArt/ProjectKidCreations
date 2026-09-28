import { canonicalJson, parseUtcTimestamp, sha256, snapshotJsonData } from "./canonical.mjs";

const SENSITIVE_KEY_PATTERN = /password|secret|token|cookie|authorization|private.?key|seed|otp|recovery.?code|database.?url/i;
const SENSITIVE_VALUE_PATTERN = /(?:^|\s)(?:password|secret|token|authorization|client[_-]?secret|database[_-]?url)\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const ROOT_KEYS = ["at", "readiness", "migration", "outbox", "keys", "n8n", "vercel", "backup", "auth", "metadata"];
const SIGNAL_KEYS = Object.freeze({
  readiness: ["ok"],
  migration: ["checksumDrift", "roleDrift", "aclDrift"],
  outbox: ["oldestPendingSeconds", "retryMax", "unknownMinutes", "terminal", "dlq"],
  keys: ["readFailures"],
  n8n: ["workflowDrift", "versionDrift", "retentionDrift"],
  vercel: ["sourceDrift", "aliasDrift"],
  backup: ["failed"],
  auth: ["challengeExhaustion", "epochMismatchSpike", "sessionAnomaly"],
});
const BOOLEAN_FIELDS = new Set(["ok", "checksumDrift", "roleDrift", "aclDrift", "workflowDrift", "versionDrift", "retentionDrift", "sourceDrift", "aliasDrift", "failed", "epochMismatchSpike", "sessionAnomaly"]);

export const MONITORING_PAYLOAD_POLICY = Object.freeze({
  maximumAlerts: 64,
  maximumInputStringLength: 128,
  maximumOutputMetadataBytes: 512,
  maximumDepth: 4,
  maximumNodes: 128,
  maximumAggregateInputBytes: 4096,
  allowedInputMetadata: ["eventId", "operationKey", "state", "attemptCount", "errorClass", "observedAt"],
  emittedMetadata: ["eventIdDigest", "operationKeyDigest", "state", "attemptCount", "errorClass", "observedAt"],
  opaqueDigestInputs: ["eventId", "operationKey"],
});

const RULES = [
  ["READINESS_DRIFT", (x) => x.readiness?.ok === false], ["MIGRATION_CHECKSUM_DRIFT", (x) => x.migration?.checksumDrift === true],
  ["ROLE_DRIFT", (x) => x.migration?.roleDrift === true], ["ACL_DRIFT", (x) => x.migration?.aclDrift === true],
  ["OUTBOX_AGE", (x) => x.outbox?.oldestPendingSeconds > 120], ["OUTBOX_RETRY", (x) => x.outbox?.retryMax > 5],
  ["OUTBOX_UNKNOWN", (x) => x.outbox?.unknownMinutes > 5], ["OUTBOX_TERMINAL", (x) => x.outbox?.terminal > 0], ["OUTBOX_DLQ", (x) => x.outbox?.dlq > 0],
  ["KEY_READ_FAILURE", (x) => x.keys?.readFailures > 0], ["N8N_WORKFLOW_DRIFT", (x) => x.n8n?.workflowDrift === true],
  ["N8N_VERSION_DRIFT", (x) => x.n8n?.versionDrift === true], ["N8N_RETENTION_DRIFT", (x) => x.n8n?.retentionDrift === true],
  ["VERCEL_SOURCE_DRIFT", (x) => x.vercel?.sourceDrift === true], ["VERCEL_ALIAS_DRIFT", (x) => x.vercel?.aliasDrift === true],
  ["BACKUP_FAILURE", (x) => x.backup?.failed === true], ["AUTH_CHALLENGE_EXHAUSTION", (x) => x.auth?.challengeExhaustion > 3],
  ["AUTH_EPOCH_MISMATCH", (x) => x.auth?.epochMismatchSpike === true], ["SESSION_ANOMALY", (x) => x.auth?.sessionAnomaly === true],
];

function closed(object, allowed, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new TypeError(`${label} must be a plain object`);
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} has unknown keys: ${unknown.sort().join(", ")}`);
}

function validateSignals(input) {
  closed(input, ROOT_KEYS, "monitoring input");
  parseUtcTimestamp(input.at, "monitoring timestamp");
  for (const [group, allowed] of Object.entries(SIGNAL_KEYS)) {
    if (input[group] === undefined) continue;
    closed(input[group], allowed, `monitoring.${group}`);
    for (const [key, value] of Object.entries(input[group])) {
      if (BOOLEAN_FIELDS.has(key)) {
        if (typeof value !== "boolean") throw new TypeError(`monitoring.${group}.${key} must be boolean`);
      } else if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
        throw new TypeError(`monitoring.${group}.${key} must be a bounded nonnegative safe integer`);
      }
    }
  }
}

function safeMetadata(input) {
  if (input === undefined) return {};
  closed(input, MONITORING_PAYLOAD_POLICY.allowedInputMetadata, "monitoring.metadata");
  const output = {};
  for (const [source, target] of [["eventId", "eventIdDigest"], ["operationKey", "operationKeyDigest"]]) {
    const value = input[source];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > MONITORING_PAYLOAD_POLICY.maximumInputStringLength) throw new TypeError(`monitoring.metadata.${source} must be a nonempty opaque string of at most 128 characters`);
    output[target] = sha256(value);
  }
  if (input.state !== undefined) {
    if (typeof input.state !== "string" || !/^[A-Z][A-Z0-9_]{0,31}$/.test(input.state)) throw new TypeError("monitoring.metadata.state is invalid");
    output.state = input.state;
  }
  if (input.attemptCount !== undefined) {
    if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0 || input.attemptCount > 1_000_000) throw new TypeError("monitoring.metadata.attemptCount is invalid");
    output.attemptCount = input.attemptCount;
  }
  if (input.errorClass !== undefined) {
    if (typeof input.errorClass !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorClass)) throw new TypeError("monitoring.metadata.errorClass is invalid");
    output.errorClass = input.errorClass;
  }
  if (input.observedAt !== undefined) {
    parseUtcTimestamp(input.observedAt, "metadata.observedAt");
    output.observedAt = input.observedAt;
  }
  if (Buffer.byteLength(canonicalJson(output)) > MONITORING_PAYLOAD_POLICY.maximumOutputMetadataBytes) throw new Error("projected monitoring metadata exceeds byte bound");
  return output;
}

export function evaluateMonitoring(value) {
  const input = snapshotJsonData(value, {
    label: "monitoring input",
    maxDepth: MONITORING_PAYLOAD_POLICY.maximumDepth,
    maxNodes: MONITORING_PAYLOAD_POLICY.maximumNodes,
    maxArrayLength: 0,
    maxStringLength: MONITORING_PAYLOAD_POLICY.maximumInputStringLength,
    maxAggregateBytes: MONITORING_PAYLOAD_POLICY.maximumAggregateInputBytes,
    secretKeyPattern: SENSITIVE_KEY_PATTERN,
    secretPattern: SENSITIVE_VALUE_PATTERN,
  });
  validateSignals(input);
  const metadata = safeMetadata(input.metadata);
  const alerts = RULES.filter(([, predicate]) => predicate(input)).slice(0, MONITORING_PAYLOAD_POLICY.maximumAlerts).map(([code]) => ({
    code,
    severity: ["READINESS_DRIFT", "MIGRATION_CHECKSUM_DRIFT", "ROLE_DRIFT", "ACL_DRIFT", "KEY_READ_FAILURE", "BACKUP_FAILURE"].includes(code) ? "critical" : "warning",
    at: input.at,
    metadata,
  }));
  return { schemaVersion: 1, evaluatedAt: input.at, externalSend: false, alerts };
}

export { RULES as MONITORING_RULES };
