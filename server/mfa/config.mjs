import { createReadOnlyKeyring } from "./keyring.mjs";
import { parseFounderMfaMode } from "./mode.mjs";

function required(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing ${name}`);
  return value.trim();
}

function base64KeyValue(raw, name) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error(`invalid ${name}`);
  const value = Buffer.from(raw, "base64");
  if (value.byteLength !== 32 || value.toString("base64") !== raw) throw new Error(`invalid ${name}`);
  return value;
}

function base64Key(env, name) {
  return base64KeyValue(required(env, name), name);
}

function origins(raw, name) {
  const result = new Set();
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) throw new Error(`invalid ${name}`);
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) throw new Error(`invalid ${name}`);
    result.add(value);
  }
  return result;
}

function positiveVersion(env, name, fallback = 1) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

function keyring(env, ringName, legacyName, activeVersion) {
  const raw = env?.[ringName];
  if (raw === undefined || raw === "") return createReadOnlyKeyring([[activeVersion, base64Key(env, legacyName)]]);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`invalid ${ringName}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error(`invalid ${ringName}`);
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 8) throw new Error(`invalid ${ringName}`);
  const result = new Map();
  for (const [rawVersion, value] of entries) {
    const numeric = Number(rawVersion);
    if (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(numeric) || numeric > 1_000_000 || typeof value !== "string") throw new Error(`invalid ${ringName}`);
    result.set(numeric, base64KeyValue(value, ringName));
  }
  if (!result.has(activeVersion)) throw new Error(`unknown active version ${ringName}`);
  return createReadOnlyKeyring([...result.entries()].sort((a, b) => a[0] - b[0]));
}

function boundedInteger(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  return value;
}

function databaseConfig(env, databaseUrl) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error("invalid PKC_DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/" || url.hash) throw new Error("invalid PKC_DATABASE_URL");
  const parameterNames = [...url.searchParams.keys()];
  const allowedParameters = new Set(["sslmode", "application_name"]);
  const sslmode = url.searchParams.get("sslmode");
  if (new Set(parameterNames).size !== parameterNames.length || parameterNames.some((name) => !allowedParameters.has(name)) || sslmode !== "verify-full") throw new Error("invalid PKC_DATABASE_URL tls");
  const expectedDatabase = required(env, "PKC_DATABASE_NAME");
  const expectedUser = required(env, "PKC_DATABASE_USER");
  const environment = required(env, "PKC_DATABASE_ENVIRONMENT");
  if (!["development", "test", "preview", "production"].includes(environment)) throw new TypeError("invalid PKC_DATABASE_ENVIRONMENT");
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase) throw new Error("database_name_mismatch");
  if (decodeURIComponent(url.username) !== expectedUser) throw new Error("database_user_mismatch");
  if (!/(?:pool|proxy|pgbouncer)/i.test(url.hostname)) throw new Error("database_pooler_required");
  const poolMax = boundedInteger(env, "PKC_DATABASE_POOL_MAX", 5, 1, 10);
  const connectionBudget = boundedInteger(env, "PKC_DATABASE_CONNECTION_BUDGET", 20, 2, 1000);
  if (poolMax * 2 > connectionBudget) throw new Error("connection_budget_exceeded");
  return Object.freeze({
    expectedDatabase, expectedUser, environment, poolMax, connectionBudget, sslmode,
    connectionTimeoutMs: 5_000, queryTimeoutMs: 6_000, statementTimeoutMs: 5_000,
    idleTransactionTimeoutMs: 10_000, totalDeadlineMs: 20_000,
  });
}

export function loadMfaConfig(env = process.env) {
  const runtimeDatabaseValue = required(env, "PKC_DATABASE_URL");
  const databaseUrl = runtimeDatabaseValue;
  const database = databaseConfig(env, databaseUrl);
  const keyVersions = Object.freeze({
    encryption: positiveVersion(env, "PKC_TOTP_ENCRYPTION_KEY_VERSION"),
    handoff: positiveVersion(env, "PKC_MFA_HANDOFF_KEY_VERSION"),
    finalize: positiveVersion(env, "PKC_MFA_FINALIZE_KEY_VERSION"),
    recovery: positiveVersion(env, "PKC_MFA_RECOVERY_PEPPER_VERSION"),
  });
  const keyrings = Object.freeze({
    encryption: keyring(env, "PKC_TOTP_ENCRYPTION_KEYRING", "PKC_TOTP_ENCRYPTION_KEY", keyVersions.encryption),
    handoff: keyring(env, "PKC_MFA_HANDOFF_KEYRING", "PKC_MFA_HANDOFF_KEY", keyVersions.handoff),
    finalize: keyring(env, "PKC_MFA_FINALIZE_KEYRING", "PKC_MFA_FINALIZE_KEY", keyVersions.finalize),
    recovery: keyring(env, "PKC_MFA_RECOVERY_PEPPER_KEYRING", "PKC_MFA_RECOVERY_PEPPER", keyVersions.recovery),
  });
  const fingerprints = Object.values(keyrings).flatMap((ring) => [...ring.values()].map((key) => key.toString("hex")));
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("key_reuse");
  const keys = {};
  for (const [name, ring] of Object.entries(keyrings)) {
    Object.defineProperty(keys, name, { enumerable: true, get: () => ring.get(keyVersions[name]) });
  }
  Object.freeze(keys);
  const n8nBase = new URL(required(env, "PKC_N8N_BASE_URL"));
  const n8nOrigins = origins(required(env, "PKC_N8N_ALLOWED_ORIGINS"), "PKC_N8N_ALLOWED_ORIGINS");
  if (n8nBase.protocol !== "https:" || n8nBase.username || n8nBase.password || n8nBase.pathname !== "/" || n8nBase.search || n8nBase.hash || !n8nOrigins.has(n8nBase.origin)) throw new Error("invalid PKC_N8N_BASE_URL");
  const founderSubject = env?.PKC_FOUNDER_SUBJECT;
  if (typeof founderSubject !== "string" || founderSubject === "") throw new Error("missing PKC_FOUNDER_SUBJECT");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(founderSubject)) throw new Error("invalid PKC_FOUNDER_SUBJECT");
  const mode = parseFounderMfaMode({ ...env, NODE_ENV: env?.NODE_ENV || (database.environment === "production" ? "production" : undefined) });
  let deployment = null;
  if (mode === "enforced") {
    const sourceCommit = required(env, "PKC_SOURCE_COMMIT");
    const deploymentId = required(env, "PKC_DEPLOYMENT_ID");
    const workflowDigest = required(env, "PKC_MFA_WORKFLOW_DIGEST");
    const enrollmentApprovalId = required(env, "PKC_MFA_ENROLLMENT_APPROVAL_ID");
    if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[0-9a-f]{64}$/.test(workflowDigest)
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,255}$/.test(deploymentId)
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(enrollmentApprovalId)) throw new Error("invalid PKC deployment authority");
    deployment = Object.freeze({ sourceCommit, deploymentId, workflowDigest, enrollmentApprovalId });
  }
  return Object.freeze({ databaseUrl, database, founderSubject, mode, deployment, keys, keyrings, keyVersions,
    publicOrigins: origins(required(env, "PKC_PUBLIC_ALLOWED_ORIGINS"), "PKC_PUBLIC_ALLOWED_ORIGINS"),
    n8nBaseUrl: n8nBase.origin, authKey: required(env, "PKC_AUTH_KEY") });
}
