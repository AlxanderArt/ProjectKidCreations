import { test as base, expect } from "@playwright/test";

function loopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!loopback(url.hostname)) return route.abort("blockedbyclient");
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && url.pathname.startsWith("/api/")) return route.abort("blockedbyclient");
      return route.continue();
    });
    await use(context);
  },
});
export { expect };
