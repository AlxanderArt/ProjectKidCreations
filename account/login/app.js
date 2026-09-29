import QRCode from "qrcode";

/* ProjectKidCreations — account login + founder MFA state machine. */
(function () {
  "use strict";

  const CFG = window.PKC_ACCOUNT_CONFIG;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const usernamePolicy = window.PKCUsernamePolicy;
  const SAFE_POST_LOGIN_PATHS = new Set(["/account/", "/account/admin/"]);
  const MFA_PANELS = [
    "#mfa-loading-panel", "#mfa-enrollment-panel", "#mfa-verify-panel",
    "#mfa-code-form", "#mfa-recovery-form", "#mfa-codes-panel",
    "#mfa-unknown-panel", "#mfa-reenroll-panel",
  ];

  let state = "LOADING";
  let lockCountdownTimer = null;
  let lockEndsAt = null;
  let invalidHoldTimer = null;
  let pendingLoginPayload = null;
  let mfaCsrf = null;
  let mfaFinalizeId = null;

  const status = $("#status");

  const navigateRoute = (url, { replace = true, reason = "login" } = {}) => {
    if (window.PKCMotion?.navigate(url, { replace, reason })) return;
    if (replace) window.location.replace(url);
    else window.location.assign(url);
  };

  function safePostLoginPath(raw) {
    const next = typeof raw === "string" ? raw.trim() : "";
    if (!next || next.includes("\\")) return null;
    try {
      const url = new URL(next, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      if (url.search || url.hash || !SAFE_POST_LOGIN_PATHS.has(url.pathname)) return null;
      return url.pathname;
    } catch (_) {
      return null;
    }
  }

  (function applyContextCopy() {
    try {
      const next = safePostLoginPath(new URL(location.href).searchParams.get("next"));
      if (next !== "/account/admin/") return;
      $$("[data-admin-text]").forEach((element) => {
        const value = element.getAttribute("data-admin-text");
        if (value) element.textContent = value;
      });
      $$("[data-admin-aria]").forEach((element) => {
        const value = element.getAttribute("data-admin-aria");
        if (value) element.setAttribute("aria-label", value);
      });
      const escape = $("#role-switch-link");
      if (escape) escape.hidden = false;
    } catch (_) { /* preserve default copy */ }
  })();

  function clearStateTimers() {
    if (invalidHoldTimer) {
      clearTimeout(invalidHoldTimer);
      invalidHoldTimer = null;
    }
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    $$(".state").forEach((element) => {
      const active = element.getAttribute("data-state") === next;
      element.setAttribute("data-active", active ? "true" : "false");
      element.setAttribute("aria-hidden", active ? "false" : "true");
    });
    clearStateTimers();

    const labels = {
      LOADING: ["Checking session", null], FORM: ["Awaiting credentials", null],
      SUBMITTING: ["Authenticating", null], SUCCESS: ["Signed in", "success"],
      MFA: ["Additional verification required", null], LOCKED: ["Account locked", "error"],
      ERROR_INVALID: ["Wrong credentials", "error"], ERROR_RETRY: ["Result unknown", "error"],
      ERROR_FATAL: ["Something went wrong", "error"],
    };
    const [text, tone] = labels[next] || labels.ERROR_FATAL;
    status.textContent = text;
    if (tone) status.setAttribute("data-tone", tone);
    else status.removeAttribute("data-tone");

    if (next === "FORM") {
      enableLoginForm(true);
      setTimeout(() => {
        const username = $("#username-input");
        const passwordInput = $("#password-input");
        if (username && !username.value) username.focus();
        else passwordInput?.focus();
      }, 60);
    } else if (next === "SUBMITTING") {
      enableLoginForm(false);
    } else if (next === "ERROR_INVALID") {
      invalidHoldTimer = setTimeout(() => {
        if (state === "ERROR_INVALID") {
          showSubmitError("Wrong username or password.");
          setState("FORM");
        }
      }, CFG.INVALID_HOLD_MS || 2000);
    } else if (next === "ERROR_FATAL") {
      $("#fatal-retry-btn")?.focus();
    }
  }

  function enableLoginForm(enabled) {
    $$("#username-input, #password-input").forEach((element) => { element.disabled = !enabled; });
    const button = $("#submit-btn");
    if (!button) return;
    button.disabled = !enabled;
    button.setAttribute("aria-busy", enabled ? "false" : "true");
    const label = $("#submit-label");
    if (label) label.textContent = enabled ? "SIGN IN" : "SIGNING IN...";
  }

  function showMessage(selector, message) {
    const element = $(selector);
    if (!element) return;
    element.textContent = message || "";
    element.hidden = !message;
  }

  function showMfaFieldError(inputSelector, errorSelector, message) {
    const input = $(inputSelector);
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
    showMessage(errorSelector, message);
  }

  function showSubmitError(message) { showMessage("#submit-error", message); }
  function clearSubmitError() { showSubmitError(""); }

  function showFieldError(field, message) {
    const fieldElement = document.querySelector(`.field[data-field="${field}"]`);
    if (!fieldElement) return;
    fieldElement.classList.add("invalid");
    const error = fieldElement.querySelector(".error-msg");
    if (error) {
      error.textContent = message || "";
      error.hidden = !message;
    }
  }

  function clearFieldErrors() {
    $$(".field.invalid").forEach((element) => element.classList.remove("invalid"));
    $$(".error-msg").forEach((element) => {
      element.textContent = "";
      element.hidden = true;
    });
  }

  async function fetchJSON(url, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CFG.FETCH_TIMEOUT_MS || 12000);
    let response;
    try {
      response = await fetch(url, Object.assign({
        credentials: "include",
        mode: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      }, opts));
    } catch (_) {
      clearTimeout(timeout);
      return { ok: false, status: 0, networkError: true, data: null };
    }
    clearTimeout(timeout);
    let data = null;
    try { data = await response.json(); } catch (_) { /* closed handling below */ }
    return { ok: response.ok, status: response.status, networkError: false, data };
  }

  function resolvePostLoginDest() {
    try {
      const safe = safePostLoginPath(new URL(location.href).searchParams.get("next"));
      if (safe) return safe;
    } catch (_) { /* use default */ }
    return CFG.ACCOUNT_HOME;
  }

  function freshLoginAttemptId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function validateLocal() {
    clearFieldErrors();
    clearSubmitError();
    const username = ($("#username-input").value || "").trim();
    const loginCredential = $("#password-input").value || "";
    let valid = true;
    if (!usernamePolicy || !usernamePolicy.isAllowedLoginUsername(username)) {
      showFieldError("username", "Use your assigned login username.");
      valid = false;
    }
    if (loginCredential.length < 8) {
      showFieldError("password", "At least 8 characters.");
      valid = false;
    }
    return valid ? { username, password: loginCredential, login_attempt_id: freshLoginAttemptId() } : null;
  }

  function showMfaPanel(...selectors) {
    const visible = new Set(selectors);
    MFA_PANELS.forEach((selector) => {
      const element = $(selector);
      if (element) element.hidden = !visible.has(selector);
    });
    if (visible.has("#mfa-unknown-panel")) $("#mfa-finalize-retry")?.focus();
  }

  function clearEnrollmentMaterial() {
    const image = $("#mfa-qr");
    if (image) image.removeAttribute("src");
    const secretElement = $("#mfa-manual-secret");
    if (secretElement) secretElement.textContent = "";
  }

  function clearMfaDom() {
    clearEnrollmentMaterial();
    const codes = $("#mfa-recovery-codes");
    if (codes) codes.replaceChildren();
    const code = $("#mfa-code-input");
    const recovery = $("#mfa-recovery-input");
    if (code) code.value = "";
    if (recovery) recovery.value = "";
    showMfaFieldError("#mfa-code-input", "#mfa-error", "");
    showMfaFieldError("#mfa-recovery-input", "#mfa-recovery-error", "");
  }

  function resetMfaMemory() {
    mfaCsrf = null;
    mfaFinalizeId = null;
    clearMfaDom();
  }

  async function beginMfa(mode, csrf) {
    pendingLoginPayload = null;
    $("#password-input").value = "";
    mfaCsrf = csrf;
    setState("MFA");
    showMfaPanel("#mfa-loading-panel");

    const submitLabel = $("#mfa-code-submit-label");
    if (submitLabel) submitLabel.textContent = mode === "enroll" ? "CONFIRM AUTHENTICATOR" : "VERIFY AUTHENTICATOR";

    if (mode === "verify") {
      showMfaPanel("#mfa-verify-panel", "#mfa-code-form");
      $("#mfa-code-input")?.focus();
      return;
    }
    if (mode !== "enroll") {
      setState("ERROR_FATAL");
      return;
    }

    const response = await fetchJSON(CFG.MFA_ENROLL_URL, {
      method: "POST",
      body: JSON.stringify({ csrf: mfaCsrf }),
    });
    if (!response.ok || response.data?.status !== "enrollment_required"
      || typeof response.data.manualSecret !== "string"
      || typeof response.data.otpauthUri !== "string") {
      setState("ERROR_FATAL");
      return;
    }
    try {
      const qrData = await QRCode.toDataURL(response.data.otpauthUri, {
        errorCorrectionLevel: "M", margin: 1, width: 240,
        color: { dark: "#000000", light: "#ffffff" },
      });
      $("#mfa-qr").src = qrData;
      $("#mfa-manual-secret").textContent = response.data.manualSecret;
      showMfaPanel("#mfa-enrollment-panel", "#mfa-code-form");
      $("#mfa-code-input")?.focus();
    } catch (_) {
      clearEnrollmentMaterial();
      setState("ERROR_FATAL");
    }
  }

  async function finalizeMfa() {
    if (!mfaCsrf || !mfaFinalizeId) return;
    showMfaPanel("#mfa-loading-panel");
    const response = await fetchJSON(CFG.MFA_FINALIZE_URL, {
      method: "POST",
      body: JSON.stringify({ csrf: mfaCsrf, finalizeId: mfaFinalizeId }),
    });
    if (response.ok && response.data?.status === "authenticated") {
      resetMfaMemory();
      setState("SUCCESS");
      setTimeout(() => navigateRoute(resolvePostLoginDest(), { reason: "mfa-auth-success" }), 350);
      return;
    }
    const ambiguous = response.networkError
      || response.status === 0
      || response.status === 202
      || response.status >= 500
      || response.data == null
      || response.data?.status === "unknown";
    if (ambiguous) {
      showMfaPanel("#mfa-unknown-panel");
      return;
    }
    setState("ERROR_FATAL");
  }

  async function verifyMfaCode() {
    showMfaFieldError("#mfa-code-input", "#mfa-error", "");
    const input = $("#mfa-code-input");
    const code = (input.value || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      showMfaFieldError("#mfa-code-input", "#mfa-error", "Enter the six-digit code from your authenticator app.");
      input.focus();
      return;
    }
    input.disabled = true;
    const response = await fetchJSON(CFG.MFA_VERIFY_URL, {
      method: "POST",
      body: JSON.stringify({ csrf: mfaCsrf, code }),
    });
    input.value = "";
    input.disabled = false;
    if (!response.ok || response.data?.status !== "finalize_pending" || typeof response.data.finalizeId !== "string") {
      showMfaFieldError("#mfa-code-input", "#mfa-error", "That code could not be verified. Try the next code.");
      input.focus();
      return;
    }
    mfaFinalizeId = response.data.finalizeId;
    clearEnrollmentMaterial();
    if (Array.isArray(response.data.recoveryCodes) && response.data.recoveryCodes.length > 0) {
      const list = $("#mfa-recovery-codes");
      list.replaceChildren(...response.data.recoveryCodes.map((value) => {
        const item = document.createElement("li");
        item.textContent = String(value);
        return item;
      }));
      showMfaPanel("#mfa-codes-panel");
      $("#mfa-codes-confirm")?.focus();
      return;
    }
    await finalizeMfa();
  }

  async function useRecoveryCode() {
    showMfaFieldError("#mfa-recovery-input", "#mfa-recovery-error", "");
    const input = $("#mfa-recovery-input");
    const code = (input.value || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){6}$/.test(code)) {
      showMfaFieldError("#mfa-recovery-input", "#mfa-recovery-error", "Enter one complete recovery code.");
      input.focus();
      return;
    }
    input.disabled = true;
    const response = await fetchJSON(CFG.MFA_RECOVERY_URL, {
      method: "POST",
      body: JSON.stringify({ csrf: mfaCsrf, code }),
    });
    input.value = "";
    input.disabled = false;
    if (response.ok && response.data?.status === "reenrollment_required") {
      mfaCsrf = null;
      showMfaPanel("#mfa-reenroll-panel");
      $("#mfa-return-login")?.focus();
      return;
    }
    showMfaFieldError("#mfa-recovery-input", "#mfa-recovery-error", "That recovery code could not be used.");
    input.focus();
  }

  async function runLogin(payload) {
    setState("SUBMITTING");
    const response = await fetchJSON(CFG.LOGIN_URL, { method: "POST", body: JSON.stringify(payload) });

    if (response.ok && response.data?.status === "mfa_required") {
      if (!["enroll", "verify"].includes(response.data.mode) || typeof response.data.csrf !== "string") {
        setState("ERROR_FATAL");
        return;
      }
      await beginMfa(response.data.mode, response.data.csrf);
      return;
    }
    if (response.ok && response.data?.ok === true) {
      pendingLoginPayload = null;
      setState("SUCCESS");
      setTimeout(() => navigateRoute(resolvePostLoginDest(), { reason: "auth-success" }), 350);
      return;
    }

    const code = response.data?.error || null;
    if (response.status === 401 || code === "invalid_credentials") {
      pendingLoginPayload = null;
      setState("ERROR_INVALID");
      return;
    }
    if (response.status === 423 || code === "account_locked") {
      pendingLoginPayload = null;
      startLockCountdown(Number(response.data?.seconds_remaining) || 0);
      setState("LOCKED");
      return;
    }
    if (response.status >= 400 && response.status < 500 && code && code !== "invalid_credentials") {
      pendingLoginPayload = null;
      showSubmitError(response.data?.message || "Sign-in was rejected. Check your input.");
      setState("FORM");
      return;
    }
    setState("ERROR_RETRY");
  }

  function startLockCountdown(seconds) {
    stopLockCountdown();
    lockEndsAt = Date.now() + Math.max(0, seconds) * 1000;
    renderLockCountdown();
    lockCountdownTimer = setInterval(renderLockCountdown, 1000);
  }
  function stopLockCountdown() {
    if (lockCountdownTimer) clearInterval(lockCountdownTimer);
    lockCountdownTimer = null;
  }
  function renderLockCountdown() {
    const element = $("#lock-countdown");
    if (!element || lockEndsAt == null) return;
    const remaining = Math.max(0, Math.round((lockEndsAt - Date.now()) / 1000));
    element.textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining <= 0) {
      stopLockCountdown();
      setState("FORM");
      showSubmitError("");
    }
  }

  async function probeSession() {
    const response = await fetchJSON(CFG.PROFILE_URL, { method: "GET" });
    if (response.ok && response.data && response.data.ok !== false) {
      status.textContent = "Already signed in";
      status.setAttribute("data-tone", "success");
      navigateRoute(resolvePostLoginDest(), { reason: "already-authenticated" });
      return;
    }
    setState("FORM");
  }

  function bindForms() {
    $("#login-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = validateLocal();
      if (!payload) return;
      pendingLoginPayload = payload;
      runLogin(pendingLoginPayload);
    });
    $$("#username-input, #password-input").forEach((element) => {
      element.addEventListener("input", () => {
        pendingLoginPayload = null;
        clearSubmitError();
        clearFieldErrors();
      });
    });
    $("#retry-btn")?.addEventListener("click", () => {
      if (pendingLoginPayload) runLogin(pendingLoginPayload);
      else setState("FORM");
    });
    $("#fatal-retry-btn")?.addEventListener("click", () => {
      if (pendingLoginPayload) runLogin(pendingLoginPayload);
      else setState("FORM");
    });
    $("#mfa-code-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      verifyMfaCode();
    });
    $("#mfa-code-input")?.addEventListener("input", () => {
      showMfaFieldError("#mfa-code-input", "#mfa-error", "");
    });
    $("#show-recovery-btn")?.addEventListener("click", () => {
      showMfaPanel("#mfa-recovery-form");
      $("#mfa-recovery-input")?.focus();
    });
    $("#cancel-recovery-btn")?.addEventListener("click", () => {
      showMfaPanel("#mfa-verify-panel", "#mfa-code-form");
      $("#mfa-code-input")?.focus();
    });
    $("#mfa-recovery-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      useRecoveryCode();
    });
    $("#mfa-recovery-input")?.addEventListener("input", () => {
      showMfaFieldError("#mfa-recovery-input", "#mfa-recovery-error", "");
    });
    $("#mfa-codes-confirm")?.addEventListener("click", () => {
      $("#mfa-recovery-codes")?.replaceChildren();
      finalizeMfa();
    });
    $("#mfa-finalize-retry")?.addEventListener("click", finalizeMfa);
    $("#mfa-return-login")?.addEventListener("click", () => {
      resetMfaMemory();
      clearSubmitError();
      setState("FORM");
    });
  }

  function init() {
    bindForms();
    probeSession();
  }

  window.addEventListener("pagehide", clearMfaDom);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pendingLoginPayload = null;
    resetMfaMemory();
    stopLockCountdown();
    clearStateTimers();
    clearSubmitError();
    const passwordInput = $("#password-input");
    if (passwordInput) passwordInput.value = "";
    showMfaPanel();
    state = "";
    setState("LOADING");
    probeSession();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
