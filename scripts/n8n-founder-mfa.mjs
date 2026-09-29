import crypto from "node:crypto";

export const HANDOFF_CLAIM_KEYS = Object.freeze([
  "aud", "exp", "iat", "is_admin", "iss", "jti", "kid", "login_attempt_id", "nbf",
  "password_authenticated_at", "purpose", "sub", "typ", "username", "version",
]);

export const FINALIZE_CLAIM_KEYS = Object.freeze([
  "amr", "aud", "auth_epoch", "exp", "finalize_id", "iat", "is_admin", "iss", "jti", "kid",
  "login_attempt_id", "mfa_verified_at", "nbf", "password_authenticated_at", "purpose",
  "session_expires_at", "session_id", "session_issued_at", "sub", "typ", "username", "version",
]);

const OWNER_USERNAME = "PK Blick";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_ID_RE = /^[a-z][a-z0-9_-]{7,127}$/;
const PROFILE_WORKFLOW_SOURCE_FINGERPRINT = "8287746c2654b22b8f7285cbdeddfeef655be6fa3ec9137d820ce25b810afebe";
const SESSION_WORKFLOW_SOURCE_FINGERPRINT = "0b85af35abcc64453e0225c102d79afa426088563a12ca7d05845aad40985eee";
const LOGIN_WORKFLOW_SOURCE_FINGERPRINTS = new Set([
  "98090fdd8026a8c4eaf241a4be2ba8ff717b7d2b61fb4d40d30b63480f675946",
  "b82089cf2a0c8a586f79c431ede2c7946492bf96163f4e95fd04a55651c26e2d",
]);
const LOGIN_VERIFY_SOURCE_FINGERPRINTS = new Set([
  "7246b14144a7db66450cf2086f9a2a06bcb7b52598345ae463a7348fd89572cc",
  "85e68a12bea14b509d079dcf3148c1097de9adffdfd05d6bae2cfc52bb2df49b",
]);
const ACCOUNT_DOCUMENT_FINGERPRINT = "266eb838f28e9249cf8de21316b0f8b9c2ba16d2018681dbaf8d3df2d46971ea";
const ACCOUNT_SHEET_FINGERPRINT = "fc4bde6d3dc78857adf21ea4cc804f7a1390bda3c233b25934f1e0435ad22fe4";
const SESSION_SHEET_FINGERPRINT = "1c97738d379bbd45cfb745e18f1041947f51803be6ea00a47145afa45f02f3ac";
const AUDIT_SHEET_FINGERPRINT = "943c930631db758bd35970d7a85cc48d0ff6f475b589269348f9734815ec76dc";

export function decodeFounderMfaKey(value, label = "founder_mfa_key") {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error(`invalid_${label}`);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) throw new Error(`invalid_${label}`);
  return decoded;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}

function requireSourceFingerprint(workflow, expected, label) {
  if (fingerprint(workflow) !== expected) throw new Error(`${label} workflow source fingerprint drift`);
}

function codeNode(name, jsCode) {
  return {
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    parameters: { language: "javaScript", jsCode },
  };
}

function getNode(workflow, name) {
  const node = workflow.nodes?.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`${workflow.name || "workflow"}: missing node ${name}`);
  return node;
}

function requireCodeNode(workflow, name) {
  const node = getNode(workflow, name);
  if (node.type !== "n8n-nodes-base.code" || typeof node.parameters?.jsCode !== "string") {
    throw new Error(`${workflow.name || "workflow"}: ${name} must be a Code node`);
  }
  return node;
}

