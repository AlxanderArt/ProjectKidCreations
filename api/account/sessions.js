// Node runtime — GET lists active sessions (Sheets read); POST revokes a
// specified session (Sheets write + audit). Two upstream paths fan out from
// req.method. Node 60s for Sheets jitter.

export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const authKey = process.env.PKC_AUTH_KEY;
  if (!base) {
    res.status(502).json({ error: "not_configured" });
    return;
  }

  const upstreamPath = req.method === "GET"
    ? "pkc-accounts/sessions"
    : "pkc-accounts/sessions/revoke";

  let bodyText;
  if (req.method === "POST") {
    try {
      bodyText = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    } catch {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
  }

  try {
    const upstream = await fetch(`${base}/webhook/${upstreamPath}`, {
      method: req.method,
      headers: {
        ...(req.method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(req.headers.cookie ? { "Cookie": req.headers.cookie } : {}),
        ...(req.headers.authorization ? { "Authorization": req.headers.authorization } : {}),
        ...(authKey ? { "x-pkc-key": authKey } : {}),
        ...(req.headers["x-forwarded-for"] ? { "x-forwarded-for": req.headers["x-forwarded-for"] } : {}),
        ...(req.headers["user-agent"] ? { "User-Agent": req.headers["user-agent"] } : {})
      },
      ...(req.method === "POST" ? { body: bodyText } : {})
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    const setCookie = upstream.headers.get("set-cookie");
    if (setCookie) res.setHeader("Set-Cookie", setCookie);
    res.send(text);
  } catch {
    res.status(502).json({ error: "upstream_unreachable" });
  }
}
