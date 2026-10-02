#!/usr/bin/env node
import { readFileSync } from "node:fs";

const IMAGE = "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const PRIVATE = "pkc_onboarding_private";
const fail = (message) => { throw new Error(`rendered Compose rejected: ${message}`); };
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

if (process.argv.length !== 5) fail("expected BASELINE_ROOT CANDIDATE_ROOT POSTGRES JSON files");
const [baseline, candidate, postgres] = process.argv.slice(2).map(read);
if (!baseline.services?.n8n || !candidate.services?.n8n) fail("n8n service missing");
const candidatePrivate = candidate.networks?.[PRIVATE];
if (candidatePrivate?.external !== true || candidatePrivate.name !== PRIVATE) fail("candidate private network must be external and exact-name");
if (!(PRIVATE in (candidate.services.n8n.networks ?? {}))) fail("n8n does not join the private network");
if (!("root_default" in (candidate.services.n8n.networks ?? {}))) fail("n8n must retain root_default");
if (!candidate.services.n8n.volumes?.some((volume) => volume.type === "volume" && volume.target === "/home/node/.n8n")) fail("n8n SQLite volume authority missing");
for (const key of Object.keys(candidate.services.n8n.environment ?? {})) {
  if (/^(DB_TYPE|DB_POSTGRESDB_|DATABASE_URL)/i.test(key)) fail("n8n database authority changed");
}
const normalized = structuredClone(candidate);
delete normalized.networks[PRIVATE];
delete normalized.services.n8n.networks[PRIVATE];
if (!equal(normalized, baseline)) fail("root Compose changed beyond the one external network attachment");

if (postgres.name !== "pkc-onboarding-postgres") fail("wrong PostgreSQL project");
const service = postgres.services?.postgres;
if (!service || service.image !== IMAGE) fail("PostgreSQL service/image mismatch");
if (Object.hasOwn(service, "ports")) fail("PostgreSQL publishes a host port");
if ("root_default" in (service.networks ?? {})) fail("PostgreSQL joins root_default");
if (Object.keys(service.networks ?? {}).join(",") !== "pkc_private") fail("PostgreSQL must join only pkc_private");
if (postgres.networks?.pkc_private?.name !== PRIVATE || postgres.networks.pkc_private.internal !== true) fail("PostgreSQL network is not exact/private/internal");
if (Object.keys(postgres.networks ?? {}).length !== 1) fail("unexpected PostgreSQL network");
console.log("rendered Compose contract valid");
