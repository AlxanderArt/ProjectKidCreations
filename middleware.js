import { next } from "@vercel/functions";
import { isProtectedBrowsePath } from "./server/auth/browse-paths.mjs";
import { resolveEntryState } from "./server/auth/entry-state.mjs";

const PRIVATE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Vary: "Cookie",
});

export const config = {
  runtime: "nodejs",
  matcher: [
    "/((?!api/).*)",
  ],
};

export function createBrowseGateMiddleware(dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const nextImpl = dependencies.next || next;

  return async function browseGateMiddleware(request) {
    if (!isProtectedBrowsePath(new URL(request.url).pathname)) {
      return nextImpl();
    }
    const method = String(request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { ...PRIVATE_HEADERS, Allow: "GET, HEAD" },
      });
    }

    const result = await resolveEntryState({
      cookieHeader: request.headers.get("cookie"),
      env,
      fetchImpl,
    });
    const authorized = result.status === 200 && result.body?.ok === true && result.body?.authenticated === true &&
      (result.body.state === "customer_active" || result.body.state === "owner_active");

    if (!authorized) {
      const destination = new URL("/", request.url);
      destination.searchParams.set("reason", "account_required");
      return new Response(null, {
        status: 307,
        headers: { ...PRIVATE_HEADERS, Location: destination.toString() },
      });
    }

    return nextImpl({ headers: PRIVATE_HEADERS });
  };
}

export default createBrowseGateMiddleware();
