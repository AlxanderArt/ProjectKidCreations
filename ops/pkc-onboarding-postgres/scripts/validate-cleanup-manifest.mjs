#!/usr/bin/env node
import { readFileSync } from "node:fs";
const fail = (message) => { throw new Error(`cleanup manifest rejected: ${message}`); };
if (process.argv.length !== 3) fail("expected one manifest path");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const topKeys = ["deletion_enabled", "expected_volume_count", "schema_version", "volumes"];
if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(topKeys.sort())) fail("top-level keys are not exact");
if (manifest.schema_version !== 1 || manifest.expected_volume_count !== 215 || manifest.deletion_enabled !== false || !Array.isArray(manifest.volumes) || manifest.volumes.length !== 215) fail("215-volume header mismatch");
const seenNames = new Set();
manifest.volumes.forEach((volume, index) => {
  const keys = ["action", "expected_mounted", "labels", "name", "ordinal"];
  if (!volume || JSON.stringify(Object.keys(volume).sort()) !== JSON.stringify(keys.sort())) fail(`volume ${index + 1} keys are not exact`);
  if (volume.ordinal !== index + 1 || typeof volume.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(volume.name) || seenNames.has(volume.name)) fail(`volume ${index + 1} identity invalid`);
  seenNames.add(volume.name);
  if (volume.expected_mounted !== false || volume.action !== "review_only") fail(`volume ${index + 1} is not review-only/unmounted`);
  const labels = volume.labels;
  const labelKeys = ["com.docker.compose.project", "com.docker.compose.volume"];
  if (!labels || JSON.stringify(Object.keys(labels).sort()) !== JSON.stringify(labelKeys.sort()) || !Object.values(labels).every((item) => typeof item === "string" && item.length > 0)) fail(`volume ${index + 1} labels invalid`);
});
console.log("cleanup manifest schema valid; deletion remains disabled");
