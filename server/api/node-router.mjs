import { createFounderLoginUpstreamTransform } from "../mfa/login-integration.mjs";
import { mfaJson } from "../mfa/http.mjs";
import { createNodeHandler } from "../proxy/node.mjs";
import { ROUTES } from "../proxy/manifest.mjs";
import { createEntryStateHandler } from "./entry-state.mjs";

const MFA_PATHS = Object.freeze({
  "/api/account/mfa-enrollment": "enrollment",
  "/api/account/mfa-verify": "verify",
  "/api/account/mfa-recovery": "recovery",
  "/api/account/mfa-finalize": "finalize",
});

function exactPath(requestTarget) {
  if (typeof requestTarget !== "string" || !requestTarget.startsWith("/") || requestTarget.startsWith("//") || requestTarget.includes("#")) return null;
  const queryIndex = requestTarget.indexOf("?");
  const path = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  if (!path) return null;
  return path;
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
}

export function createNodeRouter(options = {}) {
  const mfaModuleLoader = options.mfaModuleLoader || (() => import("../mfa/routes.mjs"));
  let mfaModulePromise;
  const loadMfaModule = () => {
    mfaModulePromise ||= Promise.resolve().then(mfaModuleLoader);
    return mfaModulePromise;
  };
  const proxyHandlerFactory = options.proxyHandlerFactory || ((routeId) => {
    const dependencies = { ...options.proxyDependencies };
    if (routeId === "accountLogin") {
      dependencies.transformUpstream = createFounderLoginUpstreamTransform({
        beginFounderMfa: async (handoff) => {
          const module = await loadMfaModule();
          if (typeof module.beginTrustedFounderMfa !== "function") throw new TypeError("invalid_mfa_module");
          return module.beginTrustedFounderMfa(handoff);
        },
      });
    }
    return createNodeHandler(routeId, dependencies);
  });
  const mfaHandlerFactory = options.mfaHandlerFactory || ((routeName) => {
    let handlerPromise;
    return async (req, res) => {
      let handler;
      try {
        handlerPromise ||= loadMfaModule().then((module) => {
          if (typeof module.createNodeMfaHandler !== "function") throw new TypeError("invalid_mfa_module");
          return module.createNodeMfaHandler(routeName, options.mfaDependencies);
        });
        handler = await handlerPromise;
      } catch {
        const response = mfaJson({ status: "mfa_failed" }, 401);
        res.statusCode = response.status;
        for (const [name, value] of response.headers) res.setHeader(name, value);
        return res.end(Buffer.from(await response.arrayBuffer()));
      }
      return handler(req, res);
    };
  });
  const entryStateHandler = options.entryStateHandler || createEntryStateHandler(options.entryStateDependencies);
  const handlers = new Map();

  for (const [routeId, route] of Object.entries(ROUTES)) {
    if (route.runtime !== "nodejs") continue;
    if (handlers.has(route.publicPath)) throw new TypeError(`duplicate Node route: ${route.publicPath}`);
    handlers.set(route.publicPath, proxyHandlerFactory(routeId));
  }
  for (const [path, routeName] of Object.entries(MFA_PATHS)) handlers.set(path, mfaHandlerFactory(routeName));
  handlers.set("/api/account/entry-state", entryStateHandler);

  if (handlers.size !== 20) throw new TypeError("invalid Node route inventory");

  return async function nodeRouter(req, res) {
    const handler = handlers.get(exactPath(req.url));
    if (!handler) return notFound(res);
    return handler(req, res);
  };
}
