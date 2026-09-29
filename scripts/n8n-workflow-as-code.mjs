import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildOutboxDispatcherWorkflow } from "./n8n-outbox-dispatcher.mjs";
import {
  buildFounderMfaFinalizerWorkflow,
  patchAccountLoginForFounderMfa,
  patchFounderProfileAuthority,
  patchFounderSessionAuthority,
} from "./n8n-founder-mfa.mjs";
import { patchDurableWorkflow } from "./n8n-durable-flow.mjs";

export const N8N_IMAGE = Object.freeze({
  version: "2.19.5",
  repository: "n8nio/n8n",
  repoDigest: "sha256:b1b0c592735e24acd3cc64db83f94ef4efd8e331e47c6883249cc51cc1bea16b",
  reference: "n8nio/n8n@sha256:b1b0c592735e24acd3cc64db83f94ef4efd8e331e47c6883249cc51cc1bea16b",
});

const IDS = Object.freeze({
  login: "wfDsutVsW15DHGr3",
  bootstrap: "nvgxxBPinPmsEmZq",
  profile: "uuNgivASLQZ08gX7",
  sessions: "GVVnbelFG97UjJDw",
  revoke: "W63ETZfmKVI7UDFW",
  logout: "jb0I4CqlJuuG6fXs",
});
const NAMES = Object.freeze({
  login: "PKC — Account Login",
  bootstrap: "PKC — Account Bootstrap",
  profile: "PKC — Account Get Profile",
  sessions: "PKC — Account Get Sessions",
  revoke: "PKC — Account Revoke Session",
  logout: "PKC — Account Logout",
});
const SOURCE_FINGERPRINTS = Object.freeze({
  login: "98090fdd8026a8c4eaf241a4be2ba8ff717b7d2b61fb4d40d30b63480f675946",
  bootstrap: "7e4df67d22091689abe6bc47198237b2120598ae48833240eb57460b9603a1f5",
  profile: "8287746c2654b22b8f7285cbdeddfeef655be6fa3ec9137d820ce25b810afebe",
  sessions: "0b85af35abcc64453e0225c102d79afa426088563a12ca7d05845aad40985eee",
  revoke: "60e3352fdcd30c64c88f7e337a51debcfe4ec4b857bdca779d3ea45618b72baf",
  logout: "f4d31328487ee49bc4b2b8abbdcb3da9f891df773c97266a1c719498de0b7d7f",
});
const SOURCE_INVENTORY_DIGESTS = Object.freeze({
  login: "98090fdd8026a8c4eaf241a4be2ba8ff717b7d2b61fb4d40d30b63480f675946",
  bootstrap: "7e4df67d22091689abe6bc47198237b2120598ae48833240eb57460b9603a1f5",
  profile: "8287746c2654b22b8f7285cbdeddfeef655be6fa3ec9137d820ce25b810afebe",
  sessions: "0b85af35abcc64453e0225c102d79afa426088563a12ca7d05845aad40985eee",
  revoke: "60e3352fdcd30c64c88f7e337a51debcfe4ec4b857bdca779d3ea45618b72baf",
  logout: "f4d31328487ee49bc4b2b8abbdcb3da9f891df773c97266a1c719498de0b7d7f",
});
const CONTRACTS = Object.freeze({
  login: Object.freeze({ authority: "exact founder UUID+PK Blick+admin tuple", founderBranch: "before session/JWT side effects", customerParity: true }),
  bootstrap: Object.freeze({ authority: "customer-only signed activation proof", founderDenied: true, directReplayDenied: true }),
  profile: Object.freeze({ authority: "exact account and current session", founderAssurance: "pwd+otp/auth_epoch/mfa_verified_at" }),
  sessions: Object.freeze({ authority: "exact current session", founderAssurance: "UUID subject+username+epoch" }),
  revoke: Object.freeze({ authority: "exact current and target session", founderTuple: "UUID subject+username+epoch" }),
  logout: Object.freeze({ authority: "exact current session", founderTuple: "UUID subject+username+epoch" }),
});

