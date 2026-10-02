#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const IMAGE = "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const fail = (message) => { throw new Error(`cluster receipt rejected: ${message}`); };
const exactKeys = (value, expected, at) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${at} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(`${at} keys are not exact`);
};

export function validateClusterReceiptBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16384) fail("receipt bytes invalid");
  const receipt = JSON.parse(bytes.toString("utf8"));
  exactKeys(receipt, ["schema_version", "compose_project", "service", "image", "volume", "private_dns", "database", "environment", "postgres_major", "system_identifier", "tls", "durability"], "receipt");
  const expected = {
    schema_version: 1,
    compose_project: "pkc-onboarding-postgres",
    service: "postgres",
    image: IMAGE,
    volume: "pkc_onboarding_postgres_data",
    private_dns: "pkc-postgres",
    database: "pkc_founder_mfa",
    environment: "production",
    postgres_major: 16
  };
  for (const [key, value] of Object.entries(expected)) if (receipt[key] !== value) fail(`${key} mismatch`);
  if (!/^[1-9][0-9]{15,24}$/.test(receipt.system_identifier)) fail("system_identifier must be an exact decimal string");
  exactKeys(receipt.tls, ["enabled", "minimum_protocol", "client_certificate_verification", "server_name"], "tls");
  if (receipt.tls.enabled !== true || receipt.tls.minimum_protocol !== "TLSv1.3" || receipt.tls.client_certificate_verification !== "verify-full" || receipt.tls.server_name !== "pkc-postgres") fail("TLS identity mismatch");
  exactKeys(receipt.durability, ["fsync", "synchronous_commit", "full_page_writes", "data_checksums"], "durability");
  if (receipt.durability.fsync !== true || receipt.durability.synchronous_commit !== "on" || receipt.durability.full_page_writes !== true || receipt.durability.data_checksums !== true) fail("durability mismatch");
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) fail("expected one receipt JSON path");
  validateClusterReceiptBytes(readFileSync(process.argv[2]));
  console.log("cluster identity receipt valid");
}
