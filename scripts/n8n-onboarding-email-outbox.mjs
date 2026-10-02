import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { N8N_IMAGE } from "./n8n-phase-one-persistence.mjs";

const RETENTION = Object.freeze({
  availableInMCP: false,
  executionOrder: "v1",
  executionTimeout: 40,
  saveDataErrorExecution: "none",
  saveDataSuccessExecution: "none",
  saveExecutionProgress: false,
  saveManualExecutions: false,
});
const DISPATCHER_CREDENTIAL = Object.freeze({ postgres: { name: "PKC Onboarding Email Dispatcher" } });
const RECONCILER_CREDENTIAL = Object.freeze({ postgres: { name: "PKC Onboarding Email Reconciler" } });
const GMAIL_CREDENTIAL = Object.freeze({ googleOAuth2Api: { name: "PKC Gmail — projectkidcreations@gmail.com" } });
const edge = (node) => ({ node, type: "main", index: 0 });
const schedule = (name, seconds) => ({ name, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.3, position: [0, 0], parameters: { rule: { interval: [{ field: "seconds", secondsInterval: seconds }] } } });
const code = (name, jsCode) => ({ name, type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { language: "javaScript", jsCode } });
const postgres = (name, query, queryReplacement, credential) => ({
  name, type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [0, 0], credentials: structuredClone(credential),
  parameters: { operation: "executeQuery", query, options: { queryBatching: "single", queryReplacement } },
});
const gmailRequest = (name, parameters) => ({
  name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [0, 0], credentials: structuredClone(GMAIL_CREDENTIAL),
  parameters: { authentication: "predefinedCredentialType", nodeCredentialType: "googleOAuth2Api", ...parameters },
});
const workerIdentity = (name) => code(name, "const worker_id=String($env.PKC_ONBOARDING_EMAIL_WORKER_ID||'');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(worker_id))throw new Error('invalid_onboarding_email_worker_id');return [{json:{worker_id,batch_size:1}}];");
const route = (name, leftValue, rightValue) => ({ name, type: "n8n-nodes-base.if", typeVersion: 2.2, position: [0, 0], parameters: { conditions: { options: { caseSensitive: true, typeValidation: "strict", version: 2 }, combinator: "and", conditions: [{ leftValue, rightValue, operator: { type: "number", operation: "gt" } }] }, options: {} } });

const BUILD_RAW_REQUEST = `const crypto=require('node:crypto');const max='9223372036854775807';return $input.all().map(({json})=>{const uuid=String(json.outbox_id||'');const fence=json.lease_fence;if(!/^[0-9a-f-]{36}$/.test(uuid)||typeof fence!=='string'||!/^[1-9][0-9]*$/.test(fence)||fence.length>max.length||(fence.length===max.length&&fence>max)||typeof json.recipient_email!=='string'||/[\\r\\n]/.test(json.recipient_email)||typeof json.email_subject!=='string'||/[\\r\\n]/.test(json.email_subject)||typeof json.email_body!=='string')throw new Error('invalid_onboarding_email_claim');const message_id='<pkc-onboarding-'+uuid+'@projectkidcreations.com>';const mime=['To: '+json.recipient_email,'From: projectkidcreations@gmail.com','Subject: '+json.email_subject,'Message-ID: '+message_id,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',json.email_body].join('\\r\\n');const raw=Buffer.from(mime,'utf8').toString('base64url');const request_body=JSON.stringify({raw});const request_sha256=crypto.createHash('sha256').update(Buffer.from(request_body,'utf8')).digest('hex');return {json:{...json,worker_id:$('Dispatcher Worker Identity').first().json.worker_id,message_id,request_body,request_sha256}};});`;
const BUILD_ACCEPTED = "const sent=$input.first()?.json||{};const built=$('Build Exact Raw Gmail Request').first().json;if(typeof sent.id!=='string'||!sent.id)throw new Error('gmail_acceptance_missing_id');return [{json:{...built,provider_message_id:sent.id}}];";

