/* ProjectKidCreations — phase-four/app.js
 * 9-state machine + dashboard hydration + dev affordances.
 *
 * States: LOADING, BOOTSTRAP, SET_PASSWORD, LOGIN, RESET_REQUEST,
 *         RESET_CONFIRM, LOCKOUT, DASHBOARD, ERROR
 *
 * URL params:
 *   ?bootstrap=mock-abc123  → BOOTSTRAP → SET_PASSWORD
 *   ?reset=mock-xyz789      → RESET_CONFIRM
 *   ?dev=1                  → reveal dev panel
 *
 * Mock auth contract (api.js, mock mode):
 *   login() succeeds when password === "mock"; 3 fails → LOCKOUT (5s).
 */

import {
  fetchMe,
  verifyBootstrap,
  setPassword,
  login,
  requestReset,
  confirmReset,
  logout,
  updateProfile,
  logEvent,
  resetMockState,
  getSession,
  mockUnlockBadge
} from "./api.js";
import { BADGE_CATALOG, findBadge } from "./badges.js";

// ── DOM helpers ────────────────────────────────────────────────────
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const status = $("#status");
const toast = $("#toast");

const params = new URLSearchParams(window.location.search);
const BOOTSTRAP_TOKEN = (params.get("bootstrap") || "").trim() || null;
const RESET_TOKEN     = (params.get("reset")     || "").trim() || null;
const DEV_FORCED      = params.get("dev") === "1";

let state = "LOADING";
let dashboardData = null;
let lockoutTimer = null;

// ── State machine ──────────────────────────────────────────────────
function setState(next) {
  if (state === next) return;
  state = next;
  $$(".state").forEach((el) => {
    const active = el.getAttribute("data-state") === next;
    el.setAttribute("data-active", active ? "true" : "false");
    el.setAttribute("aria-hidden", active ? "false" : "true");
  });
  // sync dev dropdown
  const sel = $("#dev-state-select");
  if (sel) sel.value = next;

  // status line
  if (next === "LOADING")        setStatus("Checking session", null);
  else if (next === "BOOTSTRAP") setStatus("Verifying link", null);
  else if (next === "SET_PASSWORD") setStatus("Initialize operator", null);
  else if (next === "LOGIN")     setStatus("Operator sign-in", null);
  else if (next === "RESET_REQUEST") setStatus("Request reset link", null);
  else if (next === "RESET_CONFIRM") setStatus("Set new password", null);
  else if (next === "LOCKOUT")   setStatus("Cooldown", "error");
  else if (next === "DASHBOARD") setStatus("Operator online", "success");
  else if (next === "ERROR")     setStatus("Dashboard offline", "error");
}

function setStatus(text, tone) {
  status.textContent = text;
  if (tone) status.setAttribute("data-tone", tone);
  else status.removeAttribute("data-tone");
}

function showToast(text, ms = 2200) {
  toast.textContent = text;
  toast.setAttribute("data-visible", "true");
  toast.setAttribute("aria-hidden", "false");
  setTimeout(() => {
    toast.setAttribute("data-visible", "false");
    toast.setAttribute("aria-hidden", "true");
  }, ms);
}

// ── Entry routing ──────────────────────────────────────────────────
async function boot() {
  // Reveal dev panel on localhost or ?dev=1
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocal || DEV_FORCED) {
    $("#dev-panel").setAttribute("data-visible", "true");
  }

  wireDevPanel();
  wireAuthForms();
  wireDashboardControls();
  wireBadgeModal();

  if (BOOTSTRAP_TOKEN) {
    setState("BOOTSTRAP");
    await sleep(420);
    const res = await verifyBootstrap(BOOTSTRAP_TOKEN);
    if (!res.ok) {
      setState("ERROR");
      $("#error-meta").textContent = res.message || "Bootstrap link not recognized.";
      return;
    }
    if (res.data && res.data.email) {
      $("#setpw-email").textContent = res.data.email;
    }
    setState("SET_PASSWORD");
    return;
  }

  if (RESET_TOKEN) {
    setState("RESET_CONFIRM");
    return;
  }

  // Otherwise check mock session
  await sleep(380);
  const session = getSession();
  if (session) {
    await hydrateDashboard();
    return;
  }
  setState("LOGIN");
}

