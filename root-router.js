(() => {
  "use strict";

  const ENDPOINT = "/api/account/entry-state";
  const LOGOUT_ENDPOINT = "/api/account/logout";
  const TIMEOUT_MS = 8000;
  const ROUTES = Object.freeze({
    browse: "/landing.html",
    onboard: "/phase-one/",
    login: "/account/login/",
    founderLogin: "/account/login/?next=%2Faccount%2Fadmin%2F",
    account: "/account/",
    admin: "/account/admin/",
  });

  const navigateRoute = (url, { replace = false, reason = 'root-router' } = {}) => {
    if (window.PKCMotion?.navigate(url, { replace, reason })) return;
    if (replace) window.location.replace(url);
    else window.location.assign(url);
  };

  const status = document.querySelector("#status");
  const loading = document.querySelector("#loading-state");
  const publicState = document.querySelector("#public-state");
  const sessionState = document.querySelector("#session-state");
  const degradedState = document.querySelector("#degraded-state");
  const sessionName = document.querySelector("#session-name");
  const continueLink = document.querySelector("#continue-link");
  const retryButton = document.querySelector("#retry-entry");
  const signOutButton = document.querySelector("#sign-out");
  const startNewButton = document.querySelector("#start-new");

  function show(target) {
    [loading, publicState, sessionState, degradedState].forEach((element) => {
      if (!element) return;
      const active = element === target;
      element.hidden = !active;
      element.toggleAttribute("inert", !active);
    });
  }

  async function fetchEntryState() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      let body = null;
      try { body = await response.json(); } catch (_) { /* fail below */ }
      if (!response.ok || !body || body.ok !== true) throw new Error("entry_state_unavailable");
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderEntryState(entry) {
    if (entry.state === "public") {
      status.textContent = "// CHOOSE YOUR NEXT STEP";
      show(publicState);
      return;
    }
    if (entry.state === "customer_active" || entry.state === "owner_active") {
      const isOwner = entry.state === "owner_active";
      status.textContent = isOwner ? "// FOUNDER SESSION ACTIVE" : "// SESSION ACTIVE";
      sessionName.textContent = entry.account?.display_name || entry.account?.username || "SIGNED-IN USER";
      continueLink.href = isOwner ? ROUTES.admin : ROUTES.account;
      continueLink.textContent = isOwner ? "CONTINUE TO FOUNDER ADMIN →" : "CONTINUE TO ACCOUNT →";
      show(sessionState);
      return;
    }
    throw new Error("unknown_entry_state");
  }

  async function load() {
    status.textContent = "// CHECKING SESSION";
    show(loading);
    try {
      renderEntryState(await fetchEntryState());
    } catch (_) {
      status.textContent = "// SESSION CHECK UNAVAILABLE";
      show(degradedState);
    }
  }

  async function signOut(destination) {
    status.textContent = "// SIGNING OUT";
    try {
      const response = await fetch(LOGOUT_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("logout_failed");
      navigateRoute(destination, { reason: 'logout' });
    } catch (_) {
      status.textContent = "// SIGN-OUT FAILED — TRY AGAIN";
      show(degradedState);
    }
  }

  retryButton?.addEventListener("click", load);
  signOutButton?.addEventListener("click", () => signOut("/"));
  startNewButton?.addEventListener("click", () => signOut(ROUTES.onboard));
  load();
})();
