import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseBoundedJson, readJsonDescriptorSafe } from "./n8n-workflows.mjs";

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
export const CANDIDATE_NAME = "PKC — Onboarding Submissions — Durable Email Outbox Candidate v3";
export const CANDIDATE_ID = "pkcDurableEmailOutboxCandV3";
export const CANDIDATE_PATH = "pkc-onboarding-durable-email-v3";
export const GMAIL_CREDENTIAL_NAME = "PKC Gmail — projectkidcreations@gmail.com";
export const POSTGRES_RUNTIME_CREDENTIAL_NAME = "PKC Onboarding Runtime";
export const CONSENT_KEYS = Object.freeze(["minimumAgeConfirmed", "termsAccepted", "privacyAcknowledged", "policyVersion"]);
export const INPUT_KEYS = Object.freeze(["version", "submissionId", "firstName", "lastName", "email", ...CONSENT_KEYS, "hash"]);

const SOURCE_NODE_TYPES = Object.freeze([
  "n8n-nodes-base.webhook", "n8n-nodes-base.code", "n8n-nodes-base.code", "n8n-nodes-base.code",
  "n8n-nodes-base.code", "n8n-nodes-base.code", "n8n-nodes-base.if", "n8n-nodes-base.code",
  "n8n-nodes-base.code", "n8n-nodes-base.code", "n8n-nodes-base.code", "n8n-nodes-base.code",
  "n8n-nodes-base.code", "n8n-nodes-base.respondToWebhook", "n8n-nodes-base.gmail", "n8n-nodes-base.googleSheets",
]);
const METADATA_KEYS = Object.freeze(["id", "versionId", "createdAt", "updatedAt", "activeVersion", "activeVersionId", "versionCounter", "shared", "tags", "triggerCount", "meta", "pinData", "staticData"]);
const RETENTION = Object.freeze({ availableInMCP: false, executionTimeout: 40, saveDataErrorExecution: "none", saveDataSuccessExecution: "none", saveExecutionProgress: false, saveManualExecutions: false });
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableValue = (value) => Array.isArray(value) ? value.map(stableValue) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, stableValue(value[key])])) : value;
export const serializeDeterministic = (value) => `${JSON.stringify(stableValue(value), null, 2)}\n`;
export const semanticHash = (value) => sha256(Buffer.from(canonical(value), "utf8"));

function assertSourceAuthority(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source authority drift: workflow object required");
  if (source.id !== SOURCE_AUTHORITY.id || source.name !== SOURCE_AUTHORITY.name || source.versionId !== SOURCE_AUTHORITY.versionId
      || source.updatedAt !== SOURCE_AUTHORITY.updatedAt || source.nodes?.length !== SOURCE_AUTHORITY.nodeCount
      || semanticHash(source) !== SOURCE_AUTHORITY.canonicalSha256
      || SOURCE_NODE_TYPES.some((type, index) => source.nodes[index]?.type !== type)) throw new Error("source authority drift");
}

export function loadBoundSourceWorkflow() {
  const directoryStat = fs.statSync(SOURCE_AUTHORITY.directory, { bigint: true });
  if (!directoryStat.isDirectory() || Number(directoryStat.mode & 0o777n) !== 0o700) throw new Error("protected source directory must be mode 0700");
  if (fs.realpathSync(SOURCE_AUTHORITY.directory) !== SOURCE_AUTHORITY.directory) throw new Error("protected source directory ancestry drift");
  const loaded = readJsonDescriptorSafe(SOURCE_AUTHORITY.path, { protectedInput: true });
  if (loaded.rawSha256 !== SOURCE_AUTHORITY.rawSha256 || loaded.canonicalSha256 !== SOURCE_AUTHORITY.canonicalSha256) throw new Error("protected source hash drift");
  assertSourceAuthority(loaded.value);
  return loaded;
}

