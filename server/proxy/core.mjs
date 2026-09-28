import { ROUTES } from "./manifest.mjs";

const JSON_TYPE = "application/json; charset=utf-8";
const SECURITY_HEADERS = Object.freeze({
  "Content-Type": JSON_TYPE,
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
});
const SESSION_MAX_BYTES = 4096;
const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const ADMIN_TIMEOUT_MS = 5_000;
const OWNER_USERNAME = "PK Blick";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const utf8Size = (value) => new TextEncoder().encode(value).byteLength;

function response(body, status = 200, additions = {}) {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...additions } });
}

export function jsonError(error, status, additions = {}) {
  return response(JSON.stringify({ error }), status, additions);
}

function exactOriginList(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("missing origin list");
  const values = raw.split(",").map((part) => part.trim());
  if (values.some((value) => !value)) throw new Error("invalid origin list");
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) {
      throw new Error("invalid origin");
    }
    return url.origin;
  }));
}

function configuration(env) {
  const required = ["PKC_N8N_BASE_URL", "PKC_AUTH_KEY", "PKC_N8N_ALLOWED_ORIGINS", "PKC_PUBLIC_ALLOWED_ORIGINS", "PKC_FOUNDER_SUBJECT"];
  for (const key of required) if (typeof env?.[key] !== "string" || env[key].trim() === "") throw new Error(`missing ${key}`);
  const upstreamOrigins = exactOriginList(env.PKC_N8N_ALLOWED_ORIGINS);
  const publicOrigins = exactOriginList(env.PKC_PUBLIC_ALLOWED_ORIGINS);
  const base = new URL(env.PKC_N8N_BASE_URL.trim());
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("invalid base URL");
  if (!upstreamOrigins.has(base.origin)) throw new Error("base origin denied");
  const founderSubject = env.PKC_FOUNDER_SUBJECT;
  if (!UUID_RE.test(founderSubject)) throw new Error("invalid PKC_FOUNDER_SUBJECT");
  return { base: base.origin, authKey: env.PKC_AUTH_KEY.trim(), publicOrigins, founderSubject };
}

async function readStreamLimited(stream, limit) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("payload_too_large").catch(() => {});
        const error = new Error("payload_too_large");
        error.code = "LIMIT";
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const error = new Error("invalid_utf8");
    error.code = "UTF8";
    throw error;
  }
}

function requireString(value, name, min = 1, max = 4096) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`invalid_${name}`);
}

function optionalString(value, name, max = 4096) {
  if (value !== undefined) requireString(value, name, 0, max);
}

function validateRouteBody(routeId, method, body) {
  const token = () => requireString(body.token, "token", 1, 4096);
  switch (routeId) {
    case "onboarding":
      requireString(body.submissionId, "submission_id", 1, 128);
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new Error("invalid_data");
      optionalString(body.version, "version", 32);
      optionalString(body.timestamp, "timestamp", 64);
      optionalString(body.env, "env", 32);
      optionalString(body.mode, "mode", 32);
      optionalString(body.hash, "hash", 256);
      break;
    case "phaseTwoVerify":
    case "phaseTwoSave":
    case "phaseThreeVerify":
      token();
      break;
    case "phaseTwoEvent":
    case "phaseThreeEvent":
      requireString(body.event_type, "event_type", 1, 64);
      optionalString(body.submissionId, "submission_id", 128);
      if (body.data !== undefined && (!body.data || typeof body.data !== "object" || Array.isArray(body.data))) throw new Error("invalid_data");
      break;
    case "phaseThreeCheckUsername":
      token();
      requireString(body.username, "username", 3, 32);
      break;
    case "phaseThreeSave":
      token();
      if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) throw new Error("invalid_profile");
      break;
    case "accountLogin":
      requireString(body.username, "username", 3, 64);
      requireString(body.password, "password", 8, 256);
      optionalString(body.login_attempt_id, "login_attempt_id", 36);
      if (body.login_attempt_id !== undefined
        && (body.login_attempt_id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.login_attempt_id))) {
        throw new Error("invalid_login_attempt_id");
      }
      break;
    case "accountBootstrap":
      requireString(body.activation_proof, "activation_proof", 20, 8192);
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(body.activation_proof)) {
        throw new Error("invalid_activation_proof");
      }
      break;
    case "accountBootstrapRedeem":
      token();
      requireString(body.username, "username", 3, 64);
      requireString(body.password, "password", 12, 256);
      break;
    case "accountPasswordRequest":
      requireString(body.email, "email", 3, 320);
      break;
    case "accountPasswordComplete":
      token();
      requireString(body.new_password, "new_password", 12, 256);
      break;
    case "accountPasswordChange":
      requireString(body.current_password, "current_password", 1, 256);
      requireString(body.new_password, "new_password", 12, 256);
      break;
    case "accountEmailChange":
      requireString(body.current_password, "current_password", 1, 256);
      requireString(body.new_email, "new_email", 3, 320);
      break;
    case "accountDelete":
      requireString(body.current_password, "current_password", 1, 256);
      if (body.i_am_sure !== true) throw new Error("confirmation_required");
      break;
    case "accountSessions":
      if (method === "POST") requireString(body.session_id, "session_id", 1, 256);
      break;
    case "accountProfile":
      if (method === "PATCH" && Object.keys(body).length === 0) throw new Error("empty_profile_patch");
      optionalString(body.display_name, "display_name", 80);
      optionalString(body.first_name, "first_name", 80);
      optionalString(body.last_name, "last_name", 80);
      optionalString(body.pronouns, "pronouns", 40);
      optionalString(body.bio, "bio", 2000);
      if (body.notif_marketing !== undefined && typeof body.notif_marketing !== "boolean") throw new Error("invalid_notif_marketing");
      break;
    case "accountAdminList":
      for (const key of ["offset", "limit"]) if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 1000)) throw new Error(`invalid_${key}`);
      optionalString(body.sort_by, "sort_by", 64);
      optionalString(body.sort_dir, "sort_dir", 8);
      optionalString(body.status, "status", 64);
      break;
    case "accountAdminSearch":
      optionalString(body.q, "q", 256);
      optionalString(body.status, "status", 64);
      optionalString(body.lockout_tier, "lockout_tier", 64);
      optionalString(body.last_login_before, "last_login_before", 64);
      break;
    case "accountAdminChat":
      requireString(body.message, "message", 1, 16_000);
      optionalString(body.sessionId, "session_id", 256);
      break;
    case "accountLogout":
    case "accountActivity":
      break;
    default:
      throw new Error("unknown_route_schema");
  }
}

