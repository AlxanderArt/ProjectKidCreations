import crypto from "node:crypto";
import fs from "node:fs";

import { readJsonDescriptorSafe } from "./n8n-workflows.mjs";

export const PRIVACY_VERSION = "2026-10-01";
export const PREVIOUS_PRIVACY_VERSION = "2026-09-26";
export const CANDIDATE_NAME = "PKC — Phase Three Save — 14+ Candidate v1";
export const CANDIDATE_PATH = "pkc-phase-three/save-14-plus-v1";

export function classifyPrivacyContractVersion(value) {
  if (value === undefined || value === "") return "legacy";
  if (value === "2026-09-26" || value === "2026-10-01") return "consent";
  return "unsupported";
}
export const SOURCE_AUTHORITY = Object.freeze({
  path: "/root/.hermes/protected/pkc-phase-three/live-workflow-s4erDMlvnW8vLIxI.json",
  id: "s4erDMlvnW8vLIxI",
  name: "PKC — Phase Three Save",
  versionId: "c8bd5f8f-e38d-4979-96b8-411a515a9c77",
  updatedAt: "2026-09-26T20:49:04.505Z",
  nodeCount: 17,
  rawSha256: "e04f2b8341998bbf706f466f3061a721b9bf4619e33de7e1a5b2483964b8bbe2",
  canonicalSha256: "75c3a4e8152bbf9311f2468a74d1e32eaa3de037e0bbf7027cc1a031b1e88b15",
  topologySha256: "232c33a95ace950baee1ff811ba8047310356865abf7ab55dd8546973fb4226a",
  credentialsSha256: "d8668ec34d2a46dc5156112276819bf82921a2edb0366c99305742bf6297905a",
  codeSha256: Object.freeze({
    "Validate + Compose Row": "57459b55feb21ae6b5a27f719d61adea799c1b4b6a8b97ae4b5728ddf135a7d0",
    "Compose Event": "544d8da166381696759a7149d8e74d282ab6e00bf300df04f94f565639febdeb",
    "Build Response": "cbfaca6c5fb5862807ae90f69ab990730cd3772d76c38c4c0a445fbca1c7e22f",
  }),
});

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const semanticHash = (value) => sha256(Buffer.from(canonical(value), "utf8"));

function topologyProjection(workflow) {
  return {
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: node.position,
      disabled: node.disabled || false,
    })),
    connections: workflow.connections,
  };
}

function credentialProjection(workflow) {
  return workflow.nodes.map((node) => ({ id: node.id, name: node.name, credentials: node.credentials ?? null }));
}

function codeNode(workflow, name) {
  const node = workflow.nodes?.find((item) => item.name === name);
  if (!node || typeof node.parameters?.jsCode !== "string") throw new Error(`${name} missing`);
  return node;
}

export function assertPhaseThreeSourceAuthority(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source authority drift: workflow object required");
  if (source.id !== SOURCE_AUTHORITY.id
      || source.name !== SOURCE_AUTHORITY.name
      || source.versionId !== SOURCE_AUTHORITY.versionId
      || source.updatedAt !== SOURCE_AUTHORITY.updatedAt
      || !Array.isArray(source.nodes)
      || source.nodes.length !== SOURCE_AUTHORITY.nodeCount
      || semanticHash(source) !== SOURCE_AUTHORITY.canonicalSha256) {
    throw new Error("source authority drift");
  }
  if (semanticHash(topologyProjection(source)) !== SOURCE_AUTHORITY.topologySha256) throw new Error("source authority drift: topology");
  if (semanticHash(credentialProjection(source)) !== SOURCE_AUTHORITY.credentialsSha256) throw new Error("source authority drift: credentials");
  for (const [name, expected] of Object.entries(SOURCE_AUTHORITY.codeSha256)) {
    if (sha256(codeNode(source, name).parameters.jsCode) !== expected) throw new Error(`source authority drift: ${name}`);
  }
}

export function loadBoundPhaseThreeSource() {
  const loaded = readJsonDescriptorSafe(SOURCE_AUTHORITY.path, { protectedInput: true });
  if (loaded.rawSha256 !== SOURCE_AUTHORITY.rawSha256 || loaded.canonicalSha256 !== SOURCE_AUTHORITY.canonicalSha256) {
    throw new Error("protected source hash drift");
  }
  assertPhaseThreeSourceAuthority(loaded.value);
  return loaded;
}

