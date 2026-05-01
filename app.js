/* ProjectKidCreations — onboarding/app.js
 *
 * v1.5.0 — vanilla JS, zero deps. Works via file:// or static host.
 *
 * ─── PRODUCTION READINESS CHECKLIST (#50) ───────────────────────────────
 *  [ ] CONFIG.MODE = "prod"
 *  [ ] CONFIG.DEBUG = false (auto in prod)
 *  [ ] window.PKC_ENDPOINT set to real prod endpoint
 *  [ ] window.PKC_DISABLED unset
 *  [ ] Rate limiter exercised — 6th attempt in 60s blocked
 *  [ ] Retry queue tested — offline submit → online drain
 *  [ ] Hash deterministic across two identical submits
 *  [ ] submissionId unique per attempt
 *  [ ] Completion guard tested
 *  [ ] Kill switch tested
 *  [ ] PKC_HEALTH() returns sane snapshot
 *  [ ] Mobile tested 375px / 414px
 *  [ ] Reduced-motion tested
 *  [ ] VoiceOver pass
 *  [ ] Endpoint receives + acks payload schema
 *  [ ] Vercel/host deploy from main configured
 * ─────────────────────────────────────────────────────────────────────── */

(() => {
  "use strict";

  // ════════════════════════════════════════════════════════════════════
  //  CONFIG (single source of truth, #41 #42)
  // ════════════════════════════════════════════════════════════════════
  const QUERY = new URLSearchParams(location.search);

  const PKC_ENV =
    window.PKC_ENV ||
    (location.protocol === "file:" || location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "local"
      : "prod");

  const PKC_MODE =
    QUERY.get("mode") ||
    window.PKC_MODE ||
    (PKC_ENV === "local" ? "dev" : "prod");

  const PKC_DEBUG_RAW =
    QUERY.get("debug") !== null
      ? QUERY.get("debug") !== "0"
      : window.PKC_DEBUG !== undefined
        ? !!window.PKC_DEBUG
        : PKC_MODE === "dev";

  const CONFIG = Object.freeze({
    VERSION:           "1.5.0",
    ENV:               PKC_ENV,
    MODE:              PKC_MODE,
    DEBUG:             PKC_DEBUG_RAW,
    ENDPOINT:          window.PKC_ENDPOINT || null,
    RATE_LIMIT:        5,
    RATE_WINDOW:       60_000,
    EXPIRY_MS:         60 * 60 * 1000,
    QUEUE_MAX:         10,
    QUEUE_TTL:         7 * 24 * 60 * 60 * 1000,
    IDLE_MS:           60_000,
    DEBOUNCE_MS:       300,
    LIVE_DEBOUNCE_MS:  200,
    FLUSH_MS:          5_000,
    AUTOFILL_GRACE_MS: 250,
    SAVED_FADE_MS:     1200,
  });

  // ════════════════════════════════════════════════════════════════════
  //  Logger trio (#44)
  // ════════════════════════════════════════════════════════════════════
  const log  = (...a) => { if (CONFIG.DEBUG) console.log(...a); };
  const warn = (...a) => console.warn(...a);
  const err  = (...a) => console.error(...a);

  // ════════════════════════════════════════════════════════════════════
  //  Kill switch (#43) — first runtime line
  // ════════════════════════════════════════════════════════════════════
  if (window.PKC_DISABLED === true || QUERY.get("disabled") === "1") {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.innerHTML = `
        <main class="kill" role="alert">
          <h1>SYSTEM PAUSED</h1>
          <p class="kill-line">// FORM TEMPORARILY DISABLED</p>
          <p class="kill-meta">// PKC v${CONFIG.VERSION}</p>
        </main>`;
      document.body.classList.add("ready");
      console.warn("[PKC] kill switch active — form disabled");
    });
    return;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Constants (#1 #6 #11)
  // ════════════════════════════════════════════════════════════════════
  const QUESTIONS = [
    { key: "firstName", label: "FIRST NAME // LET'S START",      type: "text",  autocomplete: "given-name",  inputmode: "text",  validate: "name",  limits: { min: 1, max: 50 }, momentum: "// LET'S GO" },
    { key: "lastName",  label: "LAST NAME // ALMOST THERE",      type: "text",  autocomplete: "family-name", inputmode: "text",  validate: "name",  limits: { min: 1, max: 50 }, momentum: "// GOOD — KEEP GOING" },
    { key: "email",     label: "EMAIL // WHERE WE REACH YOU",    type: "email", autocomplete: "email",       inputmode: "email", validate: "email", limits: { max: 100 },        momentum: "// FINAL STEP" },
  ];
  const TOTAL_STEPS = QUESTIONS.length;

  const ERRORS = {
    required:     { msg: "// REQUIRED FIELD" },
    email:        { msg: "// INVALID EMAIL FORMAT", hint: "// TRY: name@email.com" },
    too_short:    { msg: "// TOO SHORT" },
    too_long:     { msg: "// TOO LONG" },
    rate_limited: { msg: "// TOO MANY ATTEMPTS", hint: "// TRY AGAIN IN 60S" },
  };

  const STORAGE_KEY  = "pkc_onboarding";
  const ATTEMPTS_KEY = "pkc_attempts";
  const QUEUE_KEY    = "pkc_queue";

  const DISPOSABLE_DOMAINS = new Set([
    "mailinator.com", "guerrillamail.com", "10minutemail.com",
    "yopmail.com", "tempmail.com", "trashmail.com",
  ]);

  // ════════════════════════════════════════════════════════════════════
  //  State + closures
  // ════════════════════════════════════════════════════════════════════
  const state = {
    answers:       {},
    currentStep:   1,
    startTime:     null,
    lastSubmit:    0,
    idleTimer:     null,
    flushTimer:    null,
    flushInterval: null,
    savedTimer:    null,
    statusToken:   0,
    eventQueue:    [],
    perf:          { start: 0, steps: [], submitMs: null, completionMs: null },
    fields:        new Map(),
    liveTimers:    new Map(),
    booted:        false,
  };

  // ════════════════════════════════════════════════════════════════════
  //  Pure helpers
  // ════════════════════════════════════════════════════════════════════
  const padStep = (n) => String(n).padStart(2, "0");

  const sanitize = (v) =>
    String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

  const normalize = (key, value) => {
    let v = String(value ?? "").trim();
    if (key === "email") v = v.toLowerCase();
    const max = QUESTIONS.find((q) => q.key === key)?.limits?.max;
    if (max && v.length > max) v = v.slice(0, max);
    return v;
  };

  const cleanValue = (key, raw) => sanitize(normalize(key, raw));

  const validate = (key, value) => {
    const q = QUESTIONS.find((x) => x.key === key);
    if (!q) return null;
    const lim = q.limits || {};
    if (!value) return "required";
    if (lim.min && value.length < lim.min) return "too_short";
    if (lim.max && value.length > lim.max) return "too_long";
    if (q.validate === "email") {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!re.test(value)) return "email";
    }
    return null;
  };

  const computeConfidence = (data) => {
    const out = {};
    for (const q of QUESTIONS) {
      const v = String(data[q.key] || "");
      if (q.validate === "email") {
        const domain = v.split("@")[1] || "";
        if (v.includes("+")) out[q.key] = "low";
        else if (DISPOSABLE_DOMAINS.has(domain)) out[q.key] = "low";
        else out[q.key] = "high";
      } else if (q.validate === "name") {
        if (/[^a-zA-Z\s\-'’]/.test(v)) out[q.key] = "med";
        else out[q.key] = "high";
      } else {
        out[q.key] = "high";
      }
    }
    return out;
  };

  const sha256 = async (obj) => {
    try {
      const sortedKeys = Object.keys(obj).sort();
      const canonical = JSON.stringify(obj, sortedKeys);
      const buffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      );
      return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch (e) {
      warn("[PKC] sha256 unavailable, using fallback hash", e);
      let h = 2166136261;
      const s = JSON.stringify(obj);
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return "fnv1a:" + (h >>> 0).toString(16);
    }
  };

  const uuid = () => {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  const safe = (fn, label = "fn") => (...args) => {
    try { return fn(...args); }
    catch (e) {
      err(`[PKC ERROR] ${label}`, e);
      track("error_boundary", { label, message: String(e), stack: e?.stack });
    }
  };

  const safeAsync = (fn, label = "fn") => async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      err(`[PKC ERROR] ${label}`, e);
      track("error_boundary", { label, message: String(e), stack: e?.stack });
    }
  };

  // ════════════════════════════════════════════════════════════════════
  //  Storage helpers
  // ════════════════════════════════════════════════════════════════════
  const readStore = () => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - (obj.ts || 0) > CONFIG.EXPIRY_MS) {
        sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return obj;
    } catch { return null; }
  };

  const writeStore = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        data: state.answers,
        ts:   Date.now(),
      }));
    } catch (e) { warn("[PKC] writeStore failed", e); }
  };

  const clearStore = () => {
    try { sessionStorage.removeItem(STORAGE_KEY); }
    catch (e) { warn("[PKC] clearStore failed", e); }
  };

  // Rate-limit attempts
  const getAttempts = () => {
    try {
      const raw = sessionStorage.getItem(ATTEMPTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      const cutoff = Date.now() - CONFIG.RATE_WINDOW;
      const fresh = arr.filter((t) => t > cutoff);
      if (fresh.length !== arr.length) {
        sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify(fresh));
      }
      return fresh;
    } catch { return []; }
  };

  const pushAttempt = () => {
    try {
      const arr = getAttempts();
      arr.push(Date.now());
      sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify(arr));
    } catch (e) { warn("[PKC] pushAttempt failed", e); }
  };

  // Retry queue
  const getQueue = () => {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      const cutoff = Date.now() - CONFIG.QUEUE_TTL;
      const fresh = arr.filter((entry) => (entry?.ts || 0) > cutoff);
      if (fresh.length !== arr.length) {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(fresh));
      }
      return fresh;
    } catch { return []; }
  };

  const writeQueue = (q) => {
    try {
      const trimmed = q.slice(-CONFIG.QUEUE_MAX);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
    } catch (e) { warn("[PKC] writeQueue failed", e); }
  };

  const enqueue = (payload) => {
    const q = getQueue();
    const exists = q.some((entry) =>
      entry?.payload?.data?.email === payload?.data?.email ||
      entry?.payload?.submissionId === payload?.submissionId,
    );
    if (exists) {
      log("[PKC] enqueue skipped — duplicate");
      return;
    }
    q.push({ payload, ts: Date.now() });
    writeQueue(q);
    log("[PKC] enqueued", payload.submissionId);
  };

  const drainQueue = safeAsync(async () => {
    if (!CONFIG.ENDPOINT) return;
    if (CONFIG.MODE === "dev") return;
    if (!navigator.onLine) return;

    const q = getQueue();
    if (q.length === 0) return;

    const remaining = [];
    for (const entry of q) {
      try {
        await fetch(CONFIG.ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.payload),
        });
        track("submit_retried", { submissionId: entry.payload.submissionId });
      } catch (e) {
        warn("[PKC] retry failed", e);
        remaining.push(entry);
      }
    }
    writeQueue(remaining);
  }, "drainQueue");

  // ════════════════════════════════════════════════════════════════════
  //  Event tracking + batching (#8 #35 #44)
  // ════════════════════════════════════════════════════════════════════
  const track = (event, payload = {}) => {
    const entry = { event, payload, t: performance.now() };
    state.eventQueue.push(entry);
    log("[PKC EVENT]", event, payload);
    scheduleFlush();
  };

  const scheduleFlush = () => {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(flushEvents, 200);
  };

  const flushEvents = () => {
    if (state.eventQueue.length === 0) return;
    const batch = state.eventQueue.splice(0, state.eventQueue.length);
    log("[PKC BATCH]", batch);
    // Future: POST to analytics endpoint here.
  };

  // ════════════════════════════════════════════════════════════════════
  //  Status region helper
  // ════════════════════════════════════════════════════════════════════
  const setStatus = (text, tone = "", { sticky = false, fadeMs = CONFIG.SAVED_FADE_MS } = {}) => {
    const el = document.getElementById("status");
    if (!el) return;
    state.statusToken += 1;
    const myToken = state.statusToken;
    el.textContent = text || "";
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
    if (state.savedTimer) { clearTimeout(state.savedTimer); state.savedTimer = null; }
    if (!sticky && text) {
      state.savedTimer = setTimeout(() => {
        if (state.statusToken !== myToken) return;
        el.textContent = "";
        delete el.dataset.tone;
      }, fadeMs);
    }
  };

  // ════════════════════════════════════════════════════════════════════
  //  Render question sections from QUESTIONS (#1)
  // ════════════════════════════════════════════════════════════════════
  const buildSections = () => {
    const form = document.getElementById("form");
    document.documentElement.style.setProperty("--steps", String(TOTAL_STEPS));

    const bar = document.getElementById("progress-bar");
    bar.setAttribute("aria-valuemax", String(TOTAL_STEPS));
    bar.innerHTML = "";
    for (let i = 0; i < TOTAL_STEPS; i++) {
      bar.appendChild(document.createElement("span"));
    }

    QUESTIONS.forEach((q, i) => {
      const idx = i + 1;
      const sec = document.createElement("section");
      sec.dataset.question = String(idx);
      sec.dataset.active   = "false";
      sec.setAttribute("aria-hidden", "true");
      sec.innerHTML = `
        <p class="step-label">QUESTION ${padStep(idx)} OF ${padStep(TOTAL_STEPS)}</p>
        <label for="q-${idx}" class="prompt">${q.label}</label>
        <p class="momentum">${q.momentum || ""}</p>
        <input
          id="q-${idx}"
          name="${q.key}"
          type="${q.type}"
          inputmode="${q.inputmode}"
          autocomplete="${q.autocomplete}"
          ${q.limits?.max ? `maxlength="${q.limits.max}"` : ""}
          required
          spellcheck="false"
          autocapitalize="${q.key === "email" ? "off" : "words"}"
        >
        <div class="error-region">
          <span class="error-msg"></span>
          <span class="error-hint"></span>
        </div>
        <p class="hint">PRESS ENTER TO CONTINUE${idx > 1 ? " // SHIFT+TAB TO GO BACK" : ""}</p>
        <p class="idle-hint" hidden>// STILL THERE? PRESS ENTER TO CONTINUE</p>
        <button type="button" class="cta">CONTINUE →</button>
      `;
      form.appendChild(sec);

      const input = sec.querySelector("input");
      const cta   = sec.querySelector(".cta");
      const errMsg  = sec.querySelector(".error-msg");
      const errHint = sec.querySelector(".error-hint");
      const idleEl  = sec.querySelector(".idle-hint");

      // Pre-fill from hydrated answers
      if (state.answers[q.key]) input.value = state.answers[q.key];

      // Live validation (#12)
      input.addEventListener("input", () => {
        if (state.liveTimers.has(q.key)) clearTimeout(state.liveTimers.get(q.key));
        state.liveTimers.set(q.key, setTimeout(() => validateLive(q.key), CONFIG.LIVE_DEBOUNCE_MS));
        resetIdleTimer();
      });

      // Paste handling (#22)
      input.addEventListener("paste", () => {
        requestAnimationFrame(() => {
          input.value = sanitize(input.value);
          track("paste_clean", { key: q.key });
        });
      });

      // Autofill detection (#23)
      input.addEventListener("animationstart", (ev) => {
        if (ev.animationName !== "pkc-autofill") return;
        if (input.dataset.autofilled === "true") return;
        input.dataset.autofilled = "true";
        track("autofill_detected", { key: q.key });
        if (idx === TOTAL_STEPS) return;
        setTimeout(() => {
          if (validate(q.key, cleanValue(q.key, input.value)) === null) {
            tryAdvance();
          }
        }, CONFIG.AUTOFILL_GRACE_MS);
      });

      // Enter key — submit-attempt
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          tryAdvance();
        } else if (ev.key === "Tab" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          if (idx > 1 && (input.selectionStart === 0 || input.selectionStart === null)) {
            ev.preventDefault();
            history.back();
          }
        } else {
          resetIdleTimer();
        }
      });

      cta.addEventListener("click", () => tryAdvance());

      state.fields.set(q.key, { sec, input, cta, errMsg, errHint, idleEl, idx });
    });
  };

  // ════════════════════════════════════════════════════════════════════
  //  Live validation (#12) — preview without shake
  // ════════════════════════════════════════════════════════════════════
  const validateLive = (key) => {
    const f = state.fields.get(key);
    if (!f) return;
    const val = cleanValue(key, f.input.value);
    if (!val) {
      setError(f, null);
      return;
    }
    const errKey = validate(key, val);
    if (errKey) setError(f, errKey);
    else setError(f, null);
  };

  const setError = (f, errorKey) => {
    if (!errorKey) {
      f.errMsg.textContent = "";
      f.errHint.textContent = "";
      f.sec.classList.remove("invalid");
      return;
    }
    const def = ERRORS[errorKey] || { msg: "// INVALID INPUT" };
    f.errMsg.textContent  = def.msg;
    f.errHint.textContent = def.hint || "";
  };

  // ════════════════════════════════════════════════════════════════════
  //  render(step) — show one section, update chrome (#1, #5, #7, #10)
  // ════════════════════════════════════════════════════════════════════
  const render = safe((step) => {
    state.currentStep = step;

    // Toggle sections
    const sections = document.querySelectorAll('section[data-question]');
    sections.forEach((sec) => {
      const tag = sec.dataset.question;
      const isStepN = tag === String(step);
      const isEnd   = tag === "end" && step === "done";
      const active  = isStepN || isEnd;
      sec.dataset.active = active ? "true" : "false";
      sec.setAttribute("aria-hidden", active ? "false" : "true");
    });

    // Progress chrome
    const counter = document.getElementById("progress-counter");
    const bar     = document.getElementById("progress-bar");
    const back    = document.getElementById("back");

    if (step === "done") {
      counter.textContent = `${padStep(TOTAL_STEPS)} / ${padStep(TOTAL_STEPS)}`;
      bar.setAttribute("aria-valuenow", String(TOTAL_STEPS));
      Array.from(bar.children).forEach((c) => c.classList.add("filled"));
      back.hidden = true;
      return;
    }

    counter.textContent = `${padStep(step)} / ${padStep(TOTAL_STEPS)}`;
    bar.setAttribute("aria-valuenow", String(step));
    Array.from(bar.children).forEach((c, i) => {
      c.classList.toggle("filled", i < step);
    });

    back.hidden = step <= 1;
    back.setAttribute("href", "#" + Math.max(1, step - 1));

    // Momentum copy → status region
    const q = QUESTIONS[step - 1];
    if (q?.momentum) setStatus(q.momentum, "momentum", { sticky: true });
    else setStatus("");

    // Focus the active input (#10)
    const f = state.fields.get(q?.key);
    if (f) {
      requestAnimationFrame(() => {
        try { f.input.focus({ preventScroll: true }); } catch { f.input.focus(); }
      });
    }

    // Perf step (#39)
    state.perf.steps.push({ step, key: q?.key, t: performance.now() });

    track("step_view", { step, key: q?.key });
    resetIdleTimer();
  }, "render");

  // ════════════════════════════════════════════════════════════════════
  //  tryAdvance (#27 #28 #33)
  // ════════════════════════════════════════════════════════════════════
  const tryAdvance = safe(() => {
    const step = state.currentStep;
    const q = QUESTIONS[step - 1];
    if (!q) return;
    const f = state.fields.get(q.key);
    if (!f) return;

    // Enter debounce (#27)
    const now = Date.now();
    if (now - state.lastSubmit < CONFIG.DEBOUNCE_MS) return;

    // Rate limit (#33)
    if (getAttempts().length >= CONFIG.RATE_LIMIT) {
      setError(f, "rate_limited");
      shake(f);
      track("rate_limited", { step });
      return;
    }

    state.lastSubmit = now;
    const value = cleanValue(q.key, f.input.value);
    f.input.value = value; // reflect normalized value into the field

    const errKey = validate(q.key, value);
    if (errKey) {
      setError(f, errKey);
      shake(f);
      requestAnimationFrame(() => f.input.focus({ preventScroll: true })); // (#28)
      track("validation_fail", { step, key: q.key, error: errKey });
      return;
    }

    // Pass — persist + advance
    setError(f, null);
    state.answers[q.key] = value;
    writeStore();
    pushAttempt();
    setStatus("SAVED ✓", "saved");
    track("autosave", { step, key: q.key });
    track("step_complete", { step, key: q.key });

    if (step >= TOTAL_STEPS) {
      history.pushState(null, "", "#done");
      onHashChange();
    } else {
      history.pushState(null, "", "#" + (step + 1));
      onHashChange();
    }
  }, "tryAdvance");

  const shake = (f) => {
    f.sec.classList.add("invalid");
    setTimeout(() => f.sec.classList.remove("invalid"), 200);
  };

  // ════════════════════════════════════════════════════════════════════
  //  Navigation guard (#9 #24)
  // ════════════════════════════════════════════════════════════════════
  const firstMissingStep = () => {
    for (let i = 0; i < QUESTIONS.length; i++) {
      const v = cleanValue(QUESTIONS[i].key, state.answers[QUESTIONS[i].key] || "");
      if (!v) return i + 1;
    }
    return null;
  };

  const parseHash = () => {
    const raw = (location.hash || "").replace(/^#/, "");
    if (raw === "done") return "done";
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= TOTAL_STEPS) return n;
    return 1;
  };

  const onHashChange = safe(() => {
    let target = parseHash();

    if (target === "done") {
      const missing = firstMissingStep();
      if (missing !== null) {
        track("completion_guard_fail", { missing });
        location.replace("#" + missing);
        return;
      }
      render("done");
      submit();
      return;
    }

    if (typeof target === "number" && target > 1) {
      for (let i = 0; i < target - 1; i++) {
        const v = cleanValue(QUESTIONS[i].key, state.answers[QUESTIONS[i].key] || "");
        if (!v) {
          location.replace("#" + (i + 1));
          return;
        }
      }
    }

    render(target);
  }, "onHashChange");

  // ════════════════════════════════════════════════════════════════════
  //  Submit (#2 #31 #32 #37 #39 #40)
  // ════════════════════════════════════════════════════════════════════
  const submit = safeAsync(async () => {
    // Completion guard (#37)
    const missing = firstMissingStep();
    if (missing !== null) {
      track("completion_guard_fail", { missing });
      location.replace("#" + missing);
      return;
    }

    const data = {};
    for (const q of QUESTIONS) {
      data[q.key] = cleanValue(q.key, state.answers[q.key] || "");
    }

    const submissionId = uuid();
    const timestamp    = new Date().toISOString();
    const confidence   = computeConfidence(data);

    state.perf.submitMs     = performance.now();
    state.perf.completionMs = state.startTime ? Date.now() - state.startTime : null;

    const payload = {
      version:      CONFIG.VERSION,
      submissionId,
      timestamp,
      env:          CONFIG.ENV,
      mode:         CONFIG.MODE,
      data,
      confidence,
      perf:         { ...state.perf },
      hash:         await sha256(data),
    };

    log("[PKC] submission payload", payload);
    track("submit", { submissionId, hash: payload.hash });
    track("completion_time", { ms: state.perf.completionMs });

    const shouldFetch =
      CONFIG.ENDPOINT &&
      (CONFIG.MODE === "prod" || CONFIG.MODE === "staging");

    if (shouldFetch) {
      try {
        if (!navigator.onLine) {
          enqueue(payload);
          track("submit_failed", { submissionId, reason: "offline" });
        } else {
          const res = await fetch(CONFIG.ENDPOINT, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      } catch (e) {
        warn("[PKC] submit network error", e);
        enqueue(payload);
        track("submit_failed", { submissionId, reason: String(e) });
      }
    }

    // Render thank-you reveal
    const confirmEl = document.getElementById("confirm-line");
    confirmEl.removeAttribute("data-revealed");
    requestAnimationFrame(() => confirmEl.dataset.revealed = "true");

    // Submission ID reveal (debug only)
    if (CONFIG.DEBUG) {
      const idEl = document.getElementById("submission-id");
      if (idEl) {
        idEl.textContent = "// SUBMISSION_ID: " + submissionId;
        idEl.hidden = false;
      }
    }

    track("submit_confirmed", { submissionId });

    // Clear in-progress storage (run is complete)
    clearStore();

    // Final flush
    flushEvents();
  }, "submit");

  // ════════════════════════════════════════════════════════════════════
  //  Idle recovery (#14)
  // ════════════════════════════════════════════════════════════════════
  const resetIdleTimer = () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    QUESTIONS.forEach((q) => {
      const f = state.fields.get(q.key);
      if (f && f.idleEl) f.idleEl.hidden = true;
    });
    state.idleTimer = setTimeout(() => {
      const q = QUESTIONS[state.currentStep - 1];
      if (!q) return;
      const f = state.fields.get(q.key);
      if (!f) return;
      f.idleEl.hidden = false;
      track("idle_hint", { step: state.currentStep });
    }, CONFIG.IDLE_MS);
  };

  // ════════════════════════════════════════════════════════════════════
  //  Online / offline (#15)
  // ════════════════════════════════════════════════════════════════════
  const onOnline = safe(() => {
    if (state.statusToken && document.getElementById("status").dataset.tone === "offline") {
      setStatus("");
    }
    track("online");
    drainQueue();
  }, "onOnline");

  const onOffline = safe(() => {
    setStatus("OFFLINE MODE — WILL SYNC LATER", "offline", { sticky: true });
    track("offline");
  }, "onOffline");

  // ════════════════════════════════════════════════════════════════════
  //  Window-exposed surface (#45 #48 #49)
  // ════════════════════════════════════════════════════════════════════
  window.PKC_HEALTH = () => ({
    version:      CONFIG.VERSION,
    env:          CONFIG.ENV,
    mode:         CONFIG.MODE,
    debug:        CONFIG.DEBUG,
    online:       navigator.onLine,
    reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    step:         state.currentStep,
    answeredKeys: Object.keys(state.answers).filter((k) => state.answers[k]),
    queueLen:     getQueue().length,
    attemptsLen:  getAttempts().length,
    startMs:      state.startTime,
    uptimeMs:     state.perf.start ? performance.now() - state.perf.start : 0,
  });

  window.PKC_REPLAY = (data) => {
    if (!data || typeof data !== "object") {
      err("[PKC] PKC_REPLAY expects an object");
      return;
    }
    track("replay", { keys: Object.keys(data) });
    state.answers = { ...state.answers, ...data };
    return submit();
  };

  window.PKC_QUEUE = () => getQueue();
  window.PKC_QUEUE.clear = () => {
    try { localStorage.removeItem(QUEUE_KEY); log("[PKC] queue cleared"); }
    catch (e) { warn("[PKC] queue clear failed", e); }
  };
  window.PKC_QUEUE.drain = () => drainQueue();

  // ════════════════════════════════════════════════════════════════════
  //  Boot (#46 #47)
  // ════════════════════════════════════════════════════════════════════
  const boot = safe(() => {
    if (CONFIG.DEBUG) {
      console.log(`%c[PKC] v${CONFIG.VERSION} • env=${CONFIG.ENV} • mode=${CONFIG.MODE} • debug=${CONFIG.DEBUG}`,
        "color:#FF5F1F;font-weight:bold");
      console.log("[PKC CONFIG]", CONFIG);
    }

    state.perf.start = performance.now();
    state.startTime  = Date.now();

    // Hydrate
    const stored = readStore();
    if (stored?.data) {
      state.answers = { ...stored.data };
    }

    // Build sections
    buildSections();

    // Drain queue (best-effort, non-blocking)
    drainQueue();

    // Fast-forward (#24)
    const hash = (location.hash || "").replace(/^#/, "");
    const hasAnswers = Object.values(state.answers).some(Boolean);
    if ((hash === "" || hash === "1") && hasAnswers) {
      const missing = firstMissingStep();
      const target = missing === null ? "done" : String(missing);
      if (target !== "1") {
        track("fast_forward", { from: 1, to: target });
        location.replace("#" + target);
      }
    }

    // Listeners
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pagehide",     flushEvents);
    window.addEventListener("beforeunload", flushEvents);

    document.getElementById("back").addEventListener("click", (ev) => {
      ev.preventDefault();
      history.back();
    });

    // Initial state
    if (!navigator.onLine) onOffline();
    onHashChange();

    // Flush interval
    state.flushInterval = setInterval(flushEvents, CONFIG.FLUSH_MS);

    // Ready (#46)
    document.body.classList.add("ready");
    state.booted = true;
  }, "boot");

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
