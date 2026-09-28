#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { evaluateMonitoring } from "../../server/ops/monitoring.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";
const args = process.argv.slice(2);
const help = `Usage: node scripts/ops/monitor.mjs evaluate --input sanitized-signals.json\nDeterministic local evaluator only; bounded redacted alerts, no external send.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"read-only","action":"none","externalSend":false}\n'); process.exit(0); }
try { if (args.length !== 3 || args[0] !== "evaluate" || args[1] !== "--input" || !args[2]) throw new Error("exact command required: evaluate --input <nonempty-path>"); process.stdout.write(canonicalJson(evaluateMonitoring(JSON.parse(await readFile(args[2], "utf8"))))); }
catch (error) { process.stderr.write(`monitor input rejected: ${error.message}\n`); process.exitCode = 1; }
