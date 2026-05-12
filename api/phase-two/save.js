// Node runtime — Phase 2 Save now writes redeemed_at + triggers Phase 3 Email Send.
// Even with fire-and-forget on the email trigger, the Sheets update can push past 25s
// under retry load. Match Phase 3 Save's runtime config to be safe.
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
    const upstream = await fetch(`${base}/webhook/pkc-phase-two/save`, {
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
