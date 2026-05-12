// Node runtime — Phase 3 Save chains sequential Sheets reads + 2 appends;
// observed at 39.6s server-side. Edge's 25s ceiling caused 504s + browser
// auto-retries (idempotency caught the dupes but still wrote events). Node = 60s.
//
// Uses Node-style (req, res) handler — NOT the Web Request/Response API used
// by the Edge proxies. Vercel's nodejs runtime auto-parses JSON request bodies
// into req.body when Content-Type is application/json.

export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const key = process.env.PKC_AUTH_KEY;
  if (!base) {
    res.status(502).json({ error: "not configured" });
    return;
  }

  let bodyText;
  try {
    bodyText = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  } catch {
    res.status(400).json({ error: "invalid body" });
    return;
  }

  try {
    const upstream = await fetch(`${base}/webhook/pkc-phase-three/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "x-pkc-key": key } : {})
      },
      body: bodyText
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("Content-Type") || "application/json"
    );
    res.send(text);
  } catch {
    res.status(502).json({ error: "upstream unreachable" });
  }
}