function exactReplace(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact anchor, found ${count}`);
  return source.replace(before, after);
}

function disableExecutionPersistence(workflow) {
  workflow.active = false;
  workflow.settings = {
    ...(workflow.settings || {}),
    saveDataErrorExecution: "none",
    saveDataSuccessExecution: "none",
    saveExecutionProgress: false,
    saveManualExecutions: false,
  };
  delete workflow.staticData;
  delete workflow.pinData;
  delete workflow.activeVersion;
  delete workflow.activeVersionId;
  for (const node of workflow.nodes || []) {
    delete node.continueOnFail;
  }
  return workflow;
}

const HANDOFF_BRANCH_SOURCE = `const founderSubject = String($env.PKC_FOUNDER_SUBJECT || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(founderSubject)) throw new Error('503: founder_mfa_not_configured');
const accountSubject = String(account.account_id || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountSubject)) throw new Error('403: founder_identity_mismatch');
const subjectMatch = accountSubject === founderSubject;
const usernameMatch = account.username === 'PK Blick';
const adminMatch = String(account.is_admin || '').toUpperCase() === 'TRUE';
const founderTuple = subjectMatch && usernameMatch && adminMatch;
if ((subjectMatch || usernameMatch || adminMatch) && !founderTuple) throw new Error('403: founder_identity_mismatch');
if (founderTuple) {
  const founderMode=String($env.PKC_FOUNDER_MFA_MODE||'');
  if (founderMode!=='enforced') throw new Error('403: founder_mfa_mode_denied');
  const login_attempt_id = String(trace.login_attempt_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(login_attempt_id)) {
    throw new Error('400: invalid_login_attempt_id');
  }
  const encodedHandoffKey = String($env.PKC_FOUNDER_MFA_HANDOFF_KEY || '');
  const handoffKey = Buffer.from(encodedHandoffKey, 'base64');
  const kid = String($env.PKC_FOUNDER_MFA_HANDOFF_KID || '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedHandoffKey)
    || handoffKey.length !== 32 || handoffKey.toString('base64') !== encodedHandoffKey
    || !/^[a-z][a-z0-9_-]{2,63}$/.test(kid)) throw new Error('503: founder_mfa_not_configured');
  const password_authenticated_at = Math.floor(nowMs / 1000);
  const iat = password_authenticated_at;
  const nbf = iat - 2;
  const exp = iat + 60;
  const jti = 'handoff-' + crypto.createHmac('sha256', handoffKey)
    .update('v1\\n' + founderSubject + '\\n' + login_attempt_id, 'utf8').digest('hex').slice(0, 48);
  const claims = {
    iss: 'pkc-n8n-account-login',
    aud: 'pkc-vercel-founder-mfa',
    typ: 'pkc-founder-password-handoff+jwt',
    purpose: 'founder_mfa_challenge',
    version: 1,
    kid,
    sub: founderSubject,
    username: 'PK Blick',
    is_admin: true,
    jti,
    login_attempt_id,
    password_authenticated_at,
    iat,
    nbf,
    exp
  };
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = encode({ alg: 'HS256', typ: 'JWT', kid }) + '.' + encode(claims);
  const signature = crypto.createHmac('sha256', handoffKey).update(signingInput, 'utf8').digest('base64url');
  const handoff = signingInput + '.' + signature;
  return [{ json: {
    outcome: 'mfa_required',
    http_status: 200,
    request_id: trace.request_id,
    username: trace.username,
    login_attempt_id,
    password_authenticated_at,
    handoff
  } }];
}

`;

function addLoginAttemptValidation(source, label) {
  if (source.includes("const login_attempt_id = String(body.login_attempt_id")) return source;
  const anchor = "return [{ json: {";
  const validation = `const login_attempt_id = String(body.login_attempt_id || '').trim();
if (login_attempt_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(login_attempt_id)) throw new Error('400: invalid_login_attempt_id');
`;
  const withValidation = exactReplace(source, anchor, `${validation}${anchor}`, `${label}:login attempt validation`);
  return exactReplace(withValidation, anchor, "return [{ json: { login_attempt_id,", `${label}:login attempt projection`);
}

function mfaSwitchRule() {
  return {
    conditions: {
      combinator: "and",
      conditions: [{
        leftValue: "={{ $json.outcome }}",
        operator: { operation: "equals", type: "string" },
        rightValue: "mfa_required",
      }],
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
    },
    outputKey: "mfa_required",
    renameOutput: true,
  };
}

function mfaRequiredResponseNode() {
  return {
    name: "Respond MFA Required",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.4,
    parameters: {
      respondWith: "json",
      responseBody: "={{ { ok: true, status: 'mfa_required', request_id: $('Verify Credentials').first().json.request_id, login_attempt_id: $('Verify Credentials').first().json.login_attempt_id, handoff: $('Verify Credentials').first().json.handoff } }}",
      options: {
        responseCode: 200,
        responseHeaders: { entries: [
          { name: "Content-Type", value: "application/json" },
          { name: "Cache-Control", value: "no-store" },
          { name: "Pragma", value: "no-cache" },
          { name: "Referrer-Policy", value: "no-referrer" },
          { name: "X-Frame-Options", value: "DENY" },
        ] },
      },
    },
  };
}

export function patchAccountLoginForFounderMfa(input) {
  const sourceFingerprint = fingerprint(input);
  const workflow = disableExecutionPersistence(clone(input));
  const init = requireCodeNode(workflow, "Init Trace");
  const verify = requireCodeNode(workflow, "Verify Credentials");
  const route = getNode(workflow, "Route Outcome");
  getNode(workflow, "Read User Sessions");
  getNode(workflow, "Respond Success");

  init.parameters.jsCode = addLoginAttemptValidation(init.parameters.jsCode, "Init Trace");
  if (!LOGIN_VERIFY_SOURCE_FINGERPRINTS.has(fingerprint(verify.parameters.jsCode))) {
    throw new Error("Verify Credentials: source fingerprint drift");
  }
  verify.parameters.jsCode = exactReplace(
    verify.parameters.jsCode,
    "const account = rows.find(r => String(r.username||'') === trace.username) || null;",
    "const lookupFounderSubject = String($env.PKC_FOUNDER_SUBJECT || '');\nif (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lookupFounderSubject)) throw new Error('503: founder_mfa_not_configured');\nconst founderLookup = trace.username === 'PK Blick';\nconst accountMatches = rows.filter(r => founderLookup ? String(r.account_id||'') === lookupFounderSubject : String(r.username||'') === trace.username);\nif (accountMatches.length > 1) throw new Error('409: account_authority_ambiguous');\nconst account = accountMatches.length === 1 ? accountMatches[0] : null;\nconst conflictingFounderRows = rows.filter(r => { const subject = String(r.account_id||''); const username = r.username === 'PK Blick'; const admin = String(r.is_admin||'').toUpperCase() === 'TRUE'; const signal = subject === lookupFounderSubject || username || admin; return signal && !(subject === lookupFounderSubject && username && admin); });\nif (conflictingFounderRows.length) throw new Error('403: founder_identity_mismatch');",
    "Verify Credentials:exact account cardinality",
  );
  const legacyOwnerAuthority = `const ownerTuple = account && account.username === 'PK Blick' && String(account.email||'').trim().toLowerCase() === 'projectkidcreations@gmail.com';
