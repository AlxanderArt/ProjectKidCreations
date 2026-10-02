import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const productionHtml = [
  "index.html",
  "landing.html",
  "phase-one/index.html",
  "phase-two/index.html",
  "phase-three/index.html",
  "account/index.html",
  "account/login/index.html",
  "account/bootstrap/index.html",
  "account/forgot/index.html",
  "account/reset/index.html",
  "account/admin/index.html",
];

function executableInlineScripts(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  return scripts.filter(([, attrs, body]) => {
    if (/\bsrc\s*=/.test(attrs)) return false;
    if (/\btype\s*=\s*["']application\/ld\+json["']/.test(attrs)) return false;
    return body.trim().length > 0;
  });
}

test("strict CSP pages contain no executable inline scripts", () => {
  const offenders = productionHtml
    .map((path) => ({ path, count: executableInlineScripts(read(path)).length }))
    .filter((item) => item.count > 0);
  assert.deepEqual(offenders, []);
});

test("production pages use only same-origin script sources", () => {
  const offenders = [];
  for (const path of productionHtml) {
    for (const match of read(path).matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      if (/^https?:\/\//i.test(match[1])) offenders.push({ path, src: match[1] });
    }
  }
  assert.deepEqual(offenders, []);
});

test("strict CSP pages contain no inline CSS or style attributes", () => {
  const offenders = [];
  for (const path of productionHtml) {
    const html = read(path);
    if (/<style\b/i.test(html)) offenders.push({ path, type: "style-block" });
    if (/\sstyle\s*=/i.test(html)) offenders.push({ path, type: "style-attribute" });
  }
  assert.deepEqual(offenders, []);
});

test("launch runtime never creates or mutates inline styles", () => {
  const sources = [
    "src/ErrorBoundary.jsx",
    "src/hero3d.js",
    "src/components/Hero.jsx",
    "src/components/Nav.jsx",
    "src/components/Products.jsx",
    "src/components/Sections.jsx",
    "src/components/ValueProps.jsx",
    "phase-one/app.js",
    "phase-two/app.js",
    "phase-three/app.js",
    "account/admin/app.js",
  ];
  const forbidden = /style\s*=\s*\{|\.style(?:\.|\[)|createElement\(["']style["']\)|setAttribute\(["']style["']/;
  const offenders = sources.filter((path) => forbidden.test(read(path)));
  assert.deepEqual(offenders, []);
});

test("production pages do not load remote scripts, styles, or fonts", () => {
  const offenders = [];
  for (const path of productionHtml) {
    for (const match of read(path).matchAll(/(?:<script\b[^>]*src|<link\b[^>]*rel=["']stylesheet["'][^>]*href)=["'](https?:\/\/[^"']+)["']/gi)) {
      offenders.push({ path, url: match[1] });
    }
  }
  assert.deepEqual(offenders, []);
});

test("CSP forbids executable and style attributes without unsafe-inline", () => {
  const config = JSON.parse(read("vercel.json"));
  const policies = config.headers
    .map((item) => ({
      source: item.source,
      value: item.headers.find((header) => header.key === "Content-Security-Policy")?.value,
    }))
    .filter(({ value }) => value);
  const parent = policies.find(({ value }) => value.includes("frame-ancestors 'none'") && value.includes("frame-src 'self'"));
  const bootFrame = policies.find(({ source }) => source === "/assets/pkc-motion/boot/pkc-boot-frame.html");
  assert.ok(parent, "parent-page CSP must exist");
  assert.ok(bootFrame, "boot-frame CSP must exist");
  for (const { value } of [parent, bootFrame]) {
    assert.match(value, /script-src 'self'/);
    assert.match(value, /script-src-attr 'none'/);
    assert.match(value, /style-src 'self'/);
    assert.match(value, /style-src-attr 'none'/);
    assert.equal(value.includes("unsafe-inline"), false);
    assert.equal(value.includes("unsafe-eval"), false);
  }
  assert.match(bootFrame.value, /frame-ancestors 'self'/);
  assert.match(bootFrame.value, /form-action 'none'/);
});

test("root uses a CSP-compatible canonical entry-state router", () => {
  assert.match(read("index.html"), /<script\s+src=["']\/root-router\.js["'][^>]*><\/script>/);
  assert.ok(existsSync(resolve(root, "root-router.js")));
  assert.match(read("root-router.js"), /\/api\/account\/entry-state/);
  assert.ok(existsSync(resolve(root, "api/node.js")));
  assert.ok(existsSync(resolve(root, "server/api/entry-state.mjs")));
});

test("entry-state pins the n8n origin and forwards only the exact session cookie", () => {
  const adapter = read("server/api/entry-state.mjs");
  const source = read("server/auth/entry-state.mjs");
  assert.match(adapter, /import \{ resolveEntryState \} from ["']\.\.\/auth\/entry-state\.mjs["']/);
  assert.match(adapter, /resolveEntryState\(\{/);
  assert.match(source, /PKC_N8N_ALLOWED_ORIGINS/);
  assert.match(source, /allowedOrigins\.has\(parsed\.origin\)/);
  assert.match(source, /parsed\.pathname\s*!==\s*["']\/["']/);
  assert.match(source, /Cookie: `pkc_session=\$\{cookie\}`/);
  assert.match(source, /PKC_FOUNDER_SUBJECT/);
  assert.match(source, /account\?\.account_id/);
  assert.doesNotMatch(source, /OWNER_EMAIL|account\?\.email/);
  assert.doesNotMatch(source, /authorization/i);
  assert.doesNotMatch(source, /x-forwarded-for/i);
});

test("frontend account routes match deployed flat serverless files", () => {
  const source = [
    ...productionHtml,
    "account/config.js",
    "account/bootstrap/config.js",
    "account/forgot/config.js",
    "account/reset/config.js",
  ].map(read).join("\n");
  const stale = [
    "/api/account/bootstrap/redeem",
    "/api/account/password/request-reset",
    "/api/account/password/complete-reset",
    "/api/account/password/change",
    "/api/account/sessions/revoke",
  ];
  for (const route of stale) assert.equal(source.includes(route), false, route);
  for (const route of [
    "/api/account/bootstrap-redeem",
    "/api/account/password-request",
    "/api/account/password-complete",
    "/api/account/password-change",
  ]) assert.equal(source.includes(route), true, route);
});

test("public mock Phase Four is quarantined from production routing", () => {
  const config = JSON.parse(read("vercel.json"));
  const redirects = config.redirects || [];
  assert.ok(redirects.some((item) => item.source === "/onboarding/" && item.destination === "/onboarding" && item.permanent === false));
  assert.ok(redirects.some((item) => item.source === "/phase-four" && item.destination === "/"));
  assert.ok(redirects.some((item) => item.source === "/phase-four/" && item.destination === "/"));
  assert.ok(redirects.some((item) => item.source === "/phase-four/:path*" && item.destination === "/"));
});

test("catalog rewrites, broad middleware matcher, and local harness share the default-deny gate", () => {
  const config = JSON.parse(read("vercel.json"));
  const middleware = read("middleware.js");
  const localServer = read("scripts/playwright-local-server.mjs");
  const classifier = read("server/auth/browse-paths.mjs");
  const rewrites = new Map((config.rewrites || []).map((item) => [item.source, item.destination]));
  assert.equal(rewrites.get("/landing"), "/landing.html");
  assert.equal(rewrites.get("/landing/"), "/landing.html");
  assert.ok(middleware.includes(JSON.stringify("/((?!api/).*)")));
  assert.match(classifier, /EXACT_PUBLIC_PATHS/);
  assert.match(classifier, /!isPublicAnonymousPath\(pathname\)/);
  assert.match(localServer, /isProtectedBrowsePath\(pathname\)/);
  for (const source of [middleware, localServer]) {
    assert.match(source, /result\.status === 200/);
    assert.match(source, /result\.body\?\.ok === true/);
    assert.match(source, /result\.body\?\.authenticated === true/);
    assert.match(source, /result\.body\.state === "customer_active"/);
    assert.match(source, /result\.body\.state === "owner_active"/);
  }
});

test("internal tests, workflow tooling, and deferred source are excluded from Vercel uploads", () => {
  const ignore = read(".vercelignore");
  for (const pattern of ["tests/", ".deferred/", "scripts/n8n-*.mjs", "evidence/", "reports/", ".tmp-*"]) {
    assert.ok(ignore.includes(pattern), pattern);
  }
  assert.equal(ignore.includes("scripts/build.mjs"), false);
});

test("candidate contains sanitized live n8n authority evidence", () => {
  const evidence = JSON.parse(read("evidence/n8n-live-authority.json"));
  assert.equal(evidence.schema, "pkc-n8n-live-authority-v1");
  assert.equal(evidence.unsafe_admin_flip_inactive, true);
  assert.ok(evidence.workflow_count >= 20);
  const unsafe = evidence.workflows.find((workflow) => workflow.id === "JYrvqRrdhSel2KpD");
  assert.ok(unsafe);
  assert.equal(unsafe.active, false);
  assert.match(unsafe.topology_sha256, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of ["credentials", "staticData", "pinData", "N8N_API_KEY", "PKC_AUTH_KEY"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("launch documentation identifies PK Blick and excludes collaboration scope", () => {
  const readme = read("README.md");
  assert.match(readme, /PK Blick/);
  assert.match(readme, /collaboration[^\n]*(after launch|post-launch)/i);
});

test("unshipped avatar upload is quarantined without vulnerable runtime dependencies", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies?.["@vercel/blob"], undefined);
  assert.equal(existsSync(resolve(root, "phase-three/upload-worker.js")), false);
  assert.equal(existsSync(resolve(root, ".deferred/avatar-upload/upload-worker.js")), true);
  assert.doesNotMatch(read("phase-three/index.html"), /upload-worker\.js|avatar-input|dropzone-progress/);
});
