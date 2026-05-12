/* ProjectKidCreations — phase-four/api.js
 * Data-layer abstraction. Default mode is "mock"; switch to "live" by
 * setting window.PKC_DATA_MODE = "live" before this module loads.
 *
 * Every export returns a uniform envelope:
 *   { ok, code, message, retryable, data, request_id, duration_ms,
 *     api_version: "1.0.0", phase: "four" }
 *
 * Mock latency is intentional — buttons need to feel like real work
 * happens behind them. Live branch is a thin fetch wrapper that the
 * eventual Vercel proxy will satisfy at /api/dashboard/*.
 */

import {
  MOCK_USER,
  MOCK_BADGES,
  MOCK_BUILDS,
  MOCK_ORDERS,
  MOCK_ACTIVITY,
  MOCK_STREAK_GRID
} from "./mock-data.js";

const MODE = window.PKC_DATA_MODE ?? "mock";
const BASE = "/api/dashboard";
const API_VERSION = "1.0.0";
const STORE_KEY = "pkc_phase_four_mock";

// ── localStorage session helpers ───────────────────────────────────
function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
function writeStore(patch) {
  const cur = readStore();
  const next = { ...cur, ...patch };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}
export function resetMockState() {
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
}
export function getSession() {
  return readStore().session || null;
}

// ── Internal: envelope + delay ─────────────────────────────────────
function envelope(extra) {
  const base = {
    ok: true,
    code: "OK",
    message: null,
    retryable: false,
    data: null,
    request_id: "mock-" + Math.random().toString(36).slice(2, 10),
    duration_ms: extra.duration_ms || 0,
    api_version: API_VERSION,
    phase: "four"
  };
  return { ...base, ...extra };
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function liveCall(path, opts) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "include"
    });
    const json = await res.json().catch(() => ({}));
    return {
      ok: res.ok && (json.ok !== false),
      code: json.code || (res.ok ? "OK" : "HTTP_" + res.status),
      message: json.message || null,
      retryable: !!json.retryable,
      data: json.data ?? null,
      request_id: json.request_id || res.headers.get("x-request-id") || null,
      duration_ms: Math.round(performance.now() - t0),
      api_version: json.api_version || API_VERSION,
      phase: "four"
    };
  } catch (err) {
    return envelope({
      ok: false,
      code: "NETWORK_ERROR",
      message: err.message,
      retryable: true,
      duration_ms: Math.round(performance.now() - t0)
    });
  }
}

// ── Public API ─────────────────────────────────────────────────────
export async function fetchMe() {
  if (MODE === "live") return liveCall("/me", { method: "GET" });

  const t0 = performance.now();
  await delay(420);
  const store = readStore();
  const user = { ...MOCK_USER, ...(store.userPatch || {}) };
  const badges = mergeBadges(store.badgesPatch);
  return envelope({
    ok: true,
    data: {
      user,
      badges,
      builds: MOCK_BUILDS,
      orders: MOCK_ORDERS,
      activity: MOCK_ACTIVITY,
      streakGrid: MOCK_STREAK_GRID
    },
    duration_ms: Math.round(performance.now() - t0)
  });
}

function mergeBadges(patch) {
  if (!patch) return MOCK_BADGES;
  return MOCK_BADGES.map((b) => patch[b.id] ? { ...b, ...patch[b.id] } : b);
}

export async function verifyBootstrap(token) {
  if (MODE === "live") return liveCall("/bootstrap/verify", { method: "POST", body: { token } });

  const t0 = performance.now();
  await delay(600);
  if (!token || !token.startsWith("mock-")) {
    return envelope({
      ok: false,
      code: "INVALID_TOKEN",
      message: "Bootstrap token not recognized.",
      duration_ms: Math.round(performance.now() - t0)
    });
  }
  return envelope({
    ok: true,
    data: { email: MOCK_USER.email, username: MOCK_USER.username },
    duration_ms: Math.round(performance.now() - t0)
  });
}

export async function setPassword(pw) {
  if (MODE === "live") return liveCall("/auth/set-password", { method: "POST", body: { password: pw } });

  const t0 = performance.now();
  await delay(400);
  if (!pw || pw.length < 8) {
    return envelope({
      ok: false,
      code: "WEAK_PASSWORD",
      message: "Password must be at least 8 characters.",
      duration_ms: Math.round(performance.now() - t0)
    });
  }
  writeStore({ session: { userId: MOCK_USER.id, signedInAt: Date.now() }, hasPassword: true });
  return envelope({ ok: true, data: { user: MOCK_USER }, duration_ms: Math.round(performance.now() - t0) });
}