// ── Auth form wiring ───────────────────────────────────────────────
function wireAuthForms() {
  // Strength meter (shared)
  function bindStrength(inputId, barId, labelId) {
    const input = $(inputId);
    const bar = $(barId);
    const label = $(labelId);
    if (!input || !bar || !label) return;
    input.addEventListener("input", () => {
      const lvl = scorePassword(input.value);
      bar.setAttribute("data-level", String(lvl));
      label.textContent = "// STRENGTH " + ["—", "WEAK", "OK", "STRONG", "ELITE"][lvl];
    });
  }
  bindStrength("#setpw-input", "#setpw-strength", "#setpw-strength-label");
  bindStrength("#reset-new-pw", "#reset-strength", "#reset-strength-label");

  // SET_PASSWORD
  $("#setpw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#setpw-input").value;
    const confirm = $("#setpw-confirm").value;
    clearError("#setpw-error");
    clearError("#setpw-confirm-error");
    if (pw.length < 8) { showError("#setpw-error", "8+ characters required."); return; }
    if (pw !== confirm) { showError("#setpw-confirm-error", "Passwords don't match."); return; }
    const btn = $("#setpw-submit");
    btn.setAttribute("disabled", "");
    const res = await setPassword(pw);
    btn.removeAttribute("disabled");
    if (!res.ok) { showError("#setpw-error", res.message || "Couldn't set password."); return; }
    logEvent("password_set");
    await hydrateDashboard();
  });

  // LOGIN
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    clearError("#login-error");
    if (!email || !password) { showError("#login-error", "Email and password required."); return; }
    const btn = $("#login-submit");
    btn.setAttribute("disabled", "");
    const res = await login({ email, password });
    btn.removeAttribute("disabled");
    if (!res.ok) {
      if (res.code === "LOCKED_OUT" && res.data && res.data.lockoutUntil) {
        startLockout(res.data.lockoutUntil);
        return;
      }
      showError("#login-error", res.message || "Sign-in failed.");
      return;
    }
    logEvent("login");
    await hydrateDashboard();
  });

  // RESET_REQUEST
  $("#reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#reset-email").value.trim();
    if (!email) return;
    const btn = $("#reset-submit");
    btn.setAttribute("disabled", "");
    await requestReset(email);
    btn.removeAttribute("disabled");
    $("#reset-success").hidden = false;
    showToast("// RESET LINK SENT");
    logEvent("reset_requested");
  });

  // RESET_CONFIRM
  $("#reset-confirm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#reset-new-pw").value;
    clearError("#reset-confirm-error");
    if (pw.length < 8) { showError("#reset-confirm-error", "8+ characters required."); return; }
    const btn = $("#reset-confirm-submit");
    btn.setAttribute("disabled", "");
    const res = await confirmReset(RESET_TOKEN || "mock-xyz789", pw);
    btn.removeAttribute("disabled");
    if (!res.ok) { showError("#reset-confirm-error", res.message || "Couldn't update password."); return; }
    logEvent("password_reset_confirmed");
    showToast("// PASSWORD UPDATED");
    await hydrateDashboard();
  });

  // Cross-links
  $("#goto-reset")?.addEventListener("click", () => setState("RESET_REQUEST"));
  $("#goto-login")?.addEventListener("click", () => setState("LOGIN"));
  $("#goto-reset-from-lockout")?.addEventListener("click", () => {
    cancelLockout();
    setState("RESET_REQUEST");
  });

  // ERROR retry
  $("#error-retry")?.addEventListener("click", () => {
    setState("LOADING");
    setTimeout(boot, 200);
  });
}

function startLockout(until) {
  setState("LOCKOUT");
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    $("#lockout-countdown").textContent = String(remaining).padStart(2, "0");
    if (remaining <= 0) {
      cancelLockout();
      setState("LOGIN");
      return;
    }
    lockoutTimer = setTimeout(tick, 250);
  };
  tick();
}
function cancelLockout() {
  if (lockoutTimer) { clearTimeout(lockoutTimer); lockoutTimer = null; }
}

