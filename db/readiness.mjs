import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { loadMigrationPlan } from "./migrate.mjs";
import { loadPgClientAuthority } from "./client-authority.mjs";

const EXPECTED_ROLES = Object.freeze(["pkc_backup_reader","pkc_mfa_owner","pkc_mfa_migrator","pkc_mfa_runtime","pkc_mfa_verifier","pkc_mfa_outbox_worker","pkc_onboarding_runtime","pkc_onboarding_email_worker","pkc_onboarding_email_reconciler"]);
const EXPECTED_TABLES = Object.freeze(["founder_mfa_audit_events","founder_mfa_challenges","founder_mfa_enrollment_authorizations","founder_mfa_factors","founder_mfa_finalizations","founder_mfa_outbox","founder_mfa_recovery_codes","founder_mfa_recovery_operations","migration_ledger","onboarding_email_outbox","onboarding_submission_claims"]);
const EXPECTED_RELATIONS = Object.freeze([
  ["founder_mfa_audit_events", "r"], ["founder_mfa_audit_events_created", "i"], ["founder_mfa_audit_events_pkey", "i"],
  ["founder_mfa_challenges", "r"], ["founder_mfa_challenges_factor_id_challenge_id_key", "i"], ["founder_mfa_challenges_handoff_jti_key", "i"],
  ["founder_mfa_challenges_login_attempt", "i"], ["founder_mfa_challenges_one_pending_per_factor", "i"], ["founder_mfa_challenges_pkey", "i"], ["founder_mfa_challenges_token_hash_key", "i"],
  ["founder_mfa_enrollment_authorizations", "r"], ["founder_mfa_enrollment_authorizations_approval_id_key", "i"], ["founder_mfa_enrollment_authorizations_pkey", "i"],
  ["founder_mfa_factors", "r"], ["founder_mfa_factors_founder_subject_key", "i"], ["founder_mfa_factors_pkey", "i"],
  ["founder_mfa_finalizations", "r"], ["founder_mfa_finalizations_challenge_id_key", "i"], ["founder_mfa_finalizations_factor_id_finalize_id_key", "i"], ["founder_mfa_finalizations_grant_hash_key", "i"], ["founder_mfa_finalizations_grant_jti_key", "i"], ["founder_mfa_finalizations_pkey", "i"], ["founder_mfa_finalizations_session_id_key", "i"],
  ["founder_mfa_one_current_enrollment_authorization", "i"],
  ["founder_mfa_outbox", "r"], ["founder_mfa_outbox_dispatch", "i"], ["founder_mfa_outbox_operation_key_key", "i"], ["founder_mfa_outbox_pkey", "i"],
  ["founder_mfa_recovery_codes", "r"], ["founder_mfa_recovery_codes_factor_id_code_hash_key", "i"], ["founder_mfa_recovery_codes_pkey", "i"],
  ["founder_mfa_recovery_operations", "r"], ["founder_mfa_recovery_operations_pkey", "i"],
  ["migration_ledger", "r"], ["migration_ledger_filename_key", "i"], ["migration_ledger_pkey", "i"],
  ["onboarding_email_outbox", "r"], ["onboarding_email_outbox_dispatch", "i"], ["onboarding_email_outbox_operation_key_key", "i"], ["onboarding_email_outbox_pkey", "i"], ["onboarding_email_outbox_reconciliation", "i"], ["onboarding_email_outbox_submission_id_key", "i"],
  ["onboarding_submission_claims", "r"], ["onboarding_submission_claims_pkey", "i"],
]);
const WORKER_FUNCTIONS = Object.freeze(["claim_founder_mfa_outbox","claim_founder_mfa_outbox_reconciliation","complete_founder_mfa_outbox","defer_founder_mfa_outbox_reconciliation","founder_mfa_outbox_monitor","mark_founder_mfa_outbox_unknown","reconcile_founder_mfa_outbox"]);
const ONBOARDING_FUNCTIONS = Object.freeze(["accept_onboarding_email_outbox","arm_onboarding_email_outbox","claim_onboarding_email_outbox","claim_onboarding_email_outbox_reconciliation","claim_onboarding_submission","defer_onboarding_email_reconciliation","mark_onboarding_email_ambiguous","mark_onboarding_submission_persisted","reconcile_onboarding_email_accepted"]);
const ONBOARDING_DISPATCH_FUNCTIONS = Object.freeze(["accept_onboarding_email_outbox","arm_onboarding_email_outbox","claim_onboarding_email_outbox","mark_onboarding_email_ambiguous"]);
const ONBOARDING_RECONCILIATION_FUNCTIONS = Object.freeze(["claim_onboarding_email_outbox_reconciliation","defer_onboarding_email_reconciliation","reconcile_onboarding_email_accepted"]);
const ONBOARDING_RUNTIME_FUNCTIONS = Object.freeze(["claim_onboarding_submission","mark_onboarding_submission_persisted"]);
const EXPECTED_FUNCTIONS = Object.freeze([...WORKER_FUNCTIONS, ...ONBOARDING_FUNCTIONS, "prevent_audit_mutation", "prevent_enrollment_authorization_rewrite", "prevent_onboarding_claim_rewrite", "prevent_onboarding_email_identity_rewrite", "prevent_recovery_operation_mutation"].sort());
const MIGRATION_LOCK = "68430745190217";
const CATALOG_DIGESTS = Object.freeze({
  constraints: "d3b09a0086ef026ee225da7857f7bd512d08a48763e9e140672fff197e2c2065",

  triggers: "a728392de4f29bfcd0bb0ed9770071cb3b4e278d4c14c9ba5f1b7d580bf5e682",
  relationAcls: "7da56add704ecbd0bd2db479594f9b746ae0f0a9aff908d00e08d906f4c1790c",

  indexes: "3aed5d5a8e2594fbd78b2131bc7c73dcb10e4ba2b804cc91cc3581184024637f",

  defaultAcls: "64451befe501c16b4d07a531c39e3b91d8ed7a15a6d2512dc15f4b68a08dbfdd",
});

