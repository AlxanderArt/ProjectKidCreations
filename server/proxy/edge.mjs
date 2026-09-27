import { ROUTES } from "./manifest.mjs";
import { handleProxy } from "./core.mjs";

export function createEdgeHandler(routeId, dependencies = {}) {
  if (!ROUTES[routeId] || ROUTES[routeId].runtime !== "edge") throw new TypeError(`invalid Edge route: ${routeId}`);
  return async function edgeProxyHandler(request) {
    return handleProxy(routeId, request, dependencies);
  };
}
