import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { artifactPrivacyScan, compareSemanticReadback, serializeNineArtifacts, validateProtectedInputs } from "../../scripts/n8n-workflow-as-code.mjs";
import { parseBoundedJson, readJsonDescriptorSafe } from "../../scripts/n8n-workflows.mjs";
import { FINALIZE_CLAIM_KEYS, verifyFounderFinalizeGrant } from "../../scripts/n8n-founder-mfa.mjs";
import { approvalReceiptForPlan, applyBackfillPlan, planFounderAccountIdBackfill } from "../../scripts/n8n-founder-account-backfill.mjs";
import { authorityRegistry, loadAuthority } from "../support/n8n-authority-fixture.mjs";

const six = loadAuthority;
const serialize = () => serializeNineArtifacts(six(), { registry: authorityRegistry });

function reachable(workflow, from, to, omitted = null) {
  if (from === omitted) return false; const seen = new Set([from]); const queue = [from];
  while (queue.length) { const current = queue.shift(); if (current === to) return true; for (const lanes of Object.values(workflow.connections?.[current] || {})) for (const lane of lanes || []) for (const edge of lane || []) if (edge.node !== omitted && !seen.has(edge.node)) { seen.add(edge.node); queue.push(edge.node); } }
  return false;
}

test("all exact six authority descriptors load and canonical authority is closed", () => {
  const inputs = six(); assert.equal(inputs.length, 6); assert.equal(validateProtectedInputs(inputs, authorityRegistry).length, 6);
  assert.deepEqual(inputs.map((item) => item.id), authorityRegistry.map((item) => item.id));
});