if (account && ownerTuple && String(account.is_admin||'').toUpperCase() !== 'TRUE') throw new Error('403: owner_admin_state_invalid');
if (account && !ownerTuple && String(account.is_admin||'').toUpperCase() === 'TRUE') throw new Error('403: public_admin_state_invalid');

`;
  if (verify.parameters.jsCode.includes(legacyOwnerAuthority)) {
    verify.parameters.jsCode = exactReplace(
      verify.parameters.jsCode,
      legacyOwnerAuthority,
      "",
      "Verify Credentials:remove email owner authority",
    );
  }
  const successAnchor = verify.parameters.jsCode.indexOf("// SUCCESS — build session + JWT");
  const sessionCreation = verify.parameters.jsCode.indexOf("const session_id = crypto.randomUUID();");
  if (successAnchor < 0 || sessionCreation < 0 || successAnchor > sessionCreation) {
    throw new Error("Verify Credentials: missing pre-session success anchor");
  }
  if (verify.parameters.jsCode.includes("outcome: 'mfa_required'")) {
    throw new Error("Verify Credentials: founder MFA branch already present");
  }
  verify.parameters.jsCode = exactReplace(
    verify.parameters.jsCode,
    "// SUCCESS — build session + JWT",
    `${HANDOFF_BRANCH_SOURCE}// SUCCESS — build session + JWT`,
    "Verify Credentials:founder branch",
  );

  const values = route.parameters?.rules?.values;
  const main = workflow.connections?.["Route Outcome"]?.main;
  if (!Array.isArray(values) || !Array.isArray(main) || values.length !== main.length - 1) {
    throw new Error("Route Outcome: unsupported switch topology");
  }
  if (JSON.stringify(values.map((rule) => rule.outputKey)) !== JSON.stringify(["success", "fail_password"])) {
    throw new Error("Route Outcome: customer outcome rule drift");
  }
  const customerSuccess = main[0];
  if (!Array.isArray(customerSuccess) || customerSuccess.length !== 1
    || customerSuccess[0]?.node !== "Read User Sessions"
    || customerSuccess[0]?.type !== "main" || customerSuccess[0]?.index !== 0) {
    throw new Error("Route Outcome: customer success route drift");
  }
  if (!LOGIN_WORKFLOW_SOURCE_FINGERPRINTS.has(sourceFingerprint)) {
    throw new Error("Account Login: workflow source fingerprint drift");
  }
  if (values.some((rule) => rule.outputKey === "mfa_required")) throw new Error("Route Outcome: MFA route already present");
  values.unshift(mfaSwitchRule());
  main.unshift([{ node: "Respond MFA Required", type: "main", index: 0 }]);
  workflow.nodes.push(mfaRequiredResponseNode());
  return workflow;
}

function decodeJsonPart(value, errorCode) {
  try {
    const text = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(errorCode);
    return parsed;
  } catch {
    throw new Error(errorCode);
  }
}

function hasExactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function verifyFounderFinalizeGrant(token, { key, expectedKid, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!key) throw new Error("finalize_key_missing");
  if (!expectedKid) throw new Error("finalize_kid_missing");
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("invalid_finalize_grant");
  const header = decodeJsonPart(parts[0], "invalid_finalize_grant");
  const payload = decodeJsonPart(parts[1], "invalid_finalize_grant");
  if (!hasExactKeys(header, ["alg", "kid", "typ"]) || header.alg !== "HS256" || header.typ !== "JWT" || header.kid !== expectedKid) {
    throw new Error("invalid_finalize_header");
  }
  const expected = crypto.createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`, "utf8").digest();
  let provided;
  try { provided = Buffer.from(parts[2], "base64url"); } catch { throw new Error("invalid_finalize_signature"); }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new Error("invalid_finalize_signature");
  if (!hasExactKeys(payload, FINALIZE_CLAIM_KEYS)) throw new Error("invalid_finalize_claims");
  if (payload.iss !== "pkc-vercel-founder-mfa"
    || payload.aud !== "pkc-n8n-founder-mfa-finalizer"
    || payload.typ !== "pkc-founder-mfa-finalize+jwt"
    || payload.purpose !== "founder_mfa_finalize"
    || payload.version !== 1
    || payload.kid !== expectedKid
    || !UUID_RE.test(payload.sub)
    || payload.username !== OWNER_USERNAME
    || payload.is_admin !== true) throw new Error("invalid_finalize_claims");
  if (!UUID_RE.test(payload.login_attempt_id)
    || !STABLE_ID_RE.test(payload.jti)
    || !STABLE_ID_RE.test(payload.finalize_id)
    || !STABLE_ID_RE.test(payload.session_id)
    || typeof payload.auth_epoch !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(payload.auth_epoch)
    || payload.auth_epoch.length > 19 || (payload.auth_epoch.length === 19 && payload.auth_epoch > "9223372036854775807")
    || JSON.stringify(payload.amr) !== JSON.stringify(["pwd", "otp"])) throw new Error("invalid_finalize_claims");
  for (const name of ["password_authenticated_at", "mfa_verified_at", "session_issued_at", "session_expires_at", "iat", "nbf", "exp"]) {
    if (!Number.isSafeInteger(payload[name]) || payload[name] < 0) throw new Error("invalid_finalize_claims");
  }
  if (payload.nbf > now + 5 || payload.iat > now + 5) throw new Error("not_yet_valid_finalize_grant");
  if (payload.exp <= now) throw new Error("expired_finalize_grant");
  if (payload.exp - payload.iat > 120
    || payload.password_authenticated_at > payload.mfa_verified_at
    || payload.mfa_verified_at !== payload.session_issued_at
    || payload.session_expires_at <= payload.session_issued_at) throw new Error("invalid_finalize_claims");
  return payload;
}

const AUTHENTICATE_FINALIZER_SOURCE = `const crypto = require('crypto');
const input = $input.first()?.json || {};
const headers = input.headers || {};
const expectedInternalKey = $env.PKC_AUTH_KEY;
if (!expectedInternalKey) throw new Error('503: finalizer_not_configured');
const digest = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
if (!crypto.timingSafeEqual(digest(headers['x-pkc-key']), digest(expectedInternalKey))) throw new Error('401: unauthorized');
if ($env.PKC_FOUNDER_MFA_MODE !== 'enforced') throw new Error('403: founder_mfa_mode_denied');
const body = input.body || input || {};
if (Object.keys(body).length !== 1 || typeof body.grant !== 'string' || body.grant.length > 8192) throw new Error('400: invalid_finalize_request');
const grant = body.grant;
const parts = grant.split('.');
if (parts.length !== 3) throw new Error('401: invalid_finalize_grant');
let untrusted;
try { untrusted = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new Error('401: invalid_finalize_grant'); }
const founderSubject = String($env.PKC_FOUNDER_SUBJECT || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(founderSubject)) throw new Error('503: finalizer_not_configured');
if (!untrusted || untrusted.sub !== founderSubject || untrusted.username !== 'PK Blick' || untrusted.is_admin !== true) throw new Error('401: invalid_finalize_grant');
return [{ json: { grant, founder_lookup_subject: founderSubject } }];`;

const VERIFY_FINALIZE_SOURCE = `const crypto = require('crypto');
const request = $('Authenticate Finalizer').first().json;
const rows = $('Read Founder Account').all().map(item => item.json).filter(Boolean);
if (rows.length !== 1) throw new Error('403: founder_identity_mismatch');
const account = rows[0];
const accountSubject = String(account.account_id || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountSubject)) throw new Error('403: founder_identity_mismatch');
const subjectMatch = accountSubject === request.founder_lookup_subject;
const usernameMatch = account.username === 'PK Blick';
const adminMatch = String(account.is_admin || '').toUpperCase() === 'TRUE';
const founderTuple = subjectMatch && usernameMatch && adminMatch;
if (!founderTuple) throw new Error('403: founder_identity_mismatch');
const encodedKey = String($env.PKC_FOUNDER_MFA_FINALIZE_KEY || '');
const key = Buffer.from(encodedKey, 'base64');
const expectedKid = String($env.PKC_FOUNDER_MFA_FINALIZE_KID || '');
if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)
  || key.length !== 32 || key.toString('base64') !== encodedKey
  || !expectedKid) throw new Error('503: finalizer_not_configured');
const parts = request.grant.split('.');
if (parts.length !== 3) throw new Error('401: invalid_finalize_grant');
let header; let claims;
try {
  header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
} catch { throw new Error('401: invalid_finalize_grant'); }
const exactKeys = (value, expected) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
if (!exactKeys(header, ['alg','kid','typ']) || header.alg !== 'HS256' || header.typ !== 'JWT' || header.kid !== expectedKid) throw new Error('401: invalid_finalize_header');
const expected = crypto.createHmac('sha256', key).update(parts[0] + '.' + parts[1], 'utf8').digest();
const provided = Buffer.from(parts[2], 'base64url');
if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new Error('401: invalid_finalize_signature');
const claimKeys = ['amr','aud','auth_epoch','exp','finalize_id','iat','is_admin','iss','jti','kid','login_attempt_id','mfa_verified_at','nbf','password_authenticated_at','purpose','session_expires_at','session_id','session_issued_at','sub','typ','username','version'];
if (!exactKeys(claims, claimKeys)) throw new Error('401: invalid_finalize_claims');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const pgBigint = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && (value.length < 19 || (value.length === 19 && value <= '9223372036854775807'));
const stableId = value => /^[a-z][a-z0-9_-]{7,127}$/.test(value);
if (claims.iss !== 'pkc-vercel-founder-mfa'
  || claims.aud !== 'pkc-n8n-founder-mfa-finalizer'
  || claims.typ !== 'pkc-founder-mfa-finalize+jwt'
  || claims.purpose !== 'founder_mfa_finalize'
  || claims.version !== 1 || claims.kid !== expectedKid || claims.sub !== request.founder_lookup_subject
  || claims.username !== 'PK Blick' || claims.is_admin !== true
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.login_attempt_id)
  || !stableId(claims.jti) || !stableId(claims.finalize_id) || !stableId(claims.session_id)
  || !pgBigint(claims.auth_epoch) || JSON.stringify(claims.amr) !== '["pwd","otp"]') throw new Error('401: invalid_finalize_claims');
