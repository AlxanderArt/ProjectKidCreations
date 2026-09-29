import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

const removedControlPlanePaths = [
  "server/ops/alert-delivery.mjs",
  "config/n8n-protected-source-manifest.json",
  "docs/architecture/adr-021-provider-native-release-authority.md",
  "docs/operations/production-monitoring.md",
  "scripts/ops/approval.mjs",
  "scripts/ops/monitor-scheduler.mjs",
  "scripts/ops/monitor-worker.mjs",
  "scripts/ops/n8n-rollout.mjs",
  "server/ops/approval-authority.mjs",
  "server/ops/authority-ledger.mjs",
  "server/ops/monitoring-profiles.mjs",
  "server/ops/monitoring-runtime.mjs",
  "server/ops/monitoring-supervisor.mjs",
  "server/ops/production-config.mjs",
  "server/ops/providers/git-native-client.mjs",
  "server/ops/providers/monitoring-native-clients.mjs",
  "server/ops/providers/n8n-native-client.mjs",
  "server/ops/providers/n8n-repository-reader.mjs",
  "server/ops/providers/native-http.mjs",
  "server/ops/providers/postgres-backup-client.mjs",
  "server/ops/providers/vercel-native-client.mjs",
  "server/ops/restricted-process.mjs",
  "tests/contracts/final-correction-monitoring-runtime.test.mjs",
  "tests/contracts/final-correction-n8n-rollout.test.mjs",
  "tests/contracts/final-correction-vercel.test.mjs",
  "tests/contracts/final-hold-reviewer-probes.test.mjs",
  "tests/contracts/provider-authority-corrective.test.mjs",
  "tests/contracts/provider-native-attestors.test.mjs",
];

async function source(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("rejected bespoke release-authority and monitoring control plane is absent", async () => {
  for (const path of removedControlPlanePaths) {
    await assert.rejects(access(new URL(path, ROOT)), { code: "ENOENT" }, path);
  }
});

test("repository operations remain diagnostic and cannot mutate Vercel or n8n Production", async () => {
  const vercel = await source("server/ops/vercel.mjs");
  const n8n = await source("server/ops/n8n-rollout.mjs");
  const vercelCli = await source("scripts/ops/vercel.mjs");
  const joined = `${vercel}\n${n8n}\n${vercelCli}`;
  for (const forbidden of [
    "attestVercelProduction",
    "acceptVercelCandidateProduction",
    "bootstrapVercelLegacyProduction",
    "attestN8nProduction",
    "activateN8nProduction",
    "production-attest",
    "accept-candidate",
    "bootstrap-legacy",
  ]) assert.doesNotMatch(joined, new RegExp(forbidden));
  assert.match(vercelCli, /diagnostic|verify/i);
});

test("manual rollout SOP keeps every external mutation behind a separate approval and readback", async () => {
  const sop = await source("docs/operations/manual-founder-mfa-rollout.md");
  for (const phrase of [
    "No automated provider mutation",
    "Gate 0 — local exact-byte acceptance",
    "Gate 1 — read-only Production preflight",
    "Gate 2 — backup and isolated restore",
    "Gate 3 — PostgreSQL migration",
    "Gate 4 — inactive n8n import",
    "Gate 5 — Vercel disabled deployment",
    "Gate 6 — n8n activation",
    "Gate 7 — armed mode",
    "Gate 8 — enforced mode",
    "Gate 9 — founder enrollment",
    "UNKNOWN_REQUIRES_RECONCILIATION",
    "separate explicit approval",
    "provider-native readback",
    "exactly 10 API functions",
    "db/roles/005_unseal_migrator.sql",
    "db/migrations/manifest.json",
    "db/migrations/001_founder_mfa.sql",
    "db/migrations/002_founder_mfa_production_authority.sql",
    "db/roles/010_seal_migrator.sql",
    "PKC_SOURCE_COMMIT",
    "PKC_MFA_WORKFLOW_DIGEST",
  ]) assert.match(sop, new RegExp(phrase, "i"), phrase);
  assert.doesNotMatch(sop, /node scripts\/ops\/(?:approval|monitor-scheduler|monitor-worker|n8n-rollout)\.mjs/);
});

test("architecture and operations index identify the manual boundary", async () => {
  const [architecture, operations] = await Promise.all([
    source("docs/architecture/founder-mfa.md"),
    source("docs/operations/README.md"),
  ]);
  assert.match(architecture, /manual provider rollout/i);
  assert.match(architecture, /does not implement a release control plane/i);
  assert.match(operations, /manual-founder-mfa-rollout\.md/);
  const preflight = await source("docs/operations/preflight.md");
  for (const roleScript of ["000_roles.sql", "005_unseal_migrator.sql", "010_seal_migrator.sql"]) assert.match(preflight, new RegExp(roleScript.replace(".", "\\.")));
  assert.doesNotMatch(operations, /monitor-scheduler\.mjs/);
});
