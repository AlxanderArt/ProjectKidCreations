#!/usr/bin/env node
import fs from "node:fs";

import { planFounderAccountIdBackfill } from "./n8n-founder-account-backfill.mjs";

try {
  const [command, inventoryFile, proposedAccountId, outputFile] = process.argv.slice(2);
  if (command !== "plan" || !inventoryFile || !proposedAccountId || !outputFile) throw new Error("usage: plan <sanitized-inventory.json> <proposed-uuid> <new-plan.json>");
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
  const plan = planFounderAccountIdBackfill(inventory, { proposedAccountId });
  fs.writeFileSync(outputFile, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "dry-run", planDigest: plan.planDigest, outputFile })}\n`);
} catch (error) { process.stderr.write(`n8n-founder-account-backfill: ${error.message}\n`); process.exitCode = 1; }
