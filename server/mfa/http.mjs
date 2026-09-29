const MFA_COOKIE = "__Host-pkc_mfa";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const JSON_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 4096;

const MFA_HEADERS = Object.freeze({
  "Content-Type": JSON_TYPE,
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export function serializeMfaCookie(token, maxAgeSeconds = 300) {
  if (!TOKEN_RE.test(token) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300) {
    throw new TypeError("invalid_mfa_cookie");
  }
  return `${MFA_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearMfaCookie() {
  return `${MFA_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseMfaCookie(header) {
  if (header === null || header === undefined || header === "") return null;
  const values = [];
  for (const segment of String(header).split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name === MFA_COOKIE) values.push(segment.slice(separator + 1).trim());
  }
  if (values.length > 1) throw new Error("duplicate_mfa_cookie");
  if (values.length === 0) return null;
  if (!TOKEN_RE.test(values[0])) throw new Error("invalid_mfa_cookie");
  return values[0];
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel("payload_too_large").catch(() => {});
      throw new Error("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}

export async function validateMfaMutationRequest(request, publicOrigins, schema) {
  if (request.method !== "POST") throw new Error("method_not_allowed");
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !publicOrigins.has(origin)) throw new Error("origin_forbidden");
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") throw new Error("origin_forbidden");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("unsupported_media_type");

  let body;
  try {
    body = JSON.parse((await readBody(request)) || "{}");
  } catch (error) {
    if (error?.message === "payload_too_large") throw error;
    throw new Error("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_json_object");
  const allowed = new Set(schema.allowedFields || []);
  for (const field of Object.keys(body)) if (!allowed.has(field)) throw new Error("unknown_field");
  for (const field of schema.requiredFields || []) if (!(field in body)) throw new Error(`missing_${field}`);
  if (typeof body.csrf !== "string" || !TOKEN_RE.test(body.csrf)) throw new Error("invalid_csrf");
  return body;
}

export function mfaJson(value, status = 200, additions = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...MFA_HEADERS, ...additions } });
}
