// Admin proxy — POST /api/account/admin/list
// Forwards a filter body to the n8n `pkc-admin/accounts/list` webhook with
// the server-side x-pkc-key. Defense-in-depth: verifies the caller's
// pkc_session cookie belongs to an admin BEFORE forwarding upstream.
// Edge runtime — fast read path, no scrypt/Sheets-write latency to worry about.

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const authKey = process.env.PKC_AUTH_KEY;
  if (!base || !authKey) {
    return json({ error: "not_configured" }, 502);
  }

  const cookie = req.headers.get("cookie") || "";
  if (!cookie.includes("pkc_session=")) {
    return json({ error: "unauthenticated" }, 401);
  }

  // Defense-in-depth: confirm the caller is an admin via upstream profile.
  const ok = await assertAdmin(base, authKey, cookie);
  if (ok !== true) return ok; // ok is a Response on failure

  let bodyText = "";
  try {
    bodyText = await req.text();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  try {
    const upstream = await fetch(`${base}/webhook/pkc-admin/accounts/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pkc-key": authKey,
        ...(req.headers.get("x-forwarded-for") ? { "x-forwarded-for": req.headers.get("x-forwarded-for") } : {}),
        ...(req.headers.get("user-agent") ? { "User-Agent": req.headers.get("user-agent") } : {})
      },
      body: bodyText || "{}"
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502);
  }
}

async function assertAdmin(base, authKey, cookie) {
  try {
    const r = await fetch(`${base}/webhook/pkc-accounts/profile`, {
      method: "GET",
      headers: {
        "Cookie": cookie,
        "x-pkc-key": authKey,
        "Accept": "application/json"
      }
    });
    if (r.status === 401 || r.status === 403) {
      return json({ error: "unauthenticated" }, 401);
    }
    if (!r.ok) {
      return json({ error: "profile_check_failed" }, 502);
    }
    const data = await r.json().catch(() => ({}));
    const profile = (data && (data.profile || data)) || {};
    if (profile.is_admin !== true) {
      return json({ error: "admin_required" }, 403);
    }
    return true;
  } catch {
    return json({ error: "profile_check_failed" }, 502);
  }
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
