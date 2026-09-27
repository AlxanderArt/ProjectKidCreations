(() => {
  "use strict";

  const PC_QUERY = "(min-width: 1200px)";
  const ENTRY_PARAMETER = "entry";
  const BROWSE_INTENT = "browse";
  const BROWSE_SESSION_KEY = "pkc:browse-intent";
  const url = new URL(window.location.href);

  if (url.searchParams.get(ENTRY_PARAMETER) === BROWSE_INTENT) {
    try { window.sessionStorage.setItem(BROWSE_SESSION_KEY, "true"); } catch (_) { /* URL intent still permits this load. */ }
    url.searchParams.delete(ENTRY_PARAMETER);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return;
  }

  let browseWasChosen = false;
  try { browseWasChosen = window.sessionStorage.getItem(BROWSE_SESSION_KEY) === "true"; } catch (_) { /* Fall through to the entry gate. */ }
  if (browseWasChosen || !window.matchMedia(PC_QUERY).matches) return;

  window.location.replace("/");
})();
