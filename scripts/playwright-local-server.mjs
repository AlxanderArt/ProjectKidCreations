import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

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

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    return response.end();
  }
  const url = new URL(request.url, "http://127.0.0.1");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { response.writeHead(400); return response.end(); }
  if (pathname === "/phase-four" || pathname === "/phase-four/" || pathname.startsWith("/phase-four/")) {
    response.writeHead(307, { Location: "/", ...headers(pathname) });
    return response.end();
  }
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
