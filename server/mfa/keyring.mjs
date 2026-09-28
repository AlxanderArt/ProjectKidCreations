import { createHmac, timingSafeEqual } from "node:crypto";

import { decryptTotpSecret } from "./crypto.mjs";

const authenticKeyrings = new WeakSet();

class ReadOnlyKeyring {
  #entries;

  constructor(entries) {
    this.#entries = new Map(entries.map(([keyVersion, key]) => [keyVersion, Buffer.from(key)]));
    authenticKeyrings.add(this);
    Object.freeze(this);
  }

  get size() { return this.#entries.size; }
  has(keyVersion) { return this.#entries.has(keyVersion); }
  get(keyVersion) {
    const key = this.#entries.get(keyVersion);
    return key === undefined ? undefined : Buffer.from(key);
  }
  *keys() { yield* this.#entries.keys(); }
  *values() { for (const key of this.#entries.values()) yield Buffer.from(key); }
  *entries() { for (const [keyVersion, key] of this.#entries) yield [keyVersion, Buffer.from(key)]; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback, thisArg) {
    if (typeof callback !== "function") throw new TypeError("invalid_keyring_callback");
    for (const [keyVersion, key] of this.#entries) callback.call(thisArg, Buffer.from(key), keyVersion, this);
  }
  set() { throw new TypeError("read_only_keyring"); }
  delete() { throw new TypeError("read_only_keyring"); }
  clear() { throw new TypeError("read_only_keyring"); }
}

export function createReadOnlyKeyring(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => !Array.isArray(entry) || entry.length !== 2
      || !Number.isSafeInteger(entry[0]) || entry[0] < 1 || !Buffer.isBuffer(entry[1]) || entry[1].byteLength !== 32)) {
    throw new TypeError("invalid_keyring_entries");
  }
  return new ReadOnlyKeyring(entries);
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("invalid_key_version");
  return value;
}

function keyFor(keyring, keyVersion) {
  if (!authenticKeyrings.has(keyring)) throw new TypeError("invalid_keyring");
  const key = keyring.get(version(keyVersion));
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) throw new Error("unknown_key_version");
  return key;
}

function canonical(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_keyring_payload");
  const ordered = {};
  for (const field of Object.keys(value).sort()) ordered[field] = value[field];
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function decryptWithKeyring(envelope, keyring, aad) {
  return decryptTotpSecret(envelope, keyFor(keyring, envelope?.keyVersion), aad);
}

export function signWithKeyring(payload, keyring, keyVersion) {
  const bytes = canonical(payload);
  const signature = createHmac("sha256", keyFor(keyring, keyVersion)).update(bytes).digest();
  return Object.freeze({ keyVersion, payload: bytes.toString("base64url"), signature: signature.toString("base64url") });
}

export function verifyWithKeyring(artifact, keyring) {
  if (!artifact || typeof artifact.payload !== "string" || typeof artifact.signature !== "string") throw new Error("invalid_keyring_artifact");
  const key = keyFor(keyring, artifact.keyVersion);
  const payload = Buffer.from(artifact.payload, "base64url");
  if (payload.toString("base64url") !== artifact.payload) throw new Error("invalid_keyring_artifact");
  const actual = Buffer.from(artifact.signature, "base64url");
  const expected = createHmac("sha256", key).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid_keyring_signature");
  const value = JSON.parse(payload.toString("utf8"));
  if (canonical(value).toString("base64url") !== artifact.payload) throw new Error("invalid_keyring_artifact");
  return value;
}

export function selectActiveKey(keyring, keyVersion) {
  return Buffer.from(keyFor(keyring, keyVersion));
}
