#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { evaluateRestoreEvidence } from "../../server/ops/restore.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";
const args = process.argv.slice(2);
const help = `Usage: node scripts/ops/restore.mjs verify --input sanitized-evidence.json\nGate 0 read-only syntax/parity evaluator. It never calls a provider, verifies provenance, produces release authority, or creates/restores/deletes resources. Every accepted result is authoritative=false and releaseEligible=false.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"read-only","action":"none","dry-run":true}\n'); process.exit(0); }
try { if (args.length !== 3 || args[0] !== "verify" || args[1] !== "--input" || !args[2]) throw new Error("exact command required: verify --input <nonempty-path>"); process.stdout.write(canonicalJson(evaluateRestoreEvidence(JSON.parse(await readFile(args[2], "utf8"))))); }
catch (error) { process.stderr.write(`restore evidence rejected: ${error.message}\n`); process.exitCode = 1; }
