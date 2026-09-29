import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATION_LOCK = "68430745190217";
const migrationsRoot = new URL("./migrations/", import.meta.url);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function scanMigrationTransactionControl(sql) {
  if (typeof sql !== "string") throw new TypeError("invalid_migration_sql");
  let clean = "";
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2); index = end < 0 ? sql.length : end; clean += "\n"; continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth += 1; index += 2; }
        else if (sql.startsWith("*/", index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth) throw new Error("unterminated_migration_comment");
      clean += " "; continue;
    }
    if (sql[index] === "'") {
      index += 1;
      let closed = false;
      while (index < sql.length) { if (sql[index] === "'" && sql[index + 1] === "'") index += 2; else if (sql[index++] === "'") { closed = true; break; } }
      if (!closed) throw new Error("unterminated_migration_single_quote");
      clean += "''"; continue;
    }
    const dollar = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, index + dollar.length);
      if (end < 0) throw new Error("unterminated_migration_dollar_quote");
      index = end + dollar.length; clean += " "; continue;
    }
    if (sql[index] === '"') {
      index += 1; let closed = false; while (index < sql.length) { if (sql[index] === '"' && sql[index + 1] === '"') index += 2; else if (sql[index++] === '"') { closed = true; break; } }
      if (!closed) throw new Error("unterminated_migration_double_quote");
      clean += '""'; continue;
    }
    clean += sql[index++];
  }
  const statement = /(?:^|;)\s*(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|COMMIT(?:\s+PREPARED)?|END(?:\s+WORK)?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?|ABORT(?:\s+WORK)?|SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION|PREPARE\s+TRANSACTION)\b/i;
  if (statement.test(clean)) throw new Error("top_level_transaction_control");
  return true;
}

export function validateMigrationLedger(ledger, plan, expectedEnvironment) {
  if (!Array.isArray(ledger) || ledger.length > plan.length) throw new Error("migration_ledger_not_contiguous_prefix");
  for (let index = 0; index < ledger.length; index += 1) {
    const row = ledger[index];
    const migration = plan[index];
    if (!migration || Number(row.version) !== migration.version) throw new Error("migration_ledger_not_contiguous_prefix");
    if (row.filename !== migration.file || row.sha256 !== migration.sha256) throw new Error(`checksum_mismatch:${migration.file}`);
    if (row.environment !== expectedEnvironment) throw new Error("migration_environment_mismatch");
  }
}

export async function loadMigrationPlan() {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", migrationsRoot), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.migrations) || manifest.migrations.length < 1) throw new Error("invalid_migration_manifest");
  const plan = [];
  let previous = 0;
  for (const entry of manifest.migrations) {
    if (!Number.isSafeInteger(entry.version) || entry.version !== previous + 1 || !/^[0-9]{3}_[a-z0-9_]+[.]sql$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("invalid_migration_manifest");
    const bytes = await readFile(new URL(entry.file, migrationsRoot));
    if (sha256(bytes) !== entry.sha256) throw new Error(`checksum_mismatch:${entry.file}`);
    let sql;
    try { sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`invalid_utf8:${entry.file}`); }
    scanMigrationTransactionControl(sql);
    plan.push(Object.freeze({ ...entry, sql }));
    previous = entry.version;
  }
  return Object.freeze(plan);
}

export async function migrate({ pool, expectedDatabase, expectedEnvironment }) {
  if (!pool || typeof pool.connect !== "function" || !/^[a-zA-Z0-9_-]{1,63}$/.test(expectedDatabase || "") || !["development","test","preview","production"].includes(expectedEnvironment)) throw new TypeError("invalid_migration_target");
  const plan = await loadMigrationPlan();
  const client = await pool.connect();
  const applied = [];
  try {
    const identity = (await client.query("SELECT current_database() AS database, current_user AS role")).rows[0];
    if (identity.database !== expectedDatabase || identity.role !== "pkc_mfa_migrator") throw new Error("migration_target_guard_failed");
    const binding = (await client.query(`SELECT pg_catalog.count(*)::integer AS count,pg_catalog.min(pg_catalog.substr(setting,17)) AS environment
      FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
      WHERE s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
        AND s.setrole=0 AND pg_catalog.left(setting,16)='pkc.environment='`)).rows[0];
    if (Number(binding?.count) !== 1 || binding.environment !== expectedEnvironment) throw new Error("migration_environment_binding_failed");
    for (const migration of plan) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK]);
        await client.query("SELECT pg_catalog.set_config('pkc.expected_database',$1,true), pg_catalog.set_config('pkc.expected_environment',$2,true)", [expectedDatabase, expectedEnvironment]);
        await client.query("SET LOCAL ROLE pkc_mfa_owner");
        const ledgerExists = (await client.query("SELECT pg_catalog.to_regclass('pkc_auth.migration_ledger') IS NOT NULL AS present")).rows[0].present;
        const ledger = ledgerExists
          ? (await client.query("SELECT version,filename,sha256,environment FROM pkc_auth.migration_ledger ORDER BY version")).rows
          : [];
        validateMigrationLedger(ledger, plan, expectedEnvironment);
        const existing = ledgerExists
          ? await client.query("SELECT filename,sha256,environment FROM pkc_auth.migration_ledger WHERE version=$1", [migration.version])
          : { rows: [] };
        if (existing.rows.length) {
          const row = existing.rows[0];
          if (row.filename !== migration.file || row.sha256 !== migration.sha256) throw new Error(`checksum_mismatch:${migration.file}`);
          if (row.environment !== expectedEnvironment) throw new Error("migration_environment_mismatch");
          await client.query("ROLLBACK");
          continue;
        }
        await client.query("SET LOCAL ROLE pkc_mfa_owner");
        await client.query(migration.sql);
        await client.query("INSERT INTO pkc_auth.migration_ledger(version,filename,sha256,environment) VALUES($1,$2,$3,$4)", [migration.version, migration.file, migration.sha256, expectedEnvironment]);
        await client.query("RESET ROLE");
        await client.query("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
    return Object.freeze({ applied: Object.freeze(applied), currentVersion: plan.at(-1).version });
  } finally { client.release(); }
}

async function main() {
  const expectedDatabase = process.env.PKC_DATABASE_NAME;
  const expectedEnvironment = process.env.PKC_DATABASE_ENVIRONMENT;
  const pool = new pg.Pool({
    connectionString: process.env.PKC_MIGRATOR_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  try { console.log(JSON.stringify(await migrate({ pool, expectedDatabase, expectedEnvironment }))); } finally { await pool.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ error: "migration_failed", code: typeof error?.code === "string" ? error.code : "unknown", position: typeof error?.position === "string" ? error.position : null }));
  process.exitCode = 1;
});
