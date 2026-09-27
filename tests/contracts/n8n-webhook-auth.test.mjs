import assert from "node:assert/strict";
import { test } from "node:test";

import { securePostWebhooks } from "../../scripts/n8n-webhook-auth.mjs";

const code = (name, jsCode = "return $input.all();") => ({ name, type: "n8n-nodes-base.code", parameters: { jsCode } });
const webhook = (name, method) => ({ name, type: "n8n-nodes-base.webhook", parameters: { httpMethod: method } });

test("only externally reachable POST entry Code nodes receive timing-safe authentication", () => {
  const workflow = {
    id: "fixture",
    nodes: [webhook("POST", "POST"), webhook("OPTIONS", "OPTIONS"), code("Init"), code("Options Response")],
    connections: {
      POST: { main: [[{ node: "Init", type: "main", index: 0 }]] },
      OPTIONS: { main: [[{ node: "Options Response", type: "main", index: 0 }]] },
    },
  };
  const patched = securePostWebhooks(workflow);
  const init = patched.nodes.find((node) => node.name === "Init").parameters.jsCode;
  const options = patched.nodes.find((node) => node.name === "Options Response").parameters.jsCode;
  assert.match(init, /\$env\.PKC_AUTH_KEY/);
  assert.match(init, /x-pkc-key/);
  assert.match(init, /timingSafeEqual/);
  assert.equal(options, "return $input.all();");
});

test("authentication injection is idempotent", () => {
  const workflow = {
    id: "fixture",
    nodes: [webhook("POST", "POST"), code("Init")],
    connections: { POST: { main: [[{ node: "Init", type: "main", index: 0 }]] } },
  };
  const once = securePostWebhooks(workflow);
  const twice = securePostWebhooks(once);
  assert.deepEqual(twice, once);
});

test("authentication-looking comments never bypass injection", () => {
  const hostile = {
    id: "fixture",
    nodes: [webhook("POST", "POST"), code("Init", "// PKC_INTERNAL_PROXY_AUTH_V1 $env.PKC_AUTH_KEY x-pkc-key\nreturn $input.all();")],
    connections: { POST: { main: [[{ node: "Init", type: "main", index: 0 }]] } },
  };
  const patched = securePostWebhooks(hostile);
  const source = patched.nodes.find((node) => node.name === "Init").parameters.jsCode;
  assert.match(source, /timingSafeEqual/);
  assert.ok(source.startsWith("// PKC_INTERNAL_PROXY_AUTH_V1\nconst _pkcAuthCrypto"));
});

test("unexpected non-Code POST entry fails closed", () => {
  const workflow = {
    id: "fixture",
    nodes: [webhook("POST", "POST"), { name: "Set", type: "n8n-nodes-base.set", parameters: {} }],
    connections: { POST: { main: [[{ node: "Set", type: "main", index: 0 }]] } },
  };
  assert.throws(() => securePostWebhooks(workflow), /first target is not a Code node/);
});
