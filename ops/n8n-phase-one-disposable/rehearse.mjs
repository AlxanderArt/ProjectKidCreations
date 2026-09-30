#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareSemanticReadback } from "../../scripts/n8n-workflow-as-code.mjs";
import {
  N8N_IMAGE,
  readJsonDescriptorSafe,
  semanticHash,
} from "../../scripts/n8n-phase-one-persistence.mjs";
import { runAbortableChild } from "../n8n-disposable/process-control.mjs";

const MAX_OUTPUT = 1024 * 1024;
const CHILD_TIMEOUT_MS = 120_000;
const packageDirectory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: rehearse.mjs <candidate-package-directory>");
if (!fs.statSync(packageDirectory).isDirectory()) throw new Error("candidate package path must be a directory");
const names = fs.readdirSync(packageDirectory).sort();
if (JSON.stringify(names) !== JSON.stringify(["manifest.json", "workflow.json"])) throw new Error("candidate package must contain exactly workflow.json and manifest.json");
const workflowFile = path.join(packageDirectory, "workflow.json");
const manifestFile = path.join(packageDirectory, "manifest.json");
const workflowLoaded = readJsonDescriptorSafe(workflowFile, { protectedInput: true });
const manifestLoaded = readJsonDescriptorSafe(manifestFile, { protectedInput: true });
const workflow = workflowLoaded.value;
const manifest = manifestLoaded.value;
if (manifest?.schema !== "pkc-n8n-phase-one-consent-persistence-candidate-v1") throw new Error("candidate manifest schema drift");
if (manifest?.n8n?.version !== N8N_IMAGE.version
    || manifest?.n8n?.repoDigest !== N8N_IMAGE.repoDigest
    || manifest?.n8n?.reference !== N8N_IMAGE.reference) throw new Error("candidate n8n image authority drift");
if (manifest?.candidate?.rawSha256 !== workflowLoaded.rawSha256
    || manifest?.candidate?.semanticSha256 !== semanticHash(workflow)) throw new Error("candidate manifest hash drift");
if (workflow.active !== false || workflow.settings?.availableInMCP !== false) throw new Error("candidate must be inactive and unavailable in MCP");

const nonce = crypto.randomBytes(8).toString("hex");
const project = `pkc_phase_one_rehearsal_${nonce}`;
const composeFile = path.resolve(new URL("./compose.yml", import.meta.url).pathname);
const ownedRoots = [];
const controller = new AbortController();
const active = new Set();
let signalName = null;
let env = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => {
  signalName = signal;
  controller.abort(new Error(`interrupted:${signal}`));
});

const run = (command, args, { allowFailure = false, timeoutMs = CHILD_TIMEOUT_MS, signal = controller.signal } = {}) => runAbortableChild(command, args, {
  env, signal, allowFailure, timeoutMs, maxOutput: MAX_OUTPUT, active,
});
const compose = (args, options) => run("docker", ["compose", "-f", composeFile, ...args], options);

function summarizeFailure(result) {
  const summary = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .filter((line) => /error|fail|invalid|unknown|required|syntax/iu.test(line))
    .slice(-12)
    .join(" | ")
    .replace(/\/[A-Za-z0-9._/-]+/gu, "[path]")
    .replace(/\b[0-9a-f]{32,}\b/giu, "[digest]");
  return summary || "no bounded diagnostic line was emitted";
}

async function residue() {
  const checks = await Promise.all([
    run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { allowFailure: true, timeoutMs: 20_000, signal: null }),
    run("docker", ["volume", "ls", "-q", "--filter", `name=${project}`], { allowFailure: true, timeoutMs: 20_000, signal: null }),
    run("docker", ["network", "ls", "-q", "--filter", `name=${project}`], { allowFailure: true, timeoutMs: 20_000, signal: null }),
  ]);
  return checks.some((item) => item.code !== 0 || item.stdout.trim());
}

