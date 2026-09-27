import pg from "pg";

import { loadMfaConfig } from "./config.mjs";
import { mfaJson, parseMfaCookie, serializeMfaCookie, validateMfaMutationRequest } from "./http.mjs";
import { createFounderMfaService, isSafeFounderSessionCookie } from "./service.mjs";
import { createFounderMfaStore } from "./store.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMAS = Object.freeze({
  enrollment: { allowedFields: ["csrf"], requiredFields: ["csrf"] },
  verify: { allowedFields: ["csrf", "code"], requiredFields: ["csrf", "code"] },
  recovery: { allowedFields: ["csrf", "code"], requiredFields: ["csrf", "code"] },
  finalize: { allowedFields: ["csrf", "finalizeId"], requiredFields: ["csrf", "finalizeId"] },
});

function configurationFailure(error) {
  return /^(missing|invalid) PKC_|key_reuse|invalid_mfa_config|invalid_pg_pool/.test(String(error?.message || ""));
}

async function validateStart(request, publicOrigins) {
  if (request.method !== "POST") throw new Error("method_not_allowed");
  const origin = request.headers.get("origin");
  if (!origin || !publicOrigins.has(origin) || request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") throw new Error("origin_forbidden");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("unsupported_media_type");
  const text = await request.text();
  if (Buffer.byteLength(text) > 4096) throw new Error("payload_too_large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.handoff !== "string") {
    throw new Error("invalid_handoff");
  }
  return body;
}

export function createFounderMfaRoutes({ serviceFactory, publicOrigins }) {
  if (typeof serviceFactory !== "function") throw new TypeError("invalid_service_factory");
  if (!(publicOrigins instanceof Set)) throw new TypeError("invalid_public_origins");

  async function serviceOrResponse() {
    try {
      return { service: await serviceFactory() };
    } catch (error) {
      return { response: mfaJson({ status: configurationFailure(error) ? "not_configured" : "mfa_failed" }, configurationFailure(error) ? 503 : 401) };
    }
  }

  async function start(request) {
    const loaded = await serviceOrResponse();
    if (loaded.response) return loaded.response;
    try {
      const body = await validateStart(request, publicOrigins);
      const result = await loaded.service.beginFromSignedHandoff(body.handoff);
      return mfaJson(
        { status: "mfa_required", csrf: result.csrf },
        200,
        { "Set-Cookie": serializeMfaCookie(result.token, result.maxAgeSeconds) },
      );
    } catch {
      return mfaJson({ status: "mfa_failed" }, 401);
    }
  }

  function mutation(name, operation) {
    return async (request) => {
      const loaded = await serviceOrResponse();
      if (loaded.response) return loaded.response;
      try {
        const body = await validateMfaMutationRequest(request, publicOrigins, SCHEMAS[name]);
        const token = parseMfaCookie(request.headers.get("cookie"));
        if (!token) throw new Error("missing_mfa_cookie");
        const result = await operation(loaded.service, token, body);
        if (name === "finalize") {
          if (result.status === "unknown") return mfaJson({ status: "unknown" }, 202);
          if (result.status !== "authenticated" || !isSafeFounderSessionCookie(result.setCookie)) {
            throw new Error("invalid_finalizer_receipt");
          }
          return mfaJson({ status: "authenticated" }, 200, { "Set-Cookie": result.setCookie });
        }
        return mfaJson(result);
      } catch {
        return mfaJson({ status: "mfa_failed" }, 401);
      }
    };
  }

  return Object.freeze({
    start,
    enrollment: mutation("enrollment", (service, token, body) => service.discloseEnrollment({ token, csrf: body.csrf })),
    verify: mutation("verify", (service, token, body) => service.verifyTotp({ token, csrf: body.csrf, code: body.code })),
    recovery: mutation("recovery", (service, token, body) => service.useRecoveryCode({ token, csrf: body.csrf, code: body.code })),
    finalize: mutation("finalize", (service, token, body) => {
      if (!UUID_RE.test(body.finalizeId)) throw new Error("invalid_finalize_id");
      return service.finalize({ token, csrf: body.csrf, finalizeId: body.finalizeId });
    }),
  });
}

let runtime;

async function runtimeContext(env = process.env, fetchImpl = fetch) {
  if (runtime) return runtime;
  const config = loadMfaConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  const store = createFounderMfaStore({ pool });
  const service = createFounderMfaService({
    store,
    config,
    finalizer: async ({ grant }) => {
      const response = await fetchImpl(`${config.n8nBaseUrl}/webhook/pkc-internal-founder-mfa-finalize`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-pkc-key": config.authKey,
        },
        body: JSON.stringify({ grant }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { status: "unknown" };
      const receipt = await response.json();
      if (!receipt?.ok || receipt.status !== "authenticated" || typeof receipt.session_token !== "string") return { status: "unknown" };
      const maxAge = Number(receipt.expires_at) - Number(receipt.issued_at);
      if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 86_400) return { status: "unknown" };
      return {
        status: "ok",
        finalizeId: receipt.finalize_id,
        sessionId: receipt.session_id,
        grantJti: receipt.grant_jti,
        setCookie: `pkc_session=${receipt.session_token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
      };
    },
  });
  const routes = createFounderMfaRoutes({ serviceFactory: async () => service, publicOrigins: config.publicOrigins });
  runtime = Object.freeze({ config, store, service, routes });
  return runtime;
}

async function runtimeRoutes(env = process.env, fetchImpl = fetch) {
  return (await runtimeContext(env, fetchImpl)).routes;
}

export async function beginTrustedFounderMfa(handoff, dependencies = {}) {
  const context = await runtimeContext(dependencies.env, dependencies.fetch);
  return context.service.beginFromSignedHandoff(handoff);
}

export async function getFounderMfaAuthority(founderSubject, dependencies = {}) {
  const context = await runtimeContext(dependencies.env, dependencies.fetch);
  return context.store.readFactorAuthority(founderSubject);
}

function requestFromNode(req) {
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  const host = req.headers?.host || "projectkidcreations.invalid";
  const url = new URL(req.url || "/", `${proto}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, String(value));
  }
  let body;
  if (req.body !== undefined) body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  else body = req;
  return new Request(url, { method: req.method, headers, body, duplex: "half" });
}

export function createNodeMfaHandler(routeName, dependencies = {}) {
  if (!["start", "enrollment", "verify", "recovery", "finalize"].includes(routeName)) throw new TypeError("invalid_mfa_route");
  return async function handler(req, res) {
    let response;
    try {
      const routes = dependencies.routes || await runtimeRoutes(dependencies.env, dependencies.fetch);
      response = await routes[routeName](requestFromNode(req));
    } catch (error) {
      response = mfaJson({ status: configurationFailure(error) ? "not_configured" : "mfa_failed" }, configurationFailure(error) ? 503 : 401);
    }
    res.statusCode = response.status;
    for (const [name, value] of response.headers) res.setHeader(name, value);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
