import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  parseBoundedJson,
  readJsonDescriptorSafe,
} from "./n8n-workflows.mjs";

export { parseBoundedJson, readJsonDescriptorSafe };

export const SOURCE_AUTHORITY = Object.freeze({
  path: "/root/.hermes/protected/pkc-phase-one/source-workflows/RjsC9WMIDrIisJbl.json",
  directory: "/root/.hermes/protected/pkc-phase-one/source-workflows",
  id: "RjsC9WMIDrIisJbl",
  name: "PKC — Onboarding Submissions",
  versionId: "1af76ef4-103d-4e6c-8647-224cfd128295",
  updatedAt: "2026-09-26T19:38:49.277Z",
  nodeCount: 16,
  rawSha256: "4ffb8895f97b5cb2a23c8f725b2257d4bdf218424d9c6d1b79b990e0ce7d7667",
  canonicalSha256: "a3ac817737fb4f3a5231c793000f253cce736ff41dabcc9089e8ce215beaa530",
});

export const N8N_IMAGE = Object.freeze({
  version: "2.19.5",
  repoDigest: "sha256:b1b0c592735e24acd3cc64db83f94ef4efd8e331e47c6883249cc51cc1bea16b",
  reference: "n8nio/n8n@sha256:b1b0c592735e24acd3cc64db83f94ef4efd8e331e47c6883249cc51cc1bea16b",
});

export const CANDIDATE_NAME = "PKC — Onboarding Submissions — Consent Persistence Candidate v1";
export const CANDIDATE_ID = "pkcConsentCandV1";
export const CANDIDATE_PATH = "pkc-onboarding-consent-v1";
export const CONSENT_KEYS = Object.freeze([
  "minimumAgeConfirmed",
  "termsAccepted",
  "privacyAcknowledged",
  "policyVersion",
]);
export const INPUT_KEYS = Object.freeze([
  "version",
  "submissionId",
  "firstName",
  "lastName",
  "email",
  ...CONSENT_KEYS,
  "hash",
]);

const SOURCE_NODE_TYPES = Object.freeze([
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.if",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.code",
  "n8n-nodes-base.respondToWebhook",
  "n8n-nodes-base.gmail",
  "n8n-nodes-base.googleSheets",
]);

const METADATA_KEYS = Object.freeze([
  "id", "versionId", "createdAt", "updatedAt", "activeVersion", "activeVersionId",
  "versionCounter", "shared", "tags", "triggerCount", "meta", "pinData", "staticData",
]);

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, stableValue(value[key])]));
}

