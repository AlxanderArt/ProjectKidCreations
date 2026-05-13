/* ProjectKidCreations — account/bootstrap/app.js
 * State machine for /account/bootstrap?token=…&u=…
 *
 * States:
 *   LOADING         — parse URL, validate presence of token + u
 *   INVALID         — URL is missing/garbled
 *   FORM            — capture new password
 *   SUBMITTING      — POST in flight
 *   SUCCESS         — brief; redirect to ACCOUNT_HOME
 *   ERROR_TOKEN     — 401 invalid_or_expired_token
 *   ERROR_REDEEMED  — 409 already_redeemed
 *   ERROR_RETRY     — transient; one auto-retry
 *   ERROR_FATAL     — give up; manual retry
 *
 * Password rules (mirror server-side, kept lenient on the client):
 *   - length >= 8
 *   - not all the same character
 *   - not equal to the username
 */

(function () {
  "use strict";

  const CFG = window.PKC_ACCOUNT_CONFIG;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ── State ────────────────────────────────────────────────────
  let state = "LOADING";
  let tokenString = null;
  let usernameFromURL = null;
  let autoRetryUsed = false;
  let lastPayload = null;

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

    if (next === "LOADING") {
      status.textContent = "Checking your link";
      status.removeAttribute("data-tone");
    } else if (next === "INVALID") {
      status.textContent = "Link not recognized";
      status.setAttribute("data-tone", "error");
    } else if (next === "FORM") {
      status.textContent = "Set your password";
      status.removeAttribute("data-tone");
      enableForm(true);
      setTimeout(() => { const p = $("#new-password-input"); if (p) p.focus(); }, 60);
    } else if (next === "SUBMITTING") {
      status.textContent = "Locking in password";
      status.removeAttribute("data-tone");
      enableForm(false);
    } else if (next === "SUCCESS") {
      status.textContent = "Account claimed";
      status.setAttribute("data-tone", "success");
    } else if (next === "ERROR_TOKEN") {
      status.textContent = "Link expired";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_REDEEMED") {
      status.textContent = "Already claimed";
      status.setAttribute("data-tone", "success");
    } else if (next === "ERROR_RETRY") {
      status.textContent = "Retrying";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_FATAL") {
      status.textContent = "Something went wrong";
      status.setAttribute("data-tone", "error");
    }
  }

  function enableForm(enabled) {
    const btn = $("#submit-btn");
    const input = $("#new-password-input");
    if (input) input.disabled = !enabled;
    if (btn) {
      // Submit button availability is also gated on validation; on disable we
      // hard-disable, on enable we hand back to the live-validator.
      btn.disabled = !enabled;
      btn.setAttribute("aria-busy", enabled ? "false" : "true");
      const label = $("#submit-label");
      if (label) label.textContent = enabled ? "SET PASSWORD" : "SETTING UP...";
      if (enabled) revalidateChecklist();
    }
  }

  // ── URL parsing ──────────────────────────────────────────────
  function parseURL() {
    const params = new URLSearchParams(window.location.search);
    const t = (params.get("token") || "").trim();
    const u = (params.get("u") || "").trim();
    if (!t || !u) return null;
    // base64url charset — be permissive, server is the source of truth
    if (!/^[A-Za-z0-9_\-=.]+$/.test(t)) return null;
    if (u.length < 3 || u.length > 32) return null;
    return { token: t, username: u };
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

  // ── Password rules ───────────────────────────────────────────
  function evaluateRules(pw) {
    const trimmed = pw || "";
    const length = trimmed.length >= 8 && trimmed.length <= 128;
    const variety = trimmed.length > 0 && !/^(.)\1+$/.test(trimmed);
    const distinct = trimmed.length > 0 &&
      trimmed.toLowerCase() !== (usernameFromURL || "").toLowerCase();
    return { length, variety, distinct };
  }

  function revalidateChecklist() {
    const pw = $("#new-password-input") ? $("#new-password-input").value : "";
    const rules = evaluateRules(pw);
    const list = $("#password-checklist");
    if (list) {
      list.querySelector('[data-rule="length"]').setAttribute("data-ok", rules.length ? "true" : "false");
      list.querySelector('[data-rule="variety"]').setAttribute("data-ok", rules.variety ? "true" : "false");
      list.querySelector('[data-rule="distinct"]').setAttribute("data-ok", rules.distinct ? "true" : "false");
    }
    const allOk = rules.length && rules.variety && rules.distinct;
    const btn = $("#submit-btn");
    if (btn && state === "FORM") {
      btn.disabled = !allOk;
      btn.setAttribute("aria-disabled", allOk ? "false" : "true");
    }
    return allOk;
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

  // ── Submit ───────────────────────────────────────────────────
  async function runRedeem(isAutoRetry) {
    if (!lastPayload) return;
    setState("SUBMITTING");
    const res = await fetchJSON(CFG.REDEEM_URL, {
      method: "POST",
      body: JSON.stringify(lastPayload)
    });

    if (res.ok && res.data && res.data.ok === true) {
      setState("SUCCESS");
      setTimeout(() => { window.location.replace(CFG.ACCOUNT_HOME); }, 350);
      return;
    }

    const code = (res.data && res.data.error) || null;

    if (res.status === 401 || code === "invalid_or_expired_token") {
      setState("ERROR_TOKEN");
      return;
    }
    if (res.status === 409 || code === "already_redeemed") {
      setState("ERROR_REDEEMED");
      return;
    }
    // 4xx with server-side validation error → return to form with message
    if (res.status >= 400 && res.status < 500 && code) {
      autoRetryUsed = false;
      setState("FORM");
      showSubmitError((res.data && res.data.message) || "That password was rejected. Try another one.");
      return;
    }

    // 5xx, network, or unknown — transient
    if (!isAutoRetry && !autoRetryUsed) {
      autoRetryUsed = true;
      setState("ERROR_RETRY");
      const meta = $("#error-retry-meta");
      if (meta) meta.textContent = "Auto-retrying in a moment.";
      setTimeout(() => { runRedeem(true); }, CFG.AUTO_RETRY_DELAY_MS || 1500);
      return;
    }
    setState("ERROR_FATAL");
  }

  // ── Boot ─────────────────────────────────────────────────────
  function bindForm() {
    const form = $("#bootstrap-form");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      clearFieldErrors();
      clearSubmitError();
      const allOk = revalidateChecklist();
      if (!allOk) {
        showFieldError("new_password", "Doesn't meet the requirements yet.");
        return;
      }
      const pw = $("#new-password-input").value || "";
      lastPayload = {
        token: tokenString,
        username: usernameFromURL,
        password: pw
      };
      autoRetryUsed = false;
      runRedeem(false);
    });

    const pwInput = $("#new-password-input");
    if (pwInput) pwInput.addEventListener("input", () => {
      const fieldEl = document.querySelector('.field[data-field="new_password"]');
      if (fieldEl && fieldEl.classList.contains("invalid")) {
        fieldEl.classList.remove("invalid");
        const err = fieldEl.querySelector(".error-msg");
        if (err) { err.textContent = ""; err.hidden = true; }
      }
      clearSubmitError();
      revalidateChecklist();
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
    const parsed = parseURL();
    if (!parsed) {
      setState("INVALID");
      return;
    }
    tokenString = parsed.token;
    usernameFromURL = parsed.username;
    const display = $("#username-display");
    if (display) {
      display.textContent = usernameFromURL;
      display.setAttribute("data-empty", "false");
    }
    revalidateChecklist();
    setState("FORM");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