function validateJsonBody(text, routeId, route, method) {
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw new Error("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json_object");
  const allowed = new Set(route.allowedFields[method] || []);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) throw new Error("unknown_field");
  try {
    if (route === ROUTES.phaseThreeSave && parsed.profile !== undefined) {
      validateNestedObject(parsed.profile, ["display_name", "username", "avatar_url", "bio", "skill_level", "blasters_owned", "accessory_interests", "email_drops", "age_confirmed", "terms_accepted"]);
      if (parsed.profile.age_confirmed !== true || parsed.profile.terms_accepted !== true) throw new Error("consent_required");
      if (parsed.profile.email_drops !== undefined && typeof parsed.profile.email_drops !== "boolean") throw new Error("invalid_marketing_choice");
    }
    validateRouteBody(routeId, method, parsed);
  } catch (error) {
    error.code = "VALIDATION";
    throw error;
  }
  return parsed;
}

function validateNestedObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_nested_object");
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("unknown_nested_field");
}

function invalidActivationProof() {
  const error = new Error("invalid_activation_proof");
  error.code = "VALIDATION";
  return error;
}

function decodeBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw invalidActivationProof();
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function validateActivationProof(proof, authKey) {
  const [payload, signature] = proof.split(".");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("crypto_unavailable");
  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(authKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await subtle.verify("HMAC", key, decodeBase64Url(signature), encoder.encode(payload));
  if (!valid) throw invalidActivationProof();
  let claims;
  try {
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(payload)));
  } catch {
    throw invalidActivationProof();
  }
  const now = Date.now();
  if (!claims || claims.v !== 1
    || !Number.isFinite(claims.issued_at_ms)
    || !Number.isFinite(claims.expires_at_ms)
    || claims.issued_at_ms > now + 60_000
    || claims.expires_at_ms < now
    || claims.expires_at_ms > now + (31 * 60 * 1000)
    || typeof claims.submission_id !== "string" || !claims.submission_id.trim()
    || typeof claims.username !== "string" || !/^[a-z0-9_.-]{3,32}$/.test(claims.username)
    || typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
    || /^pk blick$/i.test(claims.username)) {
    throw invalidActivationProof();
  }
}

function sessionCookie(header) {
  if (!header) return null;
  const values = [];
  for (const segment of String(header).split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    if (trimmed.slice(0, separator).trim() === "pkc_session") values.push(trimmed.slice(separator + 1));
  }
  if (values.length === 0) return null;
  if (values.length !== 1) throw new Error("invalid_session_cookie");
  const value = values[0];
  if (utf8Size(value) > SESSION_MAX_BYTES || !COOKIE_VALUE_RE.test(value)) throw new Error("invalid_session_cookie");
  return `pkc_session=${value}`;
}

function upstreamPath(route, method) {
  return typeof route.upstream === "string" ? route.upstream : route.upstream[method];
}

