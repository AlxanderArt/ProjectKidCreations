// Admin proxy — POST /api/account/admin/chat
// Forwards a chat body to the n8n `pkc-accounts-agent/chat` webhook with the
// server-side x-pkc-key. LLM + tool execution can take 30+ seconds, so we
// use the Node runtime with maxDuration: 60. Defense-in-depth: verifies the
// caller's pkc_session belongs to an admin BEFORE forwarding upstream.

export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const authKey = process.env.PKC_AUTH_KEY;
  if (!base || !authKey) {
    res.status(502).json({ error: "not_configured" });
    return;
  }

  const cookie = req.headers.cookie || "";
  if (!cookie.includes("pkc_session=")) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const adminCheck = await assertAdmin(base, authKey, cookie);
  if (adminCheck !== true) {
    res.status(adminCheck.status).json(adminCheck.body);
    return;
  }

  let bodyText;
  try {
    bodyText = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  } catch {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  try {
    const upstream = await fetch(`${base}/webhook/pkc-accounts-agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pkc-key": authKey,
        ...(req.headers["x-forwarded-for"] ? { "x-forwarded-for": req.headers["x-forwarded-for"] } : {}),
        ...(req.headers["user-agent"] ? { "User-Agent": req.headers["user-agent"] } : {})
      },
      body: bodyText
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    res.send(text);
  } catch {
    res.status(502).json({ error: "upstream_unreachable" });
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
      return { status: 401, body: { error: "unauthenticated" } };
    }
    if (!r.ok) {
      return { status: 502, body: { error: "profile_check_failed" } };
    }
    const data = await r.json().catch(() => ({}));
    const profile = (data && (data.profile || data)) || {};
    if (profile.is_admin !== true) {
      return { status: 403, body: { error: "admin_required" } };
    }
    return true;
  } catch {
    return { status: 502, body: { error: "profile_check_failed" } };
  }
}