async function cleanup() {
  const errors = [];
  if (env) {
    try {
      const down = await compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], { allowFailure: true, timeoutMs: 30_000, signal: null });
      if (down.code !== 0) errors.push(new Error("compose cleanup failed"));
    } catch (error) {
      errors.push(error);
    }
  }
  for (const root of ownedRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (fs.existsSync(root)) errors.push(new Error("temporary rehearsal root remains"));
  }
  if (env) {
    try { if (await residue()) errors.push(new Error("Docker rehearsal residue remains")); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "rehearsal cleanup failed");
}

let primary = null;
try {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `${project}_candidate_`));
  const readback = fs.mkdtempSync(path.join(os.tmpdir(), `${project}_readback_`));
  ownedRoots.push(staging, readback);
  const stagedWorkflow = path.join(staging, "workflow.json");
  fs.writeFileSync(stagedWorkflow, fs.readFileSync(workflowFile), { flag: "wx", mode: 0o600 });
  for (const directory of ownedRoots) {
    fs.chmodSync(directory, 0o700);
    if (process.getuid?.() === 0) fs.chownSync(directory, 1000, 1000);
  }
  if (process.getuid?.() === 0) fs.chownSync(stagedWorkflow, 1000, 1000);
  env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    PKC_N8N_CANDIDATE_DIR: staging,
    PKC_N8N_READBACK_DIR: readback,
  };

  const inspect = await run("docker", ["image", "inspect", N8N_IMAGE.reference, "--format", "{{json .RepoDigests}}"], { timeoutMs: 20_000 });
  if (!inspect.stdout.includes(N8N_IMAGE.repoDigest)) throw new Error("pinned local n8n RepoDigest unavailable");
  const imported = await compose(["run", "--rm", "n8n", "import:workflow", "--input=/candidate/workflow.json"], { allowFailure: true });
  if (imported.code !== 0) throw new Error(`native import failed: ${summarizeFailure(imported)}`);
  await compose(["run", "--rm", "n8n", "export:workflow", "--all", "--separate", "--output=/readback/workflows"]);
  await compose(["run", "--rm", "--entrypoint", "sh", "n8n", "-c", "cp /home/node/.n8n/database.sqlite* /readback/"]);

  const probe = await run("python3", ["-c", `import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1]).cursor()\ndef n(t,w='1=1'): return c.execute(f'SELECT COUNT(*) FROM "{t}" WHERE {w}').fetchone()[0]\nprint(json.dumps({'workflowCount':n('workflow_entity'),'activeCount':n('workflow_entity','active = 1'),'credentialCount':n('credentials_entity'),'executionCount':n('execution_entity'),'publishedWebhookCount':n('webhook_entity')}))`, path.join(readback, "database.sqlite")]);
  const state = JSON.parse(probe.stdout);
  const expectedState = { workflowCount: 1, activeCount: 0, credentialCount: 0, executionCount: 0, publishedWebhookCount: 0 };
  if (JSON.stringify(state) !== JSON.stringify(expectedState)) throw new Error("native database state drift");

  const exported = fs.readdirSync(path.join(readback, "workflows")).filter((name) => name.endsWith(".json"));
  if (exported.length !== 1) throw new Error("native export count drift");
  const nativeReadback = JSON.parse(fs.readFileSync(path.join(readback, "workflows", exported[0]), "utf8"));
  const compared = compareSemanticReadback(workflow, nativeReadback);
  if (!compared.equal) throw new Error(`native semantic drift at ${compared.differences.join(",")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, version: N8N_IMAGE.version, repoDigest: N8N_IMAGE.repoDigest, artifactCount: 1, ...state })}\n`);
} catch (error) {
  primary = error;
} finally {
  try { await cleanup(); } catch (cleanupError) {
    primary = primary ? new AggregateError([primary, cleanupError], "rehearsal and cleanup failed") : cleanupError;
  }
}
if (primary) {
  if (signalName) {
    process.stderr.write(`rehearsal interrupted (${signalName}); cleanup attempted\n`);
    process.exitCode = 128;
  } else throw primary;
}
