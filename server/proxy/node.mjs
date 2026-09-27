import { ROUTES } from "./manifest.mjs";
import { handleProxy, jsonError, utf8Size } from "./core.mjs";

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    const selected = firstHeader(value);
    if (selected != null) headers.set(name, String(selected));
  }
  return headers;
}

function serializedBody(req) {
  if (req.body === undefined || req.body === null) return "";
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return JSON.stringify(req.body);
}

function writeNodeResponse(res, response) {
  res.status(response.status);
  for (const [name, value] of response.headers) res.setHeader(name, value);
  return response.text().then((text) => res.send(text));
}

export function createNodeHandler(routeId, dependencies = {}) {
  const route = ROUTES[routeId];
  if (!route || route.runtime !== "nodejs") throw new TypeError(`invalid Node route: ${routeId}`);
  return async function nodeProxyHandler(req, res) {
    let text = "";
    try {
      text = serializedBody(req);
    } catch {
      return writeNodeResponse(res, jsonError("invalid_body", 400));
    }
    if (utf8Size(text) > route.bodyLimit) return writeNodeResponse(res, jsonError("payload_too_large", 413));
    const headers = requestHeaders(req);
    const proto = firstHeader(req.headers?.["x-forwarded-proto"]) === "http" ? "http" : "https";
    const host = firstHeader(req.headers?.host) || "localhost";
    const url = new URL(req.url || "/", `${proto}://${host}`).toString();
    let webRequest;
    try {
      webRequest = new Request(url, {
        method: req.method || "GET",
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : text,
      });
    } catch {
      return writeNodeResponse(res, jsonError("invalid_request", 400));
    }
    const response = await handleProxy(routeId, webRequest, dependencies);
    return writeNodeResponse(res, response);
  };
}