export const WORKFLOW_REGISTRY = Object.freeze(Object.keys(IDS).map((role) => Object.freeze({
  role,
  id: IDS[role],
  name: NAMES[role],
  snapshotRole: `protected-${role}`,
  sourceFingerprint: SOURCE_FINGERPRINTS[role],
  sourceInventorySha256: SOURCE_INVENTORY_DIGESTS[role],
  semanticContract: CONTRACTS[role],
})));

export const N8N_ARTIFACT_ROLES = Object.freeze([
  ...WORKFLOW_REGISTRY.map((entry) => entry.role),
  "finalizer",
  "dispatcher",
  "rollback-login",
]);

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex");
const clone = (value) => structuredClone(value);
const edge = (node) => ({ node, type: "main", index: 0 });
const code = (name, jsCode) => ({ name, type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { language: "javaScript", jsCode } });

export const FINALIZER_PUBLIC_RESPONSE_KEYS = Object.freeze([
  "auth_epoch", "expires_at", "finalize_id", "grant_jti", "issued_at", "mfa_verified_at",
  "ok", "receipt_version", "session_id", "session_token", "status", "username",
]);
const FINALIZER_RESPONSE_VALIDATOR = `const receipt=$('Verify Finalize Grant').first()?.json?.receipt;
const allowed=${JSON.stringify(FINALIZER_PUBLIC_RESPONSE_KEYS)};if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||JSON.stringify(Object.keys(receipt).sort())!==JSON.stringify(allowed))throw new Error('unexpected_finalizer_response_shape');
if(receipt.ok!==true||receipt.status!=='authenticated'||receipt.receipt_version!==1)throw new Error('unexpected_finalizer_response_shape');
for(const key of ['finalize_id','grant_jti','session_id','session_token','username'])if(typeof receipt[key]!=='string'||receipt[key].length<1)throw new Error('unexpected_finalizer_response_shape');
if(typeof receipt.auth_epoch!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(receipt.auth_epoch)||receipt.auth_epoch.length>19||(receipt.auth_epoch.length===19&&receipt.auth_epoch>'9223372036854775807'))throw new Error('unexpected_finalizer_response_shape');
for(const key of ['mfa_verified_at','issued_at','expires_at'])if(!Number.isSafeInteger(receipt[key]))throw new Error('unexpected_finalizer_response_shape');
return [{json:{ok:receipt.ok,status:receipt.status,receipt_version:receipt.receipt_version,finalize_id:receipt.finalize_id,grant_jti:receipt.grant_jti,session_id:receipt.session_id,session_token:receipt.session_token,username:receipt.username,auth_epoch:receipt.auth_epoch,mfa_verified_at:receipt.mfa_verified_at,issued_at:receipt.issued_at,expires_at:receipt.expires_at}}];`;
const FINALIZER_RESPONSE_EXPRESSION = "={{ { ok: $json.ok, status: $json.status, receipt_version: $json.receipt_version, finalize_id: $json.finalize_id, grant_jti: $json.grant_jti, session_id: $json.session_id, session_token: $json.session_token, username: $json.username, auth_epoch: $json.auth_epoch, mfa_verified_at: $json.mfa_verified_at, issued_at: $json.issued_at, expires_at: $json.expires_at } }}";

function migrationFunctionSignatures() {
  const migrationDir = path.resolve(new URL("../db/migrations", import.meta.url).pathname);
  const signatures = new Set();
  for (const name of fs.readdirSync(migrationDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationDir, name), "utf8");
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(pkc_auth\.[a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
      const types = match[2].split(",").map((argument) => argument.trim()).filter(Boolean).map((argument) => {
        const tokens = argument.replace(/\s+/g, " ").split(" ");
        return tokens.at(-1).toLowerCase();
      });
      signatures.add(`${match[1].toLowerCase()}(${types.join(",")})`);
    }
  }
  return signatures;
}

