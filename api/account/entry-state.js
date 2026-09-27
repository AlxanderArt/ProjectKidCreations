const OWNER_USERNAME = "PK Blick";
const OWNER_EMAIL = "projectkidcreations@gmail.com";
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 8000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function sessionCookie(header) {
  if (!header) return null;
  const matches = String(header)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("pkc_session="));
  if (matches.length !== 1) throw new Error("invalid_session_cookie");
  const value = matches[0].slice("pkc_session=".length);
  if (!value || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new Error("invalid_session_cookie");
  return value;
}

function upstreamUrl() {
  const base = process.env.PKC_N8N_BASE_URL;
  const key = process.env.PKC_AUTH_KEY;
  const allowed = process.env.PKC_N8N_ALLOWED_ORIGINS;
  if (!base || !key || !allowed) throw new Error("service_unavailable");
  const parsed = new URL(base);
  const allowedOrigins = new Set(allowed.split(",").map((value) => value.trim()).filter(Boolean));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || !allowedOrigins.has(parsed.origin)) {
    throw new Error("service_unavailable");
  }
  return { url: new URL("/webhook/pkc-accounts/profile", parsed), key };
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > RESPONSE_LIMIT) throw new Error("upstream_too_large");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("upstream_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }

  let cookie;
  try { cookie = sessionCookie(req.headers.cookie); }
  catch (_) { return json(res, 400, { ok: false, error: "invalid_session" }); }
  if (!cookie) return json(res, 200, { ok: true, schema_version: 1, state: "public", authenticated: false });

  let config;
  try { config = upstreamUrl(); }
  catch (_) { return json(res, 503, { ok: false, error: "service_unavailable" }); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(config.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `pkc_session=${cookie}`,
        "x-pkc-key": config.key,
      },
      signal: controller.signal,
    });
    if (upstream.status === 401) {
      return json(res, 200, { ok: true, schema_version: 1, state: "public", authenticated: false });
    }
    if (!upstream.ok) return json(res, 502, { ok: false, error: "entry_state_unavailable" });
    const body = await boundedJson(upstream);
    const account = body?.account || body?.profile || body?.data || body;
    const username = String(account?.username || "");
    const email = String(account?.email || "").toLowerCase();
    const displayName = String(account?.display_name || username);
    const isAdmin = account?.is_admin === true || String(account?.is_admin || "").toUpperCase() === "TRUE";
    const ownerTuple = username === OWNER_USERNAME && email === OWNER_EMAIL;
    if ((isAdmin && !ownerTuple) || (ownerTuple && !isAdmin)) {
      return json(res, 409, { ok: false, error: "authority_conflict" });
    }
    return json(res, 200, {
      ok: true,
      schema_version: 1,
      state: ownerTuple ? "owner_active" : "customer_active",
      authenticated: true,
      account: { username, display_name: displayName },
      capabilities: { account: true, admin: ownerTuple },
    });
  } catch (_) {
    return json(res, 502, { ok: false, error: "entry_state_unavailable" });
  } finally {
    clearTimeout(timer);
  }
}
