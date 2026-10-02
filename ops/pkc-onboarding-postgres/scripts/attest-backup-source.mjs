#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";
import { loadPgClientAuthority } from "../../../db/client-authority.mjs";
import { attestFounderMfaDatabase } from "../../../db/readiness.mjs";

const fail = () => { throw new Error("backup_source_attestation_failed"); };
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function parseArgs(argv) {
  const allowed = new Set(["--backup-dsn", "--backup-pgpass-file", "--verifier-dsn", "--verifier-pgpass-file", "--source-receipt"]);
  if (argv.length !== allowed.size * 2) fail();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || values.has(key) || !value) fail();
    values.set(key, value);
  }
  return Object.fromEntries(values);
}

function readReceipt(path) {
  let bytes;
  let receipt;
  try { bytes = readFileSync(path); receipt = JSON.parse(bytes.toString("utf8")); } catch { fail(); }
  if (!receipt || receipt.schema_version !== 1 || receipt.database !== "pkc_founder_mfa" || receipt.environment !== "production") fail();
  if (!/^[0-9]{10,24}$/.test(String(receipt.system_identifier || ""))) fail();
  if (receipt.postgres_major !== 16 || receipt.tls?.enabled !== true || receipt.durability?.data_checksums !== true) fail();
  if (receipt.private_dns !== "pkc-postgres") fail();
  return { receipt, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function parseTarget(connectionString, expectedUser, expectedDatabase) {
  let target;
  try { target = new URL(connectionString); } catch { fail(); }
  if (target.protocol !== "postgresql:" || target.password || decodeURIComponent(target.username) !== expectedUser) fail();
  if (decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase) fail();
  if (target.searchParams.get("sslmode") !== "verify-full") fail();
  return target;
}

async function makePool(connectionString, pgpassFile, expectedUser, expectedDatabase) {
  const target = parseTarget(connectionString, expectedUser, expectedDatabase);
  const authority = await loadPgClientAuthority({ connectionString, pgpassFile });
  if (typeof authority.password !== "string" || authority.password.length === 0) fail();
  return {
    target,
    pool: new pg.Pool({
      host: target.hostname,
      port: Number(target.port || "5432"),
      user: expectedUser,
      database: expectedDatabase,
      application_name: target.searchParams.get("application_name"),
      password: authority.password,
      ssl: { ...authority.ssl },
      max: 1,
    }),
  };
}

async function liveSnapshot(pool) {
  const result = await pool.query(`
    SELECT current_database() AS database,
           current_user AS user_name,
           pg_catalog.inet_server_addr()::text AS server_address,
           pg_catalog.inet_server_port() AS server_port,
           pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
           pg_catalog.current_setting('pkc.environment', true) AS environment,
           pg_catalog.current_setting('fsync') AS fsync,
           pg_catalog.current_setting('full_page_writes') AS full_page_writes,
           pg_catalog.current_setting('synchronous_commit') AS synchronous_commit,
           s.ssl,
           s.version AS tls_version,
           s.client_dn
      FROM pg_catalog.pg_stat_ssl AS s
     WHERE s.pid = pg_catalog.pg_backend_pid()
  `);
  if (result.rows.length !== 1) fail();
  return result.rows[0];
}

function verifySnapshot(snapshot, expectedUser, expectedDatabase) {
  if (snapshot.database !== expectedDatabase || snapshot.user_name !== expectedUser) fail();
  if (!snapshot.server_address || snapshot.server_port !== 5432 || Math.trunc(snapshot.server_version_num / 10000) !== 16) fail();
  if (snapshot.environment !== "production" || snapshot.fsync !== "on" || snapshot.full_page_writes !== "on" || snapshot.synchronous_commit !== "on") fail();
  if (snapshot.ssl !== true || snapshot.tls_version !== "TLSv1.3" || snapshot.client_dn !== `/CN=${expectedUser}`) fail();
}

export async function attestBackupSource({ backupDsn, backupPgpassFile, verifierDsn, verifierPgpassFile, sourceReceipt }) {
  const source = readReceipt(sourceReceipt);
  const receipt = source.receipt;
  const backup = await makePool(backupDsn, backupPgpassFile, "pkc_backup_reader", receipt.database);
  const verifier = await makePool(verifierDsn, verifierPgpassFile, "pkc_mfa_verifier", receipt.database);
  if (backup.target.hostname !== verifier.target.hostname || (backup.target.port || "5432") !== (verifier.target.port || "5432")) fail();
  if (!LOOPBACK.has(backup.target.hostname) && backup.target.hostname !== receipt.private_dns) fail();
  try {
    const [backupLive, verifierLive] = await Promise.all([liveSnapshot(backup.pool), liveSnapshot(verifier.pool)]);
    verifySnapshot(backupLive, "pkc_backup_reader", receipt.database);
    verifySnapshot(verifierLive, "pkc_mfa_verifier", receipt.database);
    if (backupLive.server_address !== verifierLive.server_address || backupLive.server_port !== verifierLive.server_port) fail();
    const readiness = await attestFounderMfaDatabase({
      pool: verifier.pool,
      expectedDatabase: receipt.database,
      expectedUser: "pkc_mfa_verifier",
      expectedEnvironment: receipt.environment,
      expectedSystemIdentifier: String(receipt.system_identifier),
      expectedServerAddress: verifierLive.server_address,
      expectedServerPort: verifierLive.server_port,
      expectedTls: true,
      authorityState: "runtime-sealed",
      requireZeroRows: false,
    });
    if (readiness.ready !== true) fail();
    return Object.freeze({ ready: true, database: receipt.database, systemIdentifier: String(receipt.system_identifier), sourceReceiptSha256: source.sha256 });
  } finally {
    await Promise.allSettled([backup.pool.end(), verifier.pool.end()]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await attestBackupSource({
    backupDsn: args["--backup-dsn"],
    backupPgpassFile: args["--backup-pgpass-file"],
    verifierDsn: args["--verifier-dsn"],
    verifierPgpassFile: args["--verifier-pgpass-file"],
    sourceReceipt: args["--source-receipt"],
  });
  process.stdout.write(`${JSON.stringify({ready:result.ready,database:result.database,systemIdentifier:result.systemIdentifier,sourceReceiptSha256:result.sourceReceiptSha256})}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error(JSON.stringify({error:"backup_source_attestation_failed"}));
  process.exitCode = 1;
});