export function serializeDeterministic(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function semanticHash(value) {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

function assertSourceAuthority(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source authority drift: workflow object required");
  const identityMatches = source.id === SOURCE_AUTHORITY.id
    && source.name === SOURCE_AUTHORITY.name
    && source.versionId === SOURCE_AUTHORITY.versionId
    && source.updatedAt === SOURCE_AUTHORITY.updatedAt
    && Array.isArray(source.nodes)
    && source.nodes.length === SOURCE_AUTHORITY.nodeCount;
  if (!identityMatches || semanticHash(source) !== SOURCE_AUTHORITY.canonicalSha256) throw new Error("source authority drift");
  if (SOURCE_NODE_TYPES.some((type, index) => source.nodes[index]?.type !== type)) throw new Error("source authority drift: topology");
}

export function loadBoundSourceWorkflow() {
  const directoryStat = fs.statSync(SOURCE_AUTHORITY.directory, { bigint: true });
  if (!directoryStat.isDirectory() || Number(directoryStat.mode & 0o777n) !== 0o700) throw new Error("protected source directory must be mode 0700");
  if (fs.realpathSync(SOURCE_AUTHORITY.directory) !== SOURCE_AUTHORITY.directory) throw new Error("protected source directory ancestry drift");
  if (path.resolve(SOURCE_AUTHORITY.path) !== SOURCE_AUTHORITY.path) throw new Error("protected source path drift");
  const loaded = readJsonDescriptorSafe(SOURCE_AUTHORITY.path, { protectedInput: true });
  if (loaded.rawSha256 !== SOURCE_AUTHORITY.rawSha256 || loaded.canonicalSha256 !== SOURCE_AUTHORITY.canonicalSha256) throw new Error("protected source hash drift");
  assertSourceAuthority(loaded.value);
  return loaded;
}

function sanitizeCredentialReferences(node) {
  if (node.credentials === undefined) return;
  if (!node.credentials || typeof node.credentials !== "object" || Array.isArray(node.credentials)) throw new Error("malformed source credential reference");
  node.credentials = Object.fromEntries(Object.entries(node.credentials).map(([type, reference]) => {
    if (!type || !reference || typeof reference !== "object" || Array.isArray(reference)
      || typeof reference.name !== "string" || reference.name.length === 0) {
      throw new Error("source credential type and name required");
    }
    return [type, { name: reference.name }];
  }));
}

function edge(node) {
  return { node, type: "main", index: 0 };
}

const CONSENT_VALIDATION = `{
const __pkcBody=$input.first()?.json?.body;
const __pkcAllowed=${JSON.stringify([...INPUT_KEYS].sort())};
if(!__pkcBody||typeof __pkcBody!=='object'||Array.isArray(__pkcBody))throw new Error('pkc_consent_schema_invalid');
if(JSON.stringify(Object.keys(__pkcBody).sort())!==JSON.stringify(__pkcAllowed))throw new Error('pkc_consent_schema_invalid');
if(__pkcBody.minimumAgeConfirmed!==true||__pkcBody.termsAccepted!==true||__pkcBody.privacyAcknowledged!==true||__pkcBody.policyVersion!=='pkc-onboarding-14-plus-v1')throw new Error('pkc_consent_value_invalid');
}
`;

function mappedExpression(key) {
  return `={{ $json.${key} }}`;
}

export function deriveConsentPersistenceCandidate(source) {
  assertSourceAuthority(source);
  const workflow = structuredClone(source);
  const [webhook, intake, , , validation, , , , enrich, , , , , , gmail, sheets] = workflow.nodes;
  if (typeof intake.parameters?.jsCode !== "string"
      || typeof validation.parameters?.jsCode !== "string"
      || typeof enrich.parameters?.jsCode !== "string"
      || !enrich.parameters.jsCode.includes("createHash('sha256')")
      || !enrich.parameters.jsCode.includes("hashOk")) {
    throw new Error("source authority drift: consent transform targets");
  }

  webhook.parameters.path = CANDIDATE_PATH;
  intake.parameters.jsCode = `${CONSENT_VALIDATION}${intake.parameters.jsCode}`;

  gmail.retryOnFail = true;
  gmail.maxTries = 2;
  gmail.waitBetweenTries = 1000;

  sheets.parameters.columns = {
    ...sheets.parameters.columns,
    mappingMode: "defineBelow",
    value: Object.fromEntries(INPUT_KEYS.map((key) => [key, mappedExpression(key)])),
  };
  delete sheets.retryOnFail;
  delete sheets.maxTries;
  delete sheets.waitBetweenTries;
  delete sheets.continueOnFail;
  sheets.onError = "continueErrorOutput";

  const failureReleaseName = "Release Failed Persistence Lock";
  const failureCodeName = "Build Privacy-Minimized Persistence Failure";
  const failureResponseName = "Respond Persistence Unavailable";
  const duplicateCodeName = "Build Submission In Progress";
  const duplicateResponseName = "Respond Submission In Progress";
  workflow.nodes.push({
    name: failureReleaseName,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [sheets.position?.[0] ?? 0, (sheets.position?.[1] ?? 0) + 240],
    parameters: {
      language: "javaScript",
      jsCode: "const source=$('Enrich').first()?.json||{};const submissionId=String(source.submissionId||'');const owner=String(source?._meta?.lockOwner||'');const data=$getWorkflowStaticData('global');const current=data.locks&&typeof data.locks==='object'?data.locks[submissionId]:null;const owned=Boolean(submissionId&&owner&&current&&typeof current==='object'&&current.owner===owner);if(owned)delete data.locks[submissionId];return [{json:{lockReleased:owned}}];",
    },
  }, {
    name: failureCodeName,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [(sheets.position?.[0] ?? 0) + 240, (sheets.position?.[1] ?? 0) + 240],
    parameters: {
      language: "javaScript",
      jsCode: "return [{json:{ok:false,persisted:false,duplicate:false,error:'persistence_unavailable'}}];",
    },
  }, {
    name: failureResponseName,
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    position: [(sheets.position?.[0] ?? 0) + 480, (sheets.position?.[1] ?? 0) + 240],
    parameters: {
      respondWith: "json",
      responseBody: "={{ { ok: false, persisted: false, duplicate: false, error: 'persistence_unavailable' } }}",
      options: { responseCode: 503 },
    },
  }, {
    name: duplicateCodeName,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [(sheets.position?.[0] ?? 0) - 480, (sheets.position?.[1] ?? 0) + 240],
    parameters: {
      language: "javaScript",
      jsCode: "return [{json:{ok:false,persisted:false,duplicate:true,error:'submission_in_progress'}}];",
    },
  }, {
    name: duplicateResponseName,
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    position: [(sheets.position?.[0] ?? 0) - 240, (sheets.position?.[1] ?? 0) + 240],
    parameters: {
      respondWith: "json",
      responseBody: "={{ { ok: false, persisted: false, duplicate: true, error: 'submission_in_progress' } }}",
      options: { responseCode: 409 },
    },
  });
  const originalSheetOutputs = workflow.connections?.[sheets.name]?.main;
  if (!Array.isArray(originalSheetOutputs) || originalSheetOutputs.length !== 1 || !Array.isArray(originalSheetOutputs[0])) throw new Error("source authority drift: Sheets output topology");
  const duplicateOutputs = workflow.connections?.["IF Lock Dup"]?.main;
  if (!Array.isArray(duplicateOutputs) || duplicateOutputs.length !== 2 || !Array.isArray(duplicateOutputs[0]) || !Array.isArray(duplicateOutputs[1])) throw new Error("source authority drift: duplicate output topology");
  workflow.connections[sheets.name] = { main: [structuredClone(originalSheetOutputs[0]), [edge(failureReleaseName)]] };
  workflow.connections[failureReleaseName] = { main: [[edge(failureCodeName)]] };
  workflow.connections[failureCodeName] = { main: [[edge(failureResponseName)]] };
  workflow.connections["IF Lock Dup"] = { main: [[edge(duplicateCodeName)], structuredClone(duplicateOutputs[1])] };
  workflow.connections[duplicateCodeName] = { main: [[edge(duplicateResponseName)]] };

  for (const node of workflow.nodes) {
    delete node.id;
    delete node.webhookId;
    sanitizeCredentialReferences(node);
  }
  for (const key of METADATA_KEYS) delete workflow[key];
  workflow.name = CANDIDATE_NAME;
  workflow.id = CANDIDATE_ID;
  workflow.active = false;
  workflow.settings = {
    ...(workflow.settings || {}),
    availableInMCP: false,
    executionTimeout: 40,
    saveDataErrorExecution: "none",
    saveDataSuccessExecution: "none",
    saveExecutionProgress: false,
    saveManualExecutions: false,
  };

  return {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
    settings: workflow.settings,
    nodes: workflow.nodes,
    connections: workflow.connections,
  };
}

export function buildCandidatePackage(source) {
  const workflow = deriveConsentPersistenceCandidate(source);
  const workflowBytes = serializeDeterministic(workflow);
  const manifest = {
    schema: "pkc-n8n-phase-one-consent-persistence-candidate-v1",
    n8n: N8N_IMAGE,
    source: {
      id: SOURCE_AUTHORITY.id,
      versionId: SOURCE_AUTHORITY.versionId,
      updatedAt: SOURCE_AUTHORITY.updatedAt,
      nodeCount: SOURCE_AUTHORITY.nodeCount,
      rawSha256: SOURCE_AUTHORITY.rawSha256,
      semanticSha256: SOURCE_AUTHORITY.canonicalSha256,
    },
    candidate: {
      id: CANDIDATE_ID,
      name: CANDIDATE_NAME,
      webhookPath: CANDIDATE_PATH,
      active: false,
      availableInMCP: false,
      nodeCount: workflow.nodes.length,
      rawSha256: sha256(Buffer.from(workflowBytes, "utf8")),
      semanticSha256: semanticHash(workflow),
    },
  };
  return Object.freeze({ workflow, workflowBytes, manifest: stableValue(manifest), manifestBytes: serializeDeterministic(manifest) });
}

function writeExclusive(file, bytes) {
  fs.writeFileSync(file, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function writeCandidatePackage(outputDirectory) {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) throw new Error("user-supplied output path required");
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(output)) throw new Error("output directory must not already exist");
  const loaded = loadBoundSourceWorkflow();
  const candidatePackage = buildCandidatePackage(loaded.value);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  try {
    writeExclusive(path.join(output, "workflow.json"), candidatePackage.workflowBytes);
    writeExclusive(path.join(output, "manifest.json"), candidatePackage.manifestBytes);
    const workflowReadback = fs.readFileSync(path.join(output, "workflow.json"));
    if (sha256(workflowReadback) !== candidatePackage.manifest.candidate.rawSha256) throw new Error("candidate readback hash mismatch");
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    outputDirectory: output,
    artifactCount: 2,
    workflowRawSha256: candidatePackage.manifest.candidate.rawSha256,
    workflowSemanticSha256: candidatePackage.manifest.candidate.semanticSha256,
  });
}
