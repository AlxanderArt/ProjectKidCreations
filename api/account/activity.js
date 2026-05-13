// Edge runtime — activity is a lightweight Sheets read of the audit log
// scoped to the current user. Edge's 25s ceiling is plenty here.
// Cookie in (auth required); Set-Cookie forwarded for parity.

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const authKey = process.env.PKC_AUTH_KEY;
  if (!base) return json({ error: "not_configured" }, 502);

  const cookie = request.headers.get("cookie");
  const authz = request.headers.get("authorization");
  const xff = request.headers.get("x-forwarded-for");
  const ua = request.headers.get("user-agent");

  // Preserve query string (e.g. ?limit=50&cursor=...)
  const inboundUrl = new URL(request.url);
  const qs = inboundUrl.search || "";

  try {
    const upstream = await fetch(`${base}/webhook/pkc-accounts/activity${qs}`, {
      method: "GET",
      headers: {
        ...(cookie ? { "Cookie": cookie } : {}),
        ...(authz ? { "Authorization": authz } : {}),
        ...(authKey ? { "x-pkc-key": authKey } : {}),
        ...(xff ? { "x-forwarded-for": xff } : {}),
        ...(ua ? { "User-Agent": ua } : {})
      }
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
