/* ProjectKidCreations — account/app.js
 * Operator account SPA. Four tabs — Profile / Security / Notifications / Activity.
 *
 * Boot:
 *   1) GET /api/account/profile (cookie-authed)
 *   2) 401 → redirect to /account/login?next=...
 *   3) 200 → cache profile, render shell, activate the URL-hash tab (default profile)
 *
 * Activity loads lazily on first tab activation. Sessions preload in the
 * background after boot so the Security tab feels instant.
 */

(function () {
  "use strict";

  const CFG = window.PKC_ACCOUNT;
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ── State ──────────────────────────────────────────────────
  let profile = null;          // canonical server copy
  let formSnapshot = null;     // what the form looked like at last load/save
  let activeTab = "profile";
  let activityLoaded = false;
  let sessionsLoaded = false;
  let sessionsCache = null;

  const TAB_IDS = ["profile", "security", "notifs", "activity"];

  // ── Tiny helpers ───────────────────────────────────────────
  const statusEl = () => $("#status");

  function setStatus(text, tone) {
    const el = statusEl();
    if (!el) return;
    el.textContent = text;
    if (tone) el.setAttribute("data-tone", tone);
    else el.removeAttribute("data-tone");
  }

  function flashStatus(text, tone, ms) {
    setStatus(text, tone);
    setTimeout(() => setStatus("// IDLE"), ms || 2200);
  }

  // Fetch wrapper — cookie-included, JSON-aware. Returns { ok, status, data }.
  async function api(url, opts) {
    const init = Object.assign({
      method: "GET",
      credentials: "include",
      headers: {}
    }, opts || {});
    if (init.body && typeof init.body !== "string") {
      init.body = JSON.stringify(init.body);
      init.headers["Content-Type"] = "application/json";
    }
    let resp, data = null;
    try {
      resp = await fetch(url, init);
    } catch (_err) {
      return { ok: false, status: 0, data: null, networkError: true };
    }
    const ct = resp.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
      try { data = await resp.json(); } catch (_e) { data = null; }
    } else {
      try { data = await resp.text(); } catch (_e) { data = null; }
    }
    return { ok: resp.ok, status: resp.status, data, raw: resp };
  }

  // ── Relative time ──────────────────────────────────────────
  function relativeTime(iso) {
    if (!iso) return "—";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return String(iso);
    const diffMs = Date.now() - t;
    const s = Math.round(diffMs / 1000);
    if (s < 5)        return "just now";
    if (s < 60)       return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60)       return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24)       return h + "h ago";
    const d = Math.round(h / 24);
    if (d < 30)       return d + "d ago";
    const mo = Math.round(d / 30);
    if (mo < 12)      return mo + "mo ago";
    return Math.round(mo / 12) + "y ago";
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ── Boot ───────────────────────────────────────────────────
  async function boot() {
    setStatus("// LOADING PROFILE", "working");
    const result = await api(CFG.PROFILE_URL);

    if (result.status === 401) {
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      window.location.replace(CFG.LOGIN_REDIRECT + "?next=" + next);
      return;
    }

    if (!result.ok || !result.data || typeof result.data !== "object") {
      // Fatal — show kill state, swap boot copy.
      const boot = $("#boot");
      if (boot) {
        boot.innerHTML = '<p class="step-label">// COULDN\'T LOAD ACCOUNT</p>' +
          '<h2>SYSTEM HICCUP</h2>' +
          '<p>Try refreshing. If this keeps happening, contact support.</p>';
      }
      return;
    }

    profile = result.data.profile || result.data;
    renderShell();
    hydrateProfile();
    bindEvents();

    // URL hash deep-link
    const fromHash = (location.hash || "").replace(/^#/, "").toLowerCase();
    const initial = TAB_IDS.includes(fromHash) ? fromHash : "profile";
    activateTab(initial, { pushHash: false });

    // Reveal
    $("#boot").hidden = true;
    $("#shell").hidden = false;
    $("#tab-strip").hidden = false;
    $("#main").hidden = false;
    setStatus("// IDLE");

    // Preload sessions in the background (Security tab feels instant).
    setTimeout(() => { loadSessions().catch(() => {}); }, 400);
  }

  function renderShell() {
    const uname = profile.username || profile.display_name || "OPERATOR";
    $("#username-display").textContent = uname.toUpperCase();
    const hint = $("#delete-username-hint");
    if (hint) hint.textContent = profile.username || "—";
  }

  // ── Profile tab ────────────────────────────────────────────
  function hydrateProfile() {
    const f = $("#profile-form");
    if (!f) return;

    f.display_name.value = profile.display_name || "";
    f.first_name.value   = profile.first_name   || "";
    f.last_name.value    = profile.last_name    || "";
    f.pronouns.value     = profile.pronouns     || "";
    f.bio.value          = profile.bio          || "";
    f.email.value        = profile.email        || "";

    updateBioCount();
    snapshotForm();
    refreshSaveState();

    // Marketing toggle
    const mk = $("#notif-marketing");
    if (mk) {
      const v = String(profile.notif_marketing || "FALSE").toUpperCase();
      mk.checked = (v === "TRUE");
      $("#notif-marketing-state").textContent = mk.checked ? "// ON" : "// OFF";
    }
  }

  function snapshotForm() {
    const f = $("#profile-form");
    if (!f) return;
    formSnapshot = {
      display_name: f.display_name.value,
      first_name:   f.first_name.value,
      last_name:    f.last_name.value,
      pronouns:     f.pronouns.value,
      bio:          f.bio.value
    };
  }

  function formDiff() {
    if (!formSnapshot) return {};
    const f = $("#profile-form");
    const diff = {};
    ["display_name","first_name","last_name","pronouns","bio"].forEach((k) => {
      if ((f[k].value || "") !== (formSnapshot[k] || "")) diff[k] = f[k].value;
    });
    return diff;
  }

  function refreshSaveState() {
    const dirty = Object.keys(formDiff()).length > 0;
    const save = $("#save-btn");
    const discard = $("#discard-btn");
    [save, discard].forEach((b) => {
      if (!b) return;
      if (dirty) { b.disabled = false; b.removeAttribute("aria-disabled"); }
      else       { b.disabled = true;  b.setAttribute("aria-disabled", "true"); }
    });
  }

  function updateBioCount() {
    const v = $("#bio").value || "";
    $("#bio-count").textContent = String(v.length);
  }

  function setFieldError(name, message) {
    const wrap = document.querySelector('[data-field="' + name + '"]');
    const err  = document.querySelector('[data-error-for="' + name + '"]');
    if (wrap) wrap.classList.toggle("invalid", !!message);
    if (err) {
      err.textContent = message || "";
      err.hidden = !message;
    }
  }

  function clearAllErrors() {
    ["display_name","first_name","last_name","pronouns","bio"].forEach((n) => setFieldError(n, ""));
  }

  async function saveProfile() {
    const diff = formDiff();
    if (!Object.keys(diff).length) return;
    clearAllErrors();
    setStatus("// SAVING", "working");
    $("#save-btn").disabled = true;

    const r = await api(CFG.PROFILE_URL, { method: "PATCH", body: diff });

    if (r.ok) {
      // Server returns updated profile (or echo) — refresh local copy.
      const updated = (r.data && r.data.profile) || (r.data && typeof r.data === "object" ? r.data : null);
      if (updated) profile = Object.assign({}, profile, updated);
      else         profile = Object.assign({}, profile, diff);
      snapshotForm();
      refreshSaveState();
      flashStatus("// SAVED", "success");
      return;
    }

    if (r.status === 400 && r.data && typeof r.data === "object") {
      const errors = r.data.errors || r.data.fieldErrors || null;
      if (errors && typeof errors === "object") {
        Object.keys(errors).forEach((k) => setFieldError(k, errors[k]));
      }
      flashStatus("// CHECK FIELDS", "error", 3000);
    } else if (r.status === 401) {
      window.location.replace(CFG.LOGIN_REDIRECT);
    } else {
      flashStatus("// SAVE FAILED", "error", 3000);
    }
    refreshSaveState();
  }

  function discardChanges() {
    const f = $("#profile-form");
    if (!f || !formSnapshot) return;
    Object.keys(formSnapshot).forEach((k) => { if (f[k]) f[k].value = formSnapshot[k]; });
    clearAllErrors();
    updateBioCount();
    refreshSaveState();
    flashStatus("// REVERTED", "working", 1200);
  }

  // ── Security: password ─────────────────────────────────────
  async function submitPassword(e) {
    e.preventDefault();
    const cur  = $("#current_password").value;
    const nw   = $("#new_password").value;
    const cnf  = $("#confirm_password").value;
    const res  = $("#password-result");
    res.removeAttribute("data-tone");
    res.textContent = "";

    if (!cur || !nw || !cnf) {
      res.setAttribute("data-tone", "error");
      res.textContent = "// FILL ALL FIELDS";
      return;
    }
    if (nw !== cnf) {
      res.setAttribute("data-tone", "error");
      res.textContent = "// NEW PASSWORDS DON'T MATCH";
      return;
    }

    setStatus("// UPDATING PASSWORD", "working");
    const r = await api(CFG.PASSWORD_URL, {
      method: "POST",
      body: { current_password: cur, new_password: nw }
    });

    if (r.ok) {
      res.setAttribute("data-tone", "success");
      res.textContent = "// PASSWORD UPDATED";
      $("#password-form").reset();
      flashStatus("// PASSWORD UPDATED", "success");
    } else if (r.status === 401) {
      window.location.replace(CFG.LOGIN_REDIRECT);
    } else {
      const msg = (r.data && r.data.error) ? String(r.data.error) : "could_not_update";
      res.setAttribute("data-tone", "error");
      res.textContent = "// " + msg.toUpperCase().replace(/_/g, " ");
      flashStatus("// COULDN'T UPDATE", "error", 3000);
    }
  }

  // ── Security: email change ─────────────────────────────────
  async function submitEmailChange(e) {
    e.preventDefault();
    const pw  = $("#email_current_password").value;
    const eml = $("#new_email").value.trim();
    const res = $("#email-result");
    res.removeAttribute("data-tone");
    res.textContent = "";

    if (!pw || !eml) {
      res.setAttribute("data-tone", "error");
      res.textContent = "// FILL ALL FIELDS";
      return;
    }

    setStatus("// REQUESTING EMAIL CHANGE", "working");
    const r = await api(CFG.EMAIL_CHANGE_URL, {
      method: "POST",
      body: { current_password: pw, new_email: eml }
    });

    if (r.ok) {
      res.setAttribute("data-tone", "success");
      res.textContent = "// CHECK BOTH INBOXES TO CONFIRM";
      $("#email-form").reset();
      flashStatus("// EMAIL CHANGE REQUESTED", "success", 2600);
    } else if (r.status === 401) {
      window.location.replace(CFG.LOGIN_REDIRECT);
    } else {
      const msg = (r.data && r.data.error) ? String(r.data.error) : "could_not_request";
      res.setAttribute("data-tone", "error");
      res.textContent = "// " + msg.toUpperCase().replace(/_/g, " ");
      flashStatus("// COULDN'T REQUEST", "error", 3000);
    }
  }

  // ── Security: sessions ─────────────────────────────────────
  async function loadSessions() {
    if (sessionsLoaded) return renderSessions(sessionsCache);
    const r = await api(CFG.SESSIONS_URL);
    if (r.status === 401) {
      window.location.replace(CFG.LOGIN_REDIRECT);
      return;
    }
    if (!r.ok) {
      const region = $("#sessions-region");
      if (region) region.innerHTML = '<p class="field-error">// COULDN\'T LOAD SESSIONS</p>';
      return;
    }
    const list = (r.data && r.data.sessions) || r.data || [];
    sessionsCache = Array.isArray(list) ? list : [];
    sessionsLoaded = true;
    renderSessions(sessionsCache);
  }

  function renderSessions(list) {
    const region = $("#sessions-region");
    if (!region) return;
    if (!list || !list.length) {
      region.innerHTML = '<p class="field-hint">// NO ACTIVE SESSIONS</p>';
      return;
    }
    const rows = list.map((s) => {
      const id     = s.session_id || s.id || "";
      const label  = s.device_label || s.user_agent || s.label || "Unknown device";
      const when   = relativeTime(s.created_at || s.signed_in_at);
      const isCur  = !!(s.is_current || s.current);
      const right  = isCur
        ? '<span class="session-badge">// CURRENT</span>'
        : '<button type="button" class="btn btn--ghost btn--sm" data-revoke="' + escapeHtml(id) + '">// REVOKE</button>';
      return '<div class="session-row">' +
               '<div>' +
                 '<div class="session-label">' + escapeHtml(label) + '</div>' +
                 '<div class="session-meta">Signed in ' + escapeHtml(when) + '</div>' +
               '</div>' +
               '<span class="session-meta">' + escapeHtml(id ? id.slice(0,8) : "") + '</span>' +
               right +
             '</div>';
    }).join("");
    region.innerHTML = '<div class="sessions-list">' + rows + '</div>';
  }

  async function revokeSession(sessionId, btn) {
    if (!sessionId) return;
    btn.disabled = true;
    setStatus("// REVOKING SESSION", "working");
    const r = await api(CFG.SESSIONS_REVOKE_URL, {
      method: "POST",
      body: { session_id: sessionId }
    });
    if (r.ok) {
      sessionsCache = (sessionsCache || []).filter((s) => (s.session_id || s.id) !== sessionId);
      renderSessions(sessionsCache);
      flashStatus("// SESSION REVOKED", "success");
    } else {
      btn.disabled = false;
      flashStatus("// COULDN'T REVOKE", "error", 3000);
    }
  }

  // ── Security: delete account ───────────────────────────────
  function refreshDeleteGate() {
    const u = $("#delete_username_confirm").value.trim();
    const p = $("#delete_current_password").value;
    const ok = !!(profile && u === profile.username && p.length > 0);
    const btn = $("#delete-btn");
    if (!btn) return;
    btn.disabled = !ok;
    if (ok) btn.removeAttribute("aria-disabled");
    else    btn.setAttribute("aria-disabled","true");
  }

  async function submitDelete(e) {
    e.preventDefault();
    const u = $("#delete_username_confirm").value.trim();
    const p = $("#delete_current_password").value;
    const res = $("#delete-result");
    res.removeAttribute("data-tone");

    if (!profile || u !== profile.username || !p) {
      res.setAttribute("data-tone","error");
      res.textContent = "// CONFIRMATION INCOMPLETE";
      return;
    }
    if (!window.confirm("This deletes your operator account forever. Continue?")) return;

    setStatus("// DELETING ACCOUNT", "working");
    const r = await api(CFG.DELETE_URL, {
      method: "POST",
      body: { current_password: p, i_am_sure: true }
    });
    if (r.ok) {
      window.location.replace(CFG.LOGIN_REDIRECT + "?deleted=1");
    } else {
      const msg = (r.data && r.data.error) ? String(r.data.error) : "could_not_delete";
      res.setAttribute("data-tone","error");
      res.textContent = "// " + msg.toUpperCase().replace(/_/g, " ");
      flashStatus("// DELETE FAILED", "error", 3000);
    }
  }

  // ── Notifications ──────────────────────────────────────────
  async function toggleMarketing() {
    const cb = $("#notif-marketing");
    const stateLbl = $("#notif-marketing-state");
    const prev = !cb.checked; // optimistic flip already happened
    stateLbl.textContent = cb.checked ? "// ON" : "// OFF";
    setStatus("// UPDATING NOTIFS", "working");

    const r = await api(CFG.PROFILE_URL, {
      method: "PATCH",
      body: { notif_marketing: cb.checked ? "TRUE" : "FALSE" }
    });

    if (r.ok) {
      profile.notif_marketing = cb.checked ? "TRUE" : "FALSE";
      flashStatus("// NOTIFS UPDATED", "success", 1800);
    } else {
      // Rollback
      cb.checked = prev;
      stateLbl.textContent = cb.checked ? "// ON" : "// OFF";
      flashStatus("// COULDN'T UPDATE", "error", 3000);
    }
  }

  // ── Activity ───────────────────────────────────────────────
  function classifyEventTone(type) {
    if (!type) return "neutral";
    const t = String(type).toLowerCase();
    if (/fail|denied|revoked|invalid|locked|delete/.test(t)) return "fail";
    if (/success|saved|verified|created|signed_in|password_changed|email_changed/.test(t)) return "success";
    return "neutral";
  }

  function renderActivity(list) {
    const region = $("#activity-region");
    const meta = $("#activity-meta");
    if (!region) return;

    if (!list || !list.length) {
      region.innerHTML =
        '<div class="full-state">' +
          '<p class="step-label">// EMPTY LOG</p>' +
          '<h2>NO ACTIVITY YET</h2>' +
          '<p>Nothing to show. As you use your account, events will land here.</p>' +
        '</div>';
      if (meta) meta.textContent = "// 0 EVENTS";
      return;
    }

    if (meta) meta.textContent = "// " + list.length + " EVENT" + (list.length === 1 ? "" : "S");

    const rows = list.map((ev) => {
      const t      = ev.timestamp || ev.created_at || ev.at;
      const type   = ev.event_type || ev.type || "event";
      const tone   = classifyEventTone(type);
      const summ   = ev.summary || ev.message || ev.description || "—";
      return '<div class="timeline-row">' +
               '<span class="timeline-time">' + escapeHtml(relativeTime(t)) + '</span>' +
               '<span class="timeline-type" data-tone="' + tone + '">' + escapeHtml(type) + '</span>' +
               '<span class="timeline-summary">' + escapeHtml(summ) + '</span>' +
             '</div>';
    }).join("");

    region.innerHTML = '<div class="timeline">' + rows + '</div>';
  }

  async function loadActivity(force) {
    if (activityLoaded && !force) return;
    const region = $("#activity-region");
    const meta = $("#activity-meta");
    if (meta) meta.textContent = "// PULLING ACTIVITY...";
    if (region) {
      region.innerHTML =
        '<div class="full-state">' +
          '<p class="step-label">// LOADING</p>' +
          '<h2>READING THE LOG</h2>' +
          '<p>Pulling your recent events...</p>' +
        '</div>';
    }
    const r = await api(CFG.ACTIVITY_URL);
    if (r.status === 401) {
      window.location.replace(CFG.LOGIN_REDIRECT);
      return;
    }
    if (!r.ok) {
      if (region) {
        region.innerHTML =
          '<div class="full-state">' +
            '<p class="step-label">// SYSTEM HICCUP</p>' +
            '<h2>COULDN\'T LOAD ACTIVITY</h2>' +
            '<p>Try the refresh button. If it keeps failing, contact support.</p>' +
          '</div>';
      }
      if (meta) meta.textContent = "// ERROR";
      return;
    }
    const list = (r.data && r.data.activity) || (r.data && r.data.events) || r.data || [];
    activityLoaded = true;
    renderActivity(Array.isArray(list) ? list : []);
  }

  // ── Tabs (WAI-ARIA Tabs APG) ───────────────────────────────
  function activateTab(name, opts) {
    opts = opts || {};
    if (!TAB_IDS.includes(name)) name = "profile";
    activeTab = name;

    $$(".tab").forEach((t) => {
      const isMe = t.getAttribute("data-tab") === name;
      t.setAttribute("aria-selected", isMe ? "true" : "false");
      t.setAttribute("tabindex", isMe ? "0" : "-1");
    });

    $$(".tabpanel").forEach((p) => {
      const isMe = p.getAttribute("aria-labelledby") === ("tab-" + name);
      p.setAttribute("data-active", isMe ? "true" : "false");
      p.hidden = !isMe;
    });

    if (opts.pushHash !== false) {
      const newHash = "#" + name;
      if (location.hash !== newHash) history.replaceState(null, "", newHash);
    }

    // Lazy loads
    if (name === "activity" && !activityLoaded) loadActivity();
    if (name === "security" && !sessionsLoaded) loadSessions();
  }

  function tabKeydown(e) {
    const order = TAB_IDS;
    const idx = order.indexOf(activeTab);
    if (idx < 0) return;
    let next = null;
    switch (e.key) {
      case "ArrowRight": next = order[(idx + 1) % order.length]; break;
      case "ArrowLeft":  next = order[(idx - 1 + order.length) % order.length]; break;
      case "Home":       next = order[0]; break;
      case "End":        next = order[order.length - 1]; break;
      default: return;
    }
    if (next) {
      e.preventDefault();
      activateTab(next);
      const el = $("#tab-" + next);
      if (el) el.focus();
    }
  }

  // ── User menu ──────────────────────────────────────────────
  function toggleUserMenu(open) {
    const trigger = $("#user-menu-trigger");
    const pop = $("#user-menu-pop");
    const isOpen = (typeof open === "boolean") ? open : (trigger.getAttribute("aria-expanded") !== "true");
    trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
    pop.setAttribute("data-open", isOpen ? "true" : "false");
    if (isOpen) {
      setTimeout(() => { $("#sign-out-btn").focus(); }, 0);
    }
  }

  async function signOut() {
    setStatus("// SIGNING OUT", "working");
    try {
      await api(CFG.LOGOUT_URL, { method: "POST" });
    } catch (_) { /* sign-out should be best-effort */ }
    window.location.replace(CFG.LOGIN_REDIRECT);
  }

  // ── Events ─────────────────────────────────────────────────
  function bindEvents() {
    // Tab clicks
    $$(".tab").forEach((t) => {
      t.addEventListener("click", () => activateTab(t.getAttribute("data-tab")));
    });
    $("#tab-strip").addEventListener("keydown", tabKeydown);

    // Hash sync from back/forward
    window.addEventListener("hashchange", () => {
      const h = (location.hash || "").replace(/^#/, "").toLowerCase();
      if (TAB_IDS.includes(h) && h !== activeTab) activateTab(h, { pushHash: false });
    });

    // User menu
    $("#user-menu-trigger").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleUserMenu();
    });
    $("#sign-out-btn").addEventListener("click", signOut);
    document.addEventListener("click", (e) => {
      const menu = $("#user-menu-pop");
      const trig = $("#user-menu-trigger");
      if (!menu || !trig) return;
      if (menu.getAttribute("data-open") !== "true") return;
      if (!menu.contains(e.target) && !trig.contains(e.target)) toggleUserMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") toggleUserMenu(false);
    });

    // Profile form
    const f = $("#profile-form");
    ["display_name","first_name","last_name","pronouns","bio"].forEach((k) => {
      const el = f[k];
      if (!el) return;
      el.addEventListener("input", () => {
        if (k === "bio") updateBioCount();
        setFieldError(k, "");
        refreshSaveState();
      });
    });
    f.addEventListener("submit", (e) => { e.preventDefault(); saveProfile(); });
    $("#discard-btn").addEventListener("click", discardChanges);

    // Change email → jump to Security tab's email subsection
    $("#change-email-link").addEventListener("click", () => {
      activateTab("security");
      setTimeout(() => {
        const node = $("#sec-email");
        if (node && node.scrollIntoView) node.scrollIntoView({ behavior: "smooth", block: "start" });
        const ne = $("#new_email"); if (ne) ne.focus();
      }, 100);
    });

    // Security forms
    $("#password-form").addEventListener("submit", submitPassword);
    $("#email-form").addEventListener("submit", submitEmailChange);

    // Sessions revoke (delegated)
    $("#sessions-region").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-revoke]");
      if (!btn) return;
      const id = btn.getAttribute("data-revoke");
      revokeSession(id, btn);
    });

    // Danger zone
    const dz = $("#danger-zone");
    $("#danger-toggle").addEventListener("click", () => {
      const expanded = dz.getAttribute("data-expanded") === "true";
      dz.setAttribute("data-expanded", expanded ? "false" : "true");
      $("#danger-toggle").textContent = expanded ? "// EXPAND" : "// COLLAPSE";
    });
    ["#delete_username_confirm","#delete_current_password"].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("input", refreshDeleteGate);
    });
    $("#delete-form").addEventListener("submit", submitDelete);

    // Notifications
    const mk = $("#notif-marketing");
    if (mk) mk.addEventListener("change", toggleMarketing);

    // Activity refresh
    $("#activity-refresh").addEventListener("click", () => loadActivity(true));
  }

  // Kick off
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
