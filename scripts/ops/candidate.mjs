#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidateManifest, verifyCandidateManifest } from "../../server/ops/candidate.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";

const args = process.argv.slice(2);
const help = `Usage:
  node scripts/ops/candidate.mjs manifest [--root PATH]
  node scripts/ops/candidate.mjs manifest --root PATH --output FILE --execute-local --target-kind disposable-local --typed-approval "APPROVE LOCAL CANDIDATE MANIFEST WRITE"
  node scripts/ops/candidate.mjs verify [--root PATH] --input FILE
Options are ordered exactly as shown. Empty, duplicate, reordered, unknown, and trailing arguments are rejected. --help is valid only by itself. No arguments performs no action.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"read-only","action":"none","dry-run":true}\n'); process.exit(0); }

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} requires a nonempty value`);
  return value;
}

try {
  if (args[0] === "manifest" && args.length === 1) {
    process.stdout.write(canonicalJson(await buildCandidateManifest(process.cwd())));
  } else if (args[0] === "manifest" && args.length === 3 && args[1] === "--root") {
    process.stdout.write(canonicalJson(await buildCandidateManifest(resolve(nonempty(args[2], "--root")))));
  } else if (args[0] === "manifest" && args.length === 5 && args[1] === "--root" && args[3] === "--output") {
    nonempty(args[2], "--root");
    nonempty(args[4], "--output");
    throw new Error("candidate manifest file write requires explicit disposable-local execution and exact typed approval");
  } else if (args[0] === "manifest" && args.length === 10
    && args[1] === "--root" && args[3] === "--output" && args[5] === "--execute-local"
    && args[6] === "--target-kind" && args[8] === "--typed-approval") {
    const root = resolve(nonempty(args[2], "--root"));
    const output = nonempty(args[4], "--output");
    if (args[7] !== "disposable-local" || args[9] !== "APPROVE LOCAL CANDIDATE MANIFEST WRITE") throw new Error("candidate manifest file write requires explicit disposable-local execution and exact typed approval");
    if (resolve(output).split(/[\\/]/).filter(Boolean).some((segment) => /(^|[-_.])(prod|production|live)([-_.]|$)/i.test(segment))) throw new Error("production-like candidate output target rejected");
    await writeFile(output, canonicalJson(await buildCandidateManifest(root)), { flag: "wx", mode: 0o600 });
  } else if (args[0] === "verify" && args.length === 3 && args[1] === "--input") {
    const input = nonempty(args[2], "--input");
    process.stdout.write(canonicalJson(await verifyCandidateManifest(process.cwd(), JSON.parse(await readFile(input, "utf8")))));
  } else if (args[0] === "verify" && args.length === 5 && args[1] === "--root" && args[3] === "--input") {
    const root = resolve(nonempty(args[2], "--root"));
    const input = nonempty(args[4], "--input");
    process.stdout.write(canonicalJson(await verifyCandidateManifest(root, JSON.parse(await readFile(input, "utf8")))));
  } else {
    throw new Error("exact candidate command grammar required; use --help");
  }
} catch (error) { process.stderr.write(`candidate operation failed: ${error.message}\n`); process.exitCode = 1; }
