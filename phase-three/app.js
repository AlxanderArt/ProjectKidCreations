/* ProjectKidCreations — phase-three/app.js
 * 11-state machine + 4-section form. Token verify → identity / loadout / logistics / review → save.
 *
 * States: LOADING, INVALID, EXPIRED, ALREADY_DONE, PHASE2_INCOMPLETE,
 *         FORM (with sections: identity, maker, contact, review),
 *         SUBMITTING, SUCCESS, ERROR_RETRY, ERROR_FATAL
 */

(function () {
  "use strict";

  const CFG = window.PKC_PHASE_THREE;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const status = $("#status");
  const toast = $("#toast");

  // ── State ────────────────────────────────────────────────────
  let state = "LOADING";
  let section = "identity";
  let tokenString = null;
  let verifyData = null;
  let formEnteredAt = null;
  let abandonTimer = null;
  let loadingTimer = null;
  let autoRetryUsed = false;
  let avatarUrl = null;
  let avatarBytes = 0;
  let lastUsernameChecked = null;
  let usernameAvailable = null; // null | true | false | "checking"
  let usernameDebounceTimer = null;
  let usernameLastSeq = 0;

  const tags = {
    blasters_owned: [],
    accessory_interests: []
  };

  const SECTION_ORDER = ["identity", "maker", "contact", "review"];
  const SECTION_LABELS = {
    identity: "IDENTITY MARKERS",
    maker: "LOADOUT INTERESTS",
    contact: "LOGISTICS + COMMS",
    review: "COMMIT BUILD"
  };

  // ── Token parsing ────────────────────────────────────────────
  function safeParseToken() {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("token") || "").trim();
    if (!raw || !raw.includes(".")) return null;
    const [p, s] = raw.split(".");
    if (!p || !s || p.length < 4 || s.length < 8) return null;
    return raw;
  }

  function tokenPayloadHash(t) {
    if (!t) return null;
    const payload = t.split(".")[0] || "";
    let h = 5381;
    for (let i = 0; i < payload.length; i++) h = ((h << 5) + h) ^ payload.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  // ── Telemetry ────────────────────────────────────────────────
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
    } catch (_) {}
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
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }

    if (next === "LOADING") {
      status.textContent = "Building your profile";
      status.removeAttribute("data-tone");
      loadingTimer = setTimeout(() => {
        if (state === "LOADING") setError(true, "Verification is taking longer than expected.");
      }, CFG.LOADING_TIMEOUT_MS);
    } else if (next === "FORM") {
      status.textContent = "Configure your profile";
      status.removeAttribute("data-tone");
      formEnteredAt = Date.now();
      setupAbandonWatcher();
      setSection("identity", { silent: true });
    } else if (next === "SUBMITTING") {
      status.textContent = "Committing profile";
      status.removeAttribute("data-tone");
    } else if (next === "SUCCESS") {
      status.textContent = "Locked in";
      status.setAttribute("data-tone", "success");
      teardownAbandonWatcher();
    } else if (next === "ALREADY_DONE") {
      status.textContent = "Profile ready";
      status.setAttribute("data-tone", "success");
    } else if (next === "INVALID") {
      status.textContent = "Link not recognized";
      status.setAttribute("data-tone", "error");
    } else if (next === "EXPIRED") {
      status.textContent = "Link expired";
      status.setAttribute("data-tone", "error");
    } else if (next === "PHASE2_INCOMPLETE") {
      status.textContent = "Phase two pending";
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

  function setSection(next, opts) {
    opts = opts || {};
    if (!SECTION_ORDER.includes(next)) return;
    if (!opts.silent && section === next) return;
    section = next;

    $$(".section").forEach((el) => {
      const active = el.getAttribute("data-section") === next;
      el.setAttribute("data-active", active ? "true" : "false");
      el.setAttribute("aria-hidden", active ? "false" : "true");
    });

    const idx = SECTION_ORDER.indexOf(next) + 1;
    $("#section-step").textContent = String(idx);
    $("#section-name").textContent = SECTION_LABELS[next];
    $$("[data-section-bar]").forEach((bar) => {
      const n = parseInt(bar.getAttribute("data-section-bar"), 10);
      bar.classList.toggle("filled", n <= idx);
    });
    const bar = $(".section-progress-bar");
    if (bar) bar.setAttribute("aria-valuenow", String(idx));

    if (next === "review") renderReview();

    // Focus the first focusable element in the new section
    setTimeout(() => {
      const live = document.querySelector(`.section[data-active="true"]`);
      if (!live) return;
      const focusable = live.querySelector("input, select, textarea, button");
      if (focusable) focusable.focus({ preventScroll: false });
    }, 80);

    if (!opts.silent) {
      saveDraft();
      emitClientEvent("PHASE_THREE_SECTION_ENTERED", { section: next });
    }
  }

  // ── Abandon watcher ──────────────────────────────────────────
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
    emitClientEvent("PHASE_THREE_FORM_ABANDONED", { time_in_form_ms, section });
  }

  // ── API helpers ──────────────────────────────────────────────
  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      mode: "cors",
      credentials: "omit"
    });
    if (!res.ok) {
      return { ok: false, code: "SERVER_ERROR", message: "Network or server error.", retryable: true };
    }
    let data;
    try { data = await res.json(); } catch (_) {
      return { ok: false, code: "SERVER_ERROR", message: "Bad response from server.", retryable: true };
    }
    if (data && data.api_version && data.api_version !== CFG.EXPECTED_API_VERSION) {
      console.warn("[phase-three] api_version mismatch", data.api_version, "expected", CFG.EXPECTED_API_VERSION);
    }
    return data;
  }

  // ── Verify ───────────────────────────────────────────────────
  async function runVerify() {
    setState("LOADING");
    const res = await postJSON(CFG.VERIFY_URL, { token: tokenString });
    if (!res.ok) {
      if (res.code === "INVALID_TOKEN") return setState("INVALID");
      if (res.code === "EXPIRED")       return setState("EXPIRED");
      if (res.code === "PHASE_TWO_NOT_REDEEMED") return setState("PHASE2_INCOMPLETE");
      if (res.code === "ALREADY_COMPLETED") {
        return showAlreadyDone(res.data || {});
      }
      return setError(!!res.retryable, "We couldn't verify your link.");
    }
    verifyData = res.data || {};
    if (verifyData.already_completed) return showAlreadyDone(verifyData);
    emitClientEvent("PHASE_THREE_VERIFIED", {});
    showForm(verifyData);
  }

  function showAlreadyDone(data) {
    $("#already-username").textContent = data.existing_username || data.username || "—";
    $("#already-completed").textContent = formatTime(data.completed_at);
    setState("ALREADY_DONE");
  }

  function formatTime(iso) {
    if (!iso) return "—";
    return iso.replace("T", " ").slice(0, 19);
  }

  function showForm(data) {
    const greeting = (data.firstName || data.display_name || "").trim();
    $("#form-greeting").textContent = greeting ? `HI, ${greeting.toUpperCase()}.` : "OPERATOR ONLINE";
    $("#form-email").textContent = data.email || "—";
    restoreDraft();
    setState("FORM");
  }

  // ── Draft persistence ────────────────────────────────────────
  function draftKey() {
    const id = verifyData && verifyData.submissionId;
    return id ? `pkc-phase-three-draft-${id}` : null;
  }

  function readForm() {
    const get = (id) => ($(id) ? $(id).value : "");
    const checked = (id) => ($(id) ? $(id).checked : false);
    return {
      display_name: get("#display-name-input").trim(),
      username: get("#username-input").trim().toLowerCase(),
      avatar_url: avatarUrl || null,
      bio: get("#bio-input").trim(),
      skill_level: (document.querySelector('input[name="skill_level"]:checked') || {}).value || "",
      blasters_owned: tags.blasters_owned.slice(),
      accessory_interests: tags.accessory_interests.slice(),
      socials: {
        insta: get("#social-insta").trim(),
        yt: get("#social-yt").trim(),
        tiktok: get("#social-tiktok").trim()
      },
      birthday: get("#birthday-input"),
      shipping: {
        line1: get("#ship-line1").trim(),
        line2: get("#ship-line2").trim(),
        city: get("#ship-city").trim(),
        region: get("#ship-region").trim(),
        postal: get("#ship-postal").trim(),
        country: get("#ship-country")
      },
      email_drops: checked("#email-drops-input"),
      sms_optin: checked("#sms-optin-input")
    };
  }

  function applyDraft(d) {
    if (!d) return;
    const set = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
    set("#display-name-input", d.display_name);
    set("#username-input", d.username);
    set("#bio-input", d.bio);
    if (d.skill_level) {
      const rb = document.querySelector(`input[name="skill_level"][value="${d.skill_level}"]`);
      if (rb) rb.checked = true;
    }
    tags.blasters_owned = Array.isArray(d.blasters_owned) ? d.blasters_owned.slice(0, 10) : [];
    tags.accessory_interests = Array.isArray(d.accessory_interests) ? d.accessory_interests.slice(0, 10) : [];
    renderTags("blasters_owned");
    renderTags("accessory_interests");
    if (d.socials) {
      set("#social-insta", d.socials.insta);
      set("#social-yt", d.socials.yt);
      set("#social-tiktok", d.socials.tiktok);
    }
    set("#birthday-input", d.birthday);
    if (d.shipping) {
      set("#ship-line1", d.shipping.line1);
      set("#ship-line2", d.shipping.line2);
      set("#ship-city", d.shipping.city);
      set("#ship-region", d.shipping.region);
      set("#ship-postal", d.shipping.postal);
      set("#ship-country", d.shipping.country);
    }
    if ($("#email-drops-input") && d.email_drops != null) $("#email-drops-input").checked = !!d.email_drops;
    if ($("#sms-optin-input") && d.sms_optin != null) $("#sms-optin-input").checked = !!d.sms_optin;
    if (d.avatar_url) {
      avatarUrl = d.avatar_url;
      avatarBytes = d.avatar_bytes || 0;
      showAvatarPreview(avatarUrl);
    }
    updateBioCounter();
  }

  function saveDraft() {
    const key = draftKey();
    if (!key) return;
    try {
      const v = readForm();
      v.avatar_bytes = avatarBytes;
      v._saved_at = Date.now();
      v._section = section;
      localStorage.setItem(key, JSON.stringify(v));
    } catch (_) {}
  }

  function restoreDraft() {
    const key = draftKey();
    if (!key) return;
    let raw;
    try { raw = localStorage.getItem(key); } catch (_) { return; }
    if (!raw) return;
    let d;
    try { d = JSON.parse(raw); } catch (_) { return; }
    if (!d || typeof d !== "object") return;
    applyDraft(d);
    if (d._section && SECTION_ORDER.includes(d._section)) {
      // Defer to after setState("FORM") so listeners are in place
      setTimeout(() => setSection(d._section, { silent: true }), 100);
    }
    showToast("// DRAFT RESTORED FROM LOCAL STORAGE");
    emitClientEvent("PHASE_THREE_DRAFT_RESTORED", { section: d._section || "identity" });
  }

  function clearDraft() {
    const key = draftKey();
    if (!key) return;
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.setAttribute("aria-hidden", "false");
    toast.classList.add("visible");
    setTimeout(() => {
      toast.classList.remove("visible");
      toast.setAttribute("aria-hidden", "true");
    }, 2400);
  }

  // ── Validation ───────────────────────────────────────────────
  function validateSection(name) {
    const errs = {};
    const v = readForm();
    if (name === "identity") {
      if (!v.display_name || v.display_name.length < 1 || v.display_name.length > 40) {
        errs.display_name = "Display name must be 1–40 characters.";
      }
      if (!/^[a-z0-9_]{3,20}$/.test(v.username)) {
        errs.username = "3–20 chars, lowercase letters, numbers, underscore.";
      } else if (usernameAvailable === false) {
        errs.username = "That username is taken.";
      } else if (usernameAvailable === "checking") {
        errs.username = "Still checking availability…";
      }
      if (v.bio.length > 160) errs.bio = "Bio is over 160 characters.";
    }
    if (name === "maker") {
      if (!v.skill_level) errs.skill_level = "Pick a skill level.";
      for (const sv of Object.values(v.socials)) {
        if (sv && !/^[A-Za-z0-9_.]+$/.test(sv)) {
          errs.socials = "Handles only — letters, numbers, dot, underscore.";
          break;
        }
      }
    }
    if (name === "contact") {
      if (!v.birthday) {
        errs.birthday = "Birthday required.";
      } else {
        const age = computeAge(v.birthday);
        if (age == null) errs.birthday = "Birthday looks invalid.";
        else if (age < 14) errs.birthday = "14+ required.";
      }
      const s = v.shipping;
      const anyShipping = !!(s.line1 || s.line2 || s.city || s.region || s.postal || s.country);
      if (anyShipping) {
        if (!s.line1) errs.shipping = "Line 1 is required if you start an address.";
        else if (!s.country) errs.shipping = "Country is required if you start an address.";
      }
    }
    return errs;
  }

  function computeAge(iso) {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
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
  function applyErrors(errs) {
    clearFieldErrors();
    for (const [field, msg] of Object.entries(errs)) showFieldError(field, msg);
  }

  // ── Tag input ────────────────────────────────────────────────
  function renderTags(field) {
    const listId = field === "blasters_owned" ? "#blasters-list" : "#accessories-list";
    const list = $(listId);
    if (!list) return;
    list.innerHTML = "";
    tags[field].forEach((tag, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip";
      chip.setAttribute("aria-label", `remove ${tag}`);
      chip.innerHTML = `<span>${escapeHtml(tag)}</span><span aria-hidden="true" class="tag-x">×</span>`;
      chip.addEventListener("click", () => {
        tags[field].splice(i, 1);
        renderTags(field);
        saveDraft();
      });
      list.appendChild(chip);
    });
  }

  function setupTagInput(field, inputId) {
    const input = $(inputId);
    if (!input) return;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const raw = input.value.trim().slice(0, 30);
        if (!raw) return;
        const dup = tags[field].some((t) => t.toLowerCase() === raw.toLowerCase());
        if (dup) {
          input.value = "";
          return;
        }
        if (tags[field].length >= 10) {
          showFieldError(field, "Max 10 tags.");
          return;
        }
        tags[field].push(raw);
        input.value = "";
        renderTags(field);
        saveDraft();
      } else if (e.key === "Backspace" && !input.value && tags[field].length) {
        tags[field].pop();
        renderTags(field);
        saveDraft();
      }
    });
    input.addEventListener("blur", () => {
      const raw = input.value.trim().slice(0, 30);
      if (raw && tags[field].length < 10) {
        const dup = tags[field].some((t) => t.toLowerCase() === raw.toLowerCase());
        if (!dup) {
          tags[field].push(raw);
          input.value = "";
          renderTags(field);
          saveDraft();
        }
      }
    });
  }

  // ── Username availability ────────────────────────────────────
  function setUsernameAvailability(stateValue, label) {
    usernameAvailable = stateValue;
    const hint = $("#username-availability");
    if (!hint) return;
    hint.setAttribute("data-state", stateValue === true ? "ok" : stateValue === false ? "taken" : stateValue === "checking" ? "checking" : "idle");
    hint.textContent = label;
  }

  async function checkUsernameNow(value) {
    if (!CFG.CHECK_USERNAME_URL) return;
    const seq = ++usernameLastSeq;
    setUsernameAvailability("checking", "// CHECKING AVAILABILITY");
    const res = await postJSON(CFG.CHECK_USERNAME_URL, { token: tokenString, username: value });
    if (seq !== usernameLastSeq) return; // a newer check has been kicked off
    if (!res || !res.ok) {
      setUsernameAvailability(null, "// AVAILABILITY UNKNOWN");
      return;
    }
    lastUsernameChecked = value;
    if (res.available) setUsernameAvailability(true, "// AVAILABLE ✓");
    else setUsernameAvailability(false, "// TAKEN — TRY ANOTHER");
  }

  function scheduleUsernameCheck() {
    const input = $("#username-input");
    if (!input) return;
    const v = input.value.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(v)) {
      setUsernameAvailability(null, "// 3–20 CHARS — a-z 0-9 _");
      return;
    }
    if (v === lastUsernameChecked) return;
    if (usernameDebounceTimer) clearTimeout(usernameDebounceTimer);
    usernameDebounceTimer = setTimeout(() => checkUsernameNow(v), CFG.USERNAME_DEBOUNCE_MS || 300);
  }

  // ── Avatar ───────────────────────────────────────────────────
  function setupAvatar() {
    const dropzone = $("#dropzone");
    const fileInput = $("#avatar-input");
    const replaceBtn = $("#avatar-replace");
    if (!dropzone || !fileInput) return;

    const openPicker = () => fileInput.click();
    dropzone.addEventListener("click", (e) => {
      if (dropzone.getAttribute("data-state") === "uploading") return;
      if (e.target.closest("#avatar-replace")) return;
      openPicker();
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPicker();
      }
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (dropzone.getAttribute("data-state") === "uploading") return;
      dropzone.setAttribute("data-state", "drag");
    });
    dropzone.addEventListener("dragleave", () => {
      if (dropzone.getAttribute("data-state") === "drag") dropzone.setAttribute("data-state", "idle");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dropzone.getAttribute("data-state") === "uploading") return;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) startAvatarUpload(f);
    });
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) startAvatarUpload(f);
    });
    if (replaceBtn) replaceBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPicker();
    });
  }

  function startAvatarUpload(file) {
    if (!window.PKC_AVATAR || !tokenString) return;
    const dropzone = $("#dropzone");
    const fill = $("#upload-bar-fill");
    showAvatarStage("uploading");
    if (fill) fill.style.width = "2%";
    window.PKC_AVATAR.processAndUpload(file, tokenString, {
      onProgress: (p) => { if (fill) fill.style.width = Math.round(Math.max(2, p * 100)) + "%"; },
      onSuccess: (result) => {
        avatarUrl = result.url || (result.data && result.data.url) || null;
        avatarBytes = result.bytes || (result.data && result.data.bytes) || file.size;
        if (!avatarUrl) {
          showFieldError("avatar", "Upload returned no URL.");
          showAvatarStage("idle");
          return;
        }
        showAvatarPreview(avatarUrl);
        emitClientEvent("PHASE_THREE_AVATAR_UPLOADED", { bytes: avatarBytes });
        saveDraft();
        clearAvatarError();
      },
      onError: (err) => {
        showFieldError("avatar", (err && err.message) || "Upload failed.");
        showAvatarStage("idle");
      }
    });
    if (dropzone) dropzone.setAttribute("data-state", "uploading");
  }

  function showAvatarStage(stage) {
    const dropzone = $("#dropzone");
    if (!dropzone) return;
    dropzone.setAttribute("data-state", stage);
    const idle = dropzone.querySelector(".dropzone-idle");
    const progress = dropzone.querySelector(".dropzone-progress");
    const preview = dropzone.querySelector(".dropzone-preview");
    if (idle) idle.hidden = stage !== "idle";
    if (progress) progress.hidden = stage !== "uploading";
    if (preview) preview.hidden = stage !== "preview";
  }

  function showAvatarPreview(url) {
    const img = $("#avatar-preview");
    if (img) img.src = url;
    showAvatarStage("preview");
  }

  function clearAvatarError() {
    const fieldEl = document.querySelector('.field[data-field="avatar"]');
    if (fieldEl) fieldEl.classList.remove("invalid");
    const err = $("#avatar-error");
    if (err) { err.textContent = ""; err.hidden = true; }
  }

  // ── Bio counter ──────────────────────────────────────────────
  function updateBioCounter() {
    const bio = $("#bio-input");
    const counter = $("#bio-counter");
    if (!bio || !counter) return;
    counter.textContent = String(bio.value.length);
  }

  // ── Country dropdown ─────────────────────────────────────────
  // Common-priority countries first, then alphabetical
  const COUNTRIES = [
    ["US", "United States"], ["CA", "Canada"], ["MX", "Mexico"],
    ["GB", "United Kingdom"], ["AU", "Australia"], ["NZ", "New Zealand"],
    ["DE", "Germany"], ["FR", "France"], ["NL", "Netherlands"], ["SE", "Sweden"],
    ["NO", "Norway"], ["DK", "Denmark"], ["FI", "Finland"], ["IE", "Ireland"],
    ["ES", "Spain"], ["IT", "Italy"], ["PT", "Portugal"], ["BE", "Belgium"],
    ["AT", "Austria"], ["CH", "Switzerland"], ["PL", "Poland"], ["CZ", "Czechia"],
    ["JP", "Japan"], ["KR", "South Korea"], ["SG", "Singapore"], ["HK", "Hong Kong"],
    ["TW", "Taiwan"], ["AR", "Argentina"], ["BR", "Brazil"], ["CL", "Chile"],
    ["CO", "Colombia"], ["PE", "Peru"], ["UY", "Uruguay"], ["ZA", "South Africa"],
    ["AE", "United Arab Emirates"], ["IL", "Israel"], ["IN", "India"],
    ["MY", "Malaysia"], ["TH", "Thailand"], ["PH", "Philippines"], ["VN", "Vietnam"],
    ["ID", "Indonesia"]
  ];

  function populateCountries() {
    const sel = $("#ship-country");
    if (!sel) return;
    const frag = document.createDocumentFragment();
    // Keep the existing placeholder option, append rest
    COUNTRIES.forEach(([code, name]) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      frag.appendChild(opt);
    });
    sel.appendChild(frag);
  }

  // ── Review render ────────────────────────────────────────────
  function renderReview() {
    const grid = $("#review-grid");
    if (!grid) return;
    const v = readForm();
    const age = computeAge(v.birthday);
    const isAdult = age != null && age >= 18;
    const cells = [];
    cells.push(reviewRow("DISPLAY NAME", v.display_name || "—", "identity", "display_name"));
    cells.push(reviewRow("USERNAME", v.username || "—", "identity", "username"));
    cells.push(reviewRow(
      "AVATAR",
      v.avatar_url
        ? `<img class="review-avatar" src="${escapeAttr(v.avatar_url)}" alt="">`
        : "—",
      "identity", "avatar", true
    ));
    cells.push(reviewRow("BIO", v.bio || "—", "identity", "bio"));
    cells.push(reviewRow("SKILL", v.skill_level ? v.skill_level.toUpperCase() : "—", "maker", "skill_level"));
    cells.push(reviewRow("BLASTERS", v.blasters_owned.length ? v.blasters_owned.join(", ") : "—", "maker", "blasters_owned"));
    cells.push(reviewRow("INTERESTS", v.accessory_interests.length ? v.accessory_interests.join(", ") : "—", "maker", "accessory_interests"));
    const socials = ["insta", "yt", "tiktok"]
      .map((k) => v.socials[k] ? `${k.toUpperCase()} @${v.socials[k]}` : null)
      .filter(Boolean)
      .join("  ");
    cells.push(reviewRow("SOCIALS", socials || "—", "maker", "socials"));
    const birthdayLabel = v.birthday
      ? `${v.birthday}${isAdult ? " &nbsp;<span class=\"verified-18\">// VERIFIED 18+</span>" : ""}`
      : "—";
    cells.push(reviewRow("BIRTHDAY", birthdayLabel, "contact", "birthday", true));
    const s = v.shipping;
    const anyShipping = s.line1 || s.line2 || s.city || s.region || s.postal || s.country;
    const shippingLabel = anyShipping
      ? [s.line1, s.line2, [s.city, s.region, s.postal].filter(Boolean).join(" "), s.country].filter(Boolean).join(" / ")
      : "—";
    cells.push(reviewRow("SHIPPING", shippingLabel, "contact", "shipping"));
    cells.push(reviewRow("EMAIL DROPS", v.email_drops ? "ON" : "OFF", "contact", "prefs"));
    cells.push(reviewRow("SMS DROPS", v.sms_optin ? "ON" : "OFF", "contact", "prefs"));
    grid.innerHTML = cells.join("");
    // Wire up the edit links
    $$(".review-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-edit-section");
        setSection(target);
      });
    });
  }

  function reviewRow(label, value, sectionTarget, _field, isHtml) {
    const v = isHtml ? value : escapeHtml(value);
    return `
      <div class="review-row">
        <span class="review-label">${escapeHtml(label)}</span>
        <span class="review-value">${v}</span>
        <button type="button" class="review-edit link-btn" data-edit-section="${escapeAttr(sectionTarget)}">// EDIT</button>
      </div>
    `;
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // ── Save ─────────────────────────────────────────────────────
  async function runSave(isAutoRetry) {
    setState("SUBMITTING");
    const profile = readForm();
    // Trim ephemeral fields the server doesn't want
    delete profile._saved_at;
    delete profile._section;
    delete profile.avatar_bytes;

    const res = await postJSON(CFG.SAVE_URL, { token: tokenString, profile });
    if (!res.ok) {
      if (res.code === "INVALID_TOKEN") return setState("INVALID");
      if (res.code === "EXPIRED")       return setState("EXPIRED");
      if (res.code === "ALREADY_COMPLETED") return showAlreadyDone(res.data || profile);
      if (res.code === "UNDER_AGE") {
        setState("FORM");
        setSection("contact");
        showFieldError("birthday", "14+ required.");
        return;
      }
      if (res.code === "USERNAME_TAKEN") {
        setState("FORM");
        setSection("identity");
        showFieldError("username", "That username is taken.");
        setUsernameAvailability(false, "// TAKEN — TRY ANOTHER");
        return;
      }
      if (res.code === "VALIDATION_ERROR") {
        setState("FORM");
        // Best-effort: try to map the message to a section
        const msg = (res.message || "").toLowerCase();
        let target = "identity";
        if (msg.includes("birthday") || msg.includes("ship")) target = "contact";
        else if (msg.includes("skill") || msg.includes("social")) target = "maker";
        setSection(target);
        // Field-level fallback
        showFieldError("username", res.message || "Please check your input.");
        return;
      }
      if (res.retryable && !isAutoRetry && !autoRetryUsed) {
        autoRetryUsed = true;
        const meta = $("#error-retry-meta");
        if (meta) meta.textContent = "Auto-retrying in a moment.";
        setState("ERROR_RETRY");
        setTimeout(() => runSave(true), CFG.AUTO_RETRY_DELAY_MS);
        return;
      }
      return setError(!!res.retryable, "We couldn't commit your profile.");
    }
    showSuccess(res.data || {});
  }

  function showSuccess(data) {
    const u = data.username || readForm().username || "—";
    $("#success-username").textContent = u;
    $("#success-completed").textContent = formatTime(data.completed_at);
    if (data.persisted === false) $("#success-test-banner").hidden = false;
    clearDraft();
    setState("SUCCESS");
  }

  // ── Boot ─────────────────────────────────────────────────────
  function bindGlobalForm() {
    const form = $("#profile-form");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      // Final validation across all sections
      const errs = {
        ...validateSection("identity"),
        ...validateSection("maker"),
        ...validateSection("contact")
      };
      if (Object.keys(errs).length) {
        applyErrors(errs);
        // Jump to first section with an error
        const order = { display_name: "identity", username: "identity", bio: "identity",
                        skill_level: "maker", socials: "maker",
                        birthday: "contact", shipping: "contact" };
        const first = Object.keys(errs)[0];
        setSection(order[first] || "identity");
        return;
      }
      runSave(false);
    });

    // Section nav
    $$("[data-section-next]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-section-next");
        const errs = validateSection(section);
        if (Object.keys(errs).length) {
          applyErrors(errs);
          return;
        }
        clearFieldErrors();
        setSection(target);
      });
    });
    $$("[data-section-back]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setSection(btn.getAttribute("data-section-back"));
      });
    });

    // Username live check
    const usernameInput = $("#username-input");
    if (usernameInput) {
      usernameInput.addEventListener("input", () => {
        const v = usernameInput.value;
        const nv = v.toLowerCase();
        if (v !== nv) {
          const pos = usernameInput.selectionStart;
          usernameInput.value = nv;
          try { usernameInput.setSelectionRange(pos, pos); } catch (_) {}
        }
        clearFieldErrorsForField("username");
        scheduleUsernameCheck();
        saveDraft();
      });
    }

    // Bio counter
    const bio = $("#bio-input");
    if (bio) bio.addEventListener("input", () => { updateBioCounter(); saveDraft(); });

    // Save-on-blur for everything that affects draft
    ["#display-name-input", "#social-insta", "#social-yt", "#social-tiktok",
     "#birthday-input", "#ship-line1", "#ship-line2", "#ship-city", "#ship-region",
     "#ship-postal", "#ship-country", "#email-drops-input", "#sms-optin-input"].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("blur", saveDraft);
    });
    $$('input[name="skill_level"]').forEach((rb) => rb.addEventListener("change", saveDraft));

    // Birthday hint
    const bday = $("#birthday-input");
    const hint = $("#birthday-hint");
    if (bday && hint) {
      bday.addEventListener("change", () => {
        const age = computeAge(bday.value);
        if (age == null) { hint.textContent = "14+ required. We don't share this."; return; }
        if (age < 14) hint.textContent = "// AGE GATE: 14+ REQUIRED";
        else if (age < 18) hint.textContent = `${age} years — 14+ verified.`;
        else hint.textContent = `${age} years — 18+ verified.`;
      });
    }

    // Tag inputs
    setupTagInput("blasters_owned", "#blasters-input");
    setupTagInput("accessory_interests", "#accessories-input");

    // Retry button
    const retry = $("#retry-btn");
    if (retry) retry.addEventListener("click", () => {
      autoRetryUsed = false;
      runSave(false);
    });
  }

  function clearFieldErrorsForField(field) {
    const fieldEl = document.querySelector(`.field[data-field="${field}"]`);
    if (!fieldEl) return;
    fieldEl.classList.remove("invalid");
    const err = fieldEl.querySelector(".error-msg");
    if (err) { err.textContent = ""; err.hidden = true; }
  }

  function init() {
    tokenString = safeParseToken();
    emitClientEvent("PHASE_THREE_PAGE_OPENED", { token_payload_hash: tokenPayloadHash(tokenString) });
    populateCountries();
    setupAvatar();
    bindGlobalForm();
    if (!tokenString) {
      const meta = $("#invalid-meta");
      if (meta) meta.textContent = "This link looks incomplete. Please use the link from your email.";
      setState("INVALID");
      return;
    }
    runVerify();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
