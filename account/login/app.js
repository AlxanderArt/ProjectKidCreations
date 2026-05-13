/* ProjectKidCreations — account/login/app.js
 * State machine for /account/login.
 *
 * States:
 *   LOADING        — initial; probe /api/account/profile, redirect if already signed in
 *   FORM           — credential capture
 *   SUBMITTING     — POST in flight, form disabled
 *   SUCCESS        — brief; window.location → ACCOUNT_HOME
 *   LOCKED         — 423 account_locked; show countdown
 *   ERROR_INVALID  — 401 invalid_credentials; auto-return to FORM after INVALID_HOLD_MS
 *   ERROR_RETRY    — transient; one auto-retry, then manual retry button
 *   ERROR_FATAL    — give up; manual retry button only
 *
 * Generic credential errors — DO NOT enumerate username vs password.
 */

(function () {
  "use strict";

  const CFG = window.PKC_ACCOUNT_CONFIG;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const USERNAME_RE = /^[a-z0-9_.\-]{3,32}$/;

  // Swap user-side copy for admin-side copy when ?next= targets /account/admin.
  // Defaults in the HTML are the user-side strings; data-admin-text / data-admin-aria
  // hold the admin variants so the same page serves both audiences.
  (function applyContextCopy() {
    try {
      const next = new URL(location.href).searchParams.get("next") || "";
      if (!next.startsWith("/account/admin")) return;
      $$("[data-admin-text]").forEach((el) => {
        const v = el.getAttribute("data-admin-text");
        if (v) el.textContent = v;
      });
      $$("[data-admin-aria]").forEach((el) => {
        const v = el.getAttribute("data-admin-aria");
        if (v) el.setAttribute("aria-label", v);
      });
    } catch (_) { /* keep user defaults */ }
  })();

  // ── State ────────────────────────────────────────────────────
  let state = "LOADING";
  let autoRetryUsed = false;
  let lockCountdownTimer = null;
  let lockEndsAt = null;
  let invalidHoldTimer = null;

  const status = $("#status");

  // ── State machine ────────────────────────────────────────────
  function setState(next) {
    if (state === next) return;
    state = next;

    $$(".state").forEach((el) => {
      const active = el.getAttribute("data-state") === next;
      el.setAttribute("data-active", active ? "true" : "false");
      el.setAttribute("aria-hidden", active ? "false" : "true");
    });

    clearStateTimers();

    if (next === "LOADING") {
      status.textContent = "Checking session";
      status.removeAttribute("data-tone");
    } else if (next === "FORM") {
      status.textContent = "Awaiting credentials";
      status.removeAttribute("data-tone");
      enableForm(true);
      // Focus the first empty field
      setTimeout(() => {
        const u = $("#username-input");
        const p = $("#password-input");
        if (u && !u.value) u.focus();
        else if (p) p.focus();
      }, 60);
    } else if (next === "SUBMITTING") {
      status.textContent = "Authenticating";
      status.removeAttribute("data-tone");
      enableForm(false);
    } else if (next === "SUCCESS") {
      status.textContent = "Signed in";
      status.setAttribute("data-tone", "success");
    } else if (next === "LOCKED") {
      status.textContent = "Account locked";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_INVALID") {
      status.textContent = "Wrong credentials";
      status.setAttribute("data-tone", "error");
      // Bounce back to FORM after a short hold so the operator sees the kill
      // and gets a beat to read it.
      invalidHoldTimer = setTimeout(() => {
        if (state === "ERROR_INVALID") {
          showSubmitError("Wrong username or password.");
          setState("FORM");
        }
      }, CFG.INVALID_HOLD_MS || 2000);
    } else if (next === "ERROR_RETRY") {
      status.textContent = "Retrying";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_FATAL") {
      status.textContent = "Something went wrong";
      status.setAttribute("data-tone", "error");
    }
  }

  function clearStateTimers() {
    if (invalidHoldTimer) { clearTimeout(invalidHoldTimer); invalidHoldTimer = null; }
  }

  function enableForm(enabled) {
    const form = $("#login-form");
    if (!form) return;
    const btn = $("#submit-btn");
    $$("#username-input, #password-input").forEach((el) => { el.disabled = !enabled; });
    if (btn) {
      btn.disabled = !enabled;
      btn.setAttribute("aria-busy", enabled ? "false" : "true");
      const label = $("#submit-label");
      if (label) label.textContent = enabled ? "SIGN IN" : "SIGNING IN...";
    }
  }

  // ── Errors ───────────────────────────────────────────────────
  function showSubmitError(msg) {
    const el = $("#submit-error");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }
  function clearSubmitError() { showSubmitError(""); }

  function showFieldError(field, msg) {
    const fieldEl = document.querySelector(`.field[data-field="${field}"]`);
    if (!fieldEl) return;
    fieldEl.classList.add("invalid");
    const errEl = fieldEl.querySelector(".error-msg");
    if (errEl) {
      errEl.textContent = msg || "";
      errEl.hidden = !msg;
    }
  }
  function clearFieldErrors() {
    $$(".field.invalid").forEach((el) => el.classList.remove("invalid"));
    $$(".error-msg").forEach((el) => { el.textContent = ""; el.hidden = true; });
  }

  // ── Fetch wrapper ────────────────────────────────────────────
  async function fetchJSON(url, opts) {
    opts = opts || {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CFG.FETCH_TIMEOUT_MS || 12000);
    let res;
    try {
      res = await fetch(url, Object.assign({
        credentials: "include",
        mode: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "Accept": "application/json" }
      }, opts));
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, status: 0, networkError: true, data: null };
    }
    clearTimeout(timeout);
    let data = null;
    try { data = await res.json(); } catch (_) { /* tolerate empty body */ }
    return { ok: res.ok, status: res.status, networkError: false, data };
  }

  // ?next= must point to a same-origin path; reject anything else to
  // avoid open-redirect via login.
  function resolvePostLoginDest() {
    try {
      const next = new URL(location.href).searchParams.get("next");
      if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    } catch (_) { /* fall through */ }
    return CFG.ACCOUNT_HOME;
  }

  // ── Probe profile on load ────────────────────────────────────
  async function probeSession() {
    const res = await fetchJSON(CFG.PROFILE_URL, { method: "GET" });
    if (res.ok && res.data && res.data.ok !== false) {
      // Already signed in — redirect.
      status.textContent = "Already signed in";
      status.setAttribute("data-tone", "success");
      window.location.replace(resolvePostLoginDest());
      return;
    }
    // 401, network error, or any other → show the form. The form itself
    // is the recovery path; we don't blow up the page on a profile probe.
    setState("FORM");
  }

  // ── Submit ───────────────────────────────────────────────────
  function validateLocal() {
    clearFieldErrors();
    clearSubmitError();
    const u = ($("#username-input").value || "").trim();
    const p = $("#password-input").value || "";
    let ok = true;
    if (!USERNAME_RE.test(u)) {
      showFieldError("username", "3-32 chars: a-z 0-9 _ . -");
      ok = false;
    }
    if (p.length < 8) {
      showFieldError("password", "At least 8 characters.");
      ok = false;
    }
    return ok ? { username: u, password: p } : null;
  }

  async function runLogin(payload, isAutoRetry) {
    setState("SUBMITTING");
    const res = await fetchJSON(CFG.LOGIN_URL, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    // 200 ok:true → success
    if (res.ok && res.data && res.data.ok === true) {
      setState("SUCCESS");
      // Brief beat so the SUCCESS scan-line registers, then redirect.
      setTimeout(() => { window.location.replace(resolvePostLoginDest()); }, 350);
      return;
    }

    const code = (res.data && res.data.error) || null;

    // 401 invalid_credentials — generic, do NOT enumerate user vs pw
    if (res.status === 401 || code === "invalid_credentials") {
      autoRetryUsed = false;
      setState("ERROR_INVALID");
      return;
    }

    // 423 account_locked — show countdown
    if (res.status === 423 || code === "account_locked") {
      const secs = (res.data && Number(res.data.seconds_remaining)) || 0;
      startLockCountdown(secs);
      setState("LOCKED");
      return;
    }

    // 4xx with explicit validation error from the API
    if (res.status >= 400 && res.status < 500 && code && code !== "invalid_credentials") {
      autoRetryUsed = false;
      showSubmitError((res.data && res.data.message) || "Sign-in was rejected. Check your input.");
      setState("FORM");
      return;
    }

    // 5xx, network, or unknown — transient
    if (!isAutoRetry && !autoRetryUsed) {
      autoRetryUsed = true;
      setState("ERROR_RETRY");
      const meta = $("#error-retry-meta");
      if (meta) meta.textContent = "Auto-retrying in a moment.";
      setTimeout(() => { runLogin(payload, true); }, CFG.AUTO_RETRY_DELAY_MS || 1500);
      return;
    }
    setState("ERROR_FATAL");
  }

  // ── Lock countdown ───────────────────────────────────────────
  function startLockCountdown(seconds) {
    stopLockCountdown();
    lockEndsAt = Date.now() + Math.max(0, seconds) * 1000;
    renderLockCountdown();
    lockCountdownTimer = setInterval(renderLockCountdown, 1000);
  }
  function stopLockCountdown() {
    if (lockCountdownTimer) { clearInterval(lockCountdownTimer); lockCountdownTimer = null; }
  }
  function renderLockCountdown() {
    const el = $("#lock-countdown");
    if (!el || lockEndsAt == null) return;
    const remaining = Math.max(0, Math.round((lockEndsAt - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    el.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    if (remaining <= 0) {
      stopLockCountdown();
      // Cooldown is over — re-arm the form. The server still gates this on
      // its end; the UI is just unblocking the input affordance.
      setState("FORM");
      showSubmitError("");
    }
  }

  // ── Boot ─────────────────────────────────────────────────────
  function bindForm() {
    const form = $("#login-form");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const payload = validateLocal();
      if (!payload) return;
      autoRetryUsed = false;
      runLogin(payload, false);
    });

    // Clear field errors as the operator types
    $$("#username-input, #password-input").forEach((el) => {
      el.addEventListener("input", () => {
        const field = el.id === "username-input" ? "username" : "password";
        const fieldEl = document.querySelector(`.field[data-field="${field}"]`);
        if (fieldEl && fieldEl.classList.contains("invalid")) {
          fieldEl.classList.remove("invalid");
          const err = fieldEl.querySelector(".error-msg");
          if (err) { err.textContent = ""; err.hidden = true; }
        }
        clearSubmitError();
      });
    });

    const retryBtn = $("#retry-btn");
    if (retryBtn) retryBtn.addEventListener("click", () => {
      autoRetryUsed = false;
      setState("FORM");
    });
    const fatalRetryBtn = $("#fatal-retry-btn");
    if (fatalRetryBtn) fatalRetryBtn.addEventListener("click", () => {
      autoRetryUsed = false;
      setState("FORM");
    });
  }

  function init() {
    bindForm();
    probeSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
