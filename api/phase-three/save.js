// Node runtime with extended maxDuration — Phase 3 Save chains several sequential Sheets
// reads + 2 appends; server-side it can hit 30-40s under retry load. Edge's 25s ceiling
// caused 504s + browser auto-retries that wrote duplicate profile rows.
export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const base = process.env.PKC_N8N_BASE_URL;
  const key = process.env.PKC_AUTH_KEY;
  if (!base) return json({ error: "not configured" }, 502);

  let body;
  try {
    body = await request.text();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  try {
    const upstream = await fetch(`${base}/webhook/pkc-phase-three/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "x-pkc-key": key } : {})
      },
      body
    });
    return passthrough(upstream);
  } catch {
    return json({ error: "upstream unreachable" }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function passthrough(upstream) {
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json"
    }
  });
}
