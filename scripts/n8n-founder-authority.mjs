import crypto from "node:crypto";

export const OWNER_USERNAME = "PK Blick";
export const OWNER_EMAIL = "projectkidcreations@gmail.com";
export const PUBLIC_USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

const OWNER_CLAIM_RE = /^pk blick$/i;

export function canonicalizeUsername(value) {
  const username = String(value ?? "").trim();
  if (username === OWNER_USERNAME) return OWNER_USERNAME;
  if (OWNER_CLAIM_RE.test(username)) throw new Error("reserved_owner_identity");
  const publicUsername = username.toLowerCase();
  if (!PUBLIC_USERNAME_RE.test(publicUsername)) throw new Error("invalid_username");
  return publicUsername;
}

export function classifyProvisioningIdentity(usernameValue, emailValue) {
  const rawUsername = String(usernameValue ?? "").trim();
  const email = String(emailValue ?? "").trim().toLowerCase();
  const ownerByUsername = rawUsername === OWNER_USERNAME;
  const ownerClaim = OWNER_CLAIM_RE.test(rawUsername);
  const ownerByEmail = email === OWNER_EMAIL;
  if (ownerByUsername !== ownerByEmail || (ownerClaim && !ownerByUsername)) {
    throw new Error("owner_identity_mismatch");
  }
  const username = ownerByUsername ? OWNER_USERNAME : canonicalizeUsername(rawUsername);
  return { username, email, isOwner: ownerByUsername && ownerByEmail };
}