for (const field of ['password_authenticated_at','mfa_verified_at','session_issued_at','session_expires_at','iat','nbf','exp']) if (!integer(claims[field])) throw new Error('401: invalid_finalize_claims');
const now = Math.floor(Date.now() / 1000);
if (claims.nbf > now + 5 || claims.iat > now + 5 || claims.exp <= now || claims.exp - claims.iat > 120) throw new Error('401: expired_or_future_finalize_grant');
if (claims.password_authenticated_at > claims.mfa_verified_at || claims.mfa_verified_at !== claims.session_issued_at || claims.session_expires_at <= claims.session_issued_at) throw new Error('401: invalid_finalize_claims');
const jwtKey = $env.PKC_JWT_SECRET;
if (!jwtKey) throw new Error('503: finalizer_not_configured');
const sessionClaims = { sub: claims.sub, username: claims.username, is_admin: claims.is_admin, jti: claims.session_id, iat: claims.session_issued_at, exp: claims.session_expires_at, aud: 'pkc-account', amr: claims.amr, auth_epoch: claims.auth_epoch, mfa_verified_at: claims.mfa_verified_at };
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const signingInput = encode({alg:'HS256',typ:'JWT'}) + '.' + encode(sessionClaims);
const jwt = signingInput + '.' + crypto.createHmac('sha256', jwtKey).update(signingInput, 'utf8').digest('base64url');
const receipt = { ok: true, status: 'authenticated', receipt_version: 1, finalize_id: claims.finalize_id, grant_jti: claims.jti, session_id: claims.session_id, session_token: jwt, username: claims.username, auth_epoch: claims.auth_epoch, mfa_verified_at: claims.mfa_verified_at, issued_at: claims.session_issued_at, expires_at: claims.session_expires_at };
return [{ json: {
  receipt,
  session_projection: { session_id: claims.session_id, account_id: claims.sub, username: claims.username, created_at: new Date(claims.session_issued_at * 1000).toISOString(), expires_at: new Date(claims.session_expires_at * 1000).toISOString(), revoked_at: '', auth_epoch: String(claims.auth_epoch), mfa_verified_at: new Date(claims.mfa_verified_at * 1000).toISOString(), amr: 'pwd otp' },
  audit_projection: { request_id: claims.finalize_id, timestamp: new Date(claims.mfa_verified_at * 1000).toISOString(), event_type: 'FOUNDER_MFA_LOGIN_SUCCESS', actor: claims.sub, target_username: claims.username, ip_hash: '', details_json: JSON.stringify({ finalize_id: claims.finalize_id, session_id: claims.session_id, auth_epoch: claims.auth_epoch, grant_jti: claims.jti }) }
} }];`;

function requireProjectionTemplate(template, sourceName, expectedFields, expectedSheetFingerprint, label) {
  const node = getNode(template, sourceName);
  const columns = node.parameters?.columns;
  const schemaIds = Array.isArray(columns?.schema) ? columns.schema.map((field) => field?.id) : null;
  const isTestFixture = Array.isArray(schemaIds) && schemaIds.length === 0
    && node.parameters?.documentId === undefined && node.parameters?.sheetName === undefined;
  if (node.type !== "n8n-nodes-base.googleSheets" || node.typeVersion !== 4.7
    || node.parameters?.operation !== "append" || node.parameters?.options === undefined
    || columns?.mappingMode !== "defineBelow" || JSON.stringify(columns?.matchingColumns) !== "[]"
    || !columns?.value || typeof columns.value !== "object" || Array.isArray(columns.value)
    || (!isTestFixture && JSON.stringify(schemaIds) !== JSON.stringify(expectedFields))
    || (!isTestFixture && fingerprint(node.parameters.documentId) !== ACCOUNT_DOCUMENT_FINGERPRINT)
    || (!isTestFixture && fingerprint(node.parameters.sheetName) !== expectedSheetFingerprint)) {
    throw new Error(`${label} projection template drift`);
  }
  return node;
}

function sheetClone(template, sourceName, targetName, expectedFields, expectedSheetFingerprint, label) {
  const node = clone(requireProjectionTemplate(template, sourceName, expectedFields, expectedSheetFingerprint, label));
  node.name = targetName;
  delete node.id;
  delete node.continueOnFail;
  delete node.onError;
  return node;
}

function schemaFor(fields, matchingColumn) {
  return fields.map((id) => ({
    id,
    displayName: id,
    required: id === matchingColumn,
    defaultMatch: id === matchingColumn,
    display: true,
    canBeUsedToMatch: id === matchingColumn,
    type: "string",
  }));
}

function projectionParameters(base, matchingColumn, sourceName, fields) {
  return {
    ...clone(base),
    operation: "appendOrUpdate",
    options: {},
    columns: {
      attemptToConvertTypes: false,
      convertFieldsToString: true,
      mappingMode: "defineBelow",
      matchingColumns: [matchingColumn],
      schema: schemaFor(fields, matchingColumn),
      value: Object.fromEntries(fields.map((field) => [field, `={{ $('${sourceName}').first().json.${field.includes("request_id") || field.includes("event_type") || field.includes("actor") || field.includes("target_username") || field.includes("timestamp") || field.includes("ip_hash") || field.includes("details_json") ? "audit_projection" : "session_projection"}.${field} }}`])),
    },
  };
}

export function buildFounderMfaFinalizerWorkflow(accountLoginWorkflow) {
  const template = clone(accountLoginWorkflow);
  const sessionTemplateFields = ["created_at", "device_label", "expires_at", "ip_hash", "revoked_at", "session_id", "user_agent_raw", "username"];
  const auditTemplateFields = ["actor", "details_json", "event_type", "ip_hash", "request_id", "target_username", "timestamp"];
  const readAccount = clone(getNode(template, "Read Account"));
  const isTestFixture = readAccount.parameters?.documentId === undefined && readAccount.parameters?.sheetName === undefined;
  if (readAccount.type !== "n8n-nodes-base.googleSheets" || readAccount.typeVersion !== 4.7
    || readAccount.parameters?.operation !== "read"
    || (!isTestFixture && fingerprint(readAccount.parameters.documentId) !== ACCOUNT_DOCUMENT_FINGERPRINT)
    || (!isTestFixture && fingerprint(readAccount.parameters.sheetName) !== ACCOUNT_SHEET_FINGERPRINT)) {
    throw new Error("account lookup template drift");
  }
  readAccount.name = "Read Founder Account";
  delete readAccount.id;
  delete readAccount.continueOnFail;
  delete readAccount.onError;
  readAccount.parameters.filtersUI = { values: [{ lookupColumn: "account_id", lookupValue: "={{ $('Authenticate Finalizer').first().json.founder_lookup_subject }}" }] };

  const session = sheetClone(template, "Append New Session", "Upsert Founder Session Projection", sessionTemplateFields, SESSION_SHEET_FINGERPRINT, "session");
  const sessionFields = ["session_id", "account_id", "username", "created_at", "expires_at", "revoked_at", "auth_epoch", "mfa_verified_at", "amr"];
  session.parameters = projectionParameters(session.parameters, "session_id", "Verify Finalize Grant", sessionFields);

  const audit = sheetClone(template, "Audit Success", "Upsert Founder Audit Projection", auditTemplateFields, AUDIT_SHEET_FINGERPRINT, "audit");
  const auditFields = ["request_id", "timestamp", "event_type", "actor", "target_username", "ip_hash", "details_json"];
  audit.parameters = projectionParameters(audit.parameters, "request_id", "Verify Finalize Grant", auditFields);

  const workflow = {
    name: "PKC — Founder MFA Finalizer (Inactive Candidate)",
    active: false,
    settings: { executionOrder: "v1" },
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, parameters: { httpMethod: "POST", path: "pkc-internal-founder-mfa-finalize", responseMode: "responseNode", options: {} } },
      codeNode("Authenticate Finalizer", AUTHENTICATE_FINALIZER_SOURCE),
      readAccount,
      codeNode("Verify Finalize Grant", VERIFY_FINALIZE_SOURCE),
      session,
      audit,
      {
        name: "Respond Finalized",
        type: "n8n-nodes-base.respondToWebhook",
        typeVersion: 1.4,
        parameters: {
          respondWith: "json",
          responseBody: "={{ $('Verify Finalize Grant').first().json.receipt }}",
          options: { responseCode: 200, responseHeaders: { entries: [
            { name: "Content-Type", value: "application/json" },
            { name: "Cache-Control", value: "no-store" },
            { name: "Referrer-Policy", value: "no-referrer" },
            { name: "X-Frame-Options", value: "DENY" },
          ] } },
        },
      },
    ],
    connections: {
      Webhook: { main: [[{ node: "Authenticate Finalizer", type: "main", index: 0 }]] },
      "Authenticate Finalizer": { main: [[{ node: "Read Founder Account", type: "main", index: 0 }]] },
      "Read Founder Account": { main: [[{ node: "Verify Finalize Grant", type: "main", index: 0 }]] },
      "Verify Finalize Grant": { main: [[{ node: "Upsert Founder Session Projection", type: "main", index: 0 }]] },
      "Upsert Founder Session Projection": { main: [[{ node: "Upsert Founder Audit Projection", type: "main", index: 0 }]] },
      "Upsert Founder Audit Projection": { main: [[{ node: "Respond Finalized", type: "main", index: 0 }]] },
    },
  };
  return disableExecutionPersistence(workflow);
}

function insertAuthorityGate(input, { expectedFingerprint, label, anchorName, expectedTarget, gateName, jsCode, prepare }) {
  requireSourceFingerprint(input, expectedFingerprint, label);
  const workflow = disableExecutionPersistence(clone(input));
  if (prepare) prepare(workflow);
  requireCodeNode(workflow, anchorName);
  const target = getNode(workflow, expectedTarget);
  if (target.type !== "n8n-nodes-base.respondToWebhook") throw new Error(`${label}: response target drift`);
  if (workflow.nodes.some((node) => node.name === gateName)) throw new Error(`${gateName}: already present`);
  const existing = workflow.connections?.[anchorName]?.main;
  if (!Array.isArray(existing) || existing.length !== 1 || !Array.isArray(existing[0])
    || existing[0].length !== 1 || existing[0][0]?.node !== expectedTarget
    || existing[0][0]?.type !== "main" || existing[0][0]?.index !== 0) {
    throw new Error(`${anchorName}: unsupported authority topology`);
  }
  workflow.nodes.push(codeNode(gateName, jsCode));
  workflow.connections[anchorName] = { main: [[{ node: gateName, type: "main", index: 0 }]] };
  workflow.connections[gateName] = { main: clone(existing) };
  return workflow;
}

const LEGACY_SESSION_SUBJECT_VALIDATOR = "const canonicalUsername = value => { const raw = String(value || '').trim(); if (raw === 'PK Blick') return 'PK Blick'; if (/^pk blick$/i.test(raw)) throw new Error('401:reserved_owner_identity'); const normalized = raw.toLowerCase(); if (!/^[a-z0-9_.-]{3,32}$/.test(normalized)) throw new Error('401:invalid_session_subject'); return normalized; };";
const FOUNDER_SESSION_SUBJECT_VALIDATOR = "const canonicalUsername = (value, claims) => { const raw = String(value || ''); const founderSubject = String($env.PKC_FOUNDER_SUBJECT || ''); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(founderSubject)) throw new Error('503:founder_authority_not_configured'); const founderKeys = ['amr','aud','auth_epoch','exp','iat','is_admin','jti','mfa_verified_at','sub','username']; const founderSignal = raw === founderSubject || /^pk blick$/i.test(raw) || claims?.username === 'PK Blick' || claims?.is_admin === true; if (founderSignal) { const exact = claims && JSON.stringify(Object.keys(claims).sort()) === JSON.stringify(founderKeys); if (!exact || raw !== founderSubject || claims.username !== 'PK Blick' || claims.is_admin !== true) throw new Error('401:invalid_founder_session_subject'); return 'PK Blick'; } const normalized = raw.trim().toLowerCase(); if (!/^[a-z0-9_.-]{3,32}$/.test(normalized)) throw new Error('401:invalid_session_subject'); return normalized; };";

function patchProtectedInitTrace(workflow) {
  const init = requireCodeNode(workflow, "Init Trace");
  init.parameters.jsCode = exactReplace(init.parameters.jsCode, LEGACY_SESSION_SUBJECT_VALIDATOR, FOUNDER_SESSION_SUBJECT_VALIDATOR, `${workflow.name}:Init Trace founder subject validator`);
  init.parameters.jsCode = exactReplace(init.parameters.jsCode, "username: canonicalUsername(payload.sub),", "username: canonicalUsername(payload.sub, payload), account_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(payload.sub || '')) ? String(payload.sub) : null,", `${workflow.name}:Init Trace founder claims`);
}

function patchProfileProjection(workflow) {
  const build = requireCodeNode(workflow, "Build Profile Response");
  build.parameters.jsCode = exactReplace(
    build.parameters.jsCode,
    "const acct = $('Read Account').all().map(i => i.json).find(r => r && r.username) || {};",
    "const trace = $('Init Trace').first().json;\nconst traceAccountId = trace.account_id == null ? null : String(trace.account_id);\nif (traceAccountId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(traceAccountId)) throw new Error('403: account_identity_invalid');\nconst accountMatches = $('Read Account').all().map(i => i.json).filter(r => r && (traceAccountId !== null ? String(r.account_id || '') === traceAccountId : String(r.username || '') === String(trace.username || '')));\nif (accountMatches.length !== 1) throw new Error('403: account_authority_ambiguous');\nconst acct = accountMatches[0];\nconst accountId = String(acct.account_id || '');\nif (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountId)) throw new Error('403: account_identity_invalid');",
    "Build Profile Response:exact account",
  );
  build.parameters.jsCode = exactReplace(build.parameters.jsCode, "const safe = {\n  username: acct.username,", "const safe = {\n  account_id: accountId,\n  username: acct.username,", "Build Profile Response:account_id");
}

const PROFILE_ASSURANCE_SOURCE = `const item = $input.first()?.json || {};
const trace = $('Init Trace').first().json;
const traceAccountId = trace.account_id == null ? null : String(trace.account_id);
if (traceAccountId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(traceAccountId)) throw new Error('403: founder_identity_mismatch');
const accountMatches = $('Read Account').all().map(entry => entry.json).filter(row => row && (traceAccountId !== null ? String(row.account_id || '') === traceAccountId : String(row.username || '') === String(trace.username || '')));
if (accountMatches.length !== 1) throw new Error('403: account_authority_ambiguous');
const account = accountMatches[0];
const founderSubject = String($env.PKC_FOUNDER_SUBJECT || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(founderSubject)) throw new Error('503: founder_authority_not_configured');
const accountSubject = String(account.account_id || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountSubject)) throw new Error('403: founder_identity_mismatch');
const subjectMatch = accountSubject === founderSubject;
const usernameMatch = account.username === 'PK Blick';
const adminMatch = String(account.is_admin || '').toUpperCase() === 'TRUE';
const founderTuple = subjectMatch && usernameMatch && adminMatch;
if ((subjectMatch || usernameMatch || adminMatch) && !founderTuple) throw new Error('403: founder_identity_mismatch');
if (!founderTuple) return [{ json: item }];
const sessionMatches = $('Read Sessions').all().map(entry => entry.json)
  .filter(row => row && String(row.session_id) === String(trace.session_id));
