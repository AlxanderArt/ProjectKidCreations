/* ProjectKidCreations — /account/admin/app.js
 * Operator-admin dashboard. Vanilla JS, no framework.
 *
 * State machine:
 *   LOADING → ADMIN_OK | ACCESS_DENIED | ERROR_RETRY | ERROR_FATAL
 *
 * Boot order:
 *   1. GET /api/account/profile (credentials:'include')
 *   2. 401 → /account/login?next=/account/admin/
 *   3. !is_admin → render ACCESS DENIED
 *   4. is_admin → in parallel: load page 0 + render pulse stats from
 *      list aggregates. Trend stats stay ghosted until v2.
 */

(function () {
  "use strict";

  const CFG = window.PKC_ADMIN;
  const $   = (sel, root) => (root || document).querySelector(sel);
  const $$  = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ── State ──────────────────────────────────────────────────
  const STATE = {
    machine: "LOADING",
    profile: null,
    page: {
      offset: 0,
      total: 0,
      rows: [],
      sortBy: "last_login",
      sortDir: "desc",
      query: ""
    },
    chat: {
      sessionId: cryptoUUID(),
      thinking: false,
      lastFailedMessage: null
    },
    searchDebounce: null
  };

  function cryptoUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // ── DOM helpers ────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setStatus(text, tone) {
    const el = $("#status");
    if (!el) return;
    el.textContent = text;
    if (tone) el.setAttribute("data-tone", tone);
    else el.removeAttribute("data-tone");
  }

  function setAccountsMeta(text) {
    const el = $("#accounts-meta");
    if (el) el.textContent = text;
  }

  // ── fetchJSON ──────────────────────────────────────────────
  // 60s timeout, cookie-included, JSON in/out, throws structured.
  async function fetchJSON(url, opts) {
    const init = Object.assign({
      method: "GET",
      credentials: "include",
      headers: {}
    }, opts || {});
    if (init.body && typeof init.body !== "string") {
      init.body = JSON.stringify(init.body);
      init.headers["Content-Type"] = "application/json";
    }
    const ctl = new AbortController();
    init.signal = ctl.signal;
    const timer = setTimeout(() => ctl.abort(), 60000);

    let resp;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      clearTimeout(timer);
      const aborted = err && err.name === "AbortError";
      const e = new Error(aborted ? "Request timed out" : "Network error");
      e.status = 0;
      e.aborted = aborted;
      e.networkError = !aborted;
      throw e;
    }
    clearTimeout(timer);

    let body = null;
    const ct = resp.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
      try { body = await resp.json(); } catch (_e) { body = null; }
    } else {
      try { body = await resp.text(); } catch (_e) { body = null; }
    }

    if (!resp.ok) {
      const err = new Error("HTTP " + resp.status);
      err.status = resp.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ── Relative time ──────────────────────────────────────────
  function relativeTime(iso) {
    if (!iso) return "—";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return String(iso);
    const diffMs = Date.now() - t;
    if (diffMs < 0) return "just now";
    const s = Math.round(diffMs / 1000);
    if (s < 5)   return "just now";
    if (s < 60)  return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60)  return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24)  return h + "h ago";
    const d = Math.round(h / 24);
    if (d === 1) return "yesterday";
    if (d < 7)   return d + "d ago";
    if (d < 30)  return Math.round(d / 7) + "w ago";
    const dt = new Date(t);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[dt.getMonth()] + " " + dt.getDate();
  }

  // ────────────────────────────────────────────────────────────
  // BOOT
  // ────────────────────────────────────────────────────────────
  async function boot() {
    STATE.machine = "LOADING";

    let profile;
    try {
      profile = await fetchJSON(CFG.PROFILE_URL);
    } catch (err) {
      if (err.status === 401) {
        const next = encodeURIComponent(location.pathname + location.search + location.hash);
        window.location.replace(CFG.LOGIN_REDIRECT + "?next=" + next);
        return;
      }
      return renderBootError("Couldn't pull your profile. Refresh to try again.");
    }

    if (!profile || typeof profile !== "object") {
      return renderBootError("Profile response was empty.");
    }

    // The profile endpoint may return either {profile:{...}} or the
    // profile object directly. Handle both shapes so we never lock
    // out a valid admin just because the API wrapper changes.
    const p = (profile && profile.profile) ? profile.profile : profile;
    STATE.profile = p;

    if (p.is_admin !== true) {
      STATE.machine = "ACCESS_DENIED";
      $("#boot").hidden = true;
      $("#kill-denied").hidden = false;
      return;
    }

    STATE.machine = "ADMIN_OK";
    $("#boot").hidden = true;
    $("#shell").hidden = false;
    $("#main").hidden = false;
    setStatus("// ADMIN DASHBOARD");

    wireEvents();

    // Load the first page; pulse aggregates come back in the same payload.
    await loadPage(0);

    // Greet
    appendChat("agent",
      "Online. I can pull account records, reset lockouts, re-issue bootstrap emails, " +
      "and trigger password resets. Destructive actions require an explicit `yes` confirm. " +
      "Try: `show locked accounts` or click a quick-action on a row."
    );
  }

  function renderBootError(msg) {
    STATE.machine = "ERROR_FATAL";
    const boot = $("#boot");
    if (!boot) return;
    boot.innerHTML =
      '<p class="step-label">// SYSTEM HICCUP</p>' +
      '<h2>COULDN\'T LOAD ADMIN</h2>' +
      '<p>' + escapeHtml(msg) + '</p>';
  }

  // ────────────────────────────────────────────────────────────
  // EVENT WIRING
  // ────────────────────────────────────────────────────────────
  function wireEvents() {
    // Search
    const searchEl = $("#search-input");
    searchEl.addEventListener("input", (e) => {
      const q = e.target.value.trim();
      clearTimeout(STATE.searchDebounce);
      STATE.searchDebounce = setTimeout(() => {
        if (q.length === 0) {
          STATE.page.query = "";
          loadPage(0);
        } else {
          runSearch(q);
        }
      }, 300);
    });

    // Sortable headers
    $$(".accounts-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => onSortClick(th));
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSortClick(th);
        }
      });
    });

    // Pagination
    $("#prev-page").addEventListener("click", () => {
      if (STATE.page.offset <= 0) return;
      loadPage(Math.max(0, STATE.page.offset - CFG.PAGE_SIZE));
    });
    $("#next-page").addEventListener("click", () => {
      const next = STATE.page.offset + CFG.PAGE_SIZE;
      if (next >= STATE.page.total) return;
      loadPage(next);
    });

    // Action button delegation
    $("#accounts-tbody").addEventListener("click", (e) => {
      const btn = e.target.closest(".action-btn");
      if (!btn) return;
      const kind = btn.getAttribute("data-kind");
      const username = btn.getAttribute("data-username");
      if (!kind || !username) return;
      onActionClick(kind, username);
    });

    // Chat input — auto-grow + send
    const ta = $("#chat-input");
    ta.addEventListener("input", () => autoGrow(ta));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitChat();
      }
    });
    $("#chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitChat();
    });

    // Chat drawer toggle (mobile)
    $("#chat-toggle").addEventListener("click", () => {
      const panel = $("#chat-panel");
      const open = panel.getAttribute("data-open") === "true";
      panel.setAttribute("data-open", String(!open));
      $("#chat-toggle").setAttribute("aria-expanded", String(!open));
    });

    // Delegated user-chip clicks inside the chat log
    $("#chat-log").addEventListener("click", (e) => {
      const chip = e.target.closest(".user-chip");
      if (!chip) return;
      const username = chip.getAttribute("data-username");
      if (username) focusAccountRow(username);
    });
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    const max = 168; // ≈ 6 rows at 14px
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  }

  function onSortClick(th) {
    const key = th.getAttribute("data-sort");
    if (!key) return;
    const current = th.getAttribute("aria-sort");
    const nextDir = current === "ascending" ? "desc" : "asc";

    $$(".accounts-table thead th[data-sort]").forEach((other) => {
      other.setAttribute("aria-sort", "none");
    });
    th.setAttribute("aria-sort", nextDir === "asc" ? "ascending" : "descending");

    STATE.page.sortBy  = key;
    STATE.page.sortDir = nextDir;
    loadPage(0);
  }

  // ────────────────────────────────────────────────────────────
  // ACCOUNTS — list + search
  //
  // Uses the dedicated /api/account/admin/list + /search endpoints
  // (the agent-by-tool flow would cost a round-trip to the LLM for
  // every page nav, which is too slow for a table).
  // ────────────────────────────────────────────────────────────
  async function loadPage(offset) {
    setStatus("// LOADING", "working");
    setAccountsMeta("// LOADING...");
    const tbody = $("#accounts-tbody");
    tbody.innerHTML = '<tr><td class="table-state" colspan="7">// LOADING ACCOUNTS...</td></tr>';

    const payload = {
      offset: offset,
      limit:  CFG.PAGE_SIZE,
      sort_by: STATE.page.sortBy,
      sort_dir: STATE.page.sortDir
    };

    try {
      const body = await fetchJSON(CFG.LIST_URL, { method: "POST", body: payload });
      STATE.page.offset = offset;
      STATE.page.query  = "";
      STATE.page.rows   = Array.isArray(body && body.rows) ? body.rows : [];
      STATE.page.total  = Number((body && body.total) || STATE.page.rows.length);

      // Aggregates ride along on the list response — render them
      // once, but every page refresh keeps them current.
      const agg = (body && body.aggregates) || {};
      renderPulseStrip(agg);

      renderTable(STATE.page.rows, STATE.page.total, offset);
      setStatus("// ADMIN DASHBOARD", "success");
      setTimeout(() => setStatus("// ADMIN DASHBOARD"), 800);
    } catch (err) {
      handleTableError(err);
    }
  }

  async function runSearch(q) {
    setStatus("// SEARCHING", "working");
    setAccountsMeta("// SEARCHING “" + q + "”...");
    const tbody = $("#accounts-tbody");
    tbody.innerHTML = '<tr><td class="table-state" colspan="7">// SEARCHING...</td></tr>';

    try {
      const body = await fetchJSON(CFG.SEARCH_URL, { method: "POST", body: { q: q } });
      STATE.page.query  = q;
      STATE.page.offset = 0;
      STATE.page.rows   = Array.isArray(body && body.rows) ? body.rows : [];
      STATE.page.total  = Number((body && body.total) || STATE.page.rows.length);

      const agg = (body && body.aggregates) || null;
      if (agg) renderPulseStrip(agg);

      renderTable(STATE.page.rows, STATE.page.total, 0);
      setStatus("// ADMIN DASHBOARD");
    } catch (err) {
      handleTableError(err);
    }
  }

  function handleTableError(err) {
    setStatus("// ERROR", "error");
    const tbody = $("#accounts-tbody");
    let msg = "// FAILED TO LOAD";
    if (err.status === 401) {
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      window.location.replace(CFG.LOGIN_REDIRECT + "?next=" + next);
      return;
    }
    if (err.status === 403) msg = "// FORBIDDEN — ADMIN SCOPE REVOKED";
    else if (err.aborted)   msg = "// REQUEST TIMED OUT";
    else if (err.networkError) msg = "// NETWORK UNREACHABLE";
    tbody.innerHTML = '<tr><td class="table-state" colspan="7">' + msg + '</td></tr>';
    setAccountsMeta(msg);
  }

  // ────────────────────────────────────────────────────────────
  // RENDERERS
  // ────────────────────────────────────────────────────────────
  function renderPulseStrip(agg) {
    const total = numOr(agg.total, "—");
    const locked = numOr(agg.locked, "—");
    const logins24h = numOrGhost(agg.logins_24h);
    const lockouts7d = numOrGhost(agg.lockouts_7d);

    setStatValue("total", total);
    setStatValue("locked", locked);
    setStatValue("logins24h", logins24h.value);
    setGhost("logins24h-trend", logins24h.ghost);
    setStatValue("lockouts7d", lockouts7d.value);
    setGhost("lockouts7d-trend", lockouts7d.ghost);

    const lockoutCard = $('.pulse-card[data-stat="lockouts7d"]');
    if (lockoutCard) {
      const n = Number(agg.lockouts_7d);
      lockoutCard.setAttribute("data-tone", (Number.isFinite(n) && n > 0) ? "danger" : "neutral");
    }
  }

  function numOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : fallback;
  }
  function numOrGhost(v) {
    const n = Number(v);
    if (Number.isFinite(n)) return { value: String(n), ghost: false };
    return { value: "—", ghost: true };
  }
  function setStatValue(key, value) {
    const el = document.querySelector('[data-value="' + key + '"]');
    if (el) el.textContent = value;
  }
  function setGhost(key, ghost) {
    const el = document.querySelector('[data-value="' + key + '"]');
    if (!el) return;
    el.setAttribute("data-ghost", String(!!ghost));
    el.textContent = ghost ? "// LIVE SOON" : "// LAST 24H";
  }

  function renderTable(rows, total, offset) {
    const tbody = $("#accounts-tbody");
    if (!rows || rows.length === 0) {
      tbody.innerHTML =
        '<tr><td class="table-state" colspan="7">// NO MATCHES</td></tr>';
      updatePagination(total, offset);
      setAccountsMeta("// 0 RESULTS");
      return;
    }

    const html = rows.map((row) => rowHtml(row)).join("");
    tbody.innerHTML = html;
    updatePagination(total, offset);

    const lo = offset + 1;
    const hi = offset + rows.length;
    const queryNote = STATE.page.query ? ' · MATCH "' + escapeHtml(STATE.page.query) + '"' : "";
    setAccountsMeta("// " + lo + "–" + hi + " OF " + total + queryNote);
  }

  function rowHtml(row) {
    const username = row.username || "";
    const email = row.email || "";
    const status = String(row.status || "active").toLowerCase();
    const tier = Number(row.lockout_tier || 0);
    const lastLogin = relativeTime(row.last_login_at);
    const created = relativeTime(row.created_at);
    const isDeleted = status === "deleted";
    const hasNoBootstrap = !row.password_set_at;

    let actions = "";
    if (!isDeleted) {
      if (tier > 0) {
        actions += btnHtml("unlock", username, "UNLOCK");
      }
      if (hasNoBootstrap) {
        actions += btnHtml("reboot", username, "RE-BOOTSTRAP");
      }
      actions += btnHtml("reset", username, "RESET PW");
    }

    return ''
      + '<tr role="row" data-username="' + escapeHtml(username) + '">'
      +   '<td class="col-username">' + escapeHtml(username) + '</td>'
      +   '<td class="col-email">' + escapeHtml(email) + '</td>'
      +   '<td><span class="status-pill" data-status="' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></td>'
      +   '<td><span class="tier-badge" data-tier="' + tier + '" aria-label="lockout tier ' + tier + '">' + tier + '</span></td>'
      +   '<td class="col-time">' + escapeHtml(lastLogin) + '</td>'
      +   '<td class="col-time">' + escapeHtml(created) + '</td>'
      +   '<td><div class="actions-cell">' + actions + '</div></td>'
      + '</tr>';
  }

  function btnHtml(kind, username, label) {
    return '<button type="button" class="action-btn" data-kind="' + kind + '" data-username="' + escapeHtml(username) + '">[' + label + ']</button>';
  }

  function updatePagination(total, offset) {
    const size = CFG.PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.floor(offset / size) + 1;
    $("#page-info").textContent = "// PAGE " + current + " / " + pages;
    $("#prev-page").disabled = offset <= 0;
    $("#next-page").disabled = offset + size >= total;
  }

  // ────────────────────────────────────────────────────────────
  // CHAT
  // ────────────────────────────────────────────────────────────
  function submitChat() {
    const ta = $("#chat-input");
    const text = ta.value.trim();
    if (!text || STATE.chat.thinking) return;
    ta.value = "";
    autoGrow(ta);
    sendChatMessage(text);
  }

  async function sendChatMessage(message) {
    STATE.chat.lastFailedMessage = null;
    appendChat("user", message);
    setThinking(true);

    // Ensure mobile drawer pops up when a quick-action fires
    if (window.matchMedia && window.matchMedia("(max-width: 1024px)").matches) {
      const panel = $("#chat-panel");
      panel.setAttribute("data-open", "true");
      $("#chat-toggle").setAttribute("aria-expanded", "true");
    }

    try {
      const body = await fetchJSON(CFG.CHAT_URL, {
        method: "POST",
        body: {
          message: message,
          sessionId: STATE.chat.sessionId
        }
      });
      setThinking(false);

      const reply = (body && (body.reply || body.message || body.text)) || "";
      if (reply) {
        appendChat("agent", String(reply));
      } else {
        appendChat("agent", "(no reply)");
      }

      // If the agent reported a state-changing action, refresh the table.
      if (body && body.refresh === true) {
        loadPage(STATE.page.offset);
      }
    } catch (err) {
      setThinking(false);
      STATE.chat.lastFailedMessage = message;
      appendChatError(err);
    }
  }

  function setThinking(on) {
    STATE.chat.thinking = !!on;
    const log = $("#chat-log");
    const existing = log.querySelector(".thinking");
    if (on) {
      if (!existing) {
        const node = document.createElement("div");
        node.className = "thinking";
        node.setAttribute("role", "status");
        node.textContent = "// AGENT THINKING";
        log.appendChild(node);
        scrollChatToBottom();
      }
      $("#chat-send").disabled = true;
    } else {
      if (existing) existing.remove();
      $("#chat-send").disabled = false;
    }
  }

  // Render an agent message as plain text, but linkify backtick-wrapped
  // usernames (\`username\`) into clickable chips that focus the row.
  function renderChatMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "chat-message";
    wrap.setAttribute("data-role", role);

    const roleLabel = document.createElement("div");
    roleLabel.className = "chat-message__role";
    roleLabel.textContent = role === "user" ? "// USER" : (role === "agent" ? "// AGENT" : "// SYSTEM");
    wrap.appendChild(roleLabel);

    const body = document.createElement("div");
    body.className = "chat-message__body";
    body.innerHTML = linkifyUsernames(String(text));
    wrap.appendChild(body);

    return wrap;
  }

  function appendChat(role, text) {
    const log = $("#chat-log");
    const node = renderChatMessage(role, text);
    log.appendChild(node);
    scrollChatToBottom();
  }

  function appendChatError(err) {
    const log = $("#chat-log");
    const wrap = document.createElement("div");
    wrap.className = "chat-error-chip";
    wrap.innerHTML = '<span>// AGENT UNAVAILABLE — RETRY?</span> <button type="button">RETRY</button>';
    wrap.querySelector("button").addEventListener("click", () => {
      const msg = STATE.chat.lastFailedMessage;
      wrap.remove();
      if (msg) sendChatMessage(msg);
    });
    log.appendChild(wrap);
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    const log = $("#chat-log");
    log.scrollTop = log.scrollHeight;
  }

  function linkifyUsernames(text) {
    const escaped = escapeHtml(text);
    // `username` → <span class="user-chip" data-username="...">
    return escaped.replace(/`([a-zA-Z0-9_\-\.]{2,40})`/g, function (_match, name) {
      return '<button type="button" class="user-chip" data-username="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
    });
  }

  function focusAccountRow(username) {
    const tbody = $("#accounts-tbody");
    const row = tbody.querySelector('tr[data-username="' + cssEscape(username) + '"]');
    if (row) {
      $$('tr[data-highlight="true"]', tbody).forEach((r) => r.removeAttribute("data-highlight"));
      row.setAttribute("data-highlight", "true");
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => row.removeAttribute("data-highlight"), 4000);
      return;
    }
    // Not on this page — fall back to a search.
    $("#search-input").value = username;
    runSearch(username);
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
  }

  // ────────────────────────────────────────────────────────────
  // QUICK-ACTION BUTTONS — flow through the agent, not the API
  //
  // Every admin write goes through /chat so the agent's confirmation
  // protocol enforces the audit trail. Don't bypass.
  // ────────────────────────────────────────────────────────────
  function onActionClick(kind, username) {
    let message;
    if (kind === "unlock") {
      message = "Reset lockout for `" + username + "`";
    } else if (kind === "reboot") {
      message = "Re-send bootstrap email for `" + username + "`";
    } else if (kind === "reset") {
      message = "Trigger password reset email for `" + username + "`. Confirm.";
    } else {
      return;
    }
    sendChatMessage(message);
  }

  // ────────────────────────────────────────────────────────────
  // Kick off
  // ────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