function invariant(condition, code) { if (!condition) throw new Error(`readiness_failed:${code}`); }
function rows(result) { invariant(result && Array.isArray(result.rows), "invalid_driver_result"); return result.rows; }
function hasPublicAcl(value) { return /(?:^|[{,])"?=/.test(String(value ?? "")); }
function digestRows(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function expectedFunctionSemantics(plan) {
  const expected = new Map();
  const expression = /CREATE FUNCTION pkc_auth\.([a-z0-9_]+)\(([^)]*)\)\s*RETURNS\s+(TABLE\([^]*?\)|trigger)\s+LANGUAGE\s+(plpgsql|sql)([^]*?)\s+AS \$\$([^]*?)\$\$;/gi;
  for (const migration of plan) {
    for (const match of migration.sql.matchAll(expression)) {
      const [, name, rawArgs, rawResult, language, attributes, source] = match;
      invariant(!expected.has(name), `duplicate_expected_function:${name}`);
      const args = rawArgs.split(",").map((value)=>value.trim()).filter(Boolean).join(", ");
      const result = rawResult.replace(/,\s*/g, ", ");
      expected.set(name, Object.freeze({ args, result, language:language.toLowerCase(), volatility:/\bSTABLE\b/i.test(attributes)?"s":"v", source }));
    }
  }
  invariant(expected.size===EXPECTED_FUNCTIONS.length, "migration_function_source_inventory");
  return expected;
}

export async function attestFounderMfaDatabase({ pool, expectedDatabase, expectedUser, expectedEnvironment, expectedSystemIdentifier, expectedServerAddress, expectedServerPort, expectedTls = true, expectedBootstrapRole = "pkc_bootstrap_admin", authorityState = "runtime-sealed", requireZeroRows = false }) {
  invariant(pool && typeof pool.connect === "function", "invalid_pool");
  invariant(["development","test","preview","production"].includes(expectedEnvironment), "expectedEnvironment");
  invariant(/^[1-9][0-9]{0,19}$/.test(expectedSystemIdentifier || ""), "expectedSystemIdentifier");
  invariant(typeof expectedServerAddress === "string" && expectedServerAddress.length > 0, "expectedServerAddress");
  invariant(Number.isInteger(expectedServerPort) && expectedServerPort >= 1 && expectedServerPort <= 65535, "expectedServerPort");
  invariant(["runtime-sealed", "migrator-sealed", "migration-window"].includes(authorityState), "authority_state");
  invariant(expectedBootstrapRole === "pkc_bootstrap_admin", "expected_bootstrap_role");
  invariant(typeof requireZeroRows === "boolean", "require_zero_rows");
  const plan = await loadMigrationPlan();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK]);
    const identity = rows(await client.query(`SELECT current_database() AS database,current_user AS role,
      current_setting('server_version_num')::integer AS server_version_num,
      pg_catalog.inet_server_addr()::text AS server_address,pg_catalog.inet_server_port() AS server_port,
      (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier,
      current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS synchronous_commit`))[0];
    invariant(identity.database === expectedDatabase, "expectedDatabase");
    invariant(identity.role === expectedUser, "expectedUser");
    invariant(identity.system_identifier === expectedSystemIdentifier, "system_identifier");
    invariant(identity.server_address === expectedServerAddress && Number(identity.server_port) === expectedServerPort, "server_identity");
    const binding = rows(await client.query(`SELECT pg_catalog.count(*)::integer AS count,pg_catalog.min(pg_catalog.substr(setting,17)) AS environment
      FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
      WHERE s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
        AND s.setrole=0 AND pg_catalog.left(setting,16)='pkc.environment='`))[0];
    invariant(Number(binding?.count)===1 && binding.environment===expectedEnvironment, "database_environment_binding");
    const serverVersion = Number(identity.server_version_num);
    invariant(serverVersion >= 160000 && serverVersion < 170000, "server_version_num_postgresql_16");
    invariant(identity.fsync === "on" && identity.full_page_writes === "on" && identity.synchronous_commit === "on", "durability_settings");
    if (expectedTls) invariant(rows(await client.query("SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()"))[0]?.ssl === true, "tls");
    const databaseAuthority = rows(await client.query(`SELECT owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable
      FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) x
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE d.datname=pg_catalog.current_database() ORDER BY 2,3,4`));
    const expectedDatabaseAcl = [
      ['pkc_backup_reader','CONNECT'],
      ['pkc_mfa_migrator','CONNECT'],['pkc_mfa_outbox_worker','CONNECT'],
      ['pkc_mfa_owner','CONNECT'],['pkc_mfa_owner','CREATE'],['pkc_mfa_owner','TEMPORARY'],
      ['pkc_mfa_runtime','CONNECT'],['pkc_mfa_verifier','CONNECT'],
      ['pkc_onboarding_email_reconciler','CONNECT'],
      ['pkc_onboarding_email_worker','CONNECT'],['pkc_onboarding_runtime','CONNECT'],
    ];
    invariant(databaseAuthority.every((row)=>row.owner==='pkc_mfa_owner' && !row.is_grantable)
      && JSON.stringify(databaseAuthority.map((row)=>[row.grantee,row.privilege_type]))===JSON.stringify(expectedDatabaseAcl), "database_owner_acl");
    const publicSchema = rows(await client.query("SELECT owner.rolname AS owner,n.nspacl FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner WHERE n.nspname='public'"));
    invariant(publicSchema.length===1 && publicSchema[0].owner==='pg_database_owner' && !hasPublicAcl(publicSchema[0].nspacl), "public_schema_owner_acl");

    const ledger = rows(await client.query("SELECT version,filename,sha256,environment FROM pkc_auth.migration_ledger ORDER BY version"));
    invariant(JSON.stringify(ledger.map((r) => ({ ...r, version: Number(r.version) }))) === JSON.stringify(plan.map(({ version,file,sha256 }) => ({ version,filename:file,sha256,environment:expectedEnvironment }))), "migration_ledger");

    const roles = rows(await client.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=ANY($1) ORDER BY rolname", [EXPECTED_ROLES]));
    invariant(roles.length === EXPECTED_ROLES.length, "pg_authid_roles");
    for (const role of roles) {
      invariant(!role.rolsuper && !role.rolinherit && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication && !role.rolbypassrls, `role_attributes:${role.rolname}`);
      const expectedLogin = role.rolname === "pkc_mfa_migrator" ? authorityState === "migration-window" : role.rolname !== "pkc_mfa_owner";
      invariant(role.rolcanlogin === expectedLogin, `role_login:${role.rolname}`);
    }
    const superusers = rows(await client.query("SELECT rolname,rolcanlogin FROM pg_roles WHERE rolsuper ORDER BY rolname"));
    invariant(superusers.length === 1 && superusers[0].rolname === expectedBootstrapRole, "bootstrap_superuser_inventory");
    invariant(superusers[0].rolcanlogin === (authorityState !== "runtime-sealed"), "bootstrap_login_state");
    const controlSystemGrantees = rows(await client.query("SELECT COALESCE(r.rolname,'PUBLIC') AS grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid='pg_catalog.pg_control_system()'::regprocedure AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner ORDER BY 1"));
    invariant(JSON.stringify(controlSystemGrantees.map(({ grantee }) => grantee)) === JSON.stringify(["pkc_mfa_migrator","pkc_mfa_verifier"]), "control_system_acl");
    const roleSettings = rows(await client.query(`SELECT r.rolname,setting
      FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
      CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
      WHERE s.setdatabase=0 AND r.rolname=ANY($1) ORDER BY r.rolname,setting`, [["pkc_backup_reader","pkc_mfa_outbox_worker","pkc_mfa_runtime","pkc_onboarding_email_reconciler","pkc_onboarding_email_worker","pkc_onboarding_runtime"]]));
    const expectedRoleSettings = ["pkc_mfa_outbox_worker","pkc_mfa_runtime","pkc_onboarding_email_reconciler","pkc_onboarding_email_worker","pkc_onboarding_runtime"]
      .flatMap((rolname)=>["idle_in_transaction_session_timeout=10s","lock_timeout=2s","statement_timeout=5s"].map((setting)=>({rolname,setting})))
      .concat(["idle_in_transaction_session_timeout=10s","lock_timeout=5s","statement_timeout=30min"].map((setting)=>({rolname:"pkc_backup_reader",setting})))
      .sort((a,b)=>a.rolname.localeCompare(b.rolname)||a.setting.localeCompare(b.setting));
    invariant(JSON.stringify(roleSettings)===JSON.stringify(expectedRoleSettings), "role_settings");
    const databaseSpecificRoleSettings = rows(await client.query(`SELECT r.rolname,setting
      FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
      CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
      WHERE s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
        AND r.rolname=ANY($1) ORDER BY r.rolname,setting`, [["pkc_backup_reader","pkc_mfa_outbox_worker","pkc_mfa_runtime","pkc_onboarding_email_reconciler","pkc_onboarding_email_worker","pkc_onboarding_runtime"]]));
    invariant(databaseSpecificRoleSettings.length===0, "database_specific_role_settings");
    const memberships = rows(await client.query("SELECT member.rolname AS member,parent.rolname AS parent,m.admin_option,m.inherit_option,m.set_option FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles member ON member.oid=m.member JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid WHERE member.rolname=ANY($1) OR parent.rolname=ANY($1) ORDER BY 1,2", [EXPECTED_ROLES]));
    const expectedMemberships = authorityState === "migration-window" ? [{ member:"pkc_mfa_migrator", parent:"pkc_mfa_owner", admin_option:false, inherit_option:false, set_option:true }] : [];
    invariant(JSON.stringify(memberships) === JSON.stringify(expectedMemberships), "role_graph");

    const schema = rows(await client.query("SELECT n.nspname,owner.rolname AS owner,n.nspacl FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner WHERE n.nspname='pkc_auth'"));
    invariant(schema.length===1 && schema[0].owner==="pkc_mfa_owner" && !hasPublicAcl(schema[0].nspacl), "nspacl_owner");
    const schemaAcl = rows(await client.query("SELECT n.nspname,owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE n.nspname='pkc_auth' ORDER BY 3,4,5"));
    const expectedSchemaAcl = [
      ["pkc_backup_reader","USAGE"],
      ["pkc_mfa_outbox_worker","USAGE"],["pkc_mfa_owner","CREATE"],["pkc_mfa_owner","USAGE"],
      ["pkc_mfa_runtime","USAGE"],["pkc_mfa_verifier","USAGE"],["pkc_onboarding_email_reconciler","USAGE"],
      ["pkc_onboarding_email_worker","USAGE"],["pkc_onboarding_runtime","USAGE"],
    ];
    invariant(schemaAcl.every((row)=>row.nspname==='pkc_auth'&&row.owner==='pkc_mfa_owner'&&!row.is_grantable)
      && JSON.stringify(schemaAcl.map((row)=>[row.grantee,row.privilege_type]))===JSON.stringify(expectedSchemaAcl), "schema_acl");
    const relations = rows(await client.query("SELECT c.relname,c.relkind,owner.rolname AS owner,c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner WHERE n.nspname='pkc_auth' ORDER BY c.relname"));
    invariant(JSON.stringify(relations.map((entry)=>[entry.relname,entry.relkind]))===JSON.stringify(EXPECTED_RELATIONS), "closed_relation_inventory");
    const tableNames = relations.filter((r)=>r.relkind==='r').map((r)=>r.relname);
    invariant(JSON.stringify(tableNames)===JSON.stringify(EXPECTED_TABLES), "tables");
    invariant(relations.every((r)=>r.owner==='pkc_mfa_owner' && !hasPublicAcl(r.relacl)), "relacl_owners");
    const relationAcls = rows(await client.query(`SELECT c.relname,c.relkind,owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) x
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE n.nspname='pkc_auth' AND c.relkind IN ('r','S') ORDER BY 1,2,4,5,6`));
    invariant(digestRows(relationAcls)===CATALOG_DIGESTS.relationAcls, `relation_acls:${digestRows(relationAcls)}`);
    const columnAcls = rows(await client.query(`SELECT c.relname,a.attname,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee
      WHERE n.nspname='pkc_auth' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,3,4,5`));
    invariant(columnAcls.length===0, "column_acls");
    const rls = rows(await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_catalog.count(p.oid)::integer AS policy_count
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
      WHERE n.nspname='pkc_auth' AND c.relkind='r' GROUP BY c.relname,c.relrowsecurity,c.relforcerowsecurity ORDER BY c.relname`));
    invariant(rls.length===EXPECTED_TABLES.length && rls.every((row)=>row.relrowsecurity===false && row.relforcerowsecurity===false && Number(row.policy_count)===0), "explicit_no_rls_design");
    const forbiddenOwnership = rows(await client.query(`SELECT r.rolname,
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_database d WHERE d.datdba=r.oid)
      +(SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
      +(SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
      +(SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid)
      +(SELECT pg_catalog.count(*) FROM pg_catalog.pg_type t WHERE t.typowner=r.oid AND t.typtype IN ('e','d','c','r','m')) AS count
      FROM pg_catalog.pg_roles r WHERE r.rolname=ANY($1) ORDER BY r.rolname`, [["pkc_mfa_migrator","pkc_mfa_outbox_worker","pkc_mfa_runtime","pkc_mfa_verifier","pkc_onboarding_email_reconciler","pkc_onboarding_email_worker","pkc_onboarding_runtime"]]));
    invariant(forbiddenOwnership.length===7 && forbiddenOwnership.every((row)=>Number(row.count)===0), "migrator_runtime_verifier_worker_ownership_absence");
    if (requireZeroRows) {
      const realRows = rows(await client.query(`SELECT
        (SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_factors)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_challenges)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_enrollment_authorizations)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_recovery_codes)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_finalizations)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_outbox)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_recovery_operations)
        +(SELECT pg_catalog.count(*) FROM pkc_auth.founder_mfa_audit_events) AS count`))[0];
      realRows.count = Number(realRows.count)
        + Number((await client.query("SELECT (SELECT pg_catalog.count(*) FROM pkc_auth.onboarding_submission_claims)+(SELECT pg_catalog.count(*) FROM pkc_auth.onboarding_email_outbox) AS count")).rows[0].count);
      invariant(Number(realRows.count)===0, "zero_real_mfa_rows");
    }

    const functions = rows(await client.query("SELECT p.proname,owner.rolname AS owner,p.prosecdef,p.proacl,p.proconfig,p.prosrc,pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner WHERE n.nspname='pkc_auth' ORDER BY p.proname"));
    invariant(JSON.stringify(functions.map((entry)=>entry.proname))===JSON.stringify(EXPECTED_FUNCTIONS), "function_inventory");
    const explicitTypes = rows(await client.query("SELECT t.typname,t.typtype,COALESCE(c.relkind::text,'') AS relkind,owner.rolname AS owner FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace JOIN pg_catalog.pg_roles owner ON owner.oid=t.typowner LEFT JOIN pg_catalog.pg_class c ON c.oid=t.typrelid WHERE n.nspname='pkc_auth' AND (t.typtype IN ('e','d','r','m') OR (t.typtype='c' AND c.relkind='c')) ORDER BY t.typname"));
    invariant(explicitTypes.length===0, "explicit_type_inventory");
    for (const name of [...WORKER_FUNCTIONS, ...ONBOARDING_FUNCTIONS]) {
      const fn = functions.find((entry)=>entry.proname===name);
      invariant(fn && fn.owner==='pkc_mfa_owner' && fn.prosecdef && Array.isArray(fn.proconfig) && fn.proconfig.includes('search_path=pg_catalog, pkc_auth') && !hasPublicAcl(fn.proacl), `functions:${name}:proacl:prosecdef:proconfig`);
    }
    const functionSemantics = rows(await client.query("SELECT p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,pg_catalog.pg_get_function_result(p.oid) AS result,l.lanname,p.prosecdef,p.provolatile,p.proisstrict,p.proconfig,p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='pkc_auth' ORDER BY p.proname,args"));
    const sourceSemantics = expectedFunctionSemantics(plan);
    invariant(functionSemantics.length===sourceSemantics.size && functionSemantics.every((entry)=>{
      const expected=sourceSemantics.get(entry.proname);
      return expected && entry.args===expected.args && entry.result===expected.result && entry.lanname===expected.language
        && entry.prosecdef===true && entry.provolatile===expected.volatility && entry.proisstrict===false
        && JSON.stringify(entry.proconfig)===JSON.stringify(["search_path=pg_catalog, pkc_auth"]) && entry.prosrc===expected.source;
    }), "function_semantics_source_fingerprint");
    const functionAcls = rows(await client.query("SELECT p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE n.nspname='pkc_auth' ORDER BY 1,2,4,5,6"));
    const expectedFunctionGrantees = new Map(EXPECTED_FUNCTIONS.map((name)=>[name,["pkc_mfa_owner"]]));
    for (const name of WORKER_FUNCTIONS) expectedFunctionGrantees.get(name).push("pkc_mfa_outbox_worker");
    expectedFunctionGrantees.get("founder_mfa_outbox_monitor").push("pkc_mfa_verifier");
    for (const name of ONBOARDING_RUNTIME_FUNCTIONS) expectedFunctionGrantees.get(name).push("pkc_onboarding_runtime");
    for (const name of ONBOARDING_DISPATCH_FUNCTIONS) expectedFunctionGrantees.get(name).push("pkc_onboarding_email_worker");
    for (const name of ONBOARDING_RECONCILIATION_FUNCTIONS) expectedFunctionGrantees.get(name).push("pkc_onboarding_email_reconciler");
    const expectedFunctionAcls = functionSemantics.flatMap((fn)=>expectedFunctionGrantees.get(fn.proname).sort().map((grantee)=>({
      proname:fn.proname,args:fn.args,owner:"pkc_mfa_owner",grantee,privilege_type:"EXECUTE",is_grantable:false,
    }))).sort((a,b)=>a.proname.localeCompare(b.proname)||a.args.localeCompare(b.args)||a.grantee.localeCompare(b.grantee));
    invariant(JSON.stringify(functionAcls)===JSON.stringify(expectedFunctionAcls), "function_acls");
    const constraints = rows(await client.query("SELECT conname,pg_catalog.pg_get_constraintdef(oid,true) AS definition,convalidated FROM pg_catalog.pg_constraint WHERE connamespace='pkc_auth'::regnamespace ORDER BY conname"));
    invariant(digestRows(constraints)===CATALOG_DIGESTS.constraints, `constraints:${digestRows(constraints)}`);
    const indexes = rows(await client.query("SELECT t.relname AS table_name,i.relname AS index_name,x.indisunique,x.indisprimary,x.indisvalid,x.indisready,pg_catalog.pg_get_indexdef(x.indexrelid) AS definition FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='pkc_auth' ORDER BY t.relname,i.relname"));
    invariant(digestRows(indexes)===CATALOG_DIGESTS.indexes, `indexes:${digestRows(indexes)}`);
    const triggers = rows(await client.query("SELECT c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid,true) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pkc_auth' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname"));
    invariant(digestRows(triggers)===CATALOG_DIGESTS.triggers, `triggers:${digestRows(triggers)}`);
    const defaults = rows(await client.query("SELECT d.defaclobjtype,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE owner.rolname='pkc_mfa_owner' AND n.nspname='pkc_auth' ORDER BY 1,2,3,4"));
    invariant(digestRows(defaults)===CATALOG_DIGESTS.defaultAcls, `default_acl:${digestRows(defaults)}`);
    return Object.freeze({ ready:true,database:identity.database,user:identity.role,postgresMajor:16,authorityState,zeroRowsRequired:requireZeroRows,version:Number(ledger.at(-1).version),checksum:createHash('sha256').update(JSON.stringify(ledger)).digest('hex') });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function main() {
  if (process.env.PGPASSWORD) throw new Error("descriptor_safe_pgpassfile_required");
  const clientAuthority=await loadPgClientAuthority({connectionString:process.env.PKC_DATABASE_URL,pgpassFile:process.env.PGPASSFILE});
  const pool=new pg.Pool({...clientAuthority,ssl:{...clientAuthority.ssl},max:1,connectionTimeoutMillis:5000,query_timeout:6000,statement_timeout:5000,idle_in_transaction_session_timeout:10000});
  try { console.log(JSON.stringify(await attestFounderMfaDatabase({pool,expectedDatabase:process.env.PKC_DATABASE_NAME,expectedUser:process.env.PKC_DATABASE_USER,expectedEnvironment:process.env.PKC_DATABASE_ENVIRONMENT,expectedSystemIdentifier:process.env.PKC_DATABASE_SYSTEM_IDENTIFIER,expectedServerAddress:process.env.PKC_DATABASE_SERVER_ADDRESS,expectedServerPort:Number(process.env.PKC_DATABASE_SERVER_PORT),expectedTls:true}))); } finally { await pool.end(); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) main().catch((error)=>{console.error(error?.message||"readiness_failed");process.exitCode=1;});
