import { parseUtcTimestamp, snapshotJsonData } from "./canonical.mjs";

const PROD_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SENSITIVE_KEY_PATTERN = /password|secret|token|cookie|authorization|private.?key|seed|otp|recovery.?code|database.?url/i;
const SENSITIVE_VALUE_PATTERN = /(?:^|\s)(?:password|secret|token|authorization|client[_-]?secret|database[_-]?url)\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;

function closed(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} has unknown keys: ${unknown.sort().join(", ")}`);
}

function digest(value, label) {
  if (!HEX64.test(value ?? "")) throw new Error(`${label} must be an exact lowercase SHA-256 digest`);
}

function id(value, label) {
  if (!SAFE_ID.test(value ?? "")) throw new Error(`${label} must be a bounded stable object ID`);
}

function digestParity(value, label) {
  closed(value, ["expectedDigest", "observedDigest"], label);
  digest(value.expectedDigest, `${label}.expectedDigest`);
  digest(value.observedDigest, `${label}.observedDigest`);
  return value.expectedDigest === value.observedDigest;
}

function counts(value, label) {
  closed(value, ["databases", "files", "containers"], label);
  for (const key of ["databases", "files", "containers"]) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000) throw new Error(`${label}.${key} must be a bounded nonnegative safe integer`);
}

export function evaluateRestoreEvidence(raw) {
  const input = snapshotJsonData(raw, {
    label: "restore evidence", maxDepth: 6, maxNodes: 256, maxArrayLength: 16, maxStringLength: 256, maxAggregateBytes: 16 * 1024,
    secretKeyPattern: SENSITIVE_KEY_PATTERN, secretPattern: SENSITIVE_VALUE_PATTERN,
  });
  closed(input, ["source", "target", "restoredAt", "observedAt", "completedAt", "verifier", "migrationLedger", "catalog", "roles", "keyVersions", "residue"], "restore evidence");
  const { source, target } = input;
  closed(source, ["id", "snapshotId", "immutable", "capturedAt", "snapshotDigest", "providerReceiptId", "providerReceiptDigest"], "restore source");
  id(source.id, "source.id"); id(source.snapshotId, "source.snapshotId"); id(source.providerReceiptId, "source.providerReceiptId");
  if (/(^|[-_.:])(latest|current|head|live)([-_.:]|$)/i.test(source.snapshotId) || source.immutable !== true) throw new Error("explicit immutable stable snapshot object ID required");
  digest(source.snapshotDigest, "source.snapshotDigest");
  digest(source.providerReceiptDigest, "source.providerReceiptDigest");

  closed(target, ["id", "disposable", "isolated", "labels"], "restore target");
  id(target.id, "target.id");
  if (source.id === target.id) throw new Error("source and target IDs must be different");
  closed(target.labels, ["purpose", "production"], "target labels");
  if (PROD_LIKE.test(target.id) || target.labels.production !== "false") throw new Error("production-like restore target or unsafe production label rejected");
  if (target.disposable !== true || target.isolated !== true || target.labels.purpose !== "restore-drill") throw new Error("target must be explicitly disposable, isolated, and exactly restore-drill labeled");

  closed(input.verifier, ["identity", "evidenceIds"], "verifier");
  id(input.verifier.identity, "verifier.identity");
  if (!Array.isArray(input.verifier.evidenceIds) || input.verifier.evidenceIds.length === 0 || input.verifier.evidenceIds.length > 16) throw new Error("verifier.evidenceIds must contain 1 to 16 stable IDs");
  for (const evidenceId of input.verifier.evidenceIds) id(evidenceId, "verifier.evidenceIds entry");
  if (new Set(input.verifier.evidenceIds).size !== input.verifier.evidenceIds.length) throw new Error("verifier.evidenceIds must be unique");

  const captured = parseUtcTimestamp(source.capturedAt, "source.capturedAt");
  const restored = parseUtcTimestamp(input.restoredAt, "restoredAt");
  const observed = parseUtcTimestamp(input.observedAt, "observedAt");
  const completed = parseUtcTimestamp(input.completedAt, "completedAt");
  if (!(captured < restored && restored < observed && observed < completed)) throw new Error("restore timestamps must be strictly ordered UTC instants");
  const rpoSeconds = (restored - captured) / 1000;
  const rtoSeconds = (completed - captured) / 1000;

  const migrationLedger = digestParity(input.migrationLedger, "migrationLedger");
  const catalog = digestParity(input.catalog, "catalog");
  const roles = digestParity(input.roles, "roles");
  const keyVersions = digestParity(input.keyVersions, "keyVersions");
  closed(input.residue, ["expectedInventoryDigest", "observedInventoryDigest", "expectedCounts", "observedCounts"], "residue");
  digest(input.residue.expectedInventoryDigest, "residue.expectedInventoryDigest");
  digest(input.residue.observedInventoryDigest, "residue.observedInventoryDigest");
  counts(input.residue.expectedCounts, "residue.expectedCounts");
  counts(input.residue.observedCounts, "residue.observedCounts");
  const residueInventory = input.residue.expectedInventoryDigest === input.residue.observedInventoryDigest;
  const residueCounts = ["databases", "files", "containers"].every((key) => input.residue.expectedCounts[key] === input.residue.observedCounts[key]);
  const zeroResidue = ["databases", "files", "containers"].every((key) => input.residue.observedCounts[key] === 0);
  const checks = {
    migrationLedger, catalog, roles, keyVersions, residueInventory, residueCounts,
    rpo: rpoSeconds <= 300, rto: rtoSeconds <= 3600, zeroResidue,
  };
  return {
    status: "syntax-and-parity-only", authoritative: false, releaseEligible: false,
    paritySatisfied: Object.values(checks).every(Boolean), snapshotId: source.snapshotId, providerReceiptId: source.providerReceiptId,
    sourceId: source.id, targetId: target.id, verifierIdentity: input.verifier.identity, rpoSeconds, rtoSeconds, checks,
  };
}
