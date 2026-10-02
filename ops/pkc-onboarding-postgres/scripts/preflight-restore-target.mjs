#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadPgClientAuthority } from "../../../db/client-authority.mjs";

const fail = (reason = "unknown") => { throw new Error(`restore_target_preflight_failed:${reason}`); };
const REQUIRED = [
  "--connection-string", "--pgpass-file", "--source-receipt",
  "--expected-system-identifier", "--expected-server-address", "--expected-server-port",
  "--expected-database", "--expected-user",
];

function parseArgs(args) {
  if (args.length !== REQUIRED.length * 2) fail();
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!REQUIRED.includes(name) || values.has(name) || typeof value !== "string" || value.length === 0) fail();
    values.set(name, value);
  }
  if (REQUIRED.some((name) => !values.has(name))) fail();
  return values;
}

export async function attestEmptyRestoreTarget(options) {
  const {
    connectionString, pgpassFile, sourceReceiptPath, expectedSystemIdentifier,
    expectedServerAddress, expectedServerPort, expectedDatabase, expectedUser,
  } = options;
  if (expectedDatabase !== "pkc_founder_mfa_restore_drill" || expectedUser !== "pkc_bootstrap_admin") fail("declared_authority");
  if (!/^[1-9][0-9]{15,24}$/.test(expectedSystemIdentifier)
      || !Number.isInteger(expectedServerPort) || expectedServerPort < 1 || expectedServerPort > 65535
      || typeof expectedServerAddress !== "string" || expectedServerAddress.length === 0) fail("declared_identity");

  let target;
  try { target = new URL(connectionString); } catch { fail("target_url"); }
  if (decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase
      || decodeURIComponent(target.username) !== expectedUser
      || !["127.0.0.1", "::1", "localhost"].includes(target.hostname)) fail("target_url_identity");

  let sourceReceipt;
  try { sourceReceipt = JSON.parse(readFileSync(sourceReceiptPath, "utf8")); } catch { fail("source_receipt_read"); }
  if (!sourceReceipt || sourceReceipt.database !== "pkc_founder_mfa"
      || !/^[1-9][0-9]{15,24}$/.test(sourceReceipt.system_identifier)
      || sourceReceipt.system_identifier === expectedSystemIdentifier) fail("source_receipt_identity");

  let authority;
  try { authority = await loadPgClientAuthority({ connectionString, pgpassFile }); } catch { fail("client_authority"); }
  if (typeof authority.password !== "string") fail("client_authority_password_type");
  const pool = new pg.Pool({
    host: target.hostname,
    port: Number(target.port || "5432"),
    user: decodeURIComponent(target.username),
    database: decodeURIComponent(target.pathname.slice(1)),
    application_name: target.searchParams.get("application_name"),
    password: authority.password,
    ssl: { ...authority.ssl },
    max: 1,
  });
  try {
    let client;
    try { client = await pool.connect(); } catch (error) {
      if (["28P01", "28000"].includes(String(error?.code || ""))) fail("connection_auth");
      if (/certificate|tls|ssl|hostname|altname/i.test(String(error?.message || ""))) fail("connection_tls");
      if (/cannot redefine property/i.test(String(error?.message || ""))) fail("connection_config");
      if (/password must be a string/i.test(String(error?.message || ""))) fail("connection_scram_password_type");
      if (/server signature/i.test(String(error?.message || ""))) fail("connection_scram_signature");
      if (/sasl|scram/i.test(String(error?.message || ""))) fail("connection_scram_other");
      if (/^E(?:CONN|HOST|NET|PIPE)/.test(String(error?.code || ""))) fail("connection_network");
      fail("connection_other");
    }
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE");
      const identity = (await client.query(`SELECT pg_catalog.current_database() AS database,
        current_user AS current_user,
        (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier,
        pg_catalog.inet_server_addr()::text AS server_address,
        pg_catalog.inet_server_port() AS server_port,
        pg_catalog.current_setting('server_version_num') AS server_version_num,
        pg_catalog.current_setting('fsync') AS fsync,
        pg_catalog.current_setting('full_page_writes') AS full_page_writes,
        pg_catalog.current_setting('synchronous_commit') AS synchronous_commit`)).rows[0];
      const tls = (await client.query("SELECT ssl, version, client_dn FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()")).rows[0];
      const inventory = (await client.query(`SELECT
        pg_catalog.to_regnamespace('pkc_auth') IS NOT NULL AS has_pkc_schema,
        (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast') AS relation_count`)).rows[0];
      if (identity.database !== expectedDatabase || identity.current_user !== expectedUser) fail("session_identity");
      if (identity.system_identifier !== expectedSystemIdentifier
          || identity.server_address !== expectedServerAddress || Number(identity.server_port) !== expectedServerPort) fail("server_identity");
      if (Number(identity.server_version_num) < 160000 || Number(identity.server_version_num) >= 170000) fail("server_version");
      if (identity.fsync !== "on" || identity.full_page_writes !== "on" || identity.synchronous_commit !== "on") fail("durability");
      if (tls?.ssl !== true || !String(tls.version || "").startsWith("TLSv1.3") || tls.client_dn !== "/CN=pkc_bootstrap_admin") fail("tls_identity");
      if (inventory?.has_pkc_schema !== false || Number(inventory?.relation_count) !== 0) fail("target_not_empty");
      await client.query("COMMIT");
      return Object.freeze({ database: identity.database, user: identity.current_user, systemIdentifier: identity.system_identifier });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (String(error?.message || "").startsWith("restore_target_preflight_failed:")) throw error;
      fail("query");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  await attestEmptyRestoreTarget({
    connectionString: values.get("--connection-string"),
    pgpassFile: values.get("--pgpass-file"),
    sourceReceiptPath: values.get("--source-receipt"),
    expectedSystemIdentifier: values.get("--expected-system-identifier"),
    expectedServerAddress: values.get("--expected-server-address"),
    expectedServerPort: Number(values.get("--expected-server-port")),
    expectedDatabase: values.get("--expected-database"),
    expectedUser: values.get("--expected-user"),
  });
  process.stdout.write("restore_target_preflight_pass=true\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = String(error?.message || "restore_target_preflight_failed");
    const diagnostic = process.env.PKC_NATIVE_TEST_DIAGNOSTICS === "1" && /^restore_target_preflight_failed:[a-z_]+$/.test(message) ? message : "restore_target_preflight_failed";
    process.stderr.write(`${diagnostic}\n`);
    process.exitCode = 1;
  });
}
