import { isIP } from "node:net";
import { canonicalJson, sha256, snapshotJsonData } from "./canonical.mjs";

const CONFIG_FIELDS = ["enabled", "endpoint", "credentialName", "timeoutMs", "maxAttempts", "transportId", "credentialBrokerId"];
const ID = /^[A-Za-z][A-Za-z0-9_.-]{2,127}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function ipv4Parts(address) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? parts : null;
}

export function isPublicAddress(address) {
  if (typeof address !== "string" || address.startsWith("[") || address.endsWith("]") || isIP(address) === 0) return false;
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  let lower;
  try {
    const canonicalHostname = new URL(`http://[${address}]/`).hostname;
    lower = canonicalHostname.slice(1, -1).toLowerCase();
  } catch {
    return false;
  }
  const hextets = lower.split(":");
  const first = Number.parseInt(hextets[0] || "0", 16);
  const second = Number.parseInt(hextets[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff
    && !(lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")
    || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:")
    || lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:1:") || lower.startsWith("100:")
    || lower.startsWith("2002:") || lower.startsWith("3fff:") || (first === 0x2001 && second <= 0x01ff));
}

export function validateAlertDeliveryConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !CONFIG_FIELDS.includes(key))) throw new Error("invalid_alert_delivery");
  if (!raw.enabled) {
    if (Object.keys(raw).some((key) => key !== "enabled") || (raw.enabled !== undefined && raw.enabled !== false)) throw new Error("invalid_alert_delivery");
    return Object.freeze({ enabled: false });
  }
  let endpoint;
  try { endpoint = new URL(raw.endpoint); } catch { throw new Error("invalid_alert_delivery"); }
  const endpointHostname = endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]") ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || isIP(endpointHostname)
      || endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".local") || endpoint.pathname.includes("docker.sock") || endpoint.pathname.includes("/root")) throw new Error("invalid_alert_delivery");
  if (![raw.credentialName, raw.transportId, raw.credentialBrokerId].every((v) => ID.test(v || ""))) throw new Error("invalid_alert_delivery");
  if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 100 || raw.timeoutMs > 10_000 || !Number.isSafeInteger(raw.maxAttempts) || raw.maxAttempts < 1 || raw.maxAttempts > 3) throw new Error("invalid_alert_delivery");
  return Object.freeze({ ...raw, endpoint: endpoint.href });
}

function safeAck(receipt, key) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const prototype = Object.getPrototypeOf(receipt);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(receipt);
  if (Object.keys(descriptors).sort().join(",") !== "deliveryId,status") return false;
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || descriptor.get || descriptor.set)) return false;
  return descriptors.status.value === "acknowledged" && descriptors.deliveryId.value === key
    && Buffer.byteLength(JSON.stringify({ deliveryId: descriptors.deliveryId.value, status: descriptors.status.value })) <= 512;
}

export function createAlertDelivery(rawConfig = {}, dependencies = {}) {
  const config = validateAlertDeliveryConfig(rawConfig);
  if (!config.enabled) return async () => Object.freeze({ status: "disabled" });
  if (typeof dependencies.transport !== "function" || typeof dependencies.resolve !== "function"
      || dependencies.transportId !== config.transportId || dependencies.credentialBrokerId !== config.credentialBrokerId
      || dependencies.pinsResolvedAddresses !== true || dependencies.disablesRedirects !== true
      || dependencies.supportsAbortSignal !== true) throw new Error("alert_delivery_unconfigured");
  const settled = new Map();
  const inFlight = new Map();
  return async function deliver(rawPayload) {
    const payload = deepFreeze(snapshotJsonData(rawPayload, { label: "alert delivery", maxDepth: 6, maxNodes: 256, maxArrayLength: 64, maxStringLength: 256, maxAggregateBytes: 16_384, secretKeyPattern: /password|secret|token|cookie|authorization|credential/i, secretPattern: /Bearer\s+|-----BEGIN|password\s*[:=]|secret\s*[:=]/i }));
    if (payload?.externalSend !== false || !Array.isArray(payload?.alerts) || payload.alerts.length < 1 || payload.alerts.length > 64) throw new Error("invalid_alert_payload");
    const requestBytes = canonicalJson(payload);
    const idempotencyKey = sha256(requestBytes);
    if (settled.has(idempotencyKey)) return settled.get(idempotencyKey);
    if (inFlight.has(idempotencyKey)) return inFlight.get(idempotencyKey);
    const message = deepFreeze({ endpoint: config.endpoint, idempotencyKey, requestDigest: idempotencyKey, requestBytes, payload, transportId: config.transportId, credentialBrokerId: config.credentialBrokerId });
    const operation = (async () => {
      const addresses = await dependencies.resolve(new URL(config.endpoint).hostname);
      if (!Array.isArray(addresses) || addresses.length < 1 || addresses.some((entry) => !isPublicAddress(entry))) throw new Error("alert_delivery_ssrf");
      const controller = new AbortController();
      let timer;
      const timedOut = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(Symbol.for("timeout")); }, config.timeoutMs); });
      let receipt;
      try { receipt = await Promise.race([dependencies.transport(message, { signal: controller.signal, addresses: Object.freeze([...addresses]), redirect: "error", credentialName: config.credentialName }), timedOut]); }
      catch { receipt = Symbol.for("transport-error"); }
      finally { clearTimeout(timer); }
      let acknowledged = false;
      if (receipt !== Symbol.for("timeout") && receipt !== Symbol.for("transport-error")) {
        try { acknowledged = safeAck(receipt, idempotencyKey); } catch { acknowledged = false; }
      }
      if (!acknowledged) {
        const unknown = Object.freeze({ status: "UNKNOWN_REQUIRES_RECONCILIATION", deliveryId: idempotencyKey });
        settled.set(idempotencyKey, unknown);
        return unknown;
      }
      const safe = Object.freeze({ status: "acknowledged", deliveryId: idempotencyKey });
      settled.set(idempotencyKey, safe);
      return safe;
    })();
    inFlight.set(idempotencyKey, operation);
    try { return await operation; } finally { inFlight.delete(idempotencyKey); }
  };
}