test("descriptor reader rejects symlink, duplicate keys, invalid UTF-8, FIFO, and bounds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-hostile-json-"));
  try {
    const valid = path.join(root, "valid.json"); fs.writeFileSync(valid, '{"a":1}', { mode: 0o600 });
    const link = path.join(root, "link.json"); fs.symlinkSync(valid, link); assert.throws(() => readJsonDescriptorSafe(link, { protectedInput: true }), /ELOOP|symbolic/i);
    const duplicate = path.join(root, "duplicate.json"); fs.writeFileSync(duplicate, '{"a":1,"a":2}', { mode: 0o600 }); assert.throws(() => readJsonDescriptorSafe(duplicate, { protectedInput: true }), /duplicate key/);
    const invalid = path.join(root, "invalid.json"); fs.writeFileSync(invalid, Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0xff,0x7d]), { mode: 0o600 }); assert.throws(() => readJsonDescriptorSafe(invalid, { protectedInput: true }), /encoded data|UTF/i);
    const fifo = path.join(root, "pipe"); execFileSync("mkfifo", [fifo]); fs.chmodSync(fifo, 0o600); assert.throws(() => readJsonDescriptorSafe(fifo, { protectedInput: true }), /regular file/);
    assert.throws(() => parseBoundedJson(`${"[".repeat(90)}0${"]".repeat(90)}`), /depth bound/);
    assert.throws(() => parseBoundedJson(`{"x":"${"a".repeat(1_000_001)}"}`), /string bound/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("exact topology makes founder authority dominate login success side effects", () => {
  const login = serialize().artifacts.find((item) => item.role === "login").workflow;
  const gate = "Verify Credentials"; const entry = "Webhook";
  const sideEffects = ["Read User Sessions", "Revoke Oldest Session", "Append New Session", "Update Account (Success)", "Audit Success", "Respond Success"];
  for (const target of sideEffects) { assert.equal(reachable(login, entry, target), true, target); assert.equal(reachable(login, entry, target, gate), false, `${gate} must dominate ${target}`); }
  const route = login.nodes.find((node) => node.name === "Route Outcome");
  if (route) assert.equal(route.parameters.rules.values[0].outputKey, "mfa_required");
  else assert.ok(login.nodes.some((node) => node.name === "Founder MFA Before Session Effects"));
});

test("accepted finalize verifier rejects unsigned token and preserves signed replay identity", () => {
  const key = crypto.randomBytes(32); const kid = "finalize-v1"; const now = 2_000_000_000;
  assert.throws(() => verifyFounderFinalizeGrant("not-a.jwt.signature", { key, expectedKid: kid, now }), /invalid/);
  const claims = Object.fromEntries(FINALIZE_CLAIM_KEYS.map((name) => [name, null])); Object.assign(claims, { amr:["pwd","otp"],aud:"pkc-n8n-founder-mfa-finalizer",auth_epoch:"4",exp:now+60,finalize_id:"finalize-stable-0001",iat:now,is_admin:true,iss:"pkc-vercel-founder-mfa",jti:"grant-stable-00001",kid,login_attempt_id:"11111111-1111-4111-8111-111111111111",mfa_verified_at:now,nbf:now-2,password_authenticated_at:now-1,purpose:"founder_mfa_finalize",session_expires_at:now+3600,session_id:"session-stable-0001",session_issued_at:now,sub:"22222222-2222-4222-8222-222222222222",typ:"pkc-founder-mfa-finalize+jwt",username:"PK Blick",version:1 });
  const enc=(v)=>Buffer.from(JSON.stringify(v)).toString("base64url"); const input=`${enc({alg:"HS256",kid,typ:"JWT"})}.${enc(claims)}`; const signedGrant=`${input}.${crypto.createHmac("sha256",key).update(input).digest("base64url")}`;
  assert.equal(verifyFounderFinalizeGrant(signedGrant,{key,expectedKid:kid,now}).finalize_id,"finalize-stable-0001");
  assert.equal(verifyFounderFinalizeGrant(signedGrant,{key,expectedKid:kid,now}).finalize_id,"finalize-stable-0001");
});

test("backfill derives raw exact-one uniqueness and failed-second-write immutability", async () => {
  const id="11111111-1111-4111-8111-111111111111"; const plan=planFounderAccountIdBackfill([{row_ref:"r1",username:"PK Blick",is_admin:true,account_id:null},{row_ref:"r2",username:"customer",is_admin:false,account_id:null}],{proposedAccountId:id});
  assert.equal(plan.requiredApprovalReceipt,undefined);
  const result=await applyBackfillPlan(plan,{approvalReceipt:approvalReceiptForPlan(plan),adapter:async()=>({mutationRows:[{row_ref:"r1",before_account_id:null,after_account_id:id}],readbackRows:[{row_ref:"r1",account_id:id,username:"PK Blick",is_admin:true}],cardinalityRows:[{account_id:id,row_count:1}],immutabilityRows:[{row_ref:"r1",current_account_id:id,attempted_account_id:"33333333-3333-4333-8333-333333333333",affected_rows:0}]})});
  assert.equal(result.verified,true);
  await assert.rejects(()=>applyBackfillPlan(plan,{approvalReceipt:approvalReceiptForPlan(plan),adapter:async()=>({verified:true,immutable:true,unique:true})}),/booleans/);
});

test("semantic readback permits native metadata only", () => {
  const expected=serialize().artifacts[2].workflow; const readback=structuredClone(expected); readback.id="native123"; readback.versionId=crypto.randomUUID(); readback.createdAt="2026-09-28T00:00:00.000Z"; readback.updatedAt=readback.createdAt; readback.versionCounter=1; readback.triggerCount=0; readback.versionMetadata={name:null,description:null}; readback.nodes.forEach((node)=>{node.id=crypto.randomUUID();});
  assert.equal(compareSemanticReadback(expected,readback).equal,true); readback.connections.Webhook.main[0][0].node="Respond OK"; assert.equal(compareSemanticReadback(expected,readback).equal,false);
});

test("generated session authority rejects numeric PostgreSQL bigint epochs before canonical validation", () => {
  const moduleSource = fs.readFileSync(new URL("../../scripts/n8n-workflow-as-code.mjs", import.meta.url), "utf8");
  assert.match(moduleSource, /const epoch=row\.auth_epoch;if\(founder&&\(typeof epoch!=='string'/);
  assert.doesNotMatch(moduleSource, /const epoch=String\(row\.auth_epoch\?\?''\)/);
  const workflow = serialize().artifacts.find((item) => item.role === "sessions").workflow;
  const gate = workflow.nodes.find((node) => node.name === "Enforce Founder Session Assurance");
  assert.ok(gate, "sessions authority gate must exist");
  const founderSubject = "22222222-2222-4222-8222-222222222222";
  const execute = (auth_epoch) => {
    const row = { session_id: "session-1", account_id: founderSubject, username: "PK Blick", auth_epoch, amr: "pwd otp", mfa_verified_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
    const nodes = { "Init Trace": [{ json: { session_id: "session-1" } }], "Read Current Session": [{ json: row }] };
    const $ = (name) => ({ first: () => nodes[name][0], all: () => nodes[name] });
    return Function("$input", "$env", "$", gate.parameters.jsCode)(
      { first: () => ({ json: {} }), all: () => [{ json: {} }] },
      { PKC_FOUNDER_SUBJECT: founderSubject, PKC_FOUNDER_MFA_MODE: "enforced" },
      $,
    );
  };
  assert.equal(execute("9007199254740993").length, 1);
  for (const hostile of [9007199254740993, 0, "01", "9223372036854775808"]) {
    assert.throws(() => execute(hostile), /founder_session_assurance_invalid/);
  }
});

test("privacy scanner covers values, code literals, URL query material, canaries, accessors, and prototype tricks", () => {
  for (const hostile of [{name:"x",notes:"password=hunter2",nodes:[],settings:{}},{name:"x",url:"https://x.test/?token=value",nodes:[],settings:{}},{name:"x",nodes:[{parameters:{jsCode:"const x='otpauth://fixed';"}}],settings:{}}]) assert.equal(artifactPrivacyScan([hostile]).ok,false);
  assert.equal(artifactPrivacyScan([{name:"x",notes:"SAFE-CANARY",nodes:[],settings:{}}],{canaries:["SAFE-CANARY"]}).ok,false);
  const accessor={name:"x",nodes:[],settings:{}}; Object.defineProperty(accessor,"x",{enumerable:true,get(){return 1;}}); assert.equal(artifactPrivacyScan([accessor]).ok,false);
  const proto=Object.create({polluted:true}); proto.name="x"; proto.nodes=[]; proto.settings={}; assert.equal(artifactPrivacyScan([proto]).ok,false);
});