function scorePassword(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

function showError(sel, msg) {
  const el = $(sel);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function clearError(sel) {
  const el = $(sel);
  if (!el) return;
  el.textContent = "";
  el.hidden = true;
}

// ── Dashboard hydration ────────────────────────────────────────────
async function hydrateDashboard() {
  setState("LOADING");
  const res = await fetchMe();
  if (!res.ok) {
    setState("ERROR");
    $("#error-meta").textContent = res.message || "Could not reach dashboard.";
    return;
  }
  dashboardData = res.data;
  renderDashboard(dashboardData);
  setState("DASHBOARD");
}

function renderDashboard(data) {
  const { user, badges, builds, orders, activity, streakGrid } = data;

  // Header
  $("#dash-avatar").textContent = (user.displayName || user.username || "?").charAt(0).toUpperCase();
  $("#dash-display-name").textContent = (user.displayName || user.username).toUpperCase();
  $("#dash-username").textContent = "@" + user.username;
  $("#dash-rank").textContent = "// " + user.rank.label;

  // XP
  const rangeMin = user.xp.currentRankMin;
  const rangeMax = user.xp.nextRankMin;
  const pct = Math.max(0, Math.min(100, ((user.xp.current - rangeMin) / (rangeMax - rangeMin)) * 100));
  $("#dash-xp-current").textContent = String(user.xp.current);
  $("#dash-xp-next").textContent = String(rangeMax);
  $("#dash-rank-next").textContent = user.rank.nextLabel || "MAX";
  const fill = $("#xp-bar-fill");
  fill.setAttribute("data-pct", String(pct));
  fill.style.setProperty("--reduced-pct", pct + "%");
  // motion.js will animate fill on DASHBOARD enter

  // Badges
  renderBadges(badges);

  // Streak
  renderStreak(streakGrid, user.streak);

  // Builds
  renderBuilds(builds);

  // Activity
  renderActivity(activity);

  // Orders
  renderOrders(orders);

  // Settings
  $("#notif-toggle").checked = !!user.notifications;
}

function renderBadges(badges) {
  const grid = $("#badges-grid");
  grid.innerHTML = "";
  const counterEl = $("#badges-counter");
  let unlockedCount = 0;

  for (const b of badges) {
    const cat = findBadge(b.id);
    if (!cat) continue;
    if (b.unlocked) unlockedCount++;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "badge-cell";
    cell.setAttribute("role", "listitem");
    cell.setAttribute("data-badge", b.id);
    cell.setAttribute("data-rarity", cat.rarity);
    cell.setAttribute("data-locked", b.unlocked ? "false" : "true");
    cell.innerHTML = `
      <span class="badge-ribbon" aria-hidden="true"></span>
      <span class="badge-glyph" aria-hidden="true">${cat.glyph}</span>
      <span class="badge-label">${cat.label}</span>
      <span class="badge-tooltip">${b.unlocked ? "AWARDED " + (b.awardedAt || "—") : cat.criteria}</span>
    `;
    cell.addEventListener("click", () => openBadgeModal(b, cat));
    grid.appendChild(cell);
  }
  counterEl.textContent = `${unlockedCount} / ${badges.length}`;
}

function renderStreak(grid, streakMeta) {
  const wrap = $("#streak-grid");
  wrap.innerHTML = "";
  // 13 cols × 7 rows; oldest first. We'll lay them out column-major.
  const cols = 13;
  const rows = 7;
  // Build column-major: column[c] = grid items at indices c*7 .. c*7+6
  for (let c = 0; c < cols; c++) {
    const col = document.createElement("div");
    col.className = "streak-col";
    for (let r = 0; r < rows; r++) {
      const idx = c * rows + r;
      const day = grid[idx];
      const cell = document.createElement("div");
      cell.className = "streak-cell";
      cell.setAttribute("data-level", day ? String(day.activityCount) : "0");
      if (day) cell.title = `${day.date} · ${day.activityCount} event(s)`;
      col.appendChild(cell);
    }
    wrap.appendChild(col);
  }
  $("#streak-current").textContent = `${streakMeta.current} DAYS`;
  $("#streak-longest").textContent = `${streakMeta.longest} DAYS`;
}

const BUILD_SVGS = [
  // 1 — Glock-ish slide
  '<svg viewBox="0 0 100 100" fill="none" stroke="#39FF14" stroke-width="2"><rect x="14" y="36" width="72" height="22"/><rect x="40" y="58" width="14" height="22"/><circle cx="78" cy="47" r="3"/></svg>',
  // 2 — AR profile
  '<svg viewBox="0 0 100 100" fill="none" stroke="#39FF14" stroke-width="2"><rect x="10" y="44" width="80" height="10"/><rect x="38" y="54" width="10" height="22"/><rect x="60" y="38" width="22" height="8"/></svg>',
  // 3 — Draco compact
  '<svg viewBox="0 0 100 100" fill="none" stroke="#39FF14" stroke-width="2"><rect x="18" y="42" width="50" height="12"/><rect x="32" y="54" width="14" height="22"/><polygon points="68,42 88,42 80,54 68,54"/></svg>',
  // 4 — Switch / cube
  '<svg viewBox="0 0 100 100" fill="none" stroke="#39FF14" stroke-width="2"><polygon points="30,28 70,28 86,44 86,72 50,86 14,72 14,44"/><line x1="14" y1="44" x2="50" y2="58"/><line x1="86" y1="44" x2="50" y2="58"/><line x1="50" y1="58" x2="50" y2="86"/></svg>',
  // 5 — Glock 45 silhouette
  '<svg viewBox="0 0 100 100" fill="none" stroke="#39FF14" stroke-width="2"><rect x="12" y="34" width="74" height="20"/><rect x="42" y="54" width="14" height="26"/><circle cx="76" cy="44" r="2"/><circle cx="62" cy="44" r="2"/></svg>',
  // 6 — AK with magazine
  '<svg viewBox="0 0 100 100" fill="none" stroke="#39FF14" stroke-width="2"><rect x="10" y="42" width="80" height="10"/><polygon points="36,52 52,52 48,76 40,76"/><rect x="62" y="34" width="14" height="8"/></svg>'
];

function renderBuilds(builds) {
  const grid = $("#builds-grid");
  grid.innerHTML = "";
  for (const b of builds) {
    const card = document.createElement("div");
    card.className = "build-card";
    const svg = BUILD_SVGS[(b.seed - 1) % BUILD_SVGS.length] || BUILD_SVGS[0];
    card.innerHTML = `
      <div class="build-thumb">${svg}<span class="build-thumb-serial">// ${b.id}</span></div>
      <p class="build-title">${b.title}</p>
      <p class="build-meta"><span>${formatDate(b.submittedAt)}</span><span>♥ ${b.likes}</span></p>
    `;
    card.addEventListener("click", () => showToast(`// VIEW ${b.id} — STUBBED`));
    grid.appendChild(card);
  }
  // Upload CTA card
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "build-card--upload";
  upload.innerHTML = `// UPLOAD NEW BUILD&nbsp;&nbsp;→`;
  upload.addEventListener("click", () => showToast("// UPLOAD — STUBBED"));
  grid.appendChild(upload);

  $("#builds-counter").textContent = String(builds.length);
}

const ACTIVITY_GLYPHS = {
  badge_unlocked: "◆",
  build_submitted: "◉",
  order_placed: "▣",
  rank_promoted: "✦",
  profile_edited: "✎",
  login: "▸"
};

function renderActivity(events) {
  const list = $("#activity-list");
  list.innerHTML = "";
  for (const e of events) {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.setAttribute("data-type", e.type);
    row.innerHTML = `
      <span class="activity-glyph">${ACTIVITY_GLYPHS[e.type] || "•"}</span>
      <span class="activity-label">${e.label}</span>
      <span class="activity-when">${relativeTime(e.at)}</span>
    `;
    list.appendChild(row);
  }
}

function renderOrders(orders) {
  const body = $("#orders-body");
  body.innerHTML = "";
  for (const o of orders) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="order-id">${o.id}</td>
      <td>${formatDate(o.placedAt)}</td>
      <td class="order-items">${o.items.join(" · ")}</td>
      <td class="order-total">$${o.total.toFixed(2)}</td>
      <td><span class="status-tag" data-status="${o.status}">${o.status.toUpperCase()}</span></td>
      <td><button type="button" class="link-btn order-view">// VIEW</button></td>
    `;
    tr.querySelector(".order-view").addEventListener("click", () => showToast(`// ${o.id} — STUBBED`));
    body.appendChild(tr);
  }
}

// ── Badge modal ────────────────────────────────────────────────────
function wireBadgeModal() {
  const modal = $("#badge-modal");
  $("#badge-modal-close").addEventListener("click", closeBadgeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeBadgeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeBadgeModal(); });
  $("#badge-modal-share").addEventListener("click", () => showToast("// SHARE — STUBBED"));
}
function openBadgeModal(b, cat) {
  $("#badge-modal-glyph").textContent = cat.glyph;
  $("#badge-modal-label").textContent = cat.label;
  $("#badge-modal-criteria").textContent = cat.criteria;
  $("#badge-modal-meta").textContent = b.unlocked
    ? `// AWARDED ${b.awardedAt || "—"} · RARITY ${cat.rarity.toUpperCase()}`
    : `// LOCKED · RARITY ${cat.rarity.toUpperCase()}`;
  $("#badge-modal").setAttribute("data-open", "true");
  $("#badge-modal").setAttribute("aria-hidden", "false");
}
function closeBadgeModal() {
  $("#badge-modal").setAttribute("data-open", "false");
  $("#badge-modal").setAttribute("aria-hidden", "true");
}

