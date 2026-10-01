#!/usr/bin/env bash
set -euo pipefail

name="pkc-mfa-gate0-native-$$"
pg_auth_material="$(openssl rand -hex 24)"
image="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
cleanup() {
  local status=$?
  docker rm -f "$name" >/dev/null 2>&1 || true
  if docker ps -a --format '{{.Names}}' | grep -Fx "$name" >/dev/null; then
    printf '%s\n' 'native_postgres_cleanup_failed' >&2
    status=1
  fi
  return "$status"
}
trap cleanup EXIT INT TERM

docker image inspect "$image" >/dev/null
export POSTGRES_PASSWORD="$pg_auth_material"
docker run -d --name "$name" -e POSTGRES_PASSWORD -p 127.0.0.1::5432 "$image" >/dev/null
unset POSTGRES_PASSWORD
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$name" 5432/tcp | cut -d: -f2)"
export PGPASSWORD="$pg_auth_material"
for _ in $(seq 1 60); do
  if psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE pkc_founder_mfa' >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE pkc_founder_mfa SET pkc.environment='test'" >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/000_roles.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/004_onboarding_roles.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/004_onboarding_roles.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c "ALTER ROLE pkc_mfa_migrator PASSWORD '$pg_auth_material'; ALTER ROLE pkc_mfa_runtime PASSWORD '$pg_auth_material'; ALTER ROLE pkc_mfa_verifier PASSWORD '$pg_auth_material'; ALTER ROLE pkc_mfa_outbox_worker PASSWORD '$pg_auth_material'; ALTER ROLE pkc_onboarding_runtime PASSWORD '$pg_auth_material'; ALTER ROLE pkc_onboarding_email_worker PASSWORD '$pg_auth_material';" >/dev/null

for caller_environment in test preview production; do
  guard_db="pkc_mfa_guard_${caller_environment}"
  psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $guard_db" >/dev/null
  psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "GRANT CREATE ON DATABASE $guard_db TO pkc_mfa_owner" >/dev/null
  psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE $guard_db SET pkc.environment='development'" >/dev/null
  guard_migrator_dsn="postgresql://pkc_mfa_migrator@127.0.0.1:$port/$guard_db?sslmode=disable"
  if (
    export PGOPTIONS="-c pkc.environment=$caller_environment -c pkc.expected_environment=$caller_environment"
    export PKC_DATABASE_NAME="$guard_db" PKC_DATABASE_ENVIRONMENT="$caller_environment"
    export PKC_MIGRATOR_DATABASE_URL="$guard_migrator_dsn"
    node db/migrate.mjs >/dev/null 2>&1
  ); then
    echo "first_run_environment_binding_guard_failed:$caller_environment" >&2
    exit 1
  fi
  absent="$(psql -h 127.0.0.1 -p "$port" -U postgres -d "$guard_db" -Atc "SELECT pg_catalog.to_regnamespace('pkc_auth') IS NULL AND pg_catalog.to_regclass('pkc_auth.migration_ledger') IS NULL")"
  [[ "$absent" == "t" ]]
done

malformed_db="pkc_mfa_guard_malformed"
psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $malformed_db" >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "GRANT CREATE ON DATABASE $malformed_db TO pkc_mfa_owner" >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE $malformed_db SET pkc.environment='development=forged'" >/dev/null
malformed_migrator_dsn="postgresql://pkc_mfa_migrator@127.0.0.1:$port/$malformed_db?sslmode=disable"
if (
  export PKC_DATABASE_NAME="$malformed_db" PKC_DATABASE_ENVIRONMENT=development
  export PKC_MIGRATOR_DATABASE_URL="$malformed_migrator_dsn"
  node db/migrate.mjs >/dev/null 2>&1
); then
  echo "malformed_environment_binding_guard_failed" >&2
  exit 1
fi
absent="$(psql -h 127.0.0.1 -p "$port" -U postgres -d "$malformed_db" -Atc "SELECT pg_catalog.to_regnamespace('pkc_auth') IS NULL AND pg_catalog.to_regclass('pkc_auth.migration_ledger') IS NULL")"
[[ "$absent" == "t" ]]

export PKC_DATABASE_NAME=pkc_founder_mfa PKC_DATABASE_ENVIRONMENT=test
main_migrator_dsn="postgresql://pkc_mfa_migrator@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
export PKC_MIGRATOR_DATABASE_URL="$main_migrator_dsn"
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/005_unseal_migrator.sql >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/005_unseal_migrator.sql >/dev/null
first="$(PGOPTIONS='-c pkc.environment=production -c pkc.expected_environment=production' node db/migrate.mjs)"
second="$(node db/migrate.mjs)"
[[ "$first" == '{"applied":[1,2,3],"currentVersion":3}' ]]
[[ "$second" == '{"applied":[],"currentVersion":3}' ]]

