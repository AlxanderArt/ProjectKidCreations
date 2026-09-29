import { createHash } from "node:crypto";

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 100_000, maxArrayLength: 10_000, maxStringLength: 1_000_000, maxAggregateBytes: 32 * 1024 * 1024 });

function dataError(label, message) {
  return new TypeError(`${label} ${message}`);
}

export function snapshotJsonData(value, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const label = options.label ?? "value";
  const seen = new Set();
  let nodes = 0;
  let aggregateBytes = 0;

  function visit(input, path, depth) {
    nodes += 1;
    if (nodes > limits.maxNodes) throw dataError(label, `exceeds node bound ${limits.maxNodes}`);
    if (depth > limits.maxDepth) throw dataError(label, `exceeds depth bound ${limits.maxDepth}`);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (input.length > limits.maxStringLength) throw dataError(label, `string at ${path} exceeds length bound ${limits.maxStringLength}`);
      aggregateBytes += Buffer.byteLength(input);
      if (aggregateBytes > limits.maxAggregateBytes) throw dataError(label, `exceeds aggregate byte bound ${limits.maxAggregateBytes}`);
      if (options.secretPattern?.test(input)) throw dataError(label, `contains secret-like string value at ${path}`);
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw dataError(label, `contains a non-finite number at ${path}`);
      if (Object.is(input, -0)) throw dataError(label, `contains negative zero at ${path}`);
      return input;
    }
    if (typeof input !== "object") throw dataError(label, `is not canonical JSON at ${path}`);
    if (seen.has(input)) throw dataError(label, `contains a cycle at ${path}`);
    seen.add(input);
    try {
      let prototype;
      let descriptors;
      let symbols;
      try {
        prototype = Object.getPrototypeOf(input);
        descriptors = Object.getOwnPropertyDescriptors(input);
        symbols = Object.getOwnPropertySymbols(input);
      } catch {
        throw dataError(label, `cannot be inspected safely at ${path}`);
      }
      if (symbols.length) throw dataError(label, `contains symbol properties at ${path}`);
      if (Array.isArray(input)) {
        if (prototype !== Array.prototype) throw dataError(label, `array has an unsupported prototype at ${path}`);
        if (input.length > limits.maxArrayLength) throw dataError(label, `array at ${path} exceeds length bound ${limits.maxArrayLength}`);
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (keys.length !== input.length || keys.some((key, index) => key !== String(index))) throw dataError(label, `array at ${path} must be dense and contain only indexed data properties`);
        const output = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw dataError(label, `contains an accessor or non-data item at ${path}[${index}]`);
          output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return output;
      }
      if (prototype !== Object.prototype) throw dataError(label, `must contain only plain objects at ${path}`);
      const output = {};
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable) throw dataError(label, `contains an accessor or non-data property at ${path}.${key}`);
        aggregateBytes += Buffer.byteLength(key);
        if (aggregateBytes > limits.maxAggregateBytes) throw dataError(label, `exceeds aggregate byte bound ${limits.maxAggregateBytes}`);
        if (options.secretKeyPattern?.test(key)) throw dataError(label, `contains secret-bearing key at ${path}.${key}`);
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, `${path}.${key}`, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return output;
    } finally {
      seen.delete(input);
    }
  }

  return visit(value, "$", 0);
}

export function canonicalJson(value) {
  const normalized = snapshotJsonData(value, { label: "value" });
  return `${JSON.stringify(normalized)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseUtcTimestamp(value, label = "timestamp") {
  const match = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/);
  const parsed = match ? Date.parse(value) : Number.NaN;
  const canonical = match ? `${match[1]}${match[2] ?? ".000"}Z` : "";
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical) throw new Error(`${label} must be a valid strict ISO UTC timestamp`);
  return parsed;
}

export function assertClosedKeys(value, allowed, label = "object") {
  const snapshot = snapshotJsonData(value, { label, maxDepth: 16, maxNodes: 10_000, maxArrayLength: 1_000, maxStringLength: 1_000_000, maxAggregateBytes: 4 * 1024 * 1024 });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError(`${label} must be an object`);
  const unknown = Object.keys(snapshot).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} has unknown keys: ${unknown.sort().join(", ")}`);
  return snapshot;
}