const PREVIOUS_BLOCK = `const privacy_contract_version = clean(p.privacy_contract_version, 20);
if (privacy_contract_version === '${PREVIOUS_PRIVACY_VERSION}') {
  if (p.age_confirmed !== true) return [{ json: { ...item, _code: 'UNDER_AGE', _message: 'Account onboarding requires age 18 or older.' } }];
  if (p.terms_accepted !== true) return [{ json: { ...item, _code: 'VALIDATION_ERROR', _message: 'Privacy Notice and Terms acceptance required.' } }];
  const email_drops = p.email_drops === true;
  const completed_at = new Date().toISOString();
  const row = { submissionId: item.submissionId, email: item.email, username, display_name, avatar_url: '', bio, skill_level, blasters_owned: blasters_owned.join(', '), accessory_interests: accessory_interests.join(', '), socials_insta: '', socials_yt: '', socials_tiktok: '', birthday: '', is_adult: 'true', shipping_line1: '', shipping_line2: '', shipping_city: '', shipping_region: '', shipping_postal: '', shipping_country: '', email_drops: email_drops ? 'true' : 'false', sms_optin: 'false', completed_at, redeemed_via_token: 'true', ip: item.ip, userAgent: item.userAgent, phase2_completed_at: phase2RedeemedAt, age_confirmed: 'true', terms_accepted: 'true', privacy_contract_version };
  return [{ json: { ...item, _row: row, age_confirmed: true, terms_accepted: true, privacy_contract_version } }];
}
`;

const CURRENT_BLOCK = `const privacy_contract_version = p.privacy_contract_version === undefined ? '' : p.privacy_contract_version;
const privacy_contract_class = (${classifyPrivacyContractVersion.toString()})(p.privacy_contract_version);
if (privacy_contract_class === 'consent') {
  if (p.age_confirmed !== true) return [{ json: { ...item, _code: 'UNDER_AGE', _message: 'Account onboarding requires age 14 or older.' } }];
  if (p.terms_accepted !== true) return [{ json: { ...item, _code: 'VALIDATION_ERROR', _message: 'Privacy Notice and Terms acceptance required.' } }];
  const email_drops = p.email_drops === true;
  const completed_at = new Date().toISOString();
  const row = { submissionId: item.submissionId, email: item.email, username, display_name, avatar_url: '', bio, skill_level, blasters_owned: blasters_owned.join(', '), accessory_interests: accessory_interests.join(', '), socials_insta: '', socials_yt: '', socials_tiktok: '', birthday: '', is_adult: '', shipping_line1: '', shipping_line2: '', shipping_city: '', shipping_region: '', shipping_postal: '', shipping_country: '', email_drops: email_drops ? 'true' : 'false', sms_optin: 'false', completed_at, redeemed_via_token: 'true', ip: item.ip, userAgent: item.userAgent, phase2_completed_at: phase2RedeemedAt, age_confirmed: 'true', terms_accepted: 'true', privacy_contract_version };
  return [{ json: { ...item, _row: row, age_confirmed: true, terms_accepted: true, privacy_contract_version } }];
}
if (privacy_contract_class === 'unsupported') return [{ json: { ...item, _code: 'VALIDATION_ERROR', _message: 'Unsupported privacy contract version.' } }];
`;

const PREVIOUS_AUDIT_CODE = `const item = $('Validate + Compose Row').first().json;
const row = item._row;
const privacyV2 = row.privacy_contract_version === '${PREVIOUS_PRIVACY_VERSION}';
return [{ json: { timestamp: new Date().toISOString(), event_type: 'PHASE_THREE_PROFILE_SAVED', source: 'pkc-phase-three-save', workspace_slug: 'pkc-phase-three-save', action: 'profile_persist', status: 'committed', request_id: item.request_id, details_json: JSON.stringify({ submissionId: row.submissionId, email: row.email, username: row.username, is_adult: row.is_adult === 'true', privacy_contract_version: row.privacy_contract_version || 'legacy', age_confirmed: privacyV2, terms_accepted: privacyV2, marketing_opt_in: row.email_drops === 'true', deferred_fields_collected: !privacyV2 }) } }];`;

const CURRENT_AUDIT_CODE = `const item = $('Validate + Compose Row').first().json;
const row = item._row;
const consentContract = row.privacy_contract_version === '${PREVIOUS_PRIVACY_VERSION}' || row.privacy_contract_version === '${PRIVACY_VERSION}';
return [{ json: { timestamp: new Date().toISOString(), event_type: 'PHASE_THREE_PROFILE_SAVED', source: 'pkc-phase-three-save', workspace_slug: 'pkc-phase-three-save', action: 'profile_persist', status: 'committed', request_id: item.request_id, details_json: JSON.stringify({ submissionId: row.submissionId, email: row.email, username: row.username, privacy_contract_version: row.privacy_contract_version || 'legacy', minimum_age_confirmed: consentContract, minimum_age: consentContract ? 14 : null, adult_status: consentContract ? 'not_collected' : (row.is_adult === 'true' ? 'adult' : 'minor_or_unknown'), terms_accepted: consentContract, marketing_opt_in: row.email_drops === 'true', deferred_fields_collected: !consentContract }) } }];`;

