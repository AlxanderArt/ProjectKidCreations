#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createKeyFiles, cleanupInterruptedKeyRun, probeHistoricalKeyring, planEncryptionRotation } from "../../server/ops/keys.mjs";
import { canonicalJson } from "../../server/ops/canonical.mjs";

const args = process.argv.slice(2);
const help = `Usage:
  node scripts/ops/keys.mjs generate --directory DIR --version N --at ISO-UTC [--stdin-material] --execute-local --target-kind disposable-local --typed-approval "APPROVE LOCAL KEY GENERATION"
  node scripts/ops/keys.mjs cleanup --directory DIR --version N --execute-local --target-kind disposable-local --typed-approval "APPROVE LOCAL KEY CLEANUP"
  node scripts/ops/keys.mjs probe --input FILE --kids KID[,KID]
  node scripts/ops/keys.mjs rotation-plan --from KID --to KID --dependent-rows N
Options are ordered exactly as shown. Empty, duplicate, reordered, unknown, and trailing arguments are rejected. --help is valid only by itself. No arguments performs no action. Production targets and production cleanup are forbidden. Values are never printed.\n`;
if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); process.exit(0); }
if (!args.length) { process.stdout.write('{"mode":"dry-run","action":"none","productionKeysGenerated":false,"filesDeleted":0}\n'); process.exit(0); }

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} requires a nonempty value`);
  return value;
}

function integer(value, label) {
  nonempty(value, label);
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${label} requires a canonical nonnegative integer`);
  return Number(value);
}

async function stdinMaterial() {
  const input = await new Promise((resolve) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => value += chunk);
    process.stdin.on("end", () => resolve(value));
  });
  const lines = input.trim().split(/\r?\n/);
  if (lines.length !== 4) throw new Error("stdin must contain exactly four base64 lines");
  return Object.fromEntries(["handoff", "encryption", "finalize", "recovery"].map((purpose, index) => [purpose, Buffer.from(lines[index], "base64")]));
}

try {
  if (args[0] === "generate") {
    const withStdin = args[7] === "--stdin-material";
    const expectedLength = withStdin ? 13 : 12;
    const shift = withStdin ? 1 : 0;
    if (args.length !== expectedLength || args[1] !== "--directory" || args[3] !== "--version" || args[5] !== "--at"
      || args[7 + shift] !== "--execute-local" || args[8 + shift] !== "--target-kind" || args[10 + shift] !== "--typed-approval") throw new Error("exact generate command grammar required; use --help");
    const params = {
      directory: nonempty(args[2], "--directory"),
      version: integer(args[4], "--version"),
      at: nonempty(args[6], "--at"),
      executeLocal: true,
      targetKind: nonempty(args[9 + shift], "--target-kind"),
      typedApproval: nonempty(args[11 + shift], "--typed-approval"),
    };
    if (withStdin) params.material = await stdinMaterial();
    process.stdout.write(canonicalJson(await createKeyFiles(params)));
  } else if (args[0] === "cleanup" && args.length === 5 && args[1] === "--directory" && args[3] === "--version") {
    nonempty(args[2], "--directory");
    integer(args[4], "--version");
    throw new Error("key cleanup requires explicit local execution, disposable-local target, and exact typed approval");
  } else if (args[0] === "cleanup") {
    if (args.length !== 10 || args[1] !== "--directory" || args[3] !== "--version" || args[5] !== "--execute-local" || args[6] !== "--target-kind" || args[8] !== "--typed-approval") throw new Error("exact cleanup command grammar required; use --help");
    process.stdout.write(canonicalJson(await cleanupInterruptedKeyRun({
      directory: nonempty(args[2], "--directory"), version: integer(args[4], "--version"), executeLocal: true,
      targetKind: nonempty(args[7], "--target-kind"), typedApproval: nonempty(args[9], "--typed-approval"),
    })));
  } else if (args[0] === "probe") {
    if (args.length !== 5 || args[1] !== "--input" || args[3] !== "--kids") throw new Error("exact probe command grammar required; use --help");
    const input = nonempty(args[2], "--input");
    const kids = nonempty(args[4], "--kids").split(",");
    if (kids.some((kid) => !kid)) throw new Error("--kids requires nonempty comma-separated values");
    process.stdout.write(canonicalJson(probeHistoricalKeyring(JSON.parse(await readFile(input, "utf8")), kids)));
  } else if (args[0] === "rotation-plan") {
    if (args.length !== 7 || args[1] !== "--from" || args[3] !== "--to" || args[5] !== "--dependent-rows") throw new Error("exact rotation-plan command grammar required; use --help");
    process.stdout.write(canonicalJson(planEncryptionRotation({ from: nonempty(args[2], "--from"), to: nonempty(args[4], "--to"), dependentRows: integer(args[6], "--dependent-rows") })));
  } else {
    throw new Error("closed command enum requires generate, cleanup, probe, or rotation-plan");
  }
} catch (error) { process.stderr.write(`key operation failed safely (no key material emitted): ${error.message}\n`); process.exitCode = 1; }
