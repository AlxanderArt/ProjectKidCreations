#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildRetentionManifest, buildPurgePlan, scanPrivacyEvidence, applyPurgePlan } from "../../server/ops/n8n-retention.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";

const args = process.argv.slice(2);
const help = `Usage:
  node scripts/ops/n8n-retention.mjs retention-manifest
  node scripts/ops/n8n-retention.mjs scan --input FILE [--canaries VALUE[,VALUE]]
  node scripts/ops/n8n-retention.mjs purge-plan --input FILE
  node scripts/ops/n8n-retention.mjs apply --plan FILE
  node scripts/ops/n8n-retention.mjs apply --plan FILE --approval FILE --enable-destructive
Options are ordered exactly as shown. Empty, duplicate, reordered, unknown, and trailing arguments are rejected. --help is valid only by itself. No arguments performs no action. Apply is disabled unless the exact destructive grammar and approval receipt are supplied; Gate 0 uses a fake adapter only and never calls live n8n.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"dry-run","action":"none","writes":0}\n'); process.exit(0); }

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} requires a nonempty value`);
  return value;
}

try {
  if (args.length === 1 && args[0] === "retention-manifest") {
    process.stdout.write(canonicalJson(buildRetentionManifest()));
  } else if (args[0] === "scan" && (args.length === 3 || args.length === 5) && args[1] === "--input" && (args.length === 3 || args[3] === "--canaries")) {
    const input = nonempty(args[2], "--input");
    const canaries = args.length === 5 ? nonempty(args[4], "--canaries").split(",") : [];
    if (canaries.some((canary) => !canary)) throw new Error("--canaries requires nonempty comma-separated values");
    process.stdout.write(canonicalJson(scanPrivacyEvidence(JSON.parse(await readFile(input, "utf8")), canaries)));
  } else if (args.length === 3 && args[0] === "purge-plan" && args[1] === "--input") {
    process.stdout.write(canonicalJson(buildPurgePlan(JSON.parse(await readFile(nonempty(args[2], "--input"), "utf8")))));
  } else if (args[0] === "apply" && args.length === 3 && args[1] === "--plan") {
    const plan = JSON.parse(await readFile(nonempty(args[2], "--plan"), "utf8"));
    process.stdout.write(canonicalJson(await applyPurgePlan({ plan, enableDestructive: false, adapter: { gate0Fake: true, async apply() {} } })));
  } else if (args[0] === "apply" && args.length === 6 && args[1] === "--plan" && args[3] === "--approval" && args[5] === "--enable-destructive") {
    const plan = JSON.parse(await readFile(nonempty(args[2], "--plan"), "utf8"));
    const approval = JSON.parse(await readFile(nonempty(args[4], "--approval"), "utf8"));
    process.stdout.write(canonicalJson(await applyPurgePlan({ plan, approval, enableDestructive: true, adapter: { gate0Fake: true, async apply() {} } })));
  } else {
    throw new Error("exact n8n-retention command grammar required; use --help");
  }
} catch (error) { process.stderr.write(`n8n operation refused: ${error.message}\n`); process.exitCode = 1; }
