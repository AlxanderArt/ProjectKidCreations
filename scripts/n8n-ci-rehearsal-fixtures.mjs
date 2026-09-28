#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { serializeNineArtifacts } from "./n8n-workflow-as-code.mjs";
import { createSyntheticN8nAuthority } from "./n8n-synthetic-authority.mjs";

const output = path.resolve(process.argv[2] || "");
if (!output) throw new Error("usage: n8n-ci-rehearsal-fixtures.mjs <empty-output-dir>");
if (fs.existsSync(output) && fs.readdirSync(output).length !== 0) throw new Error("output directory must be empty");
fs.mkdirSync(output, { mode: 0o700, recursive: true });
fs.chmodSync(output, 0o700);

const { inputs, registry } = createSyntheticN8nAuthority();
const result = serializeNineArtifacts(structuredClone(inputs), { registry });
for (const artifact of result.artifacts) {
  fs.writeFileSync(path.join(output, `${artifact.role}.json`), `${JSON.stringify(artifact.workflow, null, 2)}\n`, { mode: 0o600 });
}
fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`, { mode: 0o600 });
