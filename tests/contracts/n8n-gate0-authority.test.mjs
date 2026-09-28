import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FINALIZER_PUBLIC_RESPONSE_KEYS, artifactPrivacyScan, inspectDatabaseFunctionAuthority, validateProtectedInputs } from "../../scripts/n8n-workflow-as-code.mjs";
import { buildOutboxDispatcherWorkflow } from "../../scripts/n8n-outbox-dispatcher.mjs";
import { applyBackfillPlan, planFounderAccountIdBackfill } from "../../scripts/n8n-founder-account-backfill.mjs";
import { serializeProtectedFiles } from "../../scripts/n8n-workflows.mjs";
import { authorityMode, authorityRegistry, loadAuthority } from "../support/n8n-authority-fixture.mjs";
import { assertCompleteN8nGate } from "../support/n8n-gate-assertions.mjs";

const protectedDir = "/root/.hermes/protected/pkc-founder-mfa/source-workflows";
const loadSix = loadAuthority;
const serialize = () => assertCompleteN8nGate({ inputs: loadSix(), registry: authorityRegistry });
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("selected six-workflow authority is closed and rejects topology and response drift", () => {
  const six = loadSix();
  assert.equal(serialize().artifacts.length, 9);
  for (const mutate of [
    (v) => { const n=v.nodes.find((x)=>x.type==="n8n-nodes-base.respondToWebhook"); n.parameters.responseBody="={{ $json.password }}"; },
    (v) => { const k=Object.keys(v.connections)[0]; v.connections[k].main[0][0].node=v.nodes.at(-1).name; },
  ]) { const copy=structuredClone(six); mutate(copy[0]); assert.throws(()=>validateProtectedInputs(copy, authorityRegistry), /drift/); }
});

test("manifest hashes exact emitted pretty JSON LF bytes and binds immutable image", () => {
  const result=serialize();
  for(const a of result.artifacts) assert.equal(a.rawSha256, sha(Buffer.from(`${JSON.stringify(a.workflow,null,2)}\n`)));
  assert.equal(result.manifest.image.repoDigest, "sha256:b1b0c592735e24acd3cc64db83f94ef4efd8e331e47c6883249cc51cc1bea16b");
});

test("protected release serialization accepts the exact six basenames without callback-arity drift", { skip: authorityMode === "synthetic" ? "production snapshot evidence is unavailable in the synthetic gate-engine lane" : false }, () => {
  const output=path.join(os.tmpdir(),`pkc-protected-release-${crypto.randomUUID()}`);
  try {
    const files=authorityRegistry.map((entry)=>path.join(protectedDir,`${entry.id}.json`));
    const result=serializeProtectedFiles(files,output);
    assert.equal(result.artifacts.length,9);
    assert.equal(fs.readdirSync(output).filter((name)=>name.endsWith(".json")).length,10);
  } finally { fs.rmSync(output,{recursive:true,force:true}); }
});

test("founder gates are exact case-sensitive and reject malformed IDs", () => {
  const result=serialize();
  const login=result.artifacts.find((x)=>x.role==="login").workflow;
  const source=login.nodes.map((n)=>n.parameters?.jsCode||"").join("\n");
  assert.match(source, /founder_(?:authority_not_configured|mfa_not_configured)|reserved_owner_identity/);
  assert.match(source, /username\s*===\s*['"]PK Blick['"]/);
  assert.match(source, /account_id/);
});

test("finalizer rejects unsigned token and exposes only a closed allowlisted receipt", () => {
  const result=serialize();
  const wf=result.artifacts.find((x)=>x.role==="finalizer").workflow;
  const response=wf.nodes.find((n)=>n.type==="n8n-nodes-base.respondToWebhook").parameters.responseBody;
  assert.doesNotMatch(response, /(?:finalize_)?grant\s*:/);
  assert.doesNotMatch(response, /\$json\s*}}/);
  for (const key of FINALIZER_PUBLIC_RESPONSE_KEYS) assert.match(response, new RegExp(`\\b${key}\\b`));
  const responseValidator=wf.nodes.find((n)=>n.name==="Validate Finalizer Public Response");
  assert.ok(responseValidator);
  assert.match(responseValidator.parameters.jsCode,/unexpected_finalizer_response_shape/);
  const validReceipt=Object.fromEntries(FINALIZER_PUBLIC_RESPONSE_KEYS.map((key)=>[key, key]));
  Object.assign(validReceipt,{ok:true,status:"authenticated",receipt_version:1,auth_epoch:1,mfa_verified_at:2,issued_at:3,expires_at:4});
  const execute=(receipt)=>Function("$",responseValidator.parameters.jsCode)((name)=>({first:()=>({json:{receipt}})}));
  assert.deepEqual(Object.keys(execute(validReceipt)[0].json).sort(),FINALIZER_PUBLIC_RESPONSE_KEYS);
  assert.throws(()=>execute({...validReceipt,unexpected_private_field:"blocked"}),/unexpected_finalizer_response_shape/);
  const verifier=wf.nodes.find((n)=>/Verify Finalize Grant/.test(n.name));
  assert.ok(verifier);
  assert.match(verifier.parameters.jsCode,/timingSafeEqual/);
  assert.doesNotMatch(verifier.parameters.jsCode,/input\.body.*finalize_id/s);
});

