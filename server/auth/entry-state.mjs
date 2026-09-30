const OWNER_USERNAME = "PK Blick";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 8000;

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

function upstreamUrl(env) {
  const base = env.PKC_N8N_BASE_URL;
  const key = env.PKC_AUTH_KEY;
  const allowed = env.PKC_N8N_ALLOWED_ORIGINS;
  const founderSubject = String(env.PKC_FOUNDER_SUBJECT || "");
  if (!base || !key || !allowed || !UUID_RE.test(founderSubject)) throw new Error("service_unavailable");
  const parsed = new URL(base);
  const allowedOrigins = new Set(allowed.split(",").map((value) => value.trim()).filter(Boolean));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || !allowedOrigins.has(parsed.origin)) {
    throw new Error("service_unavailable");
  }
  return { url: new URL("/webhook/pkc-accounts/profile", parsed), key, founderSubject };
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

export async function resolveEntryState({ cookieHeader, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let cookie;
  try { cookie = sessionCookie(cookieHeader); }
  catch { return { status: 400, body: { ok: false, error: "invalid_session" } }; }
  if (!cookie) {
    return { status: 200, body: { ok: true, schema_version: 1, state: "public", authenticated: false } };
  }

  let config;
  try { config = upstreamUrl(env); }
  catch { return { status: 503, body: { ok: false, error: "service_unavailable" } }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(config.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `pkc_session=${cookie}`,
        "x-pkc-key": config.key,
      },
      signal: controller.signal,
    });
    if (upstream.status === 401) {
      return { status: 200, body: { ok: true, schema_version: 1, state: "public", authenticated: false } };
    }
    if (!upstream.ok) return { status: 502, body: { ok: false, error: "entry_state_unavailable" } };
    const body = await boundedJson(upstream);
    const account = body?.account || body?.profile || body?.data || body;
    const username = String(account?.username || "");
    const displayName = String(account?.display_name || username);
    const isAdmin = account?.is_admin === true || String(account?.is_admin || "").toUpperCase() === "TRUE";
    const accountId = String(account?.account_id || "");
    if (!UUID_RE.test(accountId)) return { status: 409, body: { ok: false, error: "authority_conflict" } };
    const subjectMatch = accountId === config.founderSubject;
    const usernameMatch = username === OWNER_USERNAME;
    const ownerTuple = subjectMatch && usernameMatch && isAdmin;
    if ((subjectMatch || usernameMatch || isAdmin) && !ownerTuple) {
      return { status: 409, body: { ok: false, error: "authority_conflict" } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        schema_version: 1,
        state: ownerTuple ? "owner_active" : "customer_active",
        authenticated: true,
        account: { account_id: accountId, username, display_name: displayName },
        capabilities: { account: true, admin: ownerTuple },
      },
    };
  } catch {
    return { status: 502, body: { ok: false, error: "entry_state_unavailable" } };
  } finally {
    clearTimeout(timer);
  }
}