const PREVIOUS_RESPONSE = "return respond(true, 'SUCCESS', persisted ? 'Profile committed.' : 'Test mode: profile not persisted.', { submissionId: row.submissionId, username: row.username, completed_at: row.completed_at, is_adult: row.is_adult === 'true', persisted, activation_proof, activation_expires_at: new Date(expires_at_ms).toISOString() });";
const CURRENT_RESPONSE = "return respond(true, 'SUCCESS', persisted ? 'Profile committed.' : 'Test mode: profile not persisted.', { submissionId: row.submissionId, username: row.username, completed_at: row.completed_at, minimum_age_confirmed: row.age_confirmed === 'true', minimum_age: 14, persisted, activation_proof, activation_expires_at: new Date(expires_at_ms).toISOString() });";

function replaceExactly(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first < 0 || source.indexOf(oldValue, first + 1) >= 0) throw new Error(`unexpected ${label} source`);
  return source.replace(oldValue, newValue);
}

export function patchLaunchPrivacyWorkflow(input) {
  assertPhaseThreeSourceAuthority(input);
  const workflow = structuredClone(input);
  const validate = codeNode(workflow, "Validate + Compose Row");
  const audit = codeNode(workflow, "Compose Event");
  const response = codeNode(workflow, "Build Response");

  validate.parameters.jsCode = replaceExactly(validate.parameters.jsCode, PREVIOUS_BLOCK, CURRENT_BLOCK, "privacy validation");
  if (audit.parameters.jsCode !== PREVIOUS_AUDIT_CODE) throw new Error("unexpected audit source");
  audit.parameters.jsCode = CURRENT_AUDIT_CODE;
  response.parameters.jsCode = replaceExactly(response.parameters.jsCode, "const API_VERSION = '1.0.0';", "const API_VERSION = '1.1.0';", "API version");
  response.parameters.jsCode = replaceExactly(response.parameters.jsCode, PREVIOUS_RESPONSE, CURRENT_RESPONSE, "success response");
  workflow.active = false;
  return workflow;
}

const SERVER_METADATA_KEYS = Object.freeze([
  "id", "versionId", "createdAt", "updatedAt", "activeVersion", "activeVersionId",
  "versionCounter", "shared", "tags", "triggerCount", "meta", "pinData", "staticData",
]);

function sanitizeCredentialReferences(node) {
  if (node.credentials === undefined) return;
  if (!node.credentials || typeof node.credentials !== "object" || Array.isArray(node.credentials)) {
    throw new Error("malformed source credential reference");
  }
  node.credentials = Object.fromEntries(Object.entries(node.credentials).map(([type, reference]) => {
    if (!type || !reference || typeof reference !== "object" || Array.isArray(reference)
        || typeof reference.name !== "string" || reference.name.length === 0) {
      throw new Error("source credential type and name required");
    }
    return [type, { name: reference.name }];
  }));
}

export function derivePhaseThree14PlusCandidate(input) {
  const workflow = patchLaunchPrivacyWorkflow(input);
  const post = workflow.nodes.find((node) => node.name === "Webhook POST");
  const options = workflow.nodes.find((node) => node.name === "Webhook OPTIONS");
  if (post?.type !== "n8n-nodes-base.webhook" || post.parameters?.httpMethod !== "POST"
      || post.parameters?.path !== "pkc-phase-three/save"
      || options?.type !== "n8n-nodes-base.webhook" || options.parameters?.httpMethod !== "OPTIONS"
      || options.parameters?.path !== "pkc-phase-three/save") {
    throw new Error("source authority drift: webhook routes");
  }
  post.parameters.path = CANDIDATE_PATH;
  options.parameters.path = CANDIDATE_PATH;
  for (const node of workflow.nodes) {
    delete node.id;
    delete node.webhookId;
    sanitizeCredentialReferences(node);
  }
  for (const key of SERVER_METADATA_KEYS) delete workflow[key];
  workflow.name = CANDIDATE_NAME;
  workflow.active = false;
  workflow.settings = { ...(workflow.settings || {}), availableInMCP: false };
  return {
    name: workflow.name,
    active: false,
    settings: workflow.settings,
    nodes: workflow.nodes,
    connections: workflow.connections,
  };
}
