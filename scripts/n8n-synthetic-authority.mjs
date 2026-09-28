const SYNTHETIC_REGISTRY = Object.freeze([
  Object.freeze({ role: "login", id: "wfDsutVsW15DHGr3", name: "PKC — Account Login", snapshotRole: "synthetic-login", sourceFingerprint: "70b399d886b5744dcda715e2c8e699db4e39491e641ba31be8209703336ef18a", sourceInventorySha256: "70b399d886b5744dcda715e2c8e699db4e39491e641ba31be8209703336ef18a", semanticContract: Object.freeze({ authority: "synthetic exact founder tuple", founderBranch: "before synthetic side effects", customerParity: true }) }),
  Object.freeze({ role: "bootstrap", id: "nvgxxBPinPmsEmZq", name: "PKC — Account Bootstrap", snapshotRole: "synthetic-bootstrap", sourceFingerprint: "e0800cd6dcbb575e12818f3a72fd990467f1c38d35e80661eb9a089eb6ece0f4", sourceInventorySha256: "e0800cd6dcbb575e12818f3a72fd990467f1c38d35e80661eb9a089eb6ece0f4", semanticContract: Object.freeze({ founderDenied: true }) }),
  Object.freeze({ role: "profile", id: "uuNgivASLQZ08gX7", name: "PKC — Account Get Profile", snapshotRole: "synthetic-profile", sourceFingerprint: "ec921599820986e3ccaaa3fd616ba3d8a4ecedf8f2cb8736fa4ea66c9e1b7825", sourceInventorySha256: "ec921599820986e3ccaaa3fd616ba3d8a4ecedf8f2cb8736fa4ea66c9e1b7825", semanticContract: Object.freeze({ founderAssurance: "synthetic" }) }),
  Object.freeze({ role: "sessions", id: "GVVnbelFG97UjJDw", name: "PKC — Account Get Sessions", snapshotRole: "synthetic-sessions", sourceFingerprint: "65dcfc4a52cd51d5f98d40a0407ed1b212b19c3587f4541571e8a5bf33e08c02", sourceInventorySha256: "65dcfc4a52cd51d5f98d40a0407ed1b212b19c3587f4541571e8a5bf33e08c02", semanticContract: Object.freeze({ founderAssurance: "synthetic" }) }),
  Object.freeze({ role: "revoke", id: "W63ETZfmKVI7UDFW", name: "PKC — Account Revoke Session", snapshotRole: "synthetic-revoke", sourceFingerprint: "fef65b25730ae7b93acc528f4f3f7a72dc619bc0e33807d52e9b6c2176824433", sourceInventorySha256: "fef65b25730ae7b93acc528f4f3f7a72dc619bc0e33807d52e9b6c2176824433", semanticContract: Object.freeze({ founderTuple: "synthetic" }) }),
  Object.freeze({ role: "logout", id: "jb0I4CqlJuuG6fXs", name: "PKC — Account Logout", snapshotRole: "synthetic-logout", sourceFingerprint: "38fe59267d06b8dfe678059e29f2dfbc2f51a0437ee0ee9b74d156c1bcd4c615", sourceInventorySha256: "38fe59267d06b8dfe678059e29f2dfbc2f51a0437ee0ee9b74d156c1bcd4c615", semanticContract: Object.freeze({ founderTuple: "synthetic" }) }),
]);

const edge = (node) => ({ node, type: "main", index: 0 });
const webhook = (entry) => ({
  name: "Webhook",
  type: "n8n-nodes-base.webhook",
  typeVersion: 2,
  position: [0, 0],
  parameters: { httpMethod: "POST", path: `ci-${entry.role}`, responseMode: "responseNode", options: {} },
});
const code = (name, index) => ({
  name,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [index * 240, 0],
  parameters: { language: "javaScript", jsCode: "return $input.all();" },
});
const response = (name, index) => ({
  name,
  type: "n8n-nodes-base.respondToWebhook",
  typeVersion: 1.4,
  position: [index * 240, 0],
  parameters: { respondWith: "json", responseBody: "={{ { ok: true } }}", options: {} },
});

const source = (entry) => {
  const names = entry.role === "login"
    ? ["Webhook", "Verify Credentials", "Read User Sessions", "Revoke Oldest Session", "Append New Session", "Update Account (Success)", "Audit Success", "Respond Success"]
    : ["Webhook", "Init Trace", "Business Logic", "Respond OK"];
  const nodes = names.map((name, index) => name === "Webhook"
    ? webhook(entry)
    : name.startsWith("Respond")
      ? response(name, index)
      : code(name, index));
  const connections = Object.fromEntries(names.slice(0, -1).map((name, index) => [name, { main: [[edge(names[index + 1])]] }]));
  return {
    id: entry.id,
    name: entry.name,
    active: true,
    settings: { executionOrder: "v1" },
    nodes,
    connections,
  };
};

export function createSyntheticN8nAuthority() {
  const inputs = SYNTHETIC_REGISTRY.map(source);
  return Object.freeze({
    inputs: Object.freeze(inputs.map((input) => Object.freeze(input))),
    registry: SYNTHETIC_REGISTRY,
  });
}
