#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { N8N_IMAGE, artifactPrivacyScan, compareSemanticReadback } from "../../scripts/n8n-workflow-as-code.mjs";
import { runAbortableChild } from "./process-control.mjs";

const MAX_OUTPUT = 1024 * 1024;
const CHILD_TIMEOUT_MS = 120_000;
const roles = ["login", "bootstrap", "profile", "sessions", "revoke", "logout", "finalizer", "dispatcher", "rollback-login"];
const sourceDir = path.resolve(process.argv[2] || "");
if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error("usage: rehearse.mjs <nine-artifact-directory>");
const expectedFiles = roles.map((role) => path.join(sourceDir, `${role}.json`));
if (!expectedFiles.every((file) => fs.existsSync(file))) throw new Error("artifact directory must contain exactly the nine named role files");
const jsonFiles = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".json") && name !== "manifest.json").sort();
if (JSON.stringify(jsonFiles) !== JSON.stringify(roles.map((role) => `${role}.json`).sort())) throw new Error("unexpected or missing workflow artifact");
const expected = expectedFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const privacy = artifactPrivacyScan(expected); if (!privacy.ok) throw new Error(`artifact privacy scan failed: ${privacy.findings.join(",")}`);
if (expected.some((workflow) => workflow.active !== false)) throw new Error("all rehearsal artifacts must be inactive");
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
if (manifest?.image?.repoDigest !== N8N_IMAGE.repoDigest || manifest?.image?.reference !== N8N_IMAGE.reference) throw new Error("manifest image authority drift");

const nonce = crypto.randomBytes(8).toString("hex"); const project = `pkc_n8n_rehearsal_${nonce}`;
const artifactStagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `${project}_artifacts_`));
const readbackDir = fs.mkdtempSync(path.join(os.tmpdir(), `${project}_readback_`));
const ownedRoots = [artifactStagingDir, readbackDir]; const rehearsalIds = new Map();
for (const [index, file] of expectedFiles.entries()) { const staged = JSON.parse(fs.readFileSync(file, "utf8")); const id = crypto.createHash("sha256").update(`${nonce}:${roles[index]}`).digest("hex").slice(0, 16); staged.id = id; rehearsalIds.set(staged.name, id); fs.writeFileSync(path.join(artifactStagingDir, `${roles[index]}.json`), `${JSON.stringify(staged, null, 2)}\n`, { mode: 0o600 }); }
for (const directory of ownedRoots) { fs.chmodSync(directory, 0o700); if (process.getuid?.() === 0) fs.chownSync(directory, 1000, 1000); }
for (const file of fs.readdirSync(artifactStagingDir)) { const target = path.join(artifactStagingDir, file); fs.chmodSync(target, 0o600); if (process.getuid?.() === 0) fs.chownSync(target, 1000, 1000); }

const composeFile = path.resolve(new URL("./compose.yml", import.meta.url).pathname);
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, PKC_N8N_ARTIFACT_DIR: artifactStagingDir, PKC_N8N_READBACK_DIR: readbackDir };
const controller = new AbortController(); let signalName = null; const active = new Set();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { signalName = signal; controller.abort(new Error(`interrupted:${signal}`)); });