test("finalizer PostgreSQL calls cannot outrun repository database authority", () => {
  const result=serialize();
  const wf=result.artifacts.find((x)=>x.role==="finalizer").workflow;
  const authority=inspectDatabaseFunctionAuthority(wf);
  assert.deepEqual(authority.referenced, []);
  assert.deepEqual(authority.unknown, []);
  const drift=structuredClone(wf);
  drift.nodes.push({name:"Unknown DB authority",type:"n8n-nodes-base.postgres",typeVersion:2.6,parameters:{operation:"executeQuery",query:"SELECT * FROM pkc_auth.finalize_founder_mfa_session($1::text);",options:{queryReplacement:["x"]}}});
  assert.throws(()=>inspectDatabaseFunctionAuthority(drift),/unknown database function authority/);
});

test("all postgres nodes have exact queryReplacement bindings and dispatcher has separate reconciliation trigger", () => {
  const wf=buildOutboxDispatcherWorkflow();
  const pg=wf.nodes.filter((n)=>n.type==="n8n-nodes-base.postgres");
  assert.ok(pg.length>=6);
  for(const n of pg){ const count=(n.parameters.query.match(/\$\d+/g)||[]).reduce((m,x)=>Math.max(m,Number(x.slice(1))),0); assert.equal(n.parameters.options.queryReplacement.length,count,n.name); }
  assert.ok(wf.nodes.some((n)=>n.name==="Reconciliation Schedule"));
  assert.doesNotMatch(JSON.stringify(wf),/delivery:\{delivered:false/);
});

test("backfill approval is external and raw rows establish exact-one uniqueness and immutability", async () => {
  const proposed="11111111-1111-4111-8111-111111111111";
  const plan=planFounderAccountIdBackfill([{row_ref:"r1",username:"PK Blick",is_admin:true,account_id:null}],{proposedAccountId:proposed});
  assert.equal(plan.requiredApprovalReceipt,undefined);
  const approval=`APPLY FOUNDER ACCOUNT_ID BACKFILL ${plan.planDigest}`;
  await assert.rejects(()=>applyBackfillPlan(plan,{approvalReceipt:approval,adapter:async()=>({account_id:proposed,username:"PK Blick",is_admin:true,immutable:true,unique:true})}),/raw|rows|readback/);
});

test("privacy rejects sensitive strings hidden under innocuous keys and accessors", () => {
  const sensitiveShape = ["pass", "word=", "hunter", "2"].join("");
  assert.equal(artifactPrivacyScan([{name:"x",notes:sensitiveShape,nodes:[],settings:{}}]).ok,false);
  const hostile={name:"x",nodes:[],settings:{}}; Object.defineProperty(hostile,"safe",{enumerable:true,get(){return "ok";}});
  assert.equal(artifactPrivacyScan([hostile]).ok,false);
});

test("compose and CI never pull or claim protected production release", () => {
  const compose=fs.readFileSync(new URL("../../ops/n8n-disposable/compose.yml",import.meta.url),"utf8");
  const rehearsal=fs.readFileSync(new URL("../../ops/n8n-disposable/rehearse.mjs",import.meta.url),"utf8");
  const ci=fs.readFileSync(new URL("../../.github/workflows/ci.yml",import.meta.url),"utf8");
  assert.match(compose,/n8nio\/n8n@sha256:b1b0c592/);
  assert.doesNotMatch(rehearsal,/compose\(\["pull"/);
  assert.doesNotMatch(ci,/Rehearse nine inactive workflows/);
  assert.match(ci,/unit-only/i);
});
