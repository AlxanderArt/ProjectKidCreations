import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { loadMigrationPlan } from "./migrate.mjs";

const EXPECTED_ROLES = Object.freeze(["pkc_mfa_owner","pkc_mfa_migrator","pkc_mfa_runtime","pkc_mfa_verifier","pkc_mfa_outbox_worker"]);
const EXPECTED_TABLES = Object.freeze(["founder_mfa_audit_events","founder_mfa_challenges","founder_mfa_factors","founder_mfa_finalizations","founder_mfa_outbox","founder_mfa_recovery_codes","migration_ledger"]);
const WORKER_FUNCTIONS = Object.freeze(["claim_founder_mfa_outbox","claim_founder_mfa_outbox_reconciliation","complete_founder_mfa_outbox","defer_founder_mfa_outbox_reconciliation","founder_mfa_outbox_monitor","mark_founder_mfa_outbox_unknown","reconcile_founder_mfa_outbox"]);
const CATALOG_DIGESTS = Object.freeze({
  constraints: "2793dc1030ca82f770bb64a1dba31011626809ccbca8d262e1cbf4b6e63d9c91",
  functions: "5ce8a9ae77438c4d3773bdb6f068ad42f6f2760b416bc8ac1ab942dc46e5a804",
  triggers: "ccefc5e166e00169cbc9ee399b08b09f8255944c0aee2a447cd2ac4df619422e",
  relationAcls: "2b445e995d519930701f1e6612271cd5f3a4ef9b1108bf826db7f2b92187503e",
  functionAcls: "fdedd3b8e49d9b9242e966a9ef40a7a31a54568eb28b7d589e48beb78ee0d01d",
  indexes: "112c23fce61e1bf8aa34204c48b1b1d129f840bdd19c88d17129466d8680a763",
  schemaAcl: "9f5f66938b5d69cbbb4acce4484a5bb0595250ce0094dd0749da74dc3fc975f5",
  defaultAcls: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
});