const run = (command, args, { allowFailure = false, timeoutMs = CHILD_TIMEOUT_MS, signal = controller.signal } = {}) => runAbortableChild(command, args, { env, signal, allowFailure, timeoutMs, maxOutput: MAX_OUTPUT, active });
const compose = (args, options) => run("docker", ["compose", "-f", composeFile, ...args], options);
async function residue() { const checks = await Promise.all([
  run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { allowFailure: true, timeoutMs: 20_000, signal: null }),
  run("docker", ["volume", "ls", "-q", "--filter", `name=${project}`], { allowFailure: true, timeoutMs: 20_000, signal: null }),
  run("docker", ["network", "ls", "-q", "--filter", `name=${project}`], { allowFailure: true, timeoutMs: 20_000, signal: null }),
]); return checks.some((item) => item.code !== 0 || item.stdout.trim()); }
async function cleanup() { const errors = []; try { const down = await compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], { allowFailure: true, timeoutMs: 30_000, signal: null }); if (down.code !== 0) errors.push(new Error("compose cleanup failed")); } catch (e) { errors.push(e); }
  for (const root of ownedRoots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { errors.push(e); } if (fs.existsSync(root)) errors.push(new Error(`temp root residue: ${root}`)); }
  try { if (await residue()) errors.push(new Error("Docker residue remains")); } catch (e) { errors.push(e); }
  if (errors.length) throw new AggregateError(errors, "rehearsal cleanup failed"); }

let primary = null;
try {
  const inspect = await run("docker", ["image", "inspect", N8N_IMAGE.reference, "--format", "{{json .RepoDigests}}"], { timeoutMs: 20_000 });
  if (!inspect.stdout.includes(N8N_IMAGE.repoDigest)) throw new Error("authoritative local n8n RepoDigest unavailable");
  if (process.env.PKC_REHEARSAL_TEST_INTERRUPT_AFTER_STAGE === "1") { signalName = "TEST"; controller.abort(new Error("forced test interruption")); throw new Error("forced test interruption"); }
  for (const role of roles) await compose(["run", "--rm", "n8n", "import:workflow", `--input=/artifacts/${role}.json`]);
  await compose(["run", "--rm", "n8n", "export:workflow", "--all", "--separate", "--output=/readback/workflows"]);
  await compose(["run", "--rm", "--entrypoint", "sh", "n8n", "-c", "cp /home/node/.n8n/database.sqlite* /readback/"]);
  const probe = await run("python3", ["-c", `import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1]).cursor()\ndef n(t,w='1=1'): return c.execute(f'SELECT COUNT(*) FROM \"{t}\" WHERE {w}').fetchone()[0]\nprint(json.dumps({'workflowCount':n('workflow_entity'),'activeCount':n('workflow_entity','active = 1'),'credentialCount':n('credentials_entity'),'executionCount':n('execution_entity'),'publishedWebhookCount':n('webhook_entity')}))`, path.join(readbackDir, "database.sqlite")]);
  const state = JSON.parse(probe.stdout); if (JSON.stringify(state) !== JSON.stringify({ workflowCount: 9, activeCount: 0, credentialCount: 0, executionCount: 0, publishedWebhookCount: 0 })) throw new Error(`native database state drift: ${JSON.stringify(state)}`);
  const files = fs.readdirSync(path.join(readbackDir, "workflows")).filter((name) => name.endsWith(".json")); if (files.length !== 9) throw new Error("native export count drift");
  const byName = new Map(files.map((name) => { const value = JSON.parse(fs.readFileSync(path.join(readbackDir, "workflows", name), "utf8")); return [value.name, value]; }));
  for (const workflow of expected) { const readback = byName.get(workflow.name); if (!readback || readback.id !== rehearsalIds.get(workflow.name) || readback.active !== false) throw new Error(`${workflow.name}: native identity/state drift`); const compared = compareSemanticReadback(workflow, readback); if (!compared.equal) throw new Error(`${workflow.name}: semantic drift at ${compared.differences.join(",")}`); }
  process.stdout.write(`${JSON.stringify({ ok: true, version: N8N_IMAGE.version, repoDigest: N8N_IMAGE.repoDigest, artifactCount: 9, ...state })}\n`);
} catch (error) { primary = error; } finally { try { await cleanup(); } catch (cleanupError) { primary = primary ? new AggregateError([primary, cleanupError], "rehearsal and cleanup failed") : cleanupError; } }
if (primary) {
  if (signalName) { process.stderr.write(`rehearsal interrupted (${signalName}); cleanup complete\n`); process.exitCode = 128; }
  else throw primary;
}
