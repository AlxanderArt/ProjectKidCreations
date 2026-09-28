#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { verifyVercelDeployment } from "../../server/ops/vercel.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";
const args = process.argv.slice(2);
const help = `Usage: node scripts/ops/vercel.mjs verify --input sanitized-deployment-metadata.json\nGate 0 verify-only; accepts metadata without values and performs no Vercel mutation.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"read-only","action":"none","dry-run":true}\n'); process.exit(0); }
try { if (args.length !== 3 || args[0] !== "verify" || args[1] !== "--input" || !args[2]) throw new Error("exact command required: verify --input <nonempty-path>"); process.stdout.write(canonicalJson(verifyVercelDeployment(JSON.parse(await readFile(args[2], "utf8"))))); }
catch (error) { process.stderr.write(`Vercel evidence rejected: ${error.message}\n`); process.exitCode = 1; }
