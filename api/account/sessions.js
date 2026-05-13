// Edge runtime — GET lists active sessions (Sheets read, ~2-5s); POST revokes
// a session (Sheets write + audit, ~3-8s). Both clear Edge's 25s ceiling.
// Method-multiplexed: GET → /pkc-accounts/sessions, POST → /sessions/revoke.

export const config = { runtime: "edge" };

export default async function handler(request) {
  const method = request.method;
  if (method !== "GET" && method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const authKey = process.env.PKC_AUTH_KEY;
  if (!base) return json({ error: "not_configured" }, 502);

  const upstreamPath = method === "GET"
    ? "pkc-accounts/sessions"
    : "pkc-accounts/sessions/revoke";

  let body = "";
  if (method === "POST") {
    try {
      body = await request.text();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
  }

  const cookie = request.headers.get("cookie");
  const authz = request.headers.get("authorization");
  const xff = request.headers.get("x-forwarded-for");
  const ua = request.headers.get("user-agent");

  try {
    const upstream = await fetch(`${base}/webhook/${upstreamPath}`, {
      method,
      headers: {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { "Cookie": cookie } : {}),
        ...(authz ? { "Authorization": authz } : {}),
        ...(authKey ? { "x-pkc-key": authKey } : {}),
        ...(xff ? { "x-forwarded-for": xff } : {}),
        ...(ua ? { "User-Agent": ua } : {})
      },
      ...(method === "POST" ? { body } : {})
    });

    const text = await upstream.text();
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") || "application/json"
    });
    const setCookie = typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : (upstream.headers.get("set-cookie") ? [upstream.headers.get("set-cookie")] : []);
    for (const c of setCookie) headers.append("Set-Cookie", c);
    return new Response(text, { status: upstream.status, headers });
  } catch {
    return json({ error: "upstream_unreachable" }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