function invariant(condition, code) { if (!condition) throw new Error(`readiness_failed:${code}`); }
function rows(result) { invariant(result && Array.isArray(result.rows), "invalid_driver_result"); return result.rows; }
function hasPublicAcl(value) { return /(?:^|[{,])"?=/.test(String(value ?? "")); }
function digestRows(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function attestFounderMfaDatabase({ pool, expectedDatabase, expectedUser, expectedEnvironment, expectedTls = true }) {
  invariant(pool && typeof pool.connect === "function", "invalid_pool");
  invariant(["development","test","preview","production"].includes(expectedEnvironment), "expectedEnvironment");
  const plan = await loadMigrationPlan();
  const client = await pool.connect();
  try {
    const identity = rows(await client.query("SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::integer AS server_version_num,pg_catalog.inet_server_addr() AS server_address"))[0];
    invariant(identity.database === expectedDatabase, "expectedDatabase");
    invariant(identity.role === expectedUser, "expectedUser");
    const binding = rows(await client.query(`SELECT pg_catalog.count(*)::integer AS count,pg_catalog.min(pg_catalog.substr(setting,17)) AS environment
      FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
      WHERE s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
        AND s.setrole=0 AND pg_catalog.left(setting,16)='pkc.environment='`))[0];
    invariant(Number(binding?.count)===1 && binding.environment===expectedEnvironment, "database_environment_binding");
    const serverVersion = Number(identity.server_version_num);
    invariant(serverVersion >= 160000 && serverVersion < 170000, "server_version_num");
    if (expectedTls) invariant(rows(await client.query("SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()"))[0]?.ssl === true, "tls");

    const ledger = rows(await client.query("SELECT version,filename,sha256,environment FROM pkc_auth.migration_ledger ORDER BY version"));
    invariant(JSON.stringify(ledger.map((r) => ({ ...r, version: Number(r.version) }))) === JSON.stringify(plan.map(({ version,file,sha256 }) => ({ version,filename:file,sha256,environment:expectedEnvironment }))), "migration_ledger");

    const roles = rows(await client.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=ANY($1) ORDER BY rolname", [EXPECTED_ROLES]));
    invariant(roles.length === EXPECTED_ROLES.length, "pg_authid_roles");
    for (const role of roles) {
      invariant(!role.rolsuper && !role.rolinherit && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication && !role.rolbypassrls, `role_attributes:${role.rolname}`);
      invariant(role.rolcanlogin === (role.rolname !== "pkc_mfa_owner"), `role_login:${role.rolname}`);
    }
    const memberships = rows(await client.query("SELECT member.rolname AS member,parent.rolname AS parent,m.admin_option,m.inherit_option,m.set_option FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles member ON member.oid=m.member JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid WHERE member.rolname=ANY($1) OR parent.rolname=ANY($1) ORDER BY 1,2", [EXPECTED_ROLES]));
    invariant(JSON.stringify(memberships) === JSON.stringify([{ member:"pkc_mfa_migrator", parent:"pkc_mfa_owner", admin_option:false, inherit_option:false, set_option:true }]), "role_graph");

    const schema = rows(await client.query("SELECT n.nspname,owner.rolname AS owner,n.nspacl FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner WHERE n.nspname='pkc_auth'"));
    invariant(schema.length===1 && schema[0].owner==="pkc_mfa_owner" && !hasPublicAcl(schema[0].nspacl), "nspacl_owner");
    const schemaAcl = rows(await client.query("SELECT n.nspname,owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE n.nspname='pkc_auth' ORDER BY 3,4,5"));
    invariant(digestRows(schemaAcl)===CATALOG_DIGESTS.schemaAcl, "schema_acl");
    const relations = rows(await client.query("SELECT c.relname,c.relkind,owner.rolname AS owner,c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner WHERE n.nspname='pkc_auth' ORDER BY c.relname"));
    const tableNames = relations.filter((r)=>r.relkind==='r').map((r)=>r.relname);
    invariant(JSON.stringify(tableNames)===JSON.stringify(EXPECTED_TABLES), "tables");
    invariant(relations.every((r)=>r.owner==='pkc_mfa_owner' && !hasPublicAcl(r.relacl)), "relacl_owners");
    const relationAcls = rows(await client.query(`SELECT c.relname,c.relkind,owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) x
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE n.nspname='pkc_auth' AND c.relkind IN ('r','S') ORDER BY 1,2,4,5,6`));
    invariant(digestRows(relationAcls)===CATALOG_DIGESTS.relationAcls, "relation_acls");

    const functions = rows(await client.query("SELECT p.proname,owner.rolname AS owner,p.prosecdef,p.proacl,p.proconfig,pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner WHERE n.nspname='pkc_auth' ORDER BY p.proname"));
    for (const name of WORKER_FUNCTIONS) {
      const fn = functions.find((entry)=>entry.proname===name);
      invariant(fn && fn.owner==='pkc_mfa_owner' && fn.prosecdef && Array.isArray(fn.proconfig) && fn.proconfig.includes('search_path=pg_catalog, pkc_auth') && !hasPublicAcl(fn.proacl), `functions:${name}:proacl:prosecdef:proconfig`);
    }
    const functionSemantics = rows(await client.query("SELECT p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,pg_catalog.pg_get_function_result(p.oid) AS result,l.lanname,p.prosecdef,p.provolatile,p.proisstrict,p.proconfig,p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='pkc_auth' ORDER BY p.proname,args"));
    invariant(digestRows(functionSemantics)===CATALOG_DIGESTS.functions, "function_semantics");
    const functionAcls = rows(await client.query("SELECT p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,owner.rolname AS owner,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE n.nspname='pkc_auth' ORDER BY 1,2,4,5,6"));
    invariant(digestRows(functionAcls)===CATALOG_DIGESTS.functionAcls, "function_acls");
    const constraints = rows(await client.query("SELECT conname,pg_catalog.pg_get_constraintdef(oid,true) AS definition,convalidated FROM pg_catalog.pg_constraint WHERE connamespace='pkc_auth'::regnamespace ORDER BY conname"));
    invariant(digestRows(constraints)===CATALOG_DIGESTS.constraints, "constraints");
    const indexes = rows(await client.query("SELECT t.relname AS table_name,i.relname AS index_name,x.indisunique,x.indisprimary,x.indisvalid,x.indisready,pg_catalog.pg_get_indexdef(x.indexrelid) AS definition FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='pkc_auth' ORDER BY t.relname,i.relname"));
    invariant(digestRows(indexes)===CATALOG_DIGESTS.indexes, "indexes");
    const triggers = rows(await client.query("SELECT c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid,true) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pkc_auth' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname"));
    invariant(digestRows(triggers)===CATALOG_DIGESTS.triggers, "triggers");
    const defaults = rows(await client.query("SELECT d.defaclobjtype,COALESCE(grantee.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=x.grantee WHERE owner.rolname='pkc_mfa_owner' AND n.nspname='pkc_auth' ORDER BY 1,2,3,4"));
    invariant(digestRows(defaults)===CATALOG_DIGESTS.defaultAcls, "default_acl");
    return Object.freeze({ ready:true,database:identity.database,user:identity.role,version:Number(ledger.at(-1).version),checksum:createHash('sha256').update(JSON.stringify(ledger)).digest('hex') });
  } finally { client.release(); }
}

async function main() {
  const pool=new pg.Pool({connectionString:process.env.PKC_DATABASE_URL,max:1,connectionTimeoutMillis:5000,query_timeout:6000,statement_timeout:5000,idle_in_transaction_session_timeout:10000});
  try { console.log(JSON.stringify(await attestFounderMfaDatabase({pool,expectedDatabase:process.env.PKC_DATABASE_NAME,expectedUser:process.env.PKC_DATABASE_USER,expectedEnvironment:process.env.PKC_DATABASE_ENVIRONMENT,expectedTls:true}))); } finally { await pool.end(); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) main().catch((error)=>{console.error(error?.message||"readiness_failed");process.exitCode=1;});