function querySuffix(route, requestUrl) {
  const source = new URL(requestUrl).searchParams;
  const allowed = new Set(route.query);
  for (const key of source.keys()) if (!allowed.has(key)) throw new Error("invalid_query");
  for (const key of allowed) if (source.getAll(key).length > 1) throw new Error("invalid_query");
  const output = new URLSearchParams();
  for (const key of route.query) if (source.has(key)) output.set(key, source.get(key));
  const text = output.toString();
  return text ? `?${text}` : "";
}

async function timedOperation(run, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("operation_timeout");
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(error) {
  return error?.code === "TIMEOUT" || error?.name === "AbortError";
}

async function validatedUpstream(responseValue, limit) {
  const contentType = responseValue.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error("invalid_upstream_type");
  const declared = Number(responseValue.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("upstream_too_large");
  const text = await readStreamLimited(responseValue.body, limit);
  JSON.parse(text);
  return text;
}

function sanitizedSetCookie(raw) {
  if (!raw) return null;
  if (/[\r\n]/.test(raw) || /(?:^|;)\s*Domain\s*=/i.test(raw) || /,\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=/.test(raw)) return null;
  const first = /^\s*pkc_session=([^;,\r\n]*)/.exec(raw);
  if (!first || !COOKIE_VALUE_RE.test(first[1]) || utf8Size(first[1]) > SESSION_MAX_BYTES) return null;
  let output = `pkc_session=${first[1]}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  const maxAge = /(?:^|;)\s*Max-Age\s*=\s*(0)(?:;|$)/i.exec(raw);
  if (maxAge) output += "; Max-Age=0";
  const expires = /(?:^|;)\s*Expires\s*=\s*([^;\r\n]+)/i.exec(raw);
  if (maxAge && expires && !/[\r\n]/.test(expires[1])) output += `; Expires=${expires[1].trim()}`;
  return output;
}

async function assertFounderPolicy(config, cookie, dependencies, { adminOnly, requireRecent }) {
  if (!cookie) return jsonError("unauthenticated", 401);
  let checked;
  try {
    checked = await timedOperation(async (signal) => {
      const upstream = await dependencies.fetch(`${config.base}/webhook/pkc-accounts/profile`, {
        method: "GET",
        headers: { Accept: "application/json", Cookie: cookie, "x-pkc-key": config.authKey },
        signal,
      });
      if (upstream.status === 401 || upstream.status === 403) return { denied: true };
      if (!upstream.ok) throw new Error("profile_check_failed");
      const text = await validatedUpstream(upstream, 256 * 1024);
      return { data: JSON.parse(text) };
    }, dependencies.adminTimeoutMs);
  } catch (error) {
    return jsonError(isTimeout(error) ? "profile_check_timeout" : "profile_check_failed", isTimeout(error) ? 504 : 502);
  }
  if (checked.denied) return jsonError("unauthenticated", 401);
  const profile = checked.data?.profile || checked.data;
  const subjectMatch = profile?.account_id === config.founderSubject;
  const usernameMatch = profile?.username === OWNER_USERNAME;
  const adminMatch = profile?.is_admin === true;
  const isFounder = subjectMatch && usernameMatch && adminMatch;
  const hasFounderSignal = subjectMatch || usernameMatch || adminMatch;
  if (!isFounder) return (adminOnly || hasFounderSignal) ? jsonError("admin_required", 403) : true;

  const assurance = profile?.founder_assurance;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const amr = Array.isArray(assurance?.amr) ? assurance.amr : [];
  let authority;
  try {
    if (typeof dependencies.founderAuthority !== "function") throw new Error("founder_authority_unavailable");
    authority = await timedOperation(
      () => dependencies.founderAuthority(config.founderSubject),
      dependencies.adminTimeoutMs,
    );
  } catch (error) {
    return jsonError(isTimeout(error) ? "founder_authority_timeout" : "founder_authority_failed", isTimeout(error) ? 504 : 503);
  }
  const hasFreshFounderMfa = authority?.founderSubject === config.founderSubject
    && authority?.state === "active"
    && Number.isSafeInteger(authority?.authEpoch)
    && authority.authEpoch >= 1
    && Number.isSafeInteger(assurance?.auth_epoch)
    && assurance.auth_epoch === authority.authEpoch
    && amr.length === 2
    && amr.includes("pwd")
    && amr.includes("otp")
    && Number.isSafeInteger(assurance?.mfa_verified_at)
    && assurance.mfa_verified_at <= nowSeconds + 5
    && (!requireRecent || assurance.mfa_verified_at >= nowSeconds - 900);
  return hasFreshFounderMfa
    ? true
    : jsonError(adminOnly ? "admin_required" : requireRecent ? "recent_mfa_required" : "founder_session_invalid", 403);
}

export async function handleProxy(routeId, request, options = {}) {
  const route = ROUTES[routeId];
  if (!route) return jsonError("route_not_found", 404);
  const method = String(request.method || "GET").toUpperCase();
  if (!route.methods.includes(method)) return jsonError("method_not_allowed", 405, { Allow: route.methods.join(", ") });

  let config;
  try {
    config = configuration(options.env || process.env);
  } catch {
    return jsonError("not_configured", 503);
  }

  if (!["GET", "HEAD"].includes(method)) {
    const origin = request.headers.get("origin");
    if (!origin || origin === "null" || !config.publicOrigins.has(origin)) return jsonError("origin_forbidden", 403);
    if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return jsonError("origin_forbidden", 403);
  }

  let cookie = null;
  if (route.session) {
    try {
      cookie = sessionCookie(request.headers.get("cookie"));
    } catch {
      return jsonError("invalid_session_cookie", 400);
    }
  }

  let bodyText;
  if (!["GET", "HEAD"].includes(method)) {
    const contentType = request.headers.get("content-type") || "";
    const bodylessLogout = routeId === "accountLogout" && !request.body && !contentType;
    if (!bodylessLogout && !/^application\/json(?:\s*;|$)/i.test(contentType)) return jsonError("unsupported_media_type", 415);
    try {
      bodyText = bodylessLogout ? "{}" : await readStreamLimited(request.body, route.bodyLimit);
      const parsed = validateJsonBody(bodyText, routeId, route, method);
      if (routeId === "accountBootstrap") await validateActivationProof(parsed.activation_proof, config.authKey);
      if (routeId === "phaseThreeSave") parsed.profile.privacy_contract_version = "2026-09-26";
      bodyText = JSON.stringify(parsed);
    } catch (error) {
      const status = error?.code === "LIMIT" ? 413 : error?.code === "VALIDATION" ? 422 : 400;
      return jsonError(error?.code === "LIMIT" ? "payload_too_large" : "invalid_body", status);
    }
  }

  let suffix = "";
  if (route.query.length) {
    try {
      suffix = querySuffix(route, request.url);
    } catch {
      return jsonError("invalid_query", 400);
    }
  }

  const dependencies = {
    fetch: options.fetch || globalThis.fetch,
    founderAuthority: options.founderAuthority,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    adminTimeoutMs: options.adminTimeoutMs || ADMIN_TIMEOUT_MS,
  };
  const requiresFounderPolicy = route.admin || route.founderSensitiveMethods.includes(method)
    || (route.session && routeId !== "accountLogout");
  if (requiresFounderPolicy) {
    const requireRecent = route.admin || route.founderSensitiveMethods.includes(method);
    const check = await assertFounderPolicy(config, cookie, dependencies, { adminOnly: route.admin, requireRecent });
    if (check !== true) return check;
  }

  const headers = { Accept: "application/json", "x-pkc-key": config.authKey };
  if (bodyText !== undefined) headers["Content-Type"] = JSON_TYPE;
  if (cookie && !route.admin) headers.Cookie = cookie;
  const init = { method, headers };
  if (bodyText !== undefined) init.body = bodyText;

  let result;
  try {
    result = await timedOperation(async (signal) => {
      const upstream = await dependencies.fetch(`${config.base}${upstreamPath(route, method)}${suffix}`, { ...init, signal });
      const text = await validatedUpstream(upstream, route.responseLimit);
      return { upstream, text };
    }, dependencies.timeoutMs);
  } catch (error) {
    if (isTimeout(error)) return jsonError("upstream_timeout", 504);
    const invalidResponse = ["invalid_upstream_type", "upstream_too_large", "payload_too_large", "invalid_utf8", "Unexpected end of JSON input"].some((message) => String(error?.message).includes(message))
      || error instanceof SyntaxError
      || error?.code === "LIMIT"
      || error?.code === "UTF8";
    return jsonError(invalidResponse ? "invalid_upstream_response" : "upstream_unreachable", 502);
  }
  const { upstream, text } = result;
  if (typeof options.transformUpstream === "function") {
    let transformed;
    try {
      transformed = await options.transformUpstream({ upstream, data: JSON.parse(text) });
    } catch {
      return jsonError("invalid_upstream_response", 502);
    }
    if (transformed instanceof Response) return transformed;
    if (transformed !== null && transformed !== undefined) return jsonError("invalid_upstream_response", 502);
  }
  const additions = {};
  if (route.setCookie) {
    const rawCookie = upstream.headers.get("set-cookie");
    if (rawCookie) {
      const cookieHeader = sanitizedSetCookie(rawCookie);
      if (!cookieHeader) return jsonError("invalid_upstream_cookie", 502);
      additions["Set-Cookie"] = cookieHeader;
    }
  }
  return response(text, upstream.status, additions);
}