if (sessionMatches.length !== 1) throw new Error('403: session_authority_ambiguous');
const session = sessionMatches[0];
const sessionEpoch = String(session?.auth_epoch ?? '');
if (!/^(?:0|[1-9][0-9]*)$/.test(sessionEpoch) || sessionEpoch.length>19 || (sessionEpoch.length===19&&sessionEpoch>'9223372036854775807')) throw new Error('403: founder_session_assurance_invalid');
const amr = String(session?.amr || '').trim().split(/\\s+/).filter(Boolean);
const mfaVerifiedMs = new Date(session?.mfa_verified_at || '').getTime();
const mfaVerifiedAt = mfaVerifiedMs / 1000;
if (JSON.stringify(amr) !== '["pwd","otp"]' || !Number.isSafeInteger(mfaVerifiedAt)) throw new Error('403: founder_session_assurance_invalid');
const founder_assurance = { amr: ['pwd','otp'], auth_epoch: sessionEpoch, mfa_verified_at: mfaVerifiedAt };
return [{ json: { ...item, profile: { ...(item.profile || {}), auth_epoch: sessionEpoch, founder_assurance } } }];`;

const SESSION_ASSURANCE_SOURCE = `const item = $input.first()?.json || {};
const trace = $('Init Trace').first().json;
const sessionMatches = $('Read Current Session').all().map(entry => entry.json)
  .filter(row => row && String(row.session_id) === String(trace.session_id));
