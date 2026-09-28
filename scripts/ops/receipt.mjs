#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateMutationReceipt, validateApprovalReceipt } from "../../server/ops/receipts.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";

const args = process.argv.slice(2);
const help = `Usage: node scripts/ops/receipt.mjs verify --type mutation|approval --input receipt.json
Options are ordered exactly as shown. Empty, duplicate, reordered, unknown, and trailing arguments are rejected before file access. --help is valid only by itself. No arguments performs no action. Verification is read-only and rejects secret-bearing fields.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"read-only","action":"none","dry-run":true}\n'); process.exit(0); }

try {
  if (args.length !== 5 || args[0] !== "verify" || args[1] !== "--type" || args[3] !== "--input" || !args[2] || !args[4]) throw new Error("exact receipt command required: verify --type mutation|approval --input <nonempty-path>");
  const type = args[2];
  if (type !== "mutation" && type !== "approval") throw new Error("--type must be exactly mutation or approval");
  const value = JSON.parse(await readFile(args[4], "utf8"));
  const output = type === "approval" ? validateApprovalReceipt(value) : validateMutationReceipt(value);
  process.stdout.write(canonicalJson({ ok: true, schemaVersion: output.schemaVersion, type }));
} catch (error) { process.stderr.write(`receipt rejected: ${error.message}\n`); process.exitCode = 1; }
