/* ProjectKidCreations — account/reset/app.js
 * Complete password reset.
 *
 * States: LOADING -> INVALID (no token in URL) -> FORM -> SUBMITTING ->
 *         SUCCESS (auto-redirect to /account/login after 2s) ->
 *         ERROR_TOKEN (401 invalid_or_expired_token — funnel back to /account/forgot) ->
 *         ERROR_RETRY -> ERROR_FATAL
 *
 * The token comes from ?token=<base64url> in the URL. We pull it once at
 * boot, hold it in module scope, and POST it back with the new password.
 */

(function () {
  "use strict";

  const CFG = window.PKC_RESET_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const status = $("#status");

  // ── State ────────────────────────────────────────────────────
  let state = "LOADING";
  let token = null;
  let autoRetryUsed = false;
  let redirectTimer = null;

  // ── Token parsing ────────────────────────────────────────────
  // Just check shape (non-empty, base64url-ish). The backend is canonical;
  // we don't want to false-reject a token that's slightly different shape
  // than we expected.
  function safeParseToken() {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("token") || "").trim();
    if (!raw) return null;
    if (raw.length < 8) return null;
    return raw;
  }

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
      status.textContent = "Set a new password";
      status.removeAttribute("data-tone");
    } else if (next === "SUBMITTING") {
      status.textContent = "Saving password";
      status.removeAttribute("data-tone");
    } else if (next === "SUCCESS") {
      status.textContent = "Password updated";
      status.setAttribute("data-tone", "success");
    } else if (next === "INVALID") {
      status.textContent = "Link not recognized";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_TOKEN") {
      status.textContent = "Link expired";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_RETRY") {
      status.textContent = "Retrying";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_FATAL") {
      status.textContent = "Couldn't update";
      status.setAttribute("data-tone", "error");
    }
  }

  // ── Validation ───────────────────────────────────────────────
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
    showFieldError("new_password", null);
    showFieldError("confirm_password", null);
    const submitErr = $("#submit-error");
    if (submitErr) { submitErr.hidden = true; submitErr.textContent = ""; }
  }

  function checkRules(pw, confirm) {
    const length = pw.length >= 8 && pw.length <= 128;
    // "not all same char" — guards against `aaaaaaaa` / `11111111`.
    const variety = pw.length > 0 && !/^(.)\1+$/.test(pw);
    const match = pw.length > 0 && pw === confirm;
    return { length, variety, match };
  }

  function paintChecklist(rules) {
    $$("#password-checklist li").forEach((li) => {
      const rule = li.getAttribute("data-rule");
      const passed = !!rules[rule];
      li.setAttribute("data-passed", passed ? "true" : "false");
    });
  }

  function validateForm() {
    const pw = $("#new-password-input").value;
    const confirm = $("#confirm-password-input").value;
    const r = checkRules(pw, confirm);
    if (!r.length) return { field: "new_password", msg: "Use 8 to 128 characters." };
    if (!r.variety) return { field: "new_password", msg: "Don't repeat the same character." };
    if (!r.match) return { field: "confirm_password", msg: "Passwords don't match." };
    return null;
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
    const pw = $("#new-password-input").value;
    setState("SUBMITTING");
    let res;
    try {
      res = await fetchJSON(CFG.COMPLETE_RESET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, new_password: pw })
      });
    } catch (_) {
      res = { ok: false, status: 0, body: {} };
    }

    if (res.ok) {
      setState("SUCCESS");
      // Hard redirect — the user's session cookie state is now stale, and
      // /account/login is the right next surface to authenticate fresh.
      redirectTimer = setTimeout(() => {
        window.location.assign(CFG.LOGIN_URL || "/account/login");
      }, CFG.SUCCESS_REDIRECT_MS || 2000);
      return;
    }

    // 401 — invalid or expired token. Funnel back to /account/forgot.
    if (res.status === 401) {
      return setState("ERROR_TOKEN");
    }

    // 400 / 422 — backend validation. Show on submit-error, return to FORM.
    if (res.status === 400 || res.status === 422) {
      setState("FORM");
      const submitErr = $("#submit-error");
      if (submitErr) {
        submitErr.textContent = (res.body && res.body.message) || "We couldn't accept that password.";
        submitErr.hidden = false;
      }
      return;
    }

    // 429 — rate-limited.
    if (res.status === 429) {
      return setError(true, "Too many attempts. Wait a moment and try again.");
    }

    // Network / 5xx — retry once.
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
    const form = $("#reset-form");
    const pwInput = $("#new-password-input");
    const confirmInput = $("#confirm-password-input");

    function paint() {
      const r = checkRules(pwInput.value, confirmInput.value);
      paintChecklist(r);
    }

    if (pwInput) {
      pwInput.addEventListener("input", () => { paint(); showFieldError("new_password", null); });
    }
    if (confirmInput) {
      confirmInput.addEventListener("input", () => { paint(); showFieldError("confirm_password", null); });
    }

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        clearFieldErrors();
        const err = validateForm();
        if (err) {
          showFieldError(err.field, err.msg);
          const target = $("#" + (err.field === "new_password" ? "new-password-input" : "confirm-password-input"));
          if (target) target.focus();
          return;
        }
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
  }

  // ── Boot ─────────────────────────────────────────────────────
  function boot() {
    bind();
    token = safeParseToken();
    if (!token) {
      setState("INVALID");
      return;
    }
    setState("FORM");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
