import { jsonError } from "../proxy/core.mjs";
import { mfaJson, serializeMfaCookie } from "./http.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MFA_FIELDS = Object.freeze(["handoff", "login_attempt_id", "ok", "request_id", "status"]);

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidUpstream() {
  return jsonError("invalid_upstream_response", 502);
}

function configurationFailure(error) {
  return /^(missing|invalid) PKC_|key_reuse|invalid_mfa_config|invalid_pg_pool/.test(String(error?.message || ""));
}

export function createFounderLoginUpstreamTransform({ beginFounderMfa }) {
  if (typeof beginFounderMfa !== "function") throw new TypeError("invalid_founder_mfa_begin");
  return async function transform({ upstream, data }) {
    const hasHandoff = Boolean(data && typeof data === "object" && Object.hasOwn(data, "handoff"));
    if (data?.status !== "mfa_required") return hasHandoff ? invalidUpstream() : null;
    if (upstream.status !== 200
      || upstream.headers.get("set-cookie")
      || !exactKeys(data, MFA_FIELDS)
      || data.ok !== true
      || typeof data.request_id !== "string" || data.request_id.length < 1 || data.request_id.length > 256
      || !UUID_RE.test(data.login_attempt_id)
      || typeof data.handoff !== "string" || data.handoff.length < 32 || data.handoff.length > 8192) {
      return invalidUpstream();
    }
    try {
      const result = await beginFounderMfa(data.handoff);
      if (result?.status !== "mfa_required"
        || !["enroll", "verify"].includes(result.mode)
        || !TOKEN_RE.test(result.token)
        || !TOKEN_RE.test(result.csrf)
        || !Number.isSafeInteger(result.maxAgeSeconds)
        || result.maxAgeSeconds < 1
        || result.maxAgeSeconds > 300) return invalidUpstream();
      return mfaJson(
        { ok: true, status: "mfa_required", mode: result.mode, csrf: result.csrf },
        200,
        { "Set-Cookie": serializeMfaCookie(result.token, result.maxAgeSeconds) },
      );
    } catch (error) {
      return mfaJson(
        { status: configurationFailure(error) ? "not_configured" : "mfa_failed" },
        configurationFailure(error) ? 503 : 401,
      );
    }
  };
}