export function authenticateInternalRequest(provided, expected) {
  if (!expected) throw new Error("PKC_AUTH_KEY missing");
  const digest = (value) => crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

function getNode(workflow, name) {
  const found = workflow.nodes?.find((item) => item.name === name);
  if (!found) throw new Error(`${workflow.id}: missing node ${name}`);
  if (typeof found.parameters?.jsCode !== "string") {
    throw new Error(`${workflow.id}: ${name} is not a Code node`);
  }
  return found;
}

function replaceExact(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact anchor, found ${count}`);
  return source.replace(oldText, newText);
}

const AUTH_AND_IDENTITY_SOURCE = `const OWNER_USERNAME = 'PK Blick';
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
const rawUsername = String(body.username || '').trim();
const email = String(body.email || '').trim().toLowerCase();
const ownerByUsername = rawUsername === OWNER_USERNAME;
const ownerClaim = /^pk blick$/i.test(rawUsername);
const ownerByEmail = email === OWNER_EMAIL;
if (ownerByUsername !== ownerByEmail || (ownerClaim && !ownerByUsername)) {
  throw new Error('403: owner_identity_mismatch');
}
const username = ownerByUsername ? OWNER_USERNAME : rawUsername.toLowerCase();
if (!ownerByUsername && !PUBLIC_USERNAME_RE.test(username)) {
  throw new Error('400: invalid username format');
}
if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
  throw new Error('400: invalid email format');
}
const is_owner = ownerByUsername && ownerByEmail;`;

function patchBootstrap(workflow) {
  const init = getNode(workflow, "Init Trace");
  init.parameters.jsCode = `const crypto = require('crypto');
${AUTH_AND_IDENTITY_SOURCE}
const submission_id = String(body.submission_id || '').trim();
const first_name = String(body.first_name || '').trim();
if (!submission_id) throw new Error('400: missing submission_id');
return [{ json: {
  request_id: crypto.randomUUID(),
  trace_start_ms: Date.now(),
  submission_id, username, email, first_name, is_owner
} }];`;

  const issue = getNode(workflow, "Issue Token");
  issue.parameters.jsCode = replaceExact(
    issue.parameters.jsCode,
    "const account = existing.find(r => String(r.username||'').toLowerCase() === trace.username);",
    "const account = existing.find(r => String(r.username||'') === trace.username);\nif (account && String(account.email||'').trim().toLowerCase() !== trace.email) throw new Error('409: account_identity_mismatch');",
    `${workflow.id}:Issue Token`,
  );
  if (issue.parameters.jsCode.includes("staticData.bootstrap[tokenHash]")) {
    issue.parameters.jsCode = replaceExact(
      issue.parameters.jsCode,
      "email: trace.email,\n  issued_at_ms,",
      "email: trace.email,\n  is_owner: trace.is_owner,\n  issued_at_ms,",
      `${workflow.id}:Issue Token owner token state`,
    );
  }

  const row = getNode(workflow, "Build New Account Row");
  row.parameters.jsCode = replaceExact(
    row.parameters.jsCode,
    "const now = new Date().toISOString();",
    "const now = new Date().toISOString();\nconst OWNER_USERNAME = 'PK Blick';\nconst is_owner = trace.is_owner === true;",
    `${workflow.id}:Build New Account Row constants`,
  );
  row.parameters.jsCode = replaceExact(
    row.parameters.jsCode,
    "display_name: trace.first_name || trace.username,",
    "display_name: is_owner ? OWNER_USERNAME : (trace.first_name || trace.username),",
    `${workflow.id}:Build New Account Row display`,
  );
  row.parameters.jsCode = replaceExact(
    row.parameters.jsCode,
    "is_admin: 'FALSE',",
    "is_admin: is_owner ? 'TRUE' : 'FALSE',",
    `${workflow.id}:Build New Account Row admin`,
  );

  const redeemInit = getNode(workflow, "redeem-init");
  redeemInit.parameters.jsCode = `const crypto = require('crypto');
const OWNER_USERNAME = 'PK Blick';
const PUBLIC_USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const headers = ($input.first()?.json?.headers) || {};
const expectedKey = $env.PKC_AUTH_KEY;
if (!expectedKey) throw new Error('500: PKC_AUTH_KEY missing');
const digest = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
if (!crypto.timingSafeEqual(digest(headers['x-pkc-key']), digest(expectedKey))) throw new Error('401: unauthorized');
const body = ($input.first()?.json?.body) || $input.first()?.json || {};
const token = String(body.token||'').trim();
const rawUsername = String(body.username||'').trim();
const ownerClaim = /^pk blick$/i.test(rawUsername);
if (ownerClaim && rawUsername !== OWNER_USERNAME) throw new Error('403: reserved_owner_identity');
const username = rawUsername === OWNER_USERNAME ? OWNER_USERNAME : rawUsername.toLowerCase();
const password = String(body.password||'');
if (!token || !username || !password) throw new Error('400: missing_fields');
if (username !== OWNER_USERNAME && !PUBLIC_USERNAME_RE.test(username)) throw new Error('400: invalid_username');
if (password.length < 8) throw new Error('400: password_too_short');
if (password.length > 128) throw new Error('400: password_too_long');
const token_hash = crypto.createHash('sha256').update(token).digest('hex');
return [{ json: { request_id: crypto.randomUUID(), trace_start_ms: Date.now(), token_hash, username, password } }];`;

  const redeemValidate = getNode(workflow, "redeem-validate");
  redeemValidate.parameters.jsCode = replaceExact(
    redeemValidate.parameters.jsCode,
    "if (String(entry.username).toLowerCase() !== trace.username)",
    "if (String(entry.username) !== trace.username)",
    `${workflow.id}:redeem-validate exact identity`,
  );
  redeemValidate.parameters.jsCode = replaceExact(
    redeemValidate.parameters.jsCode,
    "return [{ json: { ...trace, _valid: true, submission_id: entry.submission_id, email: entry.email } }];",
    "const ownerTuple = entry.username === 'PK Blick' && String(entry.email||'').trim().toLowerCase() === 'projectkidcreations@gmail.com' && entry.is_owner === true;\nif ((entry.username === 'PK Blick' || String(entry.email||'').trim().toLowerCase() === 'projectkidcreations@gmail.com') && !ownerTuple) return [{ json: { ...trace, _valid: false, _reason: 'owner_identity_mismatch' } }];\nreturn [{ json: { ...trace, _valid: true, submission_id: entry.submission_id, email: entry.email, is_owner: ownerTuple } }];",
    `${workflow.id}:redeem-validate tuple`,
  );

  const sign = getNode(workflow, "redeem-hash-and-sign");
  sign.parameters.jsCode = replaceExact(
    sign.parameters.jsCode,
    "String(r.username||'').toLowerCase() === trace.username",
    "String(r.username||'') === trace.username",
    `${workflow.id}:redeem exact account`,
  );
  sign.parameters.jsCode = replaceExact(
    sign.parameters.jsCode,
    "if (acct && acct.password_hash) throw new Error('409: already_redeemed');",
    "if (!acct) throw new Error('404: account_not_found');\nif (String(acct.email||'').trim().toLowerCase() !== String(trace.email||'').trim().toLowerCase()) throw new Error('409: account_identity_mismatch');\nconst ownerTuple = trace.username === 'PK Blick' && String(trace.email||'').trim().toLowerCase() === 'projectkidcreations@gmail.com' && trace.is_owner === true;\nif ((trace.username === 'PK Blick' || String(trace.email||'').trim().toLowerCase() === 'projectkidcreations@gmail.com') && !ownerTuple) throw new Error('403: owner_identity_mismatch');\nif (ownerTuple && String(acct.is_admin||'').toUpperCase() !== 'TRUE') throw new Error('403: owner_admin_state_invalid');\nif (!ownerTuple && String(acct.is_admin||'').toUpperCase() === 'TRUE') throw new Error('403: public_admin_state_invalid');\nif (acct.password_hash) throw new Error('409: already_redeemed');",
    `${workflow.id}:redeem tuple guard`,
  );

  delete workflow.connections?.["Already-Redeemed Response"];
  return workflow;
}

function patchLogin(workflow) {
  const init = getNode(workflow, "Init Trace");
  init.parameters.jsCode = `const crypto = require('crypto');
const OWNER_USERNAME = 'PK Blick';
const PUBLIC_USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const input = $input.first()?.json || {};
const body = input.body || input || {};
const headers = input.headers || {};
const expectedKey = $env.PKC_AUTH_KEY;
if (!expectedKey) throw new Error('500: PKC_AUTH_KEY missing');
const digest = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
if (!crypto.timingSafeEqual(digest(headers['x-pkc-key']), digest(expectedKey))) throw new Error('401: unauthorized');
const rawUsername = String(body.username || '').trim();
if (/^pk blick$/i.test(rawUsername) && rawUsername !== OWNER_USERNAME) throw new Error('403: reserved_owner_identity');
const canonicalUsername = rawUsername === OWNER_USERNAME ? OWNER_USERNAME : rawUsername.toLowerCase();
const username = canonicalUsername;
const password = String(body.password || '');
if (!username || !password) throw new Error('400: missing required fields (username, password)');
if (username !== OWNER_USERNAME && !PUBLIC_USERNAME_RE.test(username)) throw new Error('400: invalid username format');
function ipHashFromHeaders(h){const ip=(h['x-forwarded-for']||h['x-real-ip']||'').split(',')[0].trim();return ip?crypto.createHash('sha256').update(ip).digest('hex').slice(0,24):'';}
function deviceFromUA(ua){if(/iPhone/.test(ua))return 'iPhone';if(/iPad/.test(ua))return 'iPad';if(/Macintosh/.test(ua))return 'Mac';if(/Windows/.test(ua))return 'Windows';if(/Android/.test(ua))return 'Android';return 'Other';}
const ua = String(headers['user-agent']||'');
return [{ json: { request_id: crypto.randomUUID(), trace_start_ms: Date.now(), username, password, ip_hash: ipHashFromHeaders(headers), user_agent_raw: ua, device_label: deviceFromUA(ua) } }];`;

  const verify = getNode(workflow, "Verify Credentials");
  verify.parameters.jsCode = replaceExact(
    verify.parameters.jsCode,
    "const account = rows.find(r => String(r.username||'').toLowerCase() === trace.username) || null;",
    "const account = rows.find(r => String(r.username||'') === trace.username) || null;",
    `${workflow.id}:Verify Credentials exact account`,
  );
  verify.parameters.jsCode = replaceExact(
    verify.parameters.jsCode,
    "// Locked permanently",
    "const ownerTuple = account && account.username === 'PK Blick' && String(account.email||'').trim().toLowerCase() === 'projectkidcreations@gmail.com';\nif (account && ownerTuple && String(account.is_admin||'').toUpperCase() !== 'TRUE') throw new Error('403: owner_admin_state_invalid');\nif (account && !ownerTuple && String(account.is_admin||'').toUpperCase() === 'TRUE') throw new Error('403: public_admin_state_invalid');\n\n// Locked permanently",
    `${workflow.id}:Verify Credentials admin invariant`,
  );
  return workflow;
}

function patchJwtSubjectWorkflow(workflow) {
  const replacements = [
    ["String(row.username||'').toLowerCase() !== String(init.username||'').toLowerCase()", "String(row.username||'') !== String(init.username||'')"],
    ["const username=String(entry.username||'').toLowerCase();", "const username=canonicalUsername(entry.username);"],
    ["String(r.username||'').toLowerCase()===trace.username", "String(r.username||'')===trace.username"],
    ["String(target.username || '').toLowerCase() !== String(trace.username || '').toLowerCase()", "String(target.username || '') !== String(trace.username || '')"],
    ["String(r.target_username || '').toLowerCase() === String(trace.username || '').toLowerCase()", "String(r.target_username || '') === String(trace.username || '')"],
  ];
  for (const item of workflow.nodes ?? []) {
    if (typeof item.parameters?.jsCode !== "string") continue;
    item.parameters.jsCode = item.parameters.jsCode.replaceAll(
      "String(payload.sub || '').toLowerCase()",
      "canonicalUsername(payload.sub)",
    ).replaceAll(
      "String(payload.sub||'').toLowerCase()",
      "canonicalUsername(payload.sub)",
    );
    for (const [before, after] of replacements) {
      item.parameters.jsCode = item.parameters.jsCode.replaceAll(before, after);
    }
    if (item.parameters.jsCode.includes("canonicalUsername(") && !item.parameters.jsCode.includes("const canonicalUsername =")) {
      item.parameters.jsCode = `const canonicalUsername = value => { const raw = String(value || '').trim(); if (raw === 'PK Blick') return 'PK Blick'; if (/^pk blick$/i.test(raw)) throw new Error('401:reserved_owner_identity'); const normalized = raw.toLowerCase(); if (!/^[a-z0-9_.-]{3,32}$/.test(normalized)) throw new Error('401:invalid_session_subject'); return normalized; };\n${item.parameters.jsCode}`;
    }
  }
  return workflow;
}

const WEBHOOK_AUTH_PREFIX = `const _authCrypto = require('crypto');
const _authInput = $input.first()?.json || {};
const _authHeaders = _authInput.headers || {};
const _authExpected = $env.PKC_AUTH_KEY;
if (!_authExpected) throw new Error('500: PKC_AUTH_KEY missing');
const _authDigest = value => _authCrypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
if (!_authCrypto.timingSafeEqual(_authDigest(_authHeaders['x-pkc-key']), _authDigest(_authExpected))) {
  throw new Error('401: unauthorized');
}`;

function ensureWebhookAuthentication(workflow) {
  const byName = new Map((workflow.nodes ?? []).map((item) => [item.name, item]));
  for (const webhook of workflow.nodes ?? []) {
    if (webhook.type !== "n8n-nodes-base.webhook") continue;
    const lanes = workflow.connections?.[webhook.name]?.main ?? [];
    const targets = lanes.flat().map((edge) => edge.node);
    if (targets.length !== 1) throw new Error(`${workflow.id}:${webhook.name} must have one first target`);
    const target = byName.get(targets[0]);
    if (!target || typeof target.parameters?.jsCode !== "string") {
      throw new Error(`${workflow.id}:${webhook.name} first target must be a Code node`);
    }
    const code = target.parameters.jsCode;
    if (code.startsWith(`${WEBHOOK_AUTH_PREFIX}\n`)) continue;
    target.parameters.jsCode = `${WEBHOOK_AUTH_PREFIX}\n${code}`;
  }
  return workflow;
}

export function patchAccountWorkflow(input) {
  const workflow = structuredClone(input);
  if (workflow.id === "nvgxxBPinPmsEmZq") return ensureWebhookAuthentication(patchBootstrap(workflow));
  if (workflow.id === "wfDsutVsW15DHGr3") return ensureWebhookAuthentication(patchLogin(workflow));
  return ensureWebhookAuthentication(patchJwtSubjectWorkflow(workflow));
}
