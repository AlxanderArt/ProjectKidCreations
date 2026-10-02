#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeCandidatePackage } from "./n8n-phase-one-persistence.mjs";

export function parseCandidateArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "build" || argv[1] !== "--out" || !argv[2]) {
    throw new Error("usage: n8n-phase-one-candidate.mjs build --out <new-output-directory>");
  }
  return Object.freeze({ outputDirectory: path.resolve(argv[2]) });
}

export function runCandidateCli(argv = process.argv.slice(2)) {
  const { outputDirectory } = parseCandidateArguments(argv);
  return writeCandidatePackage(outputDirectory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = runCandidateCli();
    process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
  } catch (error) {
    process.stderr.write(`n8n-phase-one-candidate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
