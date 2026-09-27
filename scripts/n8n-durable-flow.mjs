const IDS = Object.freeze({
  ONBOARDING: "RjsC9WMIDrIisJbl",
  PHASE_THREE_SAVE: "s4erDMlvnW8vLIxI",
  BOOTSTRAP: "nvgxxBPinPmsEmZq",
});

function clone(value) {
  return structuredClone(value);
}

function codeNode(workflow, name) {
  const node = (workflow.nodes || []).find((item) => item.name === name);
  if (!node || typeof node.parameters?.jsCode !== "string") {
    throw new Error(`missing Code node: ${name}`);
  }
  return node;
}

function replaceOnce(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first < 0 || source.indexOf(oldValue, first + 1) >= 0) {
    throw new Error(`${label}: expected one exact anchor`);
  }
  return source.replace(oldValue, newValue);
}

function patchOnboarding(workflow) {
  const node = codeNode(workflow, "Response Builder");
  node.parameters.jsCode = replaceOnce(
    node.parameters.jsCode,
    "ok: true,",
    "ok: true, persisted: m.sheetStatus === 'written' || !!m.duplicate,",
    "onboarding response",
  );
  return workflow;
}

function patchPhaseThreeSave(workflow) {
  const node = codeNode(workflow, "Build Response");
  const oldReturn = "return respond(true, 'SUCCESS', persisted ? 'Profile committed.' : 'Test mode: profile not persisted.', { submissionId: row.submissionId, username: row.username, completed_at: row.completed_at, is_adult: row.is_adult === 'true', persisted });";
  const newReturn = `const crypto = require('crypto');
const expectedKey = $env.PKC_AUTH_KEY;
if (!expectedKey) throw new Error('500: PKC_AUTH_KEY missing');
const issued_at_ms = Date.now();
const expires_at_ms = issued_at_ms + (30 * 60 * 1000);
const claims = {
  v: 1,
  submission_id: row.submissionId,
  username: row.username,
  email: row.email,
  first_name: row.display_name,
  issued_at_ms,
  expires_at_ms
};
const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
const signature = crypto.createHmac('sha256', expectedKey).update(payload, 'utf8').digest('base64url');
const activation_proof = persisted ? payload + '.' + signature : null;
return respond(true, 'SUCCESS', persisted ? 'Profile committed.' : 'Test mode: profile not persisted.', { submissionId: row.submissionId, username: row.username, completed_at: row.completed_at, is_adult: row.is_adult === 'true', persisted, activation_proof, activation_expires_at: new Date(expires_at_ms).toISOString() });`;
  node.parameters.jsCode = replaceOnce(node.parameters.jsCode, oldReturn, newReturn, "phase-three response");
  return workflow;
}

const BOOTSTRAP_INIT = `const crypto = require('crypto');
const OWNER_USERNAME = 'PK Blick';
const OWNER_EMAIL = 'projectkidcreations@gmail.com';
const PUBLIC_USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const headers = ($input.first()?.json?.headers) || {};
const expectedKey = $env.PKC_AUTH_KEY;
if (!expectedKey) throw new Error('500: PKC_AUTH_KEY missing');
const digest = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
if (!crypto.timingSafeEqual(digest(headers['x-pkc-key']), digest(expectedKey))) {
  throw new Error('401: unauthorized');
}
const body = ($input.first()?.json?.body) || $input.first()?.json || {};
const proof = String(body.activation_proof || '').trim();
let submission_id;
let username;
let email;
let first_name;
let is_owner = false;
if (proof) {
  const parts = proof.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('403: invalid_activation_proof');
  const [payload, suppliedSignature] = parts;
  const expectedSignature = crypto.createHmac('sha256', expectedKey).update(payload, 'utf8').digest();
  let supplied;
  try { supplied = Buffer.from(suppliedSignature, 'base64url'); } catch (_) { throw new Error('403: invalid_activation_proof'); }
  if (supplied.length !== expectedSignature.length || !crypto.timingSafeEqual(supplied, expectedSignature)) {
    throw new Error('403: invalid_activation_proof');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { throw new Error('403: invalid_activation_proof'); }
  const now = Date.now();
  if (!claims || claims.v !== 1 || !Number.isFinite(claims.expires_at_ms) || claims.expires_at_ms < now) {
    throw new Error('403: activation_proof_expired');
  }
  if (!Number.isFinite(claims.issued_at_ms) || claims.issued_at_ms > now + 60000 || claims.expires_at_ms > now + (31 * 60 * 1000)) {
    throw new Error('403: invalid_activation_proof');
  }
  submission_id = String(claims.submission_id || '').trim();
  username = String(claims.username || '').trim();
  email = String(claims.email || '').trim().toLowerCase();
  first_name = String(claims.first_name || '').trim();
  if (!submission_id || !PUBLIC_USERNAME_RE.test(username) || username !== username.toLowerCase()) {
    throw new Error('403: invalid_activation_claims');
  }
  if (email === OWNER_EMAIL || /^pk blick$/i.test(username)) throw new Error('403: owner_identity_mismatch');
} else {
  const ownerUsername = String(body.username || '').trim();
  const ownerEmail = String(body.email || '').trim().toLowerCase();
  if (ownerUsername !== OWNER_USERNAME || ownerEmail !== OWNER_EMAIL) {
    throw new Error('403: activation_proof_required');
  }
  submission_id = String(body.submission_id || '').trim();
  username = OWNER_USERNAME;
  email = OWNER_EMAIL;
  first_name = OWNER_USERNAME;
  is_owner = true;
}
if (!submission_id) throw new Error('400: missing_submission_id');
if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw new Error('400: invalid_email');
return [{ json: {
  request_id: crypto.randomUUID(),
  trace_start_ms: Date.now(),
  submission_id, username, email, first_name, is_owner
} }];`;

function patchBootstrap(workflow) {
  const node = codeNode(workflow, "Init Trace");
  if (!node.parameters.jsCode.includes("const rawUsername") && !node.parameters.jsCode.includes("activation_proof")) {
    throw new Error("bootstrap Init Trace: unrecognized source");
  }
  node.parameters.jsCode = BOOTSTRAP_INIT;
  return workflow;
}

export function patchDurableWorkflow(input) {
  const workflow = clone(input);
  if (workflow.id === IDS.ONBOARDING) return patchOnboarding(workflow);
  if (workflow.id === IDS.PHASE_THREE_SAVE) return patchPhaseThreeSave(workflow);
  if (workflow.id === IDS.BOOTSTRAP) return patchBootstrap(workflow);
  throw new Error(`unsupported workflow: ${workflow.id}`);
}