export async function login(creds) {
  if (MODE === "live") return liveCall("/auth/login", { method: "POST", body: creds });

  const t0 = performance.now();
  await delay(380);
  const store = readStore();
  const failCount = store.failCount || 0;
  const lockoutUntil = store.lockoutUntil || 0;

  if (Date.now() < lockoutUntil) {
    return envelope({
      ok: false,
      code: "LOCKED_OUT",
      message: "Too many attempts.",
      data: { lockoutUntil },
      duration_ms: Math.round(performance.now() - t0)
    });
  }

  if (creds && creds.password === "mock") {
    writeStore({
      session: { userId: MOCK_USER.id, signedInAt: Date.now() },
      failCount: 0,
      lockoutUntil: 0
    });
    return envelope({
      ok: true,
      data: { user: MOCK_USER },
      duration_ms: Math.round(performance.now() - t0)
    });
  }

  const nextFail = failCount + 1;
  if (nextFail >= 3) {
    const until = Date.now() + 5000;
    writeStore({ failCount: nextFail, lockoutUntil: until });
    return envelope({
      ok: false,
      code: "LOCKED_OUT",
      message: "Too many attempts.",
      data: { lockoutUntil: until },
      duration_ms: Math.round(performance.now() - t0)
    });
  }

  writeStore({ failCount: nextFail });
  return envelope({
    ok: false,
    code: "BAD_CREDENTIALS",
    message: `Wrong password. ${3 - nextFail} attempt(s) remaining.`,
    data: { attemptsLeft: 3 - nextFail },
    duration_ms: Math.round(performance.now() - t0)
  });
}

export async function requestReset(email) {
  if (MODE === "live") return liveCall("/auth/reset-request", { method: "POST", body: { email } });

  const t0 = performance.now();
  await delay(300);
  // Always succeed (no enumeration)
  return envelope({
    ok: true,
    data: { sent: true },
    duration_ms: Math.round(performance.now() - t0)
  });
}

export async function confirmReset(token, pw) {
  if (MODE === "live") return liveCall("/auth/reset-confirm", { method: "POST", body: { token, password: pw } });

  const t0 = performance.now();
  await delay(400);
  if (!token || !token.startsWith("mock-")) {
    return envelope({
      ok: false,
      code: "INVALID_TOKEN",
      message: "Reset token not recognized.",
      duration_ms: Math.round(performance.now() - t0)
    });
  }
  if (!pw || pw.length < 8) {
    return envelope({
      ok: false,
      code: "WEAK_PASSWORD",
      message: "Password must be at least 8 characters.",
      duration_ms: Math.round(performance.now() - t0)
    });
  }
  writeStore({
    session: { userId: MOCK_USER.id, signedInAt: Date.now() },
    failCount: 0,
    lockoutUntil: 0
  });
  return envelope({ ok: true, data: { user: MOCK_USER }, duration_ms: Math.round(performance.now() - t0) });
}

export async function logout() {
  if (MODE === "live") return liveCall("/auth/logout", { method: "POST" });

  await delay(120);
  const cur = readStore();
  delete cur.session;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cur)); } catch (_) {}
  return envelope({ ok: true, data: { signedOut: true } });
}

export async function updateProfile(patch) {
  if (MODE === "live") return liveCall("/me", { method: "PATCH", body: patch });

  const t0 = performance.now();
  await delay(220);
  const store = readStore();
  writeStore({ userPatch: { ...(store.userPatch || {}), ...patch } });
  return envelope({ ok: true, data: { patched: patch }, duration_ms: Math.round(performance.now() - t0) });
}

export async function logEvent(eventType, meta) {
  if (MODE === "live") return liveCall("/event", { method: "POST", body: { event_type: eventType, meta } });

  // mock: fire-and-forget, no network noise
  return envelope({ ok: true, data: { event_type: eventType, meta: meta || {} } });
}

// ── Mutation helpers for the dev panel ─────────────────────────────
export function mockUnlockBadge(id) {
  const store = readStore();
  const patch = store.badgesPatch || {};
  patch[id] = { unlocked: true, awardedAt: new Date().toISOString().slice(0, 10) };
  writeStore({ badgesPatch: patch });
}