function sanitizeCredentialReferences(node) {
  if (node.credentials === undefined) return;
  node.credentials = Object.fromEntries(Object.entries(node.credentials).map(([type, reference]) => {
    if (!type || typeof reference?.name !== "string" || !reference.name) throw new Error("source credential type and name required");
    return [type, { name: reference.name }];
  }));
}
const edge = (node) => ({ node, type: "main", index: 0 });
const mappedExpression = (key) => `={{ $('Enrich').first().json.${key} }}`;
const postgresNode = (name, query, replacements, position) => ({
  name, type: "n8n-nodes-base.postgres", typeVersion: 2.6, position,
  credentials: { postgres: { name: POSTGRES_RUNTIME_CREDENTIAL_NAME } },
  parameters: { operation: "executeQuery", query, options: { queryBatching: "single", queryReplacement: replacements } },
});
const CONSENT_VALIDATION = `const __pkcBody=$input.first()?.json?.body;const __pkcAllowed=${JSON.stringify([...INPUT_KEYS].sort())};if(!__pkcBody||typeof __pkcBody!=='object'||Array.isArray(__pkcBody)||JSON.stringify(Object.keys(__pkcBody).sort())!==JSON.stringify(__pkcAllowed))throw new Error('pkc_consent_schema_invalid');if(__pkcBody.minimumAgeConfirmed!==true||__pkcBody.termsAccepted!==true||__pkcBody.privacyAcknowledged!==true||__pkcBody.policyVersion!=='pkc-onboarding-14-plus-v1')throw new Error('pkc_consent_value_invalid');\n`;

