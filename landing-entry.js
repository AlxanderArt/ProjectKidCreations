(() => {
  "use strict";

  const PC_QUERY = "(min-width: 1200px)";
  const ENTRY_PARAMETER = "entry";
  const BROWSE_INTENT = "browse";
  const url = new URL(window.location.href);

  if (url.searchParams.get(ENTRY_PARAMETER) === BROWSE_INTENT) {
    url.searchParams.delete(ENTRY_PARAMETER);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return;
  }

  if (!window.matchMedia(PC_QUERY).matches) return;

  window.location.replace("/");
})();