export function buildOnboardingEmailDispatcherWorkflow() {
  const nodes = [
    schedule("Dispatch Schedule", 60), workerIdentity("Dispatcher Worker Identity"),
    postgres("Claim Pending Email", "SELECT * FROM pkc_auth.claim_onboarding_email_outbox($1::uuid,$2::integer);", ["={{ $json.worker_id }}", "={{ $json.batch_size }}"], DISPATCHER_CREDENTIAL),
    code("Build Exact Raw Gmail Request", BUILD_RAW_REQUEST),
    postgres("Arm Exact Gmail Request", "SELECT * FROM pkc_auth.arm_onboarding_email_outbox($1::uuid,$2::uuid,$3::bigint,pg_catalog.decode($4::text,'hex'));", ["={{ $('Build Exact Raw Gmail Request').first().json.outbox_id }}", "={{ $('Build Exact Raw Gmail Request').first().json.worker_id }}", "={{ $('Build Exact Raw Gmail Request').first().json.lease_fence }}", "={{ $('Build Exact Raw Gmail Request').first().json.request_sha256 }}"], DISPATCHER_CREDENTIAL),
    gmailRequest("Send Exact Raw Gmail Request", { method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", sendBody: true, contentType: "raw", rawContentType: "application/json", body: "={{ $('Build Exact Raw Gmail Request').first().json.request_body }}", options: { timeout: 10000, response: { response: { neverError: false, responseFormat: "json" } } } }),
    code("Validate Gmail Acceptance", BUILD_ACCEPTED),
    postgres("Record Gmail API Acceptance", "SELECT * FROM pkc_auth.accept_onboarding_email_outbox($1::uuid,$2::uuid,$3::bigint,pg_catalog.decode($4::text,'hex'),$5::text);", ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.lease_fence }}", "={{ $json.request_sha256 }}", "={{ $json.provider_message_id }}"], DISPATCHER_CREDENTIAL),
    postgres("Mark Gmail API Acceptance Ambiguous", "SELECT * FROM pkc_auth.mark_onboarding_email_ambiguous($1::uuid,$2::uuid,$3::bigint,pg_catalog.decode($4::text,'hex'));", ["={{ $('Build Exact Raw Gmail Request').first().json.outbox_id }}", "={{ $('Build Exact Raw Gmail Request').first().json.worker_id }}", "={{ $('Build Exact Raw Gmail Request').first().json.lease_fence }}", "={{ $('Build Exact Raw Gmail Request').first().json.request_sha256 }}"], DISPATCHER_CREDENTIAL),
  ];
  const send = nodes.find(({ name }) => name === "Send Exact Raw Gmail Request");
  send.onError = "continueErrorOutput";
  return { name: "PKC — Onboarding Email Outbox Dispatcher v1 (Inactive Candidate)", active: false, settings: { ...RETENTION }, nodes, connections: {
    "Dispatch Schedule": { main: [[edge("Dispatcher Worker Identity")]] },
    "Dispatcher Worker Identity": { main: [[edge("Claim Pending Email")]] },
    "Claim Pending Email": { main: [[edge("Build Exact Raw Gmail Request")]] },
    "Build Exact Raw Gmail Request": { main: [[edge("Arm Exact Gmail Request")]] },
    "Arm Exact Gmail Request": { main: [[edge("Send Exact Raw Gmail Request")]] },
    "Send Exact Raw Gmail Request": { main: [[edge("Validate Gmail Acceptance")], [edge("Mark Gmail API Acceptance Ambiguous")]] },
    "Validate Gmail Acceptance": { main: [[edge("Record Gmail API Acceptance")]] },
  } };
}

const BUILD_RECONCILIATION = "const claim=$input.first()?.json||{};const uuid=String(claim.outbox_id||'');if(!/^[0-9a-f-]{36}$/.test(uuid))throw new Error('invalid_onboarding_reconciliation_claim');return [{json:{...claim,worker_id:$('Reconciliation Worker Identity').first().json.worker_id,message_id:'<pkc-onboarding-'+uuid+'@projectkidcreations.com>',gmail_query:'in:sent rfc822msgid:<pkc-onboarding-'+uuid+'@projectkidcreations.com>'}}];";
const BUILD_RECONCILED = "const found=$input.first()?.json||{};const claim=$('Build Gmail Reconciliation Query').first().json;const messages=Array.isArray(found.messages)?found.messages:[];if(messages.length!==1||Object.prototype.hasOwnProperty.call(found,'nextPageToken'))throw new Error('gmail_reconciliation_cardinality_invalid');const id=messages[0]?.id;if(typeof id!=='string'||!id)throw new Error('gmail_reconciliation_missing_id');return [{json:{...claim,provider_message_id:id}}];";
const BUILD_DEFERRED = "return [{json:$('Build Gmail Reconciliation Query').first().json}];";

export function buildOnboardingEmailReconcilerWorkflow() {
  const nodes = [
    schedule("Reconciliation Schedule", 300), workerIdentity("Reconciliation Worker Identity"),
    postgres("Claim Ambiguous Email", "SELECT * FROM pkc_auth.claim_onboarding_email_outbox_reconciliation($1::uuid,$2::integer);", ["={{ $json.worker_id }}", "={{ $json.batch_size }}"], RECONCILER_CREDENTIAL),
    code("Build Gmail Reconciliation Query", BUILD_RECONCILIATION),
    gmailRequest("Search Gmail By Message-ID", { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages", sendQuery: true, queryParameters: { parameters: [{ name: "q", value: "={{ $('Build Gmail Reconciliation Query').first().json.gmail_query }}" }, { name: "labelIds", value: "SENT" }, { name: "maxResults", value: "2" }] }, options: { timeout: 10000, response: { response: { neverError: false, responseFormat: "json" } } } }),
    route("Gmail Message Found", "={{ Array.isArray($json.messages) && $json.messages.length===1 && !Object.prototype.hasOwnProperty.call($json,'nextPageToken') ? 1 : 0 }}", 0),
    code("Build Reconciled Acceptance", BUILD_RECONCILED),
    postgres("Reconcile Gmail Accepted", "SELECT * FROM pkc_auth.reconcile_onboarding_email_accepted($1::uuid,$2::uuid,$3::bigint,pg_catalog.decode($4::text,'hex'),$5::text);", ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.reconciliation_lease_fence }}", "={{ $json.request_sha256_hex }}", "={{ $json.provider_message_id }}"], RECONCILER_CREDENTIAL),
    code("Build Deferred Reconciliation", BUILD_DEFERRED),
    postgres("Defer Gmail Reconciliation", "SELECT * FROM pkc_auth.defer_onboarding_email_reconciliation($1::uuid,$2::uuid,$3::bigint);", ["={{ $json.outbox_id }}", "={{ $json.worker_id }}", "={{ $json.reconciliation_lease_fence }}"], RECONCILER_CREDENTIAL),
  ];
  return { name: "PKC — Onboarding Email Outbox Reconciler v1 (Inactive Candidate)", active: false, settings: { ...RETENTION }, nodes, connections: {
    "Reconciliation Schedule": { main: [[edge("Reconciliation Worker Identity")]] },
    "Reconciliation Worker Identity": { main: [[edge("Claim Ambiguous Email")]] },
    "Claim Ambiguous Email": { main: [[edge("Build Gmail Reconciliation Query")]] },
    "Build Gmail Reconciliation Query": { main: [[edge("Search Gmail By Message-ID")]] },
    "Search Gmail By Message-ID": { main: [[edge("Gmail Message Found")]] },
    "Gmail Message Found": { main: [[edge("Build Reconciled Acceptance")], [edge("Build Deferred Reconciliation")]] },
    "Build Reconciled Acceptance": { main: [[edge("Reconcile Gmail Accepted")]] },
    "Build Deferred Reconciliation": { main: [[edge("Defer Gmail Reconciliation")]] },
  } };
}

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const serialize = (value) => `${canonical(value)}\n`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function buildOnboardingEmailOutboxPackage() {
  const dispatcher = buildOnboardingEmailDispatcherWorkflow();
  const reconciler = buildOnboardingEmailReconcilerWorkflow();
  const dispatcherBytes = serialize(dispatcher);
  const reconcilerBytes = serialize(reconciler);
  const manifest = {
    schema: "pkc-onboarding-email-outbox-workflows-v1",
    n8n: structuredClone(N8N_IMAGE),
    candidates: [
      { file: "dispatcher.workflow.json", name: dispatcher.name, active: false, sha256: sha256(dispatcherBytes) },
      { file: "reconciler.workflow.json", name: reconciler.name, active: false, sha256: sha256(reconcilerBytes) },
    ],
  };
  return Object.freeze({ dispatcherBytes, reconcilerBytes, manifest: Object.freeze(manifest), manifestBytes: serialize(manifest) });
}

export function writeOnboardingEmailOutboxPackage(outputDirectory) {
  if (typeof outputDirectory !== "string" || !outputDirectory) throw new Error("user-supplied output path required");
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(output)) throw new Error("output directory must not already exist");
  const bundle = buildOnboardingEmailOutboxPackage();
  fs.mkdirSync(output, { mode: 0o700 });
  try {
    for (const [file, bytes] of [["dispatcher.workflow.json", bundle.dispatcherBytes], ["reconciler.workflow.json", bundle.reconcilerBytes], ["manifest.json", bundle.manifestBytes]]) {
      const target = path.join(output, file);
      fs.writeFileSync(target, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.chmodSync(target, 0o600);
    }
    for (const candidate of bundle.manifest.candidates) {
      if (sha256(fs.readFileSync(path.join(output, candidate.file))) !== candidate.sha256) throw new Error("candidate readback hash mismatch");
    }
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ outputDirectory: output, artifactCount: 3, candidates: bundle.manifest.candidates });
}