export function deriveConsentPersistenceCandidate(source) {
  assertSourceAuthority(source);
  const keep = ["Webhook", "Size Check", "Auth Check", "Circuit Check", "Schema Validate", "Hash Verify", "Enrich", "Sheets Append", "Aggregate", "Response Builder", "Respond Webhook"];
  const byName = new Map(source.nodes.map((node) => [node.name, structuredClone(node)]));
  const nodes = keep.map((name) => byName.get(name));
  if (nodes.some((node) => !node)) throw new Error("source authority drift: required node missing");
  const webhook = byName.get("Webhook");
  const size = byName.get("Size Check");
  const sheets = byName.get("Sheets Append");
  const auth = byName.get("Auth Check");
  const circuit = byName.get("Circuit Check");
  const enrich = byName.get("Enrich");
  const aggregate = byName.get("Aggregate");
  const response = byName.get("Response Builder");
  webhook.parameters.path = CANDIDATE_PATH;
  size.parameters.jsCode = `${CONSENT_VALIDATION}${size.parameters.jsCode}`;
  auth.parameters.jsCode = "const item=$input.first().json;const expected=$env.PKC_AUTH_KEY;const got=item.headers?.['x-pkc-key'];if(!got||got!==expected)throw new Error('AUTH_INVALID_KEY: 401');item._meta={...(item._meta||{}),stage:'auth_check',execution:{id:$execution?.id||null,workflow:$workflow?.id||null}};return [{json:item}];";
  circuit.parameters.jsCode = "const item=$input.first().json;item._meta={...(item._meta||{}),stage:'circuit_check'};return [{json:item}];";
  const digestCode = "const crypto=require('node:crypto');const requestProjection={version:item.version,submissionId:item.submissionId,firstName:item.firstName,lastName:item.lastName,email:item.email,minimumAgeConfirmed:item.minimumAgeConfirmed,termsAccepted:item.termsAccepted,privacyAcknowledged:item.privacyAcknowledged,policyVersion:item.policyVersion};item._meta.serverRequestDigest=crypto.createHash('sha256').update(JSON.stringify(requestProjection)).digest('hex');item._meta.persistenceWorkerId=crypto.randomUUID();";
  if (!enrich.parameters.jsCode.includes("return [{ json: item }];")) throw new Error("source authority drift: Enrich return marker");
  enrich.parameters.jsCode = enrich.parameters.jsCode.replace("return [{ json: item }];", `${digestCode}\nreturn [{ json: item }];`);
  sheets.parameters.columns = { ...sheets.parameters.columns, mappingMode: "defineBelow", value: Object.fromEntries(INPUT_KEYS.map((key) => [key, mappedExpression(key)])) };
  delete sheets.retryOnFail; delete sheets.maxTries; delete sheets.waitBetweenTries; delete sheets.continueOnFail;
  sheets.onError = "continueErrorOutput";
  aggregate.parameters.jsCode = "const item=structuredClone($('Enrich').first().json);item._meta={...(item._meta||{}),sheetStatus:'written',emailStatus:'queued',stage_completed:'sheets'};return [{json:item}];";
  response.parameters.jsCode = "const item=$input.first().json;const m=item._meta||{};return [{json:{ok:true,persisted:true,submissionId:m.correlationId||item.submissionId||null,correlationId:m.correlationId||item.submissionId||null,email:'queued',sheet:'written',duplicate:m.duplicate===true,stage:'sheets'}}];";
  const claim = postgresNode("Claim Submission + Block Email", "SELECT * FROM pkc_auth.claim_onboarding_submission($1::text,pg_catalog.decode($2::text,'hex'),$3::text,$4::uuid);", ["={{ $('Enrich').first().json.submissionId }}", "={{ $('Enrich').first().json._meta.serverRequestDigest }}", "={{ $('Enrich').first().json.email }}", "={{ $('Enrich').first().json._meta.persistenceWorkerId }}"], [2448, 400]);
  const needsSheets = { name: "Needs Sheets Persistence", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [2640, 400], parameters: { conditions: { options: { caseSensitive: true, typeValidation: "strict", version: 2 }, combinator: "and", conditions: [{ leftValue: "={{ $json.claim_state }}", rightValue: "claimed", operator: { type: "string", operation: "equals" } }] }, options: {} } };
  const lookupSheet = structuredClone(sheets);
  lookupSheet.name = "Lookup Existing Sheet Submission";
  lookupSheet.position = [2864, 400];
  lookupSheet.alwaysOutputData = true;
  lookupSheet.parameters = {
    operation: "read",
    documentId: structuredClone(sheets.parameters.documentId),
    sheetName: structuredClone(sheets.parameters.sheetName),
    filtersUI: { values: [{ lookupColumn: "submissionId", lookupValue: "={{ $('Enrich').first().json.submissionId }}" }] },
    combineFilters: "AND",
    options: { returnFirstMatch: false },
  };
  delete lookupSheet.onError; delete lookupSheet.continueOnFail; delete lookupSheet.retryOnFail;
  const classifySheet = { name: "Classify Existing Sheet Submission", type: "n8n-nodes-base.code", typeVersion: 2, position: [3088, 400], parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: `const source=$('Enrich').first().json;const rows=$input.all().map(({json})=>json).filter((row)=>row&&Object.prototype.hasOwnProperty.call(row,'submissionId'));if(rows.length>1)throw new Error('sheet_submission_cardinality_invalid');if(rows.length===0)return [{json:{exact:false}}];const row=rows[0];const keys=${JSON.stringify(INPUT_KEYS)};const same=keys.every((key)=>{const expected=source[key];const actual=row[key];if(typeof expected==='boolean')return String(actual).toLowerCase()===String(expected);return String(actual??'')===String(expected??'');});if(!same)throw new Error('sheet_submission_mismatch');return [{json:{exact:true}}];` } };
  const existingExact = { name: "Existing Sheet Row Is Exact", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [3312, 400], parameters: { conditions: { options: { caseSensitive: true, typeValidation: "strict", version: 2 }, combinator: "and", conditions: [{ leftValue: "={{ $json.exact }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} } };
  sheets.position = [3536, 520];
  const release = postgresNode("Release Email After Sheets Persistence", "SELECT * FROM pkc_auth.mark_onboarding_submission_persisted($1::text,pg_catalog.decode($2::text,'hex'),$3::uuid,$4::bigint);", ["={{ $('Enrich').first().json.submissionId }}", "={{ $('Enrich').first().json._meta.serverRequestDigest }}", "={{ $('Enrich').first().json._meta.persistenceWorkerId }}", "={{ $('Claim Submission + Block Email').first().json.persistence_fence }}"], [3760, 400]);
  const alreadyPersisted = { name: "Submission Already Persisted", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [2864, 600], parameters: { conditions: { options: { caseSensitive: true, typeValidation: "strict", version: 2 }, combinator: "and", conditions: [{ leftValue: "={{ $json.claim_state }}", rightValue: "persisted", operator: { type: "string", operation: "equals" } }] }, options: {} } };
  const duplicate = { name: "Build Already Persisted Response", type: "n8n-nodes-base.code", typeVersion: 2, position: [2880, 600], parameters: { language: "javaScript", jsCode: "const item=structuredClone($('Enrich').first().json);item._meta={...(item._meta||{}),sheetStatus:'written',emailStatus:'queued',stage_completed:'sheets',duplicate:true};return [{json:item}];" } };
  const failed = { name: "Build Persistence Failure", type: "n8n-nodes-base.code", typeVersion: 2, position: [3104, 600], parameters: { language: "javaScript", jsCode: "return [{json:{ok:false,persisted:false,duplicate:false,error:'persistence_unavailable'}}];" } };
  const failedResponse = { name: "Respond Persistence Unavailable", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [3328, 600], parameters: { respondWith: "json", responseBody: "={{ { ok:false,persisted:false,duplicate:false,error:'persistence_unavailable' } }}", options: { responseCode: 503 } } };
  nodes.push(claim, needsSheets, lookupSheet, classifySheet, existingExact, release, alreadyPersisted, duplicate, failed, failedResponse);
  for (const node of nodes) { delete node.id; delete node.webhookId; sanitizeCredentialReferences(node); }
  const connections = {
    Webhook: { main: [[edge("Size Check")]] }, "Size Check": { main: [[edge("Auth Check")]] }, "Auth Check": { main: [[edge("Circuit Check")]] },
    "Circuit Check": { main: [[edge("Schema Validate")]] }, "Schema Validate": { main: [[edge("Hash Verify")]] }, "Hash Verify": { main: [[edge("Enrich")]] },
    Enrich: { main: [[edge(claim.name)]] }, [claim.name]: { main: [[edge(needsSheets.name)]] },
    [needsSheets.name]: { main: [[edge(lookupSheet.name)], [edge(alreadyPersisted.name)]] },
    [lookupSheet.name]: { main: [[edge(classifySheet.name)]] }, [classifySheet.name]: { main: [[edge(existingExact.name)]] },
    [existingExact.name]: { main: [[edge(release.name)], [edge(sheets.name)]] },
    [sheets.name]: { main: [[edge(release.name)], [edge(failed.name)]] }, [release.name]: { main: [[edge(aggregate.name)]] },
    [alreadyPersisted.name]: { main: [[edge(duplicate.name)], [edge(failed.name)]] },
    [duplicate.name]: { main: [[edge(aggregate.name)]] }, [failed.name]: { main: [[edge(failedResponse.name)]] },
    [aggregate.name]: { main: [[edge(response.name)]] }, [response.name]: { main: [[edge("Respond Webhook")]] },
  };
  return { id: CANDIDATE_ID, name: CANDIDATE_NAME, active: false, settings: { ...(source.settings || {}), ...RETENTION }, nodes, connections };
}

export function buildCandidatePackage(source) {
  const workflow = deriveConsentPersistenceCandidate(source);
  const workflowBytes = serializeDeterministic(workflow);
  const manifest = { schema: "pkc-n8n-phase-one-durable-email-outbox-candidate-v3", n8n: N8N_IMAGE, source: { id: SOURCE_AUTHORITY.id, versionId: SOURCE_AUTHORITY.versionId, updatedAt: SOURCE_AUTHORITY.updatedAt, nodeCount: SOURCE_AUTHORITY.nodeCount, rawSha256: SOURCE_AUTHORITY.rawSha256, semanticSha256: SOURCE_AUTHORITY.canonicalSha256 }, candidate: { id: CANDIDATE_ID, name: CANDIDATE_NAME, webhookPath: CANDIDATE_PATH, active: false, availableInMCP: false, nodeCount: workflow.nodes.length, rawSha256: sha256(Buffer.from(workflowBytes, "utf8")), semanticSha256: semanticHash(workflow) } };
  return Object.freeze({ workflow, workflowBytes, manifest: stableValue(manifest), manifestBytes: serializeDeterministic(manifest) });
}
function writeExclusive(file, bytes) { fs.writeFileSync(file, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 }); fs.chmodSync(file, 0o600); }
export function writeCandidatePackage(outputDirectory) {
  if (typeof outputDirectory !== "string" || !outputDirectory) throw new Error("user-supplied output path required");
  const output = path.resolve(outputDirectory); if (fs.existsSync(output)) throw new Error("output directory must not already exist");
  const candidatePackage = buildCandidatePackage(loadBoundSourceWorkflow().value); fs.mkdirSync(output, { mode: 0o700 });
  try { writeExclusive(path.join(output, "workflow.json"), candidatePackage.workflowBytes); writeExclusive(path.join(output, "manifest.json"), candidatePackage.manifestBytes); if (sha256(fs.readFileSync(path.join(output, "workflow.json"))) !== candidatePackage.manifest.candidate.rawSha256) throw new Error("candidate readback hash mismatch"); }
  catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  return Object.freeze({ outputDirectory: output, artifactCount: 2, workflowRawSha256: candidatePackage.manifest.candidate.rawSha256, workflowSemanticSha256: candidatePackage.manifest.candidate.semanticSha256 });
}
