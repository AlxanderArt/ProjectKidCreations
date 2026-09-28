function required(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing ${name}`);
  return value.trim();
}

function base64Key(env, name) {
  const raw = required(env, name);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error(`invalid ${name}`);
  const value = Buffer.from(raw, "base64");
  if (value.byteLength !== 32 || value.toString("base64") !== raw) throw new Error(`invalid ${name}`);
  return value;
}

function origins(raw, name) {
  const result = new Set();
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) throw new Error(`invalid ${name}`);
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) {
      throw new Error(`invalid ${name}`);
    }
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

function uuid(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

export function loadMfaConfig(env = process.env) {
  const databaseUrl = required(env, "PKC_DATABASE_URL");
  const database = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || !database.pathname || database.hash) {
    throw new Error("invalid PKC_DATABASE_URL");
  }

  const keys = Object.freeze({
    encryption: base64Key(env, "PKC_TOTP_ENCRYPTION_KEY"),
    handoff: base64Key(env, "PKC_MFA_HANDOFF_KEY"),
    finalize: base64Key(env, "PKC_MFA_FINALIZE_KEY"),
    recovery: base64Key(env, "PKC_MFA_RECOVERY_PEPPER"),
  });
  const fingerprints = Object.values(keys).map((key) => key.toString("hex"));
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("key_reuse");

  const n8nBase = new URL(required(env, "PKC_N8N_BASE_URL"));
  const n8nOrigins = origins(required(env, "PKC_N8N_ALLOWED_ORIGINS"), "PKC_N8N_ALLOWED_ORIGINS");
  if (n8nBase.protocol !== "https:" || n8nBase.username || n8nBase.password || n8nBase.pathname !== "/" || n8nBase.search || n8nBase.hash || !n8nOrigins.has(n8nBase.origin)) {
    throw new Error("invalid PKC_N8N_BASE_URL");
  }

  return Object.freeze({
    databaseUrl,
    founderSubject: uuid(env, "PKC_FOUNDER_SUBJECT"),
    keys,
    keyVersions: Object.freeze({
      encryption: positiveVersion(env, "PKC_TOTP_ENCRYPTION_KEY_VERSION"),
      handoff: positiveVersion(env, "PKC_MFA_HANDOFF_KEY_VERSION"),
      finalize: positiveVersion(env, "PKC_MFA_FINALIZE_KEY_VERSION"),
      recovery: positiveVersion(env, "PKC_MFA_RECOVERY_PEPPER_VERSION"),
    }),
    publicOrigins: origins(required(env, "PKC_PUBLIC_ALLOWED_ORIGINS"), "PKC_PUBLIC_ALLOWED_ORIGINS"),
    n8nBaseUrl: n8nBase.origin,
    authKey: required(env, "PKC_AUTH_KEY"),
  });
}
