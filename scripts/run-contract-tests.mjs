#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = path.join(root, "tests", "contracts");
const protectedReleaseGateFiles = new Set([
  "n8n-workflow-as-code.test.mjs",
  "n8n-gate0-authority.test.mjs",
  "n8n-gate-engine.test.mjs",
  "n8n-permission-boundary.test.mjs",
  "n8n-synthetic-permission-gate.test.mjs",
]);
const files = fs.readdirSync(contractsDir)
  .filter((name) => name.endsWith(".test.mjs") && !protectedReleaseGateFiles.has(name))
  .sort()
  .map((name) => path.join("tests", "contracts", name));
if (files.length === 0) throw new Error("clean-checkout contract inventory is empty");
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
