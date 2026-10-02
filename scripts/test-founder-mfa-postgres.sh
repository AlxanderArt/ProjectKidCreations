#!/usr/bin/env bash
set -euo pipefail
umask 077

name="pkc-mfa-gate0-native-$$"
setup_name="${name}-setup"
scrub_name="${name}-scrub"
pg_auth_material="$(openssl rand -hex 24)"
pgpass_file="$(mktemp)"
tls_root="$(mktemp -d)"
ca_dir="$tls_root/ca"
server_tls_dir="$tls_root/server"
client_tls_dir="$tls_root/client"
install -d -m 0700 "$ca_dir" "$server_tls_dir" "$client_tls_dir"
image="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
cleanup() {
  local status=$?
  docker rm -f "$name" "$setup_name" >/dev/null 2>&1 || true
  rm -f "$pgpass_file"
  docker rm -f "$scrub_name" >/dev/null 2>&1 || true
  docker run --rm --name "$scrub_name" --pull=never --network none --read-only \
    --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges \
    -v "$tls_root:/fixture:rw" --entrypoint /bin/sh "$image" \
    -c 'rm -rf -- /fixture/ca /fixture/server /fixture/client' >/dev/null 2>&1 || true
  docker rm -f "$scrub_name" >/dev/null 2>&1 || true
  rm -rf -- "$tls_root"
  if docker ps -a --format '{{.Names}}' | grep -E "^(${name}|${setup_name}|${scrub_name})$" >/dev/null; then
    printf '%s\n' 'native_postgres_cleanup_failed' >&2
    status=1
  fi
  return "$status"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=PKC Native Test CA' -keyout "$ca_dir/ca.key" -out "$ca_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$server_tls_dir/server.key" -out "$server_tls_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' >"$server_tls_dir/server.ext"
openssl x509 -req -days 2 -in "$server_tls_dir/server.csr" -CA "$ca_dir/ca.crt" -CAkey "$ca_dir/ca.key" -CAcreateserial -extfile "$server_tls_dir/server.ext" -out "$server_tls_dir/server.crt" >/dev/null 2>&1
client_roles=(pkc_bootstrap_admin pkc_backup_reader pkc_mfa_migrator pkc_mfa_runtime pkc_mfa_verifier pkc_mfa_outbox_worker pkc_onboarding_runtime pkc_onboarding_email_worker pkc_onboarding_email_reconciler)
printf '%s\n' 'extendedKeyUsage=clientAuth' >"$client_tls_dir/client.ext"
for role in "${client_roles[@]}"; do
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$role" -keyout "$client_tls_dir/$role.key" -out "$client_tls_dir/$role.csr" >/dev/null 2>&1
  openssl x509 -req -days 2 -in "$client_tls_dir/$role.csr" -CA "$ca_dir/ca.crt" -CAkey "$ca_dir/ca.key" -CAcreateserial -extfile "$client_tls_dir/client.ext" -out "$client_tls_dir/$role.crt" >/dev/null 2>&1
  chmod 0600 "$client_tls_dir/$role.key" "$client_tls_dir/$role.crt"
done
cp "$ca_dir/ca.crt" "$server_tls_dir/ca.crt"
cp "$ca_dir/ca.crt" "$client_tls_dir/ca.crt"
printf '%s\n' 'local all all trust' 'hostssl all all 0.0.0.0/0 scram-sha-256 clientcert=verify-full' >"$server_tls_dir/pg_hba.conf"
chmod 0600 "$server_tls_dir/server.key" "$server_tls_dir/server.crt" "$server_tls_dir/ca.crt" "$server_tls_dir/pg_hba.conf" "$client_tls_dir/ca.crt"
docker image inspect "$image" >/dev/null
docker run --rm --name "$setup_name" --pull=never --network none --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges \
  -v "$tls_root:/fixture:rw" --entrypoint /bin/sh "$image" \
  -c 'chown -R 70:70 /fixture/server && chmod 0700 /fixture/server' >/dev/null

export POSTGRES_PASSWORD="$pg_auth_material"
docker run --pull=never -d --name "$name" -e POSTGRES_PASSWORD -e POSTGRES_USER=pkc_bootstrap_admin -v "$server_tls_dir:/tls:ro" -p 127.0.0.1::5432 "$image" postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.3 -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key -c ssl_ca_file=/tls/ca.crt -c hba_file=/tls/pg_hba.conf >/dev/null
unset POSTGRES_PASSWORD
ready=false
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U pkc_bootstrap_admin >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf '%s\n' 'native_postgres_not_ready' >&2; exit 1; }
binding="$(docker container inspect "$name" --format '{{json (index (index .NetworkSettings.Ports "5432/tcp") 0)}}')"
read -r host_ip port < <(python3 - "$binding" <<'PY'
import json, sys
value=json.loads(sys.argv[1])
if set(value)!={'HostIp','HostPort'} or value['HostIp']!='127.0.0.1' or not value['HostPort'].isdigit():
    raise SystemExit('native loopback port binding invalid')
print(value['HostIp'], value['HostPort'])
PY
)
[[ "$host_ip" == '127.0.0.1' && "$port" =~ ^[0-9]+$ ]]
printf '127.0.0.1:%s:*:*:%s\n' "$port" "$pg_auth_material" >"$pgpass_file"
chmod 600 "$pgpass_file"
export PGPASSFILE="$pgpass_file"
export PGSSLMODE=verify-full PGSSLROOTCERT="$client_tls_dir/ca.crt"
psql() {
  local role=""
  local previous=""
  for argument in "$@"; do
    if [[ "$previous" == "-U" ]]; then role="$argument"; break; fi
    previous="$argument"
  done
  [[ -n "$role" && -f "$client_tls_dir/$role.crt" && -f "$client_tls_dir/$role.key" ]] || return 64
  PGSSLCERT="$client_tls_dir/$role.crt" PGSSLKEY="$client_tls_dir/$role.key" command psql "$@"
}
dsn_for() {
  local role="$1" database="$2"
  printf 'postgresql://%s@127.0.0.1:%s/%s?sslmode=verify-full&sslrootcert=%s&sslcert=%s&sslkey=%s&application_name=pkc-native-test\n' "$role" "$port" "$database" "$client_tls_dir/ca.crt" "$client_tls_dir/$role.crt" "$client_tls_dir/$role.key"
}
run_readiness() {
  local authority_state="$1" expected_user="$2" readiness_label="$3" require_zero_rows="$4"
  PKC_TEST_AUTHORITY_STATE="$authority_state" PKC_DATABASE_USER="$expected_user" \
    PKC_TEST_READINESS_LABEL="$readiness_label" PKC_TEST_REQUIRE_ZERO_ROWS="$require_zero_rows" \
  node --input-type=module <<'NODE'
import pg from 'pg';
import { loadPgClientAuthority } from './db/client-authority.mjs';
import { attestFounderMfaDatabase } from './db/readiness.mjs';
let pool;
try {
  const authority = await loadPgClientAuthority({ connectionString: process.env.PKC_DATABASE_URL, pgpassFile: process.env.PGPASSFILE });
  pool = new pg.Pool({ ...authority, ssl: { ...authority.ssl }, max: 1 });
  const result = await attestFounderMfaDatabase({
    pool,
    expectedDatabase: process.env.PKC_DATABASE_NAME,
    expectedUser: process.env.PKC_DATABASE_USER,
    expectedEnvironment: process.env.PKC_DATABASE_ENVIRONMENT,
    expectedSystemIdentifier: process.env.PKC_DATABASE_SYSTEM_IDENTIFIER,
    expectedServerAddress: process.env.PKC_DATABASE_SERVER_ADDRESS,
    expectedServerPort: Number(process.env.PKC_DATABASE_SERVER_PORT),
    expectedTls: true,
    authorityState: process.env.PKC_TEST_AUTHORITY_STATE,
    requireZeroRows: process.env.PKC_TEST_REQUIRE_ZERO_ROWS === 'true',
  });
  if (!result.ready) throw new Error('not_ready');
  console.log(process.env.PKC_TEST_READINESS_LABEL);
} catch (error) {
  const tag = String(error?.message || "unknown").replace(/[^a-zA-Z0-9_:.-]+/g, "_").slice(0, 120) || "unknown";
  console.error(`native_readiness_failed:${tag}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => {});
}
NODE
}
for _ in $(seq 1 60); do
  if psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE pkc_founder_mfa' >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE pkc_founder_mfa SET pkc.environment='test'" >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -v expected_empty_cluster=true -f db/roles/000_roles.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/004_onboarding_roles.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/004_onboarding_roles.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/006_backup_reader.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/006_backup_reader.sql >/dev/null
export PKC_TEST_ROLE_AUTH="$pg_auth_material"
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
\getenv role_auth PKC_TEST_ROLE_AUTH
ALTER ROLE pkc_mfa_migrator PASSWORD :'role_auth';
ALTER ROLE pkc_mfa_runtime PASSWORD :'role_auth';
ALTER ROLE pkc_mfa_verifier PASSWORD :'role_auth';
ALTER ROLE pkc_mfa_outbox_worker PASSWORD :'role_auth';
ALTER ROLE pkc_onboarding_runtime PASSWORD :'role_auth';
ALTER ROLE pkc_onboarding_email_worker PASSWORD :'role_auth';
ALTER ROLE pkc_onboarding_email_reconciler PASSWORD :'role_auth';
ALTER ROLE pkc_backup_reader PASSWORD :'role_auth';
SQL
unset PKC_TEST_ROLE_AUTH

export PKC_DATABASE_SYSTEM_IDENTIFIER="$(psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -Atc "SELECT (pg_catalog.pg_control_system()).system_identifier")"
export PKC_DATABASE_SERVER_ADDRESS="$(psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -Atc "SELECT pg_catalog.inet_server_addr()::text")"
export PKC_DATABASE_SERVER_PORT=5432

for caller_environment in test preview production; do
  guard_db="pkc_mfa_guard_${caller_environment}"
  psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $guard_db" >/dev/null
  psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "GRANT CREATE ON DATABASE $guard_db TO pkc_mfa_owner" >/dev/null
  psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE $guard_db SET pkc.environment='development'" >/dev/null
  guard_migrator_dsn="$(dsn_for pkc_mfa_migrator "$guard_db")"
  if (
    export PGOPTIONS="-c pkc.environment=$caller_environment -c pkc.expected_environment=$caller_environment"
    export PKC_DATABASE_NAME="$guard_db" PKC_DATABASE_ENVIRONMENT="$caller_environment"
    export PKC_MIGRATOR_DATABASE_URL="$guard_migrator_dsn"
    node db/migrate.mjs >/dev/null 2>&1
  ); then
    echo "first_run_environment_binding_guard_failed:$caller_environment" >&2
    exit 1
  fi
  absent="$(psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d "$guard_db" -Atc "SELECT pg_catalog.to_regnamespace('pkc_auth') IS NULL AND pg_catalog.to_regclass('pkc_auth.migration_ledger') IS NULL")"
  [[ "$absent" == "t" ]]
done

malformed_db="pkc_mfa_guard_malformed"
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $malformed_db" >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "GRANT CREATE ON DATABASE $malformed_db TO pkc_mfa_owner" >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE $malformed_db SET pkc.environment='development=forged'" >/dev/null
malformed_migrator_dsn="$(dsn_for pkc_mfa_migrator "$malformed_db")"
if (
  export PKC_DATABASE_NAME="$malformed_db" PKC_DATABASE_ENVIRONMENT=development
  export PKC_MIGRATOR_DATABASE_URL="$malformed_migrator_dsn"
  node db/migrate.mjs >/dev/null 2>&1
); then
  echo "malformed_environment_binding_guard_failed" >&2
  exit 1
fi
absent="$(psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d "$malformed_db" -Atc "SELECT pg_catalog.to_regnamespace('pkc_auth') IS NULL AND pg_catalog.to_regclass('pkc_auth.migration_ledger') IS NULL")"
[[ "$absent" == "t" ]]

export PKC_DATABASE_NAME=pkc_founder_mfa PKC_DATABASE_ENVIRONMENT=test
main_migrator_dsn="$(dsn_for pkc_mfa_migrator pkc_founder_mfa)"
export PKC_MIGRATOR_DATABASE_URL="$main_migrator_dsn"
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/005_unseal_migrator.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/005_unseal_migrator.sql >/dev/null
first="$(PGOPTIONS='-c pkc.environment=production -c pkc.expected_environment=production' node db/migrate.mjs)"
second="$(node db/migrate.mjs)"
[[ "$first" == '{"applied":[1,2,3,4],"currentVersion":4}' ]]
[[ "$second" == '{"applied":[],"currentVersion":4}' ]]

backup_psql=(psql -h 127.0.0.1 -p "$port" -U pkc_backup_reader -d pkc_founder_mfa -v ON_ERROR_STOP=1)
"${backup_psql[@]}" -c 'SELECT count(*) FROM pkc_auth.migration_ledger; SELECT count(*) FROM pkc_auth.onboarding_email_outbox' >/dev/null
if "${backup_psql[@]}" -c "INSERT INTO pkc_auth.onboarding_submission_claims(submission_id,request_digest) VALUES('backup-denied',decode(repeat('00',32),'hex'))" >/dev/null 2>&1; then
  echo 'backup_reader_write_denial_failed' >&2
  exit 1
fi
if "${backup_psql[@]}" -c 'SET ROLE pkc_mfa_owner' >/dev/null 2>&1; then
  echo 'backup_reader_role_escalation_denial_failed' >&2
  exit 1
fi
docker exec "$name" pg_dump -U pkc_backup_reader -d pkc_founder_mfa --format=custom --no-owner --no-privileges --schema=pkc_auth >/dev/null

admin_dsn="$(dsn_for pkc_bootstrap_admin pkc_founder_mfa)"
(
  export PKC_DATABASE_URL="$admin_dsn"
  run_readiness migration-window pkc_bootstrap_admin migration_window_readiness_pass true
)
psql -h 127.0.0.1 -p "$port" -U pkc_mfa_migrator -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c 'SET ROLE pkc_mfa_owner; SELECT 1' >/dev/null

psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c "INSERT INTO pkc_auth.migration_ledger(version,filename,sha256,environment) VALUES(5,'005_unknown.sql',repeat('0',64),'test')" >/dev/null
if node db/migrate.mjs >/dev/null 2>&1; then
  echo "unknown_migration_ledger_guard_failed" >&2
  exit 1
fi
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c "DELETE FROM pkc_auth.migration_ledger WHERE version=5" >/dev/null
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/010_seal_migrator.sql >/dev/null
PGOPTIONS='-c client_min_messages=error' psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/010_seal_migrator.sql >/dev/null

if psql -h 127.0.0.1 -p "$port" -U pkc_mfa_migrator -d pkc_founder_mfa -c 'SELECT 1' >/dev/null 2>&1; then
  echo "sealed_migrator_login_guard_failed" >&2
  exit 1
fi

runtime_psql=(psql -h 127.0.0.1 -p "$port" -U pkc_mfa_runtime -d pkc_founder_mfa -v ON_ERROR_STOP=1)
for denied_sql in \
  'CREATE TABLE pkc_auth.runtime_escape(id integer)' \
  'CREATE TABLE public.runtime_escape(id integer)' \
  'TRUNCATE pkc_auth.founder_mfa_factors' \
  'SET ROLE pkc_mfa_owner' \
  "INSERT INTO pkc_auth.migration_ledger(version,filename,sha256,environment) VALUES(99,'bad.sql',repeat('0',64),'test')" \
  "UPDATE pkc_auth.migration_ledger SET filename='bad.sql' WHERE version=1" \
  "INSERT INTO pkc_auth.founder_mfa_factors(founder_subject,state) VALUES('11111111-1111-4111-8111-111111111111','invalid')"; do
  if "${runtime_psql[@]}" -c "$denied_sql" >/dev/null 2>&1; then
    echo "runtime_denial_guard_failed" >&2
    exit 1
  fi
done
"${runtime_psql[@]}" -c "BEGIN; INSERT INTO pkc_auth.founder_mfa_factors(founder_subject) VALUES('11111111-1111-4111-8111-111111111111'); ROLLBACK" >/dev/null
for denied_sql in \
  'SELECT count(*) FROM pkc_auth.founder_mfa_recovery_operations' \
  "INSERT INTO pkc_auth.founder_mfa_recovery_operations(operation_id,factor_id,operator_principal_id,operator_approval_id,verifier_principal_id,verifier_approval_id,reason_code,prior_auth_epoch,resulting_auth_epoch,completed_at) VALUES('recovery-test-01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','operator-test-01','operator-approval-01','verifier-test-02','verifier-approval-02','FACTOR_LOST',0,1,clock_timestamp())" \
  "UPDATE pkc_auth.founder_mfa_recovery_operations SET reason_code='OTHER' WHERE false" \
  'DELETE FROM pkc_auth.founder_mfa_recovery_operations WHERE false' \
  'TRUNCATE pkc_auth.founder_mfa_recovery_operations'; do
  if "${runtime_psql[@]}" -c "$denied_sql" >/dev/null 2>&1; then
    echo 'runtime_recovery_operations_authority_denial_failed' >&2
    exit 1
  fi
done
if "${runtime_psql[@]}" -c "INSERT INTO pkc_auth.founder_mfa_enrollment_authorizations(founder_subject,source_commit,deployment_id,workflow_digest,approval_id,issued_at,expires_at,expected_factor_state,expected_auth_epoch) VALUES('11111111-1111-4111-8111-111111111111',repeat('a',40),'deployment-test-01',repeat('b',64),'approval-test-01',clock_timestamp(),clock_timestamp()+interval '5 minutes','unenrolled',0)" >/dev/null 2>&1; then
  echo 'runtime_enrollment_authorization_insert_denial_failed' >&2
  exit 1
fi

verifier_psql=(psql -h 127.0.0.1 -p "$port" -U pkc_mfa_verifier -d pkc_founder_mfa -v ON_ERROR_STOP=1)
"${verifier_psql[@]}" -c 'SELECT current_user,current_database(); SELECT count(*) FROM pkc_auth.migration_ledger' >/dev/null
for denied_sql in \
  'SELECT count(*) FROM pkc_auth.founder_mfa_enrollment_authorizations' \
  'SELECT count(*) FROM pkc_auth.founder_mfa_recovery_operations' \
  "INSERT INTO pkc_auth.founder_mfa_enrollment_authorizations(founder_subject) VALUES('11111111-1111-4111-8111-111111111111')" \
  "INSERT INTO pkc_auth.founder_mfa_recovery_operations(operation_id) VALUES('recovery-denied')"; do
  if "${verifier_psql[@]}" -c "$denied_sql" >/dev/null 2>&1; then
    echo 'verifier_new_table_write_denial_failed' >&2
    exit 1
  fi
done

worker_psql=(psql -h 127.0.0.1 -p "$port" -U pkc_mfa_outbox_worker -d pkc_founder_mfa -v ON_ERROR_STOP=1)
for denied_sql in \
  'SELECT count(*) FROM pkc_auth.founder_mfa_enrollment_authorizations' \
  'SELECT count(*) FROM pkc_auth.founder_mfa_recovery_operations'; do
  if "${worker_psql[@]}" -c "$denied_sql" >/dev/null 2>&1; then
    echo 'worker_new_table_read_denial_failed' >&2
    exit 1
  fi
done

native_test_dsn="$(dsn_for pkc_bootstrap_admin pkc_founder_mfa)"
worker_test_dsn="$(dsn_for pkc_mfa_outbox_worker pkc_founder_mfa)"
onboarding_runtime_test_dsn="$(dsn_for pkc_onboarding_runtime pkc_founder_mfa)"
onboarding_worker_test_dsn="$(dsn_for pkc_onboarding_email_worker pkc_founder_mfa)"
onboarding_reconciler_test_dsn="$(dsn_for pkc_onboarding_email_reconciler pkc_founder_mfa)"
export PKC_MFA_TEST_DATABASE_URL="$native_test_dsn"
export PKC_MFA_WORKER_TEST_DATABASE_URL="$worker_test_dsn"
export PKC_ONBOARDING_RUNTIME_TEST_DATABASE_URL="$onboarding_runtime_test_dsn"
export PKC_ONBOARDING_EMAIL_WORKER_TEST_DATABASE_URL="$onboarding_worker_test_dsn"
export PKC_ONBOARDING_EMAIL_RECONCILER_TEST_DATABASE_URL="$onboarding_reconciler_test_dsn"
node --test --test-concurrency=1 tests/contracts/founder-mfa-store.test.mjs tests/contracts/founder-mfa-outbox-native.test.mjs tests/contracts/founder-mfa-readiness-native.test.mjs tests/contracts/onboarding-email-outbox-native.test.mjs

if psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v expected_database=postgres -v expected_empty_cluster=true -f db/roles/000_roles.sql >/dev/null 2>&1; then
  echo "cross_database_role_guard_failed" >&2
  exit 1
fi
psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -v bootstrap_role=pkc_bootstrap_admin -f db/roles/020_seal_bootstrap.sql >/dev/null
if psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d pkc_founder_mfa -c 'SELECT 1' >/dev/null 2>&1; then
  echo "sealed_bootstrap_login_guard_failed" >&2
  exit 1
fi

runtime_dsn="$(dsn_for pkc_mfa_runtime pkc_founder_mfa)"
(
  export PKC_DATABASE_URL="$runtime_dsn"
  export PKC_DATABASE_USER=pkc_mfa_runtime
  node --input-type=module - <<'NODE'
import pg from 'pg';
import { loadPgClientAuthority } from './db/client-authority.mjs';
let pool;
try {
  const authority = await loadPgClientAuthority({ connectionString: process.env.PKC_DATABASE_URL, pgpassFile: process.env.PGPASSFILE, expectedUser: 'pkc_mfa_runtime', expectedDatabase: 'pkc_founder_mfa' });
  pool = new pg.Pool({ ...authority, ssl: { ...authority.ssl }, max: 1 });
  if ((await pool.query('SELECT 1 AS usable')).rows[0]?.usable !== 1) throw new Error('runtime_login');
  console.log('native_runtime_login_pass');
} catch (error) {
  const tag = String(error?.message || "unknown").replace(/[^a-zA-Z0-9_:.-]+/g, "_").slice(0, 120) || "unknown";
  console.error(`native_runtime_login_failed:${tag}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => {});
}
NODE
)

verifier_dsn="$(dsn_for pkc_mfa_verifier pkc_founder_mfa)"
(
  export PKC_DATABASE_URL="$verifier_dsn"
  export PKC_DATABASE_USER=pkc_mfa_verifier
  run_readiness runtime-sealed pkc_mfa_verifier final_runtime_readiness_pass false
)

if (
  export PKC_DATABASE_URL="$PKC_MIGRATOR_DATABASE_URL"
  export PKC_DATABASE_NAME=pkc_founder_mfa PKC_DATABASE_ENVIRONMENT=staging PKC_MFA_MIGRATION_MANIFEST=db/migrations/manifest.json
  node db/migrate.mjs >/dev/null 2>&1
); then
  echo "cross_environment_migration_guard_failed" >&2
  exit 1
fi

printf '%s\n' 'native_postgres_gate0_pass'