export function inspectDatabaseFunctionAuthority(workflow) {
  const declared = migrationFunctionSignatures();
  const referenced = [];
  for (const node of workflow?.nodes || []) {
    if (node.type !== "n8n-nodes-base.postgres") continue;
    const query = String(node.parameters?.query || "");
    for (const match of query.matchAll(/\b(pkc_auth\.[a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
      const types = [...match[2].matchAll(/\$\d+::([a-z_][a-z0-9_]*(?:\[\])?)/gi)].map((item) => item[1].toLowerCase());
      const placeholders = [...match[2].matchAll(/\$\d+/g)];
      if (types.length !== placeholders.length) throw new Error(`${node.name}: database function arguments require explicit casts`);
      referenced.push(`${match[1].toLowerCase()}(${types.join(",")})`);
    }
  }
  const unknown = referenced.filter((signature) => !declared.has(signature));
  if (unknown.length) throw new Error(`unknown database function authority: ${unknown.join(",")}`);
  return Object.freeze({ declared: Object.freeze([...declared].sort()), referenced: Object.freeze(referenced.sort()), unknown: Object.freeze([]) });
}

export function buildSafeSourceInventory(workflow) {
  if (!workflow || typeof workflow !== "object" || !Array.isArray(workflow.nodes)) throw new Error("invalid workflow snapshot");
  const summarize = (value, depth = 0) => {
    if (depth > 64) throw new Error("workflow inventory depth exceeded");
    if (Array.isArray(value)) return { kind: "array", length: value.length, values: value.map((entry) => summarize(entry, depth + 1)) };
    if (value && typeof value === "object") return { kind: "object", keys: Object.keys(value).sort(), values: Object.fromEntries(Object.keys(value).sort().map((key) => [key, summarize(value[key], depth + 1)])) };
    return { kind: value === null ? "null" : typeof value, sha256: sha256(canonical(value)) };
  };
  return summarize(workflow);
}

export function createRegistryForInputs(inputs, templates = WORKFLOW_REGISTRY) {
  const byId = new Map(inputs.map((workflow) => [workflow.id, workflow]));
  return Object.freeze(templates.map((template) => {
    const input = byId.get(template.id);
    if (!input) throw new Error(`missing protected workflow role: ${template.role}`);
    return Object.freeze({
      ...template,
      sourceFingerprint: template.sourceFingerprint || sha256(input),
      sourceInventorySha256: template.sourceInventorySha256 || sha256(input),
      semanticContract: Object.freeze({ ...(template.semanticContract || {}) }),
    });
  }));
}

export function validateProtectedInputs(inputs, registry = WORKFLOW_REGISTRY) {
  if (!Array.isArray(inputs)) throw new Error("protected workflow inputs must be an array");
  const allowed = new Map(registry.map((entry) => [entry.id, entry]));
  const seen = new Set();
  for (const workflow of inputs) {
    if (!/^[A-Za-z0-9]{16}$/.test(String(workflow?.id || ""))) throw new Error(`malformed workflow id: ${String(workflow?.id || "")}`);
    if (seen.has(workflow.id)) throw new Error(`duplicate protected workflow id: ${workflow.id}`);
    seen.add(workflow.id);
    const entry = allowed.get(workflow.id);
    if (!entry) throw new Error(`unknown protected workflow id: ${workflow.id}`);
    if (workflow.name !== entry.name) throw new Error(`${entry.role}: protected workflow name drift`);
    const digest = sha256(workflow);
    if (digest !== entry.sourceInventorySha256) throw new Error(`${entry.role}: source fingerprint drift`);
  }
  for (const entry of registry) if (!seen.has(entry.id)) throw new Error(`missing protected workflow role: ${entry.role}`);
  if (seen.size !== registry.length) throw new Error("protected workflow set is not closed");
  return registry.map((entry) => inputs.find((workflow) => workflow.id === entry.id));
}

function sanitizeCredentialReferences(workflow) {
  for (const node of workflow.nodes || []) {
    if (node.credentials === undefined) continue;
    if (!node.credentials || typeof node.credentials !== "object" || Array.isArray(node.credentials)) throw new Error(`${node.name}: malformed credential references`);
    node.credentials = Object.fromEntries(Object.entries(node.credentials).map(([type, reference]) => {
      if (!reference || typeof reference.name !== "string" || !reference.name.trim()) throw new Error(`${node.name}: credential name required`);
      return [type, { name: reference.name }];
    }));
  }
}

function sanitizeWorkflow(input) {
  const workflow = clone(input);
  for (const key of ["id", "versionId", "createdAt", "updatedAt", "activeVersion", "activeVersionId", "versionCounter", "shared", "tags", "triggerCount", "meta", "staticData", "pinData"]) delete workflow[key];
  workflow.active = false;
  workflow.settings = {
    ...(workflow.settings || {}),
    saveDataErrorExecution: "none",
    saveDataSuccessExecution: "none",
    saveExecutionProgress: false,
    saveManualExecutions: false,
  };
  for (const [index, node] of (workflow.nodes || []).entries()) {
    if (!Array.isArray(node.position) || node.position.length !== 2) node.position = [index * 240, 0];
    delete node.id;
    delete node.continueOnFail;
    delete node.retryOnFail;
    delete node.maxTries;
    delete node.waitBetweenTries;
  }
  sanitizeCredentialReferences(workflow);
  return workflow;
}

function insertAfter(workflow, sourceName, node) {
  if (workflow.nodes.some((candidate) => candidate.name === node.name)) throw new Error(`${node.name}: duplicate transform`);
  const current = workflow.connections?.[sourceName]?.main;
  if (!Array.isArray(current) || current.length !== 1 || !Array.isArray(current[0])) throw new Error(`${sourceName}: unsupported topology`);
  workflow.nodes.push(node);
  workflow.connections[sourceName] = { main: [[edge(node.name)]] };
  workflow.connections[node.name] = { main: clone(current) };
}

function insertBefore(workflow, targetName, node) {
  if (workflow.nodes.some((candidate) => candidate.name === node.name)) throw new Error(`${node.name}: duplicate transform`);
  let rewired = 0;
  for (const lanes of Object.values(workflow.connections || {})) {
    for (const lane of lanes.main || []) for (const connection of lane || []) {
      if (connection.node === targetName) { connection.node = node.name; rewired += 1; }
    }
  }
  if (rewired !== 1) throw new Error(`${targetName}: expected exact-one incoming authority edge, found ${rewired}`);
  const targetIndex = workflow.nodes.findIndex((candidate) => candidate.name === targetName);
  if (targetIndex < 0) throw new Error(`${targetName}: authority target missing`);
  workflow.nodes.splice(targetIndex, 0, node);
  workflow.connections[node.name] = { main: [[edge(targetName)]] };
}

const IDENTITY_GATE = `const input=$input.first()?.json||{};const body=input.body||input;const claims=body.claims||body.session||{};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;const founderSubject=String($env.PKC_FOUNDER_SUBJECT||'');if(!uuid.test(founderSubject))throw new Error('503:founder_authority_not_configured');
const rawId=body.account_id??claims.sub;const id=rawId==null?'':String(rawId);if(id&&!uuid.test(id))throw new Error('403:account_identity_invalid');const username=body.username??claims.username;const admin=body.is_admin??claims.is_admin;const signals=[id===founderSubject,username==='PK Blick',admin===true];
if(signals.some(Boolean)&&!signals.every(Boolean))throw new Error('403:founder_identity_mismatch');if(!signals.some(Boolean)&&(id||username==='PK Blick'||admin===true))throw new Error('403:founder_identity_mismatch');return $input.all();`;
const SESSION_GATE = `const rows=$input.all().map(item=>item.json).filter(Boolean);if(rows.length!==1)throw new Error('403:session_authority_ambiguous');const row=rows[0];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;const founderSubject=String($env.PKC_FOUNDER_SUBJECT||'');if(!uuid.test(founderSubject))throw new Error('503:founder_authority_not_configured');const raw=row.account_id??row.sub;const subject=raw==null?'':String(raw);if(subject&&!uuid.test(subject))throw new Error('403:account_identity_invalid');const username=row.username==='PK Blick';const admin=row.is_admin===true||String(row.is_admin||'').toUpperCase()==='TRUE';const founder=subject===founderSubject&&username&&admin;
if((subject===founderSubject||username||admin)&&!founder)throw new Error('403:founder_session_authority_invalid');if(founder&&String($env.PKC_FOUNDER_MFA_MODE||'')!=='enforced')throw new Error('403:founder_mfa_mode_denied');const epoch=String(row.auth_epoch??'');if(founder&&(!/^(?:0|[1-9][0-9]*)$/.test(epoch)||epoch.length>19||(epoch.length===19&&epoch>'9223372036854775807')||String(row.amr||'').trim()!=='pwd otp'))throw new Error('403:founder_session_authority_invalid');return $input.all();`;

function applyIdentityAuthority(input, role) {
  const workflow = clone(input);
  const webhook = workflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  if (!webhook) throw new Error(`${role}: webhook missing`);
  insertAfter(workflow, webhook.name, code("Enforce Immutable Founder Authority", IDENTITY_GATE));
  return workflow;
}

function applyDurableFlow(input, role) {
  const workflow = clone(input);
  if (role !== "bootstrap") return workflow;
  const target = workflow.nodes.find((node) => /Business Logic|Issue Token|Build New Account/i.test(node.name));
  if (!target) throw new Error("bootstrap: durable target missing");
  insertBefore(workflow, target.name, code("Deny Founder Bootstrap Replay", `const item=$input.first()?.json||{};const body=item.body||item;if(/^pk blick$/i.test(String(body.username||''))||body.is_admin===true||body.account_id)throw new Error('403:founder_bootstrap_denied');if(!body.activation_proof&&body.direct_replay===true)throw new Error('403:activation_proof_required');return $input.all();`));
  return workflow;
}

function applyFounderMfa(input, role) {
  const workflow = clone(input);
  const target = workflow.nodes.find((node) => /Business Logic|Verify Credentials|Build Profile|Build Sessions|Validate Current Session|Update Session/i.test(node.name));
  if (role === "bootstrap") return workflow;
  if (!target) throw new Error(`${role}: MFA authority target missing`);
  if (role === "login") {
    insertBefore(workflow, target.name, code("Founder MFA Before Session Effects", `const item=$input.first()?.json||{};const account=item.account||item;const founderSubject=String($env.PKC_FOUNDER_SUBJECT||'');const signals=[String(account.account_id||'')===founderSubject,account.username==='PK Blick',account.is_admin===true||String(account.is_admin||'').toUpperCase()==='TRUE'];if(signals.some(Boolean)&&!signals.every(Boolean))throw new Error('403:founder_identity_mismatch');if(signals.every(Boolean)){if(String($env.PKC_FOUNDER_MFA_MODE||'')!=='enforced')throw new Error('403:founder_mfa_mode_denied');throw new Error('MFA_REQUIRED_BEFORE_SESSION');}return $input.all();`));
  } else if (["profile", "sessions", "revoke", "logout"].includes(role)) {
    insertBefore(workflow, target.name, code(`Enforce ${role[0].toUpperCase()}${role.slice(1)} Session Authority`, SESSION_GATE));
  }
  return workflow;
}

function correctedWorkflow(source, entry) {
  let workflow;
  const production = entry.sourceFingerprint === SOURCE_FINGERPRINTS[entry.role];
  if (!production) workflow = applyFounderMfa(applyDurableFlow(applyIdentityAuthority(source, entry.role), entry.role), entry.role);
  else if (entry.role === "login") workflow = patchAccountLoginForFounderMfa(source);
  else if (entry.role === "bootstrap") {
    workflow = patchDurableWorkflow(source);
    for (const node of workflow.nodes || []) if (typeof node.parameters?.jsCode === "string") node.parameters.jsCode = node.parameters.jsCode.replaceAll("?token=", "#token=");
  }
  else if (entry.role === "profile") workflow = patchFounderProfileAuthority(source);
  else if (entry.role === "sessions") workflow = patchFounderSessionAuthority(source);
  else workflow = applyFounderMfa(applyIdentityAuthority(source, entry.role), entry.role);
  workflow = sanitizeWorkflow(workflow);
  workflow.name = `${entry.name} — Founder MFA Candidate v1`;
  return workflow;
}

function buildFinalizerWorkflow(loginSource, production = true) {
  if (production) {
    const accepted = buildFounderMfaFinalizerWorkflow(loginSource);
    insertBefore(accepted, "Respond Finalized", code("Validate Finalizer Public Response", FINALIZER_RESPONSE_VALIDATOR));
    accepted.nodes.find((node) => node.name === "Respond Finalized").parameters.responseBody = FINALIZER_RESPONSE_EXPRESSION;
    inspectDatabaseFunctionAuthority(accepted);
    return sanitizeWorkflow(accepted);
  }
  return sanitizeWorkflow({ name: "PKC — Founder MFA Finalizer (Synthetic Gate Fixture)", active: false, settings: { executionOrder: "v1" }, nodes: [
    { name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, parameters: { httpMethod: "POST", path: "unit-founder-finalize", responseMode: "responseNode", options: {} } },
    code("Verify Finalize Grant", "const crypto=require('crypto');const token=String(($input.first()?.json?.body||{}).grant||'');const parts=token.split('.');if(parts.length!==3)throw new Error('invalid_finalize_grant');const key=Buffer.from(String($env.PKC_FOUNDER_MFA_FINALIZE_KEY||''),'base64');const expected=crypto.createHmac('sha256',key).update(parts[0]+'.'+parts[1]).digest();const supplied=Buffer.from(parts[2],'base64url');if(expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))throw new Error('invalid_finalize_signature');const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));return [{json:{receipt:{ok:true,status:'authenticated',receipt_version:1,finalize_id:claims.finalize_id,grant_jti:claims.jti,session_id:claims.session_id,session_token:claims.session_token,username:claims.username,auth_epoch:claims.auth_epoch,mfa_verified_at:claims.mfa_verified_at,issued_at:claims.iat,expires_at:claims.exp}}}];"),
    code("Validate Finalizer Public Response", FINALIZER_RESPONSE_VALIDATOR),
    { name: "Respond Finalized", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.4, parameters: { respondWith: "json", responseBody: FINALIZER_RESPONSE_EXPRESSION, options: { responseCode: 200 } } },
  ], connections: { Webhook: { main: [[edge("Verify Finalize Grant")]] }, "Verify Finalize Grant": { main: [[edge("Validate Finalizer Public Response")]] }, "Validate Finalizer Public Response": { main: [[edge("Respond Finalized")]] } } });
}

function rollbackLogin(login) {
  const workflow = clone(login);
  workflow.name = "PKC — Customer-Only Rollback Login v1 (Inactive Candidate)";
  const webhook = workflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  webhook.parameters.path = "pkc-accounts/login-customer-rollback-v1";
  const target = workflow.nodes.find((node) => /Business Logic|Verify Credentials|Session|JWT/i.test(node.name) && node.name !== "Enforce Immutable Founder Authority" && node.name !== "Founder MFA Before Session Effects");
  if (!target) throw new Error("rollback login: customer target missing");
  insertBefore(workflow, target.name, code("Deny Founder Rollback", `const item=$input.first()?.json||{};const account=item.account||item;const subject=String(account.account_id||item.account_id||'');const founderSubject=String($env.PKC_FOUNDER_SUBJECT||'');const username=String(account.username||item.username||'');const admin=account.is_admin===true||String(account.is_admin||'').toUpperCase()==='TRUE';if(subject===founderSubject||username==='PK Blick'||/^pk blick$/i.test(username)||admin)throw new Error('403:founder_rollback_denied');return $input.all();`));
  return sanitizeWorkflow(workflow);
}

function artifact(role, workflow, source = null, sourceRawDigest = null) {
  const sanitized = sanitizeWorkflow(workflow);
  const privacy = artifactPrivacyScan([sanitized]);
  if (!privacy.ok) throw new Error(`${role}: privacy scan failed: ${privacy.findings.join(", ")}`);
  return Object.freeze({ role, workflow: sanitized, rawSha256: sha256(`${JSON.stringify(sanitized, null, 2)}\n`), semanticSha256: semanticHash(sanitized), sourceRawSha256: sourceRawDigest || (source ? sha256(canonical(source)) : null) });
}

export function serializeNineArtifacts(inputs, { registry = WORKFLOW_REGISTRY, sourceRawDigests = {} } = {}) {
  const ordered = validateProtectedInputs(inputs, registry);
  const corrected = ordered.map((source, index) => artifact(registry[index].role, correctedWorkflow(source, registry[index]), source, sourceRawDigests[registry[index].id]));
  const finalizer = artifact("finalizer", buildFinalizerWorkflow(ordered[0], registry[0].sourceFingerprint === SOURCE_FINGERPRINTS.login));
  const dispatcher = artifact("dispatcher", buildOutboxDispatcherWorkflow());
  const rollback = artifact("rollback-login", rollbackLogin(corrected.find((item) => item.role === "login").workflow));
  const artifacts = Object.freeze([...corrected, finalizer, dispatcher, rollback]);
  if (artifacts.length !== N8N_ARTIFACT_ROLES.length
      || JSON.stringify(artifacts.map((item) => item.role)) !== JSON.stringify(N8N_ARTIFACT_ROLES)) {
    throw new Error("exact canonical nine artifact roles required");
  }
  const manifest = Object.freeze({
    schema: "pkc-n8n-nine-artifact-manifest-v1",
    n8nCompatibility: "2.19.5",
    image: N8N_IMAGE,
    artifactCount: artifacts.length,
    transformOrder: Object.freeze(["identity-authority", "durable-flow", "retention-privacy", "founder-mfa"]),
    sources: Object.freeze(registry.map((entry, index) => Object.freeze({ role: entry.role, id: entry.id, name: entry.name, sourceFingerprint: entry.sourceFingerprint, sourceInventorySha256: entry.sourceInventorySha256, rawSha256: artifacts[index].sourceRawSha256 }))),
    artifacts: Object.freeze(artifacts.map((item) => Object.freeze({ role: item.role, name: item.workflow.name, rawSha256: item.rawSha256, semanticSha256: item.semanticSha256 }))),
  });
  return Object.freeze({ manifest, artifacts });
}

function semanticNormalize(workflow) {
  const output = clone(workflow);
  const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const nativeId = output.id;
  const native = {
    id: (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value),
    versionId: uuid,
    createdAt: timestamp,
    updatedAt: timestamp,
    versionCounter: (value) => Number.isSafeInteger(value) && value >= 1,
    triggerCount: (value) => Number.isSafeInteger(value) && value >= 0,
    versionMetadata: (value) => value && typeof value === "object" && !Array.isArray(value)
      && JSON.stringify(Object.keys(value).sort()) === '["description","name"]'
      && value.name === null && value.description === null,
    activeVersionId: (value) => value === null,
    meta: (value) => value === null,
    tags: (value) => Array.isArray(value) && value.length === 0,
    shared: (value) => {
      if (!Array.isArray(value) || value.length !== 1) return false;
      const share = value[0];
      const project = share?.project;
      return share && JSON.stringify(Object.keys(share).sort()) === '["createdAt","project","projectId","role","updatedAt","workflowId"]'
        && share.role === "workflow:owner" && share.workflowId === nativeId
        && typeof share.projectId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(share.projectId)
        && timestamp(share.createdAt) && timestamp(share.updatedAt)
        && project && JSON.stringify(Object.keys(project).sort()) === '["createdAt","creatorId","description","icon","id","name","type","updatedAt"]'
        && project.id === share.projectId && project.type === "personal" && project.name === "Unnamed Project"
        && project.icon === null && project.description === null && uuid(project.creatorId)
        && timestamp(project.createdAt) && timestamp(project.updatedAt);
    },
  };
  for (const [key, validate] of Object.entries(native)) {
    if (!(key in output)) continue;
    if (!validate(output[key])) throw new Error(`unsafe native metadata: ${key}`);
    delete output[key];
  }
  // n8n materializes absent runtime data as null/empty on export. Any populated
  // value remains in the comparison and therefore fails closed.
  if (output.pinData === null || (output.pinData && typeof output.pinData === "object" && Object.keys(output.pinData).length === 0)) delete output.pinData;
  if (output.staticData === null || (output.staticData && typeof output.staticData === "object" && Object.keys(output.staticData).length === 0)) delete output.staticData;
  if (output.isArchived === false) delete output.isArchived;
  if (output.description === null) delete output.description;
  if (output.settings?.callerPolicy === "workflowsFromSameOwner") delete output.settings.callerPolicy;
  if (output.settings?.availableInMCP === false) delete output.settings.availableInMCP;
  for (const node of output.nodes || []) {
    delete node.id;
    if (node.credentials && typeof node.credentials === "object") {
      for (const reference of Object.values(node.credentials)) if (reference && typeof reference === "object") delete reference.id;
    }
  }
  return output;
}
export function semanticHash(workflow) { return sha256(semanticNormalize(workflow)); }
function semanticDifferencePaths(left, right, location = "$") {
  if (canonical(left) === canonical(right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths = [];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) paths.push(...semanticDifferencePaths(left[index], right[index], `${location}[${index}]`));
    return paths;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const paths = [];
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) paths.push(...semanticDifferencePaths(left[key], right[key], `${location}.${key}`));
    return paths;
  }
  return [location];
}
export function compareSemanticReadback(expected, readback) {
  const expectedNormalized = semanticNormalize(expected);
  const readbackNormalized = semanticNormalize(readback);
  const expectedHash = sha256(expectedNormalized);
  const readbackHash = sha256(readbackNormalized);
  return Object.freeze({ equal: expectedHash === readbackHash, expectedHash, readbackHash, differences: Object.freeze(semanticDifferencePaths(expectedNormalized, readbackNormalized)) });
}

const FORBIDDEN_KEYS = /^(pinData|staticData|executionData|execution_data|binaryData|pairedItem|password|secret|token|otp|seed|recovery_code|recovery_codes|otpauth|qr|cookie|cookies)$/i;
const FORBIDDEN_VALUE = /(?:password\s*[=:]|otpauth:\/\/|recovery[_ -]?codes?\s*[=:]|totp[_ -]?seed\s*[=:]|set-cookie\s*:|cookie\s*[=:]|(?:https?:\/\/|\?)[^\s"']*(?:password|otp|seed|recovery|token|secret)=)/i;
const FORBIDDEN_CODE_LITERAL = /(?:['"`]otpauth:\/\/|['"`][^'"`\n]*(?:password|otp|seed|recovery[_ -]?code|set-cookie)[=:][^'"`\n]+['"`]|https?:\/\/[^\s'"`]*[?&](?:password|otp|seed|recovery|token|secret)=)/i;
const JWT_SHAPE = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
const SAFE_CANARY_DIGEST = crypto.createHash("sha256").update("PKC_PRIVACY_CANARY_V1").digest("hex");
export function artifactPrivacyScan(workflows, { canaries = [] } = {}) {
  const findings = [];
  let nodes = 0; let strings = 0; const seen = new Set();
  const walk = (value, location, depth = 0) => {
    if (++nodes > 200000 || depth > 80) { findings.push(`${location}:bounds`); return; }
    if (typeof value === "string") { strings += value.length; if (strings > 8_000_000 || value.length > 1_000_000) findings.push(`${location}:bounds`); const isCode=location.endsWith(".jsCode"); const forbidden = isCode ? FORBIDDEN_CODE_LITERAL : FORBIDDEN_VALUE; if (forbidden.test(value)||(!isCode&&JWT_SHAPE.test(value))) findings.push(`${location}:sensitive-value`); if(sha256(value)===SAFE_CANARY_DIGEST)findings.push(`${location}:fixed-canary`); return; }
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${location}[${index}]`));
    if (!value || typeof value !== "object") return;
    if (seen.has(value) || Object.getPrototypeOf(value) !== Object.prototype) { findings.push(`${location}:unsafe-object`); return; }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") { findings.push(`${location}:symbol-key`); continue; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) { findings.push(`${location}.${key}:accessor`); continue; }
      const child = descriptor.value;
      if (FORBIDDEN_KEYS.test(key) && key !== "jsCode") findings.push(`${location}.${key}`);
      if (key === "credentials" && child && typeof child === "object") {
        for (const [type, reference] of Object.entries(child)) {
          if (!reference || typeof reference !== "object" || Object.keys(reference).some((field) => field !== "name")) findings.push(`${location}.credentials.${type}`);
        }
      }
      walk(child, `${location}.${key}`, depth + 1);
    }
    seen.delete(value);
  };
  workflows.forEach((workflow, index) => { try { walk(workflow, `$[${index}]`); } catch (error) { findings.push(`$[${index}]:uninspectable:${error instanceof Error ? error.name : "error"}`); } });
  let serialized=""; try { serialized=canonical(workflows); } catch (error) { findings.push(`$:uncanonicalizable:${error instanceof Error ? error.name : "error"}`); }
  for (const canary of canaries) if (String(canary) && serialized.includes(String(canary))) findings.push(`canary:${sha256(String(canary))}`);
  return Object.freeze({ ok: findings.length === 0, findings: Object.freeze(findings) });
}