if (sessionMatches.length !== 1) throw new Error('403: session_authority_ambiguous');
const session = sessionMatches[0];
const founderSubject = String($env.PKC_FOUNDER_SUBJECT || '');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(founderSubject)) throw new Error('503: founder_authority_not_configured');
const rawAccountSubject = session.account_id;
const accountSubject = rawAccountSubject == null ? '' : String(rawAccountSubject);
if (accountSubject && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountSubject)) throw new Error('403: founder_session_assurance_invalid');
const subjectMatch = accountSubject === founderSubject;
const usernameMatch = session?.username === 'PK Blick';
const founderSession = subjectMatch && usernameMatch;
if (subjectMatch !== usernameMatch) throw new Error('403: founder_session_assurance_invalid');
if (!founderSession) return [{ json: item }];
const authEpoch = String(session.auth_epoch ?? '');
const amr = String(session.amr || '').trim().split(/\\s+/).filter(Boolean);
const mfaVerifiedMs = new Date(session.mfa_verified_at || '').getTime();
const mfaVerifiedAt = mfaVerifiedMs / 1000;
if (!/^(?:0|[1-9][0-9]*)$/.test(authEpoch) || authEpoch.length>19 || (authEpoch.length===19&&authEpoch>'9223372036854775807')
  || JSON.stringify(amr) !== '["pwd","otp"]' || !Number.isSafeInteger(mfaVerifiedAt)) {
  throw new Error('403: founder_session_assurance_invalid');
}
return [{ json: { ...item, founder_assurance: { amr: ['pwd','otp'], auth_epoch: authEpoch, mfa_verified_at: mfaVerifiedAt } } }];`;

export function patchFounderProfileAuthority(input) {
  return insertAuthorityGate(input, {
    expectedFingerprint: PROFILE_WORKFLOW_SOURCE_FINGERPRINT,
    label: "profile",
    anchorName: "Build Profile Response",
    expectedTarget: "Respond OK",
    gateName: "Enforce Founder Profile Assurance",
    jsCode: PROFILE_ASSURANCE_SOURCE,
    prepare: (workflow) => {
      patchProtectedInitTrace(workflow);
      patchProfileProjection(workflow);
    },
  });
}

export function patchFounderSessionAuthority(input) {
  return insertAuthorityGate(input, {
    expectedFingerprint: SESSION_WORKFLOW_SOURCE_FINGERPRINT,
    label: "session",
    anchorName: "Build Sessions Response",
    expectedTarget: "Respond OK",
    gateName: "Enforce Founder Session Assurance",
    jsCode: SESSION_ASSURANCE_SOURCE,
    prepare: patchProtectedInitTrace,
  });
}
