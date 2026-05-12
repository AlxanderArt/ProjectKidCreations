import { put } from "@vercel/blob";

export const config = { runtime: "edge" };

const API_VERSION = "1.0.0";
const PHASE = "three";
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const VERIFY_TIMEOUT_MS = 10_000;

export default async function handler(request) {
  const started = Date.now();
  const requestId = crypto.randomUUID();

  if (request.method !== "POST") {
    return envelope({ ok: false, code: "METHOD_NOT_ALLOWED", message: "POST only" }, 405, requestId, started);
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const key = process.env.PKC_AUTH_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!base || !blobToken) {
    return envelope({ ok: false, code: "SERVER_ERROR", message: "not configured", retryable: false }, 502, requestId, started);
  }

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return envelope({ ok: false, code: "INVALID_TOKEN", message: "missing bearer token" }, 401, requestId, started);
  }

  let verifyResult;
  try {
    verifyResult = await verifyToken(token, base, key);
  } catch (err) {
    const message = err && err.name === "AbortError" ? "verify upstream timeout" : "verify upstream unreachable";
    return envelope({ ok: false, code: "SERVER_ERROR", message, retryable: true }, 502, requestId, started);
  }
  if (!verifyResult.ok) {
    const upstreamCode = verifyResult.code || "INVALID_TOKEN";
    return envelope({ ok: false, code: upstreamCode, message: verifyResult.message || "token rejected" }, 401, requestId, started);
  }

  const submissionId = verifyResult.data && verifyResult.data.submissionId;
  if (!submissionId || typeof submissionId !== "string") {
    return envelope({ ok: false, code: "INVALID_TOKEN", message: "token missing submissionId" }, 401, requestId, started);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return envelope({ ok: false, code: "VALIDATION_ERROR", message: "malformed multipart body" }, 400, requestId, started);
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return envelope({ ok: false, code: "VALIDATION_ERROR", message: "field 'file' required" }, 400, requestId, started);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return envelope({ ok: false, code: "VALIDATION_ERROR", message: `mime '${file.type}' not allowed; use jpeg, png, or webp` }, 400, requestId, started);
  }
  if (typeof file.size === "number" && file.size > MAX_BYTES) {
    return envelope({ ok: false, code: "VALIDATION_ERROR", message: `file ${file.size}B exceeds ${MAX_BYTES}B max` }, 400, requestId, started);
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) {
    return envelope({ ok: false, code: "VALIDATION_ERROR", message: `file ${bytes.byteLength}B exceeds ${MAX_BYTES}B max` }, 400, requestId, started);
  }

  const blobKey = `profile-avatars/${submissionId}.webp`;
  let blob;
  try {
    blob = await put(blobKey, new Uint8Array(bytes), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: file.type,
      token: blobToken
    });
  } catch {
    return envelope({ ok: false, code: "SERVER_ERROR", message: "blob upload failed", retryable: true }, 502, requestId, started);
  }

  return envelope({
    ok: true,
    code: "SUCCESS",
    data: { url: blob.url, key: blobKey, bytes: bytes.byteLength }
  }, 200, requestId, started);
}

async function verifyToken(token, base, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/webhook/pkc-phase-three/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "x-pkc-key": key } : {})
      },
      body: JSON.stringify({ token }),
      signal: controller.signal
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: false, code: "SERVER_ERROR", message: "verify returned non-json" }; }
  } finally {
    clearTimeout(timer);
  }
}

function envelope(payload, status, requestId, started) {
  const body = {
    ...payload,
    request_id: requestId,
    duration_ms: Date.now() - started,
    api_version: API_VERSION,
    phase: PHASE
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
