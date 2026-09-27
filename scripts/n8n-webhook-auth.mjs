const MARKER = "// PKC_INTERNAL_PROXY_AUTH_V1";

const ALWAYS_AUTH = `${MARKER}
const _pkcAuthCrypto = require('crypto');
const _pkcAuthHeaders = ($input.first()?.json?.headers) || {};
const _pkcExpectedKey = $env.PKC_AUTH_KEY;
if (!_pkcExpectedKey) throw new Error('500: PKC_AUTH_KEY missing');
const _pkcDigest = value => _pkcAuthCrypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
if (!_pkcAuthCrypto.timingSafeEqual(_pkcDigest(_pkcAuthHeaders['x-pkc-key']), _pkcDigest(_pkcExpectedKey))) {
  throw new Error('401: unauthorized');
}
`;

const WEBHOOK_ONLY_AUTH = `${MARKER}
const _pkcAuthInput = $input.first()?.json || {};
const _pkcIsWebhookEnvelope = _pkcAuthInput.headers && typeof _pkcAuthInput.headers === 'object';
if (_pkcIsWebhookEnvelope) {
  const _pkcAuthCrypto = require('crypto');
  const _pkcExpectedKey = $env.PKC_AUTH_KEY;
  if (!_pkcExpectedKey) throw new Error('500: PKC_AUTH_KEY missing');
  const _pkcDigest = value => _pkcAuthCrypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
  if (!_pkcAuthCrypto.timingSafeEqual(_pkcDigest(_pkcAuthInput.headers['x-pkc-key']), _pkcDigest(_pkcExpectedKey))) {
    throw new Error('401: unauthorized');
  }
}
`;

function clone(value) {
  return structuredClone(value);
}

function targetsFor(workflow, sourceName) {
  return (workflow.connections?.[sourceName]?.main || []).flat().map((edge) => edge.node);
}

function inboundSources(workflow, targetName) {
  const result = [];
  for (const [source, output] of Object.entries(workflow.connections || {})) {
    if ((output.main || []).flat().some((edge) => edge.node === targetName)) result.push(source);
  }
  return result;
}

export function securePostWebhooks(input) {
  const workflow = clone(input);
  const nodes = new Map((workflow.nodes || []).map((node) => [node.name, node]));
  const postWebhooks = (workflow.nodes || []).filter((node) =>
    node.type === "n8n-nodes-base.webhook" && node.parameters?.httpMethod === "POST");
  if (!postWebhooks.length) throw new Error("workflow has no POST webhook");

  for (const webhook of postWebhooks) {
    const targets = targetsFor(workflow, webhook.name);
    if (targets.length !== 1) throw new Error(`${webhook.name}: expected exactly one first target`);
    const target = nodes.get(targets[0]);
    if (!target || target.type !== "n8n-nodes-base.code" || typeof target.parameters?.jsCode !== "string") {
      throw new Error(`${webhook.name}: first target is not a Code node`);
    }
    const source = target.parameters.jsCode;
    if (source.startsWith(ALWAYS_AUTH) || source.startsWith(WEBHOOK_ONLY_AUTH)) continue;
    const sharedWithNonWebhook = inboundSources(workflow, target.name).some((sourceName) =>
      nodes.get(sourceName)?.type !== "n8n-nodes-base.webhook");
    target.parameters.jsCode = (sharedWithNonWebhook ? WEBHOOK_ONLY_AUTH : ALWAYS_AUTH) + source;
  }
  return workflow;
}
