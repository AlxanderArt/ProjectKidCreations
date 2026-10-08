const EXACT_PUBLIC_PATHS = new Set([
  "/",
  "/index.html",
  "/onboarding",
  "/onboarding/",
  "/tokens.css",
  "/root.css",
  "/root-router.js",
  "/legal.css",
  "/assets/pkc-motion/tokens.css",
  "/assets/pkc-motion/interaction.css",
  "/dist/pkc-motion.js",
  "/dist/pkc-boot-renderer.js",
  "/dist/pkc-land-topology.json",
  "/dist/account-login.js",
  "/account/styles.css",
  "/privacy",
  "/privacy/",
  "/privacy/index.html",
  "/terms",
  "/terms/",
  "/terms/index.html",
  "/phase-one",
  "/phase-two",
  "/phase-three",
  "/account/login",
  "/account/forgot",
  "/account/reset",
  "/account/bootstrap",
]);

const PUBLIC_PREFIXES = Object.freeze([
  "/phase-one/",
  "/phase-two/",
  "/phase-three/",
  "/account/login/",
  "/account/forgot/",
  "/account/reset/",
  "/account/bootstrap/",
  "/assets/fonts/",
  "/assets/pkc-motion/boot/",
]);

export const BROWSE_GATE_MATCHERS = Object.freeze([
  "/((?!api/).*)",
]);

export function isPublicAnonymousPath(pathname) {
  return typeof pathname === "string" && (
    EXACT_PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function isProtectedBrowsePath(pathname) {
  return typeof pathname === "string" && !pathname.startsWith("/api/") && !isPublicAnonymousPath(pathname);
}
