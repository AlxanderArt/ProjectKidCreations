import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { createVercelNodeHandler } from "../../server/api/vercel-node-router.mjs";
import { ROUTES } from "../../server/proxy/manifest.mjs";

const MFA_ROUTES = Object.freeze({
  "/api/account/mfa-enrollment": "enrollment",
  "/api/account/mfa-verify": "verify",
  "/api/account/mfa-recovery": "recovery",
  "/api/account/mfa-finalize": "finalize",
});

const manifestRoutes = Object.entries(ROUTES)
  .filter(([, route]) => route.runtime === "nodejs")
  .map(([routeId, route]) => [route.publicPath, routeId, "proxy"]);

const expectedRoutes = [
  ...manifestRoutes,
  ...Object.entries(MFA_ROUTES).map(([path, routeName]) => [path, routeName, "mfa"]),
  ["/api/account/entry-state", "entryState", "entry"],
];

function response() {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  return {
    statusCode: 200,
    headers: new Map(),
    payload: undefined,
    done,
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    end(value) { this.payload = value; resolveDone(); },
  };
}

test("every nested Node API route rewrites to the consolidated function without a caller-controlled selector", () => {
  const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  const expected = expectedRoutes.map(([source]) => ({ source, destination: "/api/node" }));
  const actual = vercel.rewrites.filter((rewrite) => expected.some(({ source }) => source === rewrite.source));

  assert.equal(expected.length, 20);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual.map((rewrite) => rewrite.source)).size, expected.length);
  assert.equal(fs.existsSync("api/node.js"), true);
  assert.equal(fs.existsSync("api/[...route].js"), false);
  assert.equal(JSON.stringify(vercel).includes("__pkc_route"), false);
});

test("the Vercel handler dispatches all preserved canonical source paths and rejects direct aliases", async () => {
  const calls = [];
  const finish = (kind, id) => async (req, res) => {
    calls.push({ kind, id, url: req.url });
    res.statusCode = 204;
    res.end();
  };
  const handler = createVercelNodeHandler({
    proxyHandlerFactory: (routeId) => finish("proxy", routeId),
    mfaHandlerFactory: (routeName) => finish("mfa", routeName),
    entryStateHandler: finish("entry", "entryState"),
  });

  for (const [path, id, kind] of expectedRoutes) {
    const req = { url: `${path}?probe=a%2Fb&probe=c` };
    const res = response();
    await handler(req, res);
    await res.done;
    assert.equal(res.statusCode, 204, path);
    assert.deepEqual(calls.at(-1), { kind, id, url: `${path}?probe=a%2Fb&probe=c` });
    assert.equal(req.url, `${path}?probe=a%2Fb&probe=c`, path);
  }

  const selectorReq = { url: "/api/account/profile?__pkc_route=accountAdminList" };
  const selectorRes = response();
  await handler(selectorReq, selectorRes);
  await selectorRes.done;
  assert.equal(selectorRes.statusCode, 204);
  assert.deepEqual(calls.at(-1), {
    kind: "proxy",
    id: "accountProfile",
    url: "/api/account/profile?__pkc_route=accountAdminList",
  });

  const callCount = calls.length;
  for (const target of [
    "/api/node",
    "/api/node?__pkc_route=accountProfile",
    "/api/account/unknown",
  ]) {
    const req = { url: target };
    const res = response();
    await handler(req, res);
    await res.done;
    assert.equal(res.statusCode, 404, target);
    assert.equal(JSON.parse(String(res.payload)).error, "not_found", target);
    assert.equal(req.url, target, target);
  }
  assert.equal(calls.length, callCount);
});
