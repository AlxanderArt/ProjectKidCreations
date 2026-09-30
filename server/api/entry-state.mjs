import { resolveEntryState } from "../auth/entry-state.mjs";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

export function createEntryStateHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  return async function entryStateHandler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { ok: false, error: "method_not_allowed" });
    }
    const result = await resolveEntryState({
      cookieHeader: req.headers?.cookie,
      env,
      fetchImpl,
    });
    return json(res, result.status, result.body);
  };
}
