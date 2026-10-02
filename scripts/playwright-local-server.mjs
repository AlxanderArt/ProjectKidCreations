import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { isProtectedBrowsePath } from "../server/auth/browse-paths.mjs";
import { resolveEntryState } from "../server/auth/entry-state.mjs";

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid local server port");

const mime = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});
const csp = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self'; frame-src 'self'";
const frameCsp = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; font-src 'self'; connect-src 'self'";
const testEnv = Object.freeze({
  PKC_N8N_BASE_URL: "https://n8n.example.test",
  PKC_AUTH_KEY: "e2e-only-key",
  PKC_N8N_ALLOWED_ORIGINS: "https://n8n.example.test",
  PKC_FOUNDER_SUBJECT: "11111111-1111-4111-8111-111111111111",
});
const testFetch = async (_url, init) => {
  if (init?.headers?.Cookie === "pkc_session=e2e-founder") {
    return new Response(JSON.stringify({
      account: {
        account_id: testEnv.PKC_FOUNDER_SUBJECT,
        username: "PK Blick",
        display_name: "PK Blick",
        is_admin: true,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (init?.headers?.Cookie !== "pkc_session=e2e-customer") return new Response(null, { status: 401 });
  return new Response(JSON.stringify({
    account: {
      account_id: "22222222-2222-4222-8222-222222222222",
      username: "e2e-customer",
      display_name: "E2E Customer",
      is_admin: false,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

function headers(pathname) {
  const frame = pathname === "/assets/pkc-motion/boot/pkc-boot-frame.html";
  return {
    "Content-Security-Policy": frame ? frameCsp : csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": frame ? "no-referrer" : "strict-origin-when-cross-origin",
    "Permissions-Policy": frame ? "camera=(), microphone=(), geolocation=()" : "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "X-Frame-Options": frame ? "SAMEORIGIN" : "DENY",
    ...(frame ? { "Cross-Origin-Resource-Policy": "same-origin" } : { "Cross-Origin-Opener-Policy": "same-origin" }),
  };
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    return response.end();
  }
  const url = new URL(request.url, "http://127.0.0.1");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { response.writeHead(400); return response.end(); }
  if (pathname === "/onboarding/") {
    response.writeHead(307, { Location: "/onboarding", ...headers(pathname) });
    return response.end();
  }
  if (pathname === "/onboarding") pathname = "/phase-one/";
  if (pathname === "/phase-four" || pathname === "/phase-four/" || pathname.startsWith("/phase-four/")) {
    response.writeHead(307, { Location: "/", ...headers(pathname) });
    return response.end();
  }
  if (isProtectedBrowsePath(pathname)) {
    const result = await resolveEntryState({ cookieHeader: request.headers.cookie, env: testEnv, fetchImpl: testFetch });
    const authorized = result.status === 200 && result.body?.ok === true && result.body?.authenticated === true &&
      (result.body.state === "customer_active" || result.body.state === "owner_active");
    if (!authorized) {
      response.writeHead(307, {
        Location: "/?reason=account_required",
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
        Vary: "Cookie",
        ...headers(pathname),
      });
      return response.end();
    }
  }
  if (pathname === "/landing" || pathname === "/landing/") pathname = "/landing.html";
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${sep}`)) { response.writeHead(404); return response.end(); }
  try {
    if (statSync(file).isDirectory()) file = resolve(file, "index.html");
    if (!statSync(file).isFile()) throw new Error("not_file");
  } catch {
    response.writeHead(404, headers(pathname));
    return response.end();
  }
  const responseHeaders = { ...headers(pathname), "Content-Type": mime[extname(file)] || "application/octet-stream" };
  response.writeHead(200, responseHeaders);
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`local-playwright-server http://127.0.0.1:${port}\n`));
