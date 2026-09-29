import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { pgBigint } from "./pg-bigint.mjs";

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_TOTP = Object.freeze({ algorithm: "sha1", digits: 6, period: 30, window: 1 });

function requireBuffer(value, length, name) {
  if (!Buffer.isBuffer(value) || (length !== null && value.byteLength !== length)) {
    throw new TypeError(`invalid_${name}`);
  }
  return value;
}

function canonicalJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_canonical_object");
  const ordered = {};
  for (const key of Object.keys(value).sort()) ordered[key] = value[key];
  return JSON.stringify(ordered);
}

function b64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function b64urlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  return Buffer.from(value, "base64url");
}

function exactFieldSet(value, allowedFields) {
  if (!Array.isArray(allowedFields) || allowedFields.some((field) => typeof field !== "string" || !field)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...new Set(allowedFields)].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

export function generateTotpSecret(bytes = 20) {
  if (!Number.isSafeInteger(bytes) || bytes < 20 || bytes > 64) throw new RangeError("invalid_totp_secret_size");
  return randomBytes(bytes);
}

export function encryptTotpSecret(secret, key, aad, options = {}) {
  requireBuffer(secret, null, "secret");
  requireBuffer(key, 32, "encryption_key");
  const nonce = options.nonce === undefined ? randomBytes(12) : requireBuffer(options.nonce, 12, "nonce");
  const keyVersion = options.keyVersion;
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new TypeError("invalid_key_version");
  const aadBytes = Buffer.from(canonicalJson(aad), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadBytes);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Object.freeze({
    algorithm: "aes-256-gcm",
    keyVersion,
    nonce: Buffer.from(nonce),
    ciphertext,
    tag: cipher.getAuthTag(),
  });
}

export function decryptTotpSecret(envelope, key, aad) {
  requireBuffer(key, 32, "encryption_key");
  if (!envelope || envelope.algorithm !== "aes-256-gcm" || !Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) {
    throw new Error("invalid_envelope");
  }
  const nonce = requireBuffer(envelope.nonce, 12, "nonce");
  const ciphertext = requireBuffer(envelope.ciphertext, null, "ciphertext");
  const tag = requireBuffer(envelope.tag, 16, "tag");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(canonicalJson(aad), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function signArtifact(claims, key) {
  requireBuffer(key, 32, "signing_key");
  const payload = b64urlEncode(Buffer.from(canonicalJson(claims), "utf8"));
  const signature = createHmac("sha256", key).update(payload, "ascii").digest();
  return `${payload}.${b64urlEncode(signature)}`;
}

export function verifyArtifact(token, key, policy) {
  requireBuffer(key, 32, "signing_key");
  if (typeof token !== "string" || token.split(".").length !== 2) throw new Error("invalid_artifact");
  const [payload, encodedSignature] = token.split(".");
  const signature = b64urlDecode(encodedSignature);
  const expected = createHmac("sha256", key).update(payload, "ascii").digest();
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) throw new Error("invalid_artifact_signature");

  let claims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8"));
  } catch {
    throw new Error("invalid_artifact_payload");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || !exactFieldSet(claims, policy?.allowedFields)) {
    throw new Error("invalid_artifact_claims");
  }
  const now = policy?.now;
  if (!Number.isSafeInteger(now)
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.nbf)
    || !Number.isSafeInteger(claims.exp)
    || claims.iat > now
    || claims.nbf > now
    || claims.exp < now
    || claims.exp <= claims.iat
    || claims.iss !== policy.issuer
    || claims.aud !== policy.audience
    || claims.typ !== policy.type
    || claims.purpose !== policy.purpose) {
    throw new Error("invalid_artifact_claims");
  }
  return claims;
}

function counterBuffer(counter) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("invalid_totp_counter");
  const value = Buffer.alloc(8);
  value.writeBigUInt64BE(BigInt(counter));
  return value;
}

export function totpAt(secret, timestampMs, options = {}) {
  requireBuffer(secret, null, "totp_secret");
  const digits = options.digits ?? DEFAULT_TOTP.digits;
  const period = options.period ?? DEFAULT_TOTP.period;
  const algorithm = String(options.algorithm ?? DEFAULT_TOTP.algorithm).toLowerCase();
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || !Number.isSafeInteger(digits) || digits < 6 || digits > 8
      || !Number.isSafeInteger(period) || period < 1 || algorithm !== "sha1") {
    throw new TypeError("invalid_totp_parameters");
  }
  const counter = Math.floor(timestampMs / 1000 / period);
  const digest = createHmac(algorithm, secret).update(counterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(binary).padStart(digits, "0");
}

export function verifyTotp(code, secret, timestampMs, options = {}) {
  const digits = options.digits ?? DEFAULT_TOTP.digits;
  const period = options.period ?? DEFAULT_TOTP.period;
  const window = options.window ?? DEFAULT_TOTP.window;
  if (typeof code !== "string" || !new RegExp(`^\\d{${digits}}$`).test(code)) return { valid: false, reason: "malformed" };
  if (!Number.isSafeInteger(window) || window < 0 || window > 1) throw new TypeError("invalid_totp_window");
  const current = Math.floor(timestampMs / 1000 / period);
  let replayed = false;
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = current + delta;
    if (counter < 0) continue;
    const candidate = totpAt(secret, counter * period * 1000, { ...options, digits, period });
    const matched = timingSafeEqual(Buffer.from(code, "ascii"), Buffer.from(candidate, "ascii"));
    if (!matched) continue;
    const counterString = String(counter);
    if (options.lastAcceptedCounter !== null && options.lastAcceptedCounter !== undefined
        && BigInt(counterString) <= BigInt(pgBigint(options.lastAcceptedCounter, "last_accepted_counter"))) {
      replayed = true;
      continue;
    }
    return { valid: true, counter: counterString };
  }
  return { valid: false, reason: replayed ? "replayed" : "invalid" };
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError("invalid_opaque_token");
  return createHmac("sha256", Buffer.from("pkc-mfa-opaque-token-v1", "ascii")).update(token, "ascii").digest();
}

export function normalizeRecoveryCode(code) {
  if (typeof code !== "string") throw new TypeError("invalid_recovery_code");
  const normalized = code.trim().toUpperCase().replaceAll("-", "");
  if (!/^[A-Z2-9]{28}$/.test(normalized)) throw new TypeError("invalid_recovery_code");
  return normalized;
}

export function generateRecoveryCodes(options = {}) {
  const count = options.count ?? 10;
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new RangeError("invalid_recovery_code_count");
  const codes = new Set();
  while (codes.size < count) {
    let raw = "";
    for (let index = 0; index < 28; index += 1) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.add(raw.match(/.{4}/g).join("-"));
  }
  return [...codes];
}

export function hashRecoveryCode(code, pepper) {
  requireBuffer(pepper, 32, "recovery_pepper");
  return createHmac("sha256", pepper).update(normalizeRecoveryCode(code), "ascii").digest();
}
