/* ProjectKidCreations — account/forgot/app.js
 * Request a password reset email.
 *
 * States: LOADING (very brief) -> FORM -> SUBMITTING -> SUCCESS
 *         (always shown on 200; backend opacity rule) -> ERROR_RETRY -> ERROR_FATAL
 *
 * Opacity contract: the backend returns 200 whether or not the email is
 * known. This frontend MUST NOT differentiate copy between found and
 * not-found. The whole point is no enumeration signal.
 */

(function () {
  "use strict";

  const CFG = window.PKC_FORGOT_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const status = $("#status");

  // ── State ────────────────────────────────────────────────────
  let state = "LOADING";
  let autoRetryUsed = false;
  let lastEmail = "";

  // ── State machine ────────────────────────────────────────────
  function setState(next) {
    if (state === next) return;
    state = next;
    $$(".state").forEach((el) => {
      const active = el.getAttribute("data-state") === next;
      el.setAttribute("data-active", active ? "true" : "false");
      el.setAttribute("aria-hidden", active ? "false" : "true");
    });
    if (next === "FORM") {
      status.textContent = "Enter your email";
      status.removeAttribute("data-tone");
    } else if (next === "SUBMITTING") {
      status.textContent = "Sending reset link";
      status.removeAttribute("data-tone");
    } else if (next === "SUCCESS") {
      status.textContent = "Reset queued";
      status.setAttribute("data-tone", "success");
    } else if (next === "ERROR_RETRY") {
      status.textContent = "Retrying";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_FATAL") {
      status.textContent = "Couldn't send";
      status.setAttribute("data-tone", "error");
    }
  }

  // ── Validation ───────────────────────────────────────────────
  function validateEmail(v) {
    const trimmed = (v || "").trim();
    if (!trimmed) return "Email is required.";
    // Lightweight check — backend is canonical.
    if (trimmed.length > 254) return "That email is too long.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "That doesn't look like an email.";
    return null;
  }

  function showFieldError(field, msg) {
    const errEl = $("#" + field + "-error");
    if (errEl) {
      if (msg) {
        errEl.textContent = msg;
        errEl.hidden = false;
      } else {
        errEl.textContent = "";
        errEl.hidden = true;
      }
    }
  }

  function clearFieldErrors() {
    showFieldError("email", null);
    const submitErr = $("#submit-error");
    if (submitErr) { submitErr.hidden = true; submitErr.textContent = ""; }
  }

  // ── Fetch wrapper ────────────────────────────────────────────
  function fetchJSON(url, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.FETCH_TIMEOUT_MS || 12000);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .then((res) => {
        const ct = res.headers.get("content-type") || "";
        const isJSON = ct.includes("application/json");
        return (isJSON ? res.json() : res.text().then(() => ({}))).then((body) => ({
          ok: res.ok,
          status: res.status,
          body: body || {}
        }));
      })
      .finally(() => clearTimeout(t));
  }

  // ── Submit ───────────────────────────────────────────────────
  function setError(retryable, message) {
    const target = retryable ? "ERROR_RETRY" : "ERROR_FATAL";
    const metaEl = $(retryable ? "#error-retry-meta" : "#error-fatal-meta");
    if (metaEl && message) metaEl.textContent = message;
    setState(target);
  }

  async function runSubmit(isAutoRetry) {
    setState("SUBMITTING");
    let res;
    try {
      res = await fetchJSON(CFG.REQUEST_RESET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: lastEmail })
      });
    } catch (_) {
      res = { ok: false, status: 0, body: {} };
    }

    // Opacity rule — any 2xx is a success, no matter what the body says.
    if (res.ok) {
      setState("SUCCESS");
      return;
    }

    // 429 — too many requests. Treat as retryable with a soft message.
    if (res.status === 429) {
      return setError(true, "Too many requests. Wait a moment and try again.");
    }

    // 4xx that isn't a rate limit — treat as fatal. Backend rejected the shape.
    if (res.status >= 400 && res.status < 500 && res.status !== 408) {
      return setError(false, "We couldn't process that request.");
    }

    // Network / 5xx — auto-retry once.
    if (!isAutoRetry && !autoRetryUsed) {
      autoRetryUsed = true;
      const meta = $("#error-retry-meta");
      if (meta) meta.textContent = "Auto-retrying in a moment.";
      setState("ERROR_RETRY");
      setTimeout(() => runSubmit(true), CFG.AUTO_RETRY_DELAY_MS || 1500);
      return;
    }
    setError(true, "We couldn't reach the server. Try again.");
  }

  // ── Bind ─────────────────────────────────────────────────────
  function bind() {
    const form = $("#forgot-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        clearFieldErrors();
        const v = ($("#email-input").value || "").trim();
        const err = validateEmail(v);
        if (err) {
          showFieldError("email", err);
          $("#email-input").focus();
          return;
        }
        lastEmail = v;
        autoRetryUsed = false;
        runSubmit(false);
      });
    }

    const retry = $("#retry-btn");
    if (retry) retry.addEventListener("click", () => {
      autoRetryUsed = false;
      runSubmit(false);
    });

    const fatalRetry = $("#fatal-retry-btn");
    if (fatalRetry) fatalRetry.addEventListener("click", () => {
      autoRetryUsed = false;
      setState("FORM");
    });

    // Live-clear error on input.
    const emailInput = $("#email-input");
    if (emailInput) emailInput.addEventListener("input", () => showFieldError("email", null));
  }

  // ── Boot ─────────────────────────────────────────────────────
  function boot() {
    bind();
    // LOADING -> FORM immediately. Nothing async to wait on.
    setState("FORM");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