admin_dsn="postgresql://postgres@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
(
  export PKC_DATABASE_URL="$admin_dsn"
  export PKC_DATABASE_USER=postgres
  node --input-type=module -e "import pg from 'pg'; import {attestFounderMfaDatabase} from './db/readiness.mjs'; const pool=new pg.Pool({connectionString:process.env.PKC_DATABASE_URL,max:1}); try { const result=await attestFounderMfaDatabase({pool,expectedDatabase:process.env.PKC_DATABASE_NAME,expectedUser:process.env.PKC_DATABASE_USER,expectedEnvironment:process.env.PKC_DATABASE_ENVIRONMENT,expectedTls:false,authorityState:'migration-window',requireZeroRows:true}); if(!result.ready) process.exitCode=1; else console.log('migration_window_readiness_pass'); } finally { await pool.end(); }"
)
psql -h 127.0.0.1 -p "$port" -U pkc_mfa_migrator -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c 'SET ROLE pkc_mfa_owner; SELECT 1' >/dev/null

psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c "INSERT INTO pkc_auth.migration_ledger(version,filename,sha256,environment) VALUES(4,'004_unknown.sql',repeat('0',64),'test')" >/dev/null
if node db/migrate.mjs >/dev/null 2>&1; then
  echo "unknown_migration_ledger_guard_failed" >&2
  exit 1
fi
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c "DELETE FROM pkc_auth.migration_ledger WHERE version=4" >/dev/null
psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/010_seal_migrator.sql >/dev/null
PGOPTIONS='-c client_min_messages=error' psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -f db/roles/010_seal_migrator.sql >/dev/null

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

native_test_dsn="postgresql://postgres@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
worker_test_dsn="postgresql://pkc_mfa_outbox_worker@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
onboarding_runtime_test_dsn="postgresql://pkc_onboarding_runtime@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
onboarding_worker_test_dsn="postgresql://pkc_onboarding_email_worker@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
export PKC_MFA_TEST_DATABASE_URL="$native_test_dsn"
export PKC_MFA_WORKER_TEST_DATABASE_URL="$worker_test_dsn"
export PKC_ONBOARDING_RUNTIME_TEST_DATABASE_URL="$onboarding_runtime_test_dsn"
export PKC_ONBOARDING_EMAIL_WORKER_TEST_DATABASE_URL="$onboarding_worker_test_dsn"
node --test --test-concurrency=1 tests/contracts/founder-mfa-store.test.mjs tests/contracts/founder-mfa-outbox-native.test.mjs tests/contracts/founder-mfa-readiness-native.test.mjs tests/contracts/onboarding-email-outbox-native.test.mjs

runtime_dsn="postgresql://pkc_mfa_runtime@127.0.0.1:$port/pkc_founder_mfa?sslmode=disable"
(
  export PKC_DATABASE_URL="$runtime_dsn"
  export PKC_DATABASE_USER=pkc_mfa_runtime
  node --input-type=module -e "import pg from 'pg'; import {attestFounderMfaDatabase} from './db/readiness.mjs'; const pool=new pg.Pool({connectionString:process.env.PKC_DATABASE_URL,max:1}); try { const result=await attestFounderMfaDatabase({pool,expectedDatabase:process.env.PKC_DATABASE_NAME,expectedUser:process.env.PKC_DATABASE_USER,expectedEnvironment:process.env.PKC_DATABASE_ENVIRONMENT,expectedTls:false}); if(!result.ready) process.exitCode=1; else console.log('native_readiness_pass'); } finally { await pool.end(); }"
)

if (
  export PKC_DATABASE_URL="$PKC_MIGRATOR_DATABASE_URL"
  export PKC_DATABASE_NAME=pkc_founder_mfa PKC_DATABASE_ENVIRONMENT=staging PKC_MFA_MIGRATION_MANIFEST=db/migrations/manifest.json
  node db/migrate.mjs >/dev/null 2>&1
); then
  echo "cross_environment_migration_guard_failed" >&2
  exit 1
fi

role_password="$pg_auth_material"
if psql -h 127.0.0.1 -p "$port" -U postgres -d pkc_founder_mfa -v expected_database=postgres -v "role_password=$role_password" -f db/roles/000_roles.sql >/dev/null 2>&1; then
  echo "cross_database_role_guard_failed" >&2
  exit 1
fi
printf '%s\n' 'native_postgres_gate0_pass'
