/* ProjectKidCreations — phase-two/app.js
 * 9-state machine for token verification + profile creation.
 * States: LOADING, INVALID, EXPIRED, ALREADY_DONE, FORM, SUBMITTING, SUCCESS, ERROR_RETRY, ERROR_FATAL
 */

(function () {
  "use strict";

  const CFG = window.PKC_PHASE_TWO;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const stage = $("#stage");
  const status = $("#status");

  let state = "LOADING";
  let tokenString = null;
  let verifyData = null;
  let formEnteredAt = null;
  let abandonTimer = null;
  let loadingTimer = null;
  let autoRetryUsed = false;

  // ──────────────────────────────────────────────
  // Token parsing — runs before any network call
  // ──────────────────────────────────────────────

  function safeParseToken() {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("token") || "").trim();
    if (!raw) return null;
    if (!raw.includes(".")) return null;
    const [payloadB64, sigB64] = raw.split(".");
    if (!payloadB64 || !sigB64) return null;
    if (payloadB64.length < 4 || sigB64.length < 8) return null;
    return raw;
  }

  function tokenPayloadHash(t) {
    // Cheap stable hash of just the payload portion (NOT the secret-bearing sig).
    // Used so PAGE_OPENED is correlatable before VERIFY runs without leaking the sig.
    if (!t) return null;
    const payload = t.split(".")[0] || "";
    let h = 5381;
    for (let i = 0; i < payload.length; i++) h = ((h << 5) + h) ^ payload.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  // ──────────────────────────────────────────────
  // Fire-and-forget client events
  // ──────────────────────────────────────────────

  function emitClientEvent(event_type, extra) {
    try {
      const body = JSON.stringify({
        event_type,
        submissionId: (verifyData && verifyData.submissionId) || null,
        data: extra || {}
      });
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon && navigator.sendBeacon(CFG.EVENT_URL, blob)) return;
      fetch(CFG.EVENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        mode: "cors"
      }).catch(() => {});
    } catch (_) { /* swallow */ }
  }

  // ──────────────────────────────────────────────
  // State transitions
  // ──────────────────────────────────────────────

  function setState(next) {
    if (state === next) return;
    state = next;
    $$(".state").forEach((el) => {
      const active = el.getAttribute("data-state") === next;
      el.setAttribute("data-active", active ? "true" : "false");
      el.setAttribute("aria-hidden", active ? "false" : "true");
    });
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
    if (next === "LOADING") {
      status.textContent = "Checking your link";
      status.removeAttribute("data-tone");
      loadingTimer = setTimeout(() => {
        if (state === "LOADING") setError(true, "Checking your link took longer than expected.");
      }, CFG.LOADING_TIMEOUT_MS);
    } else if (next === "FORM") {
      status.textContent = "Choose a username";
      status.removeAttribute("data-tone");
      formEnteredAt = Date.now();
      setupAbandonWatcher();
    } else if (next === "SUBMITTING") {
      status.textContent = "Saving your profile";
      status.removeAttribute("data-tone");
    } else if (next === "SUCCESS") {
      status.textContent = "All set";
      status.setAttribute("data-tone", "success");
      teardownAbandonWatcher();
    } else if (next === "ALREADY_DONE") {
      status.textContent = "Profile ready";
      status.setAttribute("data-tone", "success");
    } else if (next === "INVALID" || next === "EXPIRED") {
      status.textContent = next === "EXPIRED" ? "Link expired" : "Link not recognized";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_RETRY") {
      status.textContent = "Retrying";
      status.setAttribute("data-tone", "error");
    } else if (next === "ERROR_FATAL") {
      status.textContent = "Something went wrong";
      status.setAttribute("data-tone", "error");
    }
  }

  function setError(retryable, metaText) {
    if (retryable) {
      const meta = $("#error-retry-meta");
      if (meta && metaText) meta.textContent = metaText;
      setState("ERROR_RETRY");
    } else {
      const meta = $("#error-fatal-meta");
      if (meta && metaText) meta.textContent = metaText;
      setState("ERROR_FATAL");
    }
  }

  // ──────────────────────────────────────────────
  // Abandonment watcher
  // ──────────────────────────────────────────────

  function setupAbandonWatcher() {
    if (abandonTimer) clearTimeout(abandonTimer);
    abandonTimer = setTimeout(() => { abandonTimer = "armed"; }, CFG.ABANDON_AFTER_MS);
    window.addEventListener("pagehide", maybeEmitAbandon, { once: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") maybeEmitAbandon();
    });
  }

  function teardownAbandonWatcher() {
    if (abandonTimer && abandonTimer !== "armed") clearTimeout(abandonTimer);
    abandonTimer = null;
  }

  function maybeEmitAbandon() {
    if (state !== "FORM") return;
    if (abandonTimer !== "armed") return;
    abandonTimer = null;
    const time_in_form_ms = Date.now() - (formEnteredAt || Date.now());
    emitClientEvent("PHASE_TWO_FORM_ABANDONED", { time_in_form_ms });
  }

  // ──────────────────────────────────────────────
  // API helpers
  // ──────────────────────────────────────────────

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      mode: "cors",
      credentials: "omit"
    });
    if (!res.ok) {
      // Treat HTTP-level failures as retryable SERVER_ERROR
      return { ok: false, code: "SERVER_ERROR", message: "Network or server error.", retryable: true };
    }
    let data;
    try { data = await res.json(); } catch (_) {
      return { ok: false, code: "SERVER_ERROR", message: "Bad response from server.", retryable: true };
    }
    if (data && data.api_version && data.api_version !== CFG.EXPECTED_API_VERSION) {
      console.warn("[phase-two] api_version mismatch", data.api_version, "expected", CFG.EXPECTED_API_VERSION);
    }
    return data;
  }

  // ──────────────────────────────────────────────
  // Verify
  // ──────────────────────────────────────────────

  async function runVerify() {
    setState("LOADING");
    const res = await postJSON(CFG.VERIFY_URL, { token: tokenString });
    if (!res.ok) {
      if (res.code === "INVALID_TOKEN") return setState("INVALID");
      if (res.code === "EXPIRED")       return setState("EXPIRED");
      if (res.code === "ALREADY_COMPLETED") {
        return showAlreadyDone(res.data || {});
      }
      return setError(!!res.retryable, "We couldn't check your link just now.");
    }
    verifyData = res.data || {};
    if (verifyData.already_completed) {
      return showAlreadyDone(verifyData);
    }
    emitClientEvent("PHASE_TWO_VERIFIED", { submissionId: verifyData.submissionId });
    showForm(verifyData);
  }

  function showAlreadyDone(data) {
    $("#already-username").textContent = data.existing_username || data.username || "—";
    $("#already-completed").textContent = (data.completed_at || "").replace("T", " ").slice(0, 19) || "—";
    setState("ALREADY_DONE");
  }

  // ──────────────────────────────────────────────
  // Form
  // ──────────────────────────────────────────────

  function showForm(data) {
    const greeting = (data.firstName || "").trim();
    $("#form-greeting").textContent = greeting ? `HI, ${greeting.toUpperCase()}` : "WELCOME";
    $("#form-email").textContent = data.email || "—";
    setState("FORM");
    setTimeout(() => { $("#username-input").focus(); }, 200);
  }

  function readForm() {
    const username = ($("#username-input").value || "").trim().toLowerCase();
    const notifications_enabled = $("#notif-input").checked;
    const theme = $("#theme-input").checked ? "dark" : "light";
    return { username, notifications_enabled, theme };
  }

  function validateClient(values) {
    if (!/^[a-z0-9_-]{3,24}$/.test(values.username)) {
      return "Username must be 3-24 characters: lowercase letters, numbers, hyphen, or underscore.";
    }
    return null;
  }

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

  // ──────────────────────────────────────────────
  // Save
  // ──────────────────────────────────────────────

  async function runSave(values, isAutoRetry) {
    setState("SUBMITTING");
    const res = await postJSON(CFG.SAVE_URL, {
      token: tokenString,
      username: values.username,
      notifications_enabled: values.notifications_enabled,
      theme: values.theme
    });
    if (!res.ok) {
      if (res.code === "INVALID_TOKEN") return setState("INVALID");
      if (res.code === "EXPIRED")       return setState("EXPIRED");
      if (res.code === "ALREADY_COMPLETED") return showAlreadyDone(res.data || values);
      if (res.code === "USERNAME_TAKEN") {
        setState("FORM");
        showFieldError("username", "That username is taken. Try another.");
        return;
      }
      if (res.code === "VALIDATION_ERROR") {
        setState("FORM");
        showFieldError("username", res.message || "Please check your input.");
        return;
      }
      // RATE_LIMITED / SERVER_ERROR / unknown
      if (res.retryable && !isAutoRetry && !autoRetryUsed) {
        autoRetryUsed = true;
        const meta = $("#error-retry-meta");
        if (meta) meta.textContent = "We'll try again in just a moment.";
        setState("ERROR_RETRY");
        setTimeout(() => { runSave(values, true); }, CFG.AUTO_RETRY_DELAY_MS);
        return;
      }
      return setError(!!res.retryable, "We weren't able to save your profile.");
    }
    showSuccess(res.data || {});
  }

  function showSuccess(data) {
    const u = data.username || "—";
    const greet = (verifyData && verifyData.firstName) ? verifyData.firstName.toUpperCase() : "FRIEND";
    $("#success-greeting").textContent = `WELCOME, ${greet}.`;
    $("#success-username").textContent = u;
    if (data.persisted === false) {
      $("#success-test-banner").hidden = false;
    }
    setState("SUCCESS");
  }

  // ──────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────

  // ──────────────────────────────────────────────
  // Theme + preferences
  // ──────────────────────────────────────────────

  const THEME_KEY = "pkc-phase-two-theme";

  function applyTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (_) {}
  }

  function initThemeFromStorage() {
    let stored = "dark";
    try { stored = localStorage.getItem(THEME_KEY) || "dark"; } catch (_) {}
    const isDark = stored !== "light";
    applyTheme(isDark ? "dark" : "light");
    const themeInput = $("#theme-input");
    if (themeInput) themeInput.checked = isDark;
  }

  function init() {
    tokenString = safeParseToken();
    emitClientEvent("PHASE_TWO_PAGE_OPENED", { token_payload_hash: tokenPayloadHash(tokenString) });
    initThemeFromStorage();

    if (!tokenString) {
      const meta = $("#invalid-meta");
      if (meta) meta.textContent = "This link looks incomplete. Please use the link from your email.";
      setState("INVALID");
      return;
    }

    runVerify();

    const form = $("#profile-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      clearFieldErrors();
      const values = readForm();
      const localErr = validateClient(values);
      if (localErr) {
        showFieldError("username", localErr);
        return;
      }
      runSave(values, false);
    });

    const usernameInput = $("#username-input");
    usernameInput.addEventListener("input", () => {
      // Live-normalize as user types, but preserve cursor position
      const v = usernameInput.value;
      const nv = v.toLowerCase();
      if (v !== nv) {
        const pos = usernameInput.selectionStart;
        usernameInput.value = nv;
        try { usernameInput.setSelectionRange(pos, pos); } catch (_) {}
      }
      clearFieldErrors();
    });

    const themeInput = $("#theme-input");
    if (themeInput) {
      themeInput.addEventListener("change", () => {
        applyTheme(themeInput.checked ? "dark" : "light");
      });
    }

    $("#retry-btn").addEventListener("click", () => {
      autoRetryUsed = false;
      const values = readForm();
      const localErr = validateClient(values);
      if (localErr) {
        setState("FORM");
        showFieldError("username", localErr);
        return;
      }
      runSave(values, false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