// ── Dashboard control wiring ──────────────────────────────────────
function wireDashboardControls() {
  $("#logout-btn").addEventListener("click", async () => {
    await logout();
    showToast("// SIGNED OUT");
    setState("LOGIN");
  });
  $("#change-pw").addEventListener("click", async () => {
    await logout();
    setState("RESET_REQUEST");
  });
  $("#delete-account").addEventListener("click", () => {
    showToast("// DELETE — STUBBED");
  });
  $("#notif-toggle").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await updateProfile({ notifications: on });
    showToast(on ? "// NOTIFICATIONS ON" : "// NOTIFICATIONS OFF");
  });
}

// ── Dev panel ──────────────────────────────────────────────────────
function wireDevPanel() {
  $("#dev-state-select").addEventListener("change", async (e) => {
    const target = e.target.value;
    if (target === "DASHBOARD") {
      if (!dashboardData) {
        await hydrateDashboard();
        return;
      }
      renderDashboard(dashboardData);
      setState("DASHBOARD");
      return;
    }
    if (target === "RESET_CONFIRM") {
      // simulate token presence
      setState("RESET_CONFIRM");
      return;
    }
    setState(target);
  });

  $("#dev-badge-pop").addEventListener("click", () => {
    // Find a locked cell and pop it (or pop the first cell if none)
    const cell = document.querySelector('.badge-cell[data-locked="true"]') || document.querySelector(".badge-cell");
    if (!cell) { showToast("// NO BADGES TO POP — OPEN DASHBOARD FIRST"); return; }
    // visually unlock it
    cell.setAttribute("data-locked", "false");
    const id = cell.getAttribute("data-badge");
    if (id) {
      mockUnlockBadge(id);
      if (dashboardData) {
        const found = dashboardData.badges.find((x) => x.id === id);
        if (found) { found.unlocked = true; found.awardedAt = new Date().toISOString().slice(0, 10); }
        const unlocked = dashboardData.badges.filter((x) => x.unlocked).length;
        $("#badges-counter").textContent = `${unlocked} / ${dashboardData.badges.length}`;
      }
    }
    window.PKC_MOTION?.badgePop(cell);
  });

  $("#dev-xp-tick").addEventListener("click", () => {
    const el = $("#dash-xp-current");
    if (!el || !dashboardData) { showToast("// HYDRATE DASHBOARD FIRST"); return; }
    const from = dashboardData.user.xp.current;
    const to = Math.min(dashboardData.user.xp.nextRankMin, from + 50);
    window.PKC_MOTION?.xpTick(el, from, to);
    dashboardData.user.xp.current = to;
    // re-animate XP bar to new pct
    const u = dashboardData.user;
    const pct = Math.max(0, Math.min(100, ((to - u.xp.currentRankMin) / (u.xp.nextRankMin - u.xp.currentRankMin)) * 100));
    const fill = $("#xp-bar-fill");
    fill.setAttribute("data-pct", String(pct));
    window.PKC_MOTION?.opCardFill(fill, pct);
  });

  $("#dev-rank-promote").addEventListener("click", () => {
    const label = (dashboardData?.user?.rank?.nextLabel) || "VETERAN";
    window.PKC_MOTION?.rankPromote(label);
  });

  $("#dev-streak-flame").addEventListener("click", () => {
    const cells = $$(".streak-cell");
    if (!cells.length) { showToast("// HYDRATE DASHBOARD FIRST"); return; }
    // flame the most recent (last) cell
    window.PKC_MOTION?.streakFlame(cells[cells.length - 1]);
  });

  $("#dev-reset").addEventListener("click", () => {
    resetMockState();
    showToast("// MOCK STATE CLEARED");
    setTimeout(() => window.location.reload(), 400);
  });
}

// ── Utilities ──────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function relativeTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!t) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  if (d < 30) return d + "d ago";
  const mo = Math.round(d / 30);
  return mo + "mo ago";
}

// ── Go ─────────────────────────────────────────────────────────────
boot();
