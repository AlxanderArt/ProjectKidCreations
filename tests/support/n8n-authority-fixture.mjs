import path from "node:path";

import { WORKFLOW_REGISTRY } from "../../scripts/n8n-workflow-as-code.mjs";
import { createSyntheticN8nAuthority } from "../../scripts/n8n-synthetic-authority.mjs";
import { readJsonDescriptorSafe } from "../../scripts/n8n-workflows.mjs";

export const authorityMode = process.env.PKC_N8N_TEST_AUTHORITY === "synthetic" ? "synthetic" : "protected";
const synthetic = authorityMode === "synthetic" ? createSyntheticN8nAuthority() : null;
export const authorityRegistry = synthetic?.registry ?? WORKFLOW_REGISTRY;

export function loadAuthority() {
  if (synthetic) return structuredClone(synthetic.inputs);
  const protectedDir = "/root/.hermes/protected/pkc-founder-mfa/source-workflows";
  return WORKFLOW_REGISTRY.map((entry) => readJsonDescriptorSafe(path.join(protectedDir, `${entry.id}.json`), { protectedInput: true }).value);
}

export function serializeAuthority(inputs = loadAuthority()) {
  return { inputs, options: authorityMode === "synthetic" ? { registry: authorityRegistry } : {} };
}
