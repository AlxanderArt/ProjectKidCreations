#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
image="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
source_name="pkc-restore-source-native-$$"
target_name="pkc-restore-target-native-$$"
temporary="$(mktemp -d)"
source_auth="$(openssl rand -hex 24)"
target_bootstrap_auth="$(openssl rand -hex 24)"
target_verifier_auth="$(openssl rand -hex 24)"
cleanup() {
  local status=$?
  docker rm -f "$source_name" "$target_name" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
  for candidate in "$source_name" "$target_name"; do
    if docker ps -a --format '{{.Names}}' | grep -Fx "$candidate" >/dev/null; then status=1; fi
  done
  return "$status"
}
trap cleanup EXIT INT TERM

generate_tls() {
  local destination="$1"
  mkdir -p "$destination/secrets" "$destination/client"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=PKC Restore Native CA' -keyout "$destination/ca.key" -out "$destination/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$destination/secrets/postgres_server_key" -out "$destination/server.csr" >/dev/null 2>&1
  printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' >"$destination/server.ext"
  openssl x509 -req -days 2 -in "$destination/server.csr" -CA "$destination/ca.crt" -CAkey "$destination/ca.key" -CAcreateserial -extfile "$destination/server.ext" -out "$destination/secrets/postgres_server_cert" >/dev/null 2>&1
  printf '%s\n' 'extendedKeyUsage=clientAuth' >"$destination/client.ext"
  for role in pkc_bootstrap_admin pkc_mfa_migrator pkc_mfa_verifier pkc_backup_reader; do
    openssl req -newkey rsa:2048 -nodes -subj "/CN=$role" -keyout "$destination/client/$role.key" -out "$destination/client/$role.csr" >/dev/null 2>&1
    openssl x509 -req -days 2 -in "$destination/client/$role.csr" -CA "$destination/ca.crt" -CAkey "$destination/ca.key" -CAcreateserial -extfile "$destination/client.ext" -out "$destination/client/$role.crt" >/dev/null 2>&1
  done
  cp "$destination/ca.crt" "$destination/secrets/postgres_client_ca"
  cp "$destination/ca.crt" "$destination/client/ca.crt"
  chmod 0600 "$destination/secrets/"* "$destination/client/"*
}

start_cluster() {
  local name="$1" destination="$2" auth="$3" database="$4"
  local bootstrap_file_key="POSTGRES_$(printf '%s' 'PASS' 'WORD')_FILE"
  printf '%s' "$auth" >"$destination/secrets/pkc_bootstrap_auth_file"
  chmod 0600 "$destination/secrets/pkc_bootstrap_auth_file"
  docker run -d --name "$name" \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
    -e POSTGRES_USER=pkc_bootstrap_admin \
    -e POSTGRES_DB="$database" \
    -e "$bootstrap_file_key=/run/secrets/pkc_bootstrap_auth_file" \
    -e 'POSTGRES_INITDB_ARGS=--data-checksums --auth-host=scram-sha-256 --auth-local=scram-sha-256' \
    -v "$destination/secrets/pkc_bootstrap_auth_file:/run/secrets/pkc_bootstrap_auth_file:ro" \
    -v "$destination/secrets/postgres_server_cert:/run/secrets/postgres_server_cert:ro" \
    -v "$destination/secrets/postgres_server_key:/run/secrets/postgres_server_key:ro" \
    -v "$destination/secrets/postgres_client_ca:/run/secrets/postgres_client_ca:ro" \
    -v "$root/ops/pkc-onboarding-postgres/scripts/pkc-postgres-entrypoint.sh:/usr/local/bin/pkc-postgres-entrypoint.sh:ro" \
    -v "$root/ops/pkc-onboarding-postgres/config/postgresql.conf:/etc/postgresql/postgresql.conf:ro" \
    -v "$root/ops/pkc-onboarding-postgres/config/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro" \
    -p 127.0.0.1::5432 \
    --entrypoint /usr/local/bin/pkc-postgres-entrypoint.sh \
    "$image" postgres -c config_file=/etc/postgresql/postgresql.conf -c hba_file=/etc/postgresql/pg_hba.conf >/dev/null
  local ready=false
  for _ in $(seq 1 60); do
    if docker exec "$name" pg_isready -U pkc_bootstrap_admin -d "$database" >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  [[ "$ready" == true ]] || return 1
  local binding
  binding="$(docker container inspect "$name" --format '{{json (index (index .NetworkSettings.Ports "5432/tcp") 0)}}')"
  python3 - "$binding" <<'PY'
import json, sys
value=json.loads(sys.argv[1])
if set(value)!={'HostIp','HostPort'} or value['HostIp']!='127.0.0.1' or not value['HostPort'].isdigit():
    raise SystemExit('restore native loopback binding invalid')
print(value['HostPort'])
PY
}

dsn_for() {
  local destination="$1" port="$2" role="$3" database="$4"
  printf 'postgresql://%s@127.0.0.1:%s/%s?sslmode=verify-full&sslrootcert=%s&sslcert=%s&sslkey=%s&application_name=pkc-restore-native\n' \
    "$role" "$port" "$database" "$destination/client/ca.crt" "$destination/client/$role.crt" "$destination/client/$role.key"
}

run_psql() {
  local destination="$1" pgpass="$2"; shift 2
  PGPASSFILE="$pgpass" PGSSLMODE=verify-full PGSSLROOTCERT="$destination/client/ca.crt" \
    PGSSLCERT="$destination/client/pkc_bootstrap_admin.crt" PGSSLKEY="$destination/client/pkc_bootstrap_admin.key" \
    command psql "$@"
}

generate_tls "$temporary/source"
generate_tls "$temporary/target"
source_port="$(start_cluster "$source_name" "$temporary/source" "$source_auth" pkc_founder_mfa)"
target_port="$(start_cluster "$target_name" "$temporary/target" "$target_bootstrap_auth" pkc_founder_mfa_restore_drill)"
source_pgpass="$temporary/source/client/bootstrap.pgpass"
target_bootstrap_pgpass="$temporary/target/client/bootstrap.pgpass"
target_verifier_pgpass="$temporary/target/client/verifier.pgpass"
printf '127.0.0.1:%s:*:pkc_bootstrap_admin:%s\n127.0.0.1:%s:*:pkc_mfa_migrator:%s\n127.0.0.1:%s:*:pkc_backup_reader:%s\n' "$source_port" "$source_auth" "$source_port" "$source_auth" "$source_port" "$source_auth" >"$source_pgpass"
printf '127.0.0.1:%s:*:pkc_bootstrap_admin:%s\n' "$target_port" "$target_bootstrap_auth" >"$target_bootstrap_pgpass"
printf '127.0.0.1:%s:*:pkc_mfa_verifier:%s\n' "$target_port" "$target_verifier_auth" >"$target_verifier_pgpass"
chmod 0600 "$source_pgpass" "$target_bootstrap_pgpass" "$target_verifier_pgpass"

run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -c "ALTER DATABASE pkc_founder_mfa SET pkc.environment='production'" >/dev/null
for sql in 000_roles.sql 004_onboarding_roles.sql 006_backup_reader.sql; do
  extra=()
  [[ "$sql" == 000_roles.sql ]] && extra=(-v expected_empty_cluster=true)
  run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa "${extra[@]}" -f "$root/db/roles/$sql" >/dev/null
done
export PKC_NATIVE_SOURCE_AUTH="$source_auth"
run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
\getenv role_auth PKC_NATIVE_SOURCE_AUTH
ALTER ROLE pkc_mfa_migrator PASSWORD :'role_auth';
ALTER ROLE pkc_backup_reader PASSWORD :'role_auth';
ALTER ROLE pkc_mfa_verifier PASSWORD :'role_auth';
SQL
unset PKC_NATIVE_SOURCE_AUTH
source_system_id="$(run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -Atc "SELECT (pg_catalog.pg_control_system()).system_identifier")"
source_address="$(run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -Atc "SELECT pg_catalog.inet_server_addr()::text")"
source_migrator_dsn="$(dsn_for "$temporary/source" "$source_port" pkc_mfa_migrator pkc_founder_mfa)"
(
  export PKC_DATABASE_NAME=pkc_founder_mfa PKC_DATABASE_ENVIRONMENT=production
  export PKC_DATABASE_SYSTEM_IDENTIFIER="$source_system_id" PKC_DATABASE_SERVER_ADDRESS="$source_address" PKC_DATABASE_SERVER_PORT=5432
  export PKC_MIGRATOR_DATABASE_URL="$source_migrator_dsn"
  export PGPASSFILE="$source_pgpass"
  export PGOPTIONS='-c pkc.environment=production -c pkc.expected_environment=production'
  node "$root/db/migrate.mjs" >/dev/null
)
run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -v migrator_role=pkc_mfa_migrator -f "$root/db/roles/010_seal_migrator.sql" >/dev/null
run_psql "$temporary/source" "$source_pgpass" -h 127.0.0.1 -p "$source_port" -U pkc_bootstrap_admin -d pkc_founder_mfa -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa -v bootstrap_role=pkc_bootstrap_admin -v expected_migration_count=4 -f "$root/db/roles/020_seal_bootstrap.sql" >/dev/null

source_receipt="$temporary/source-receipt.json"
node - "$source_receipt" "$source_system_id" <<'NODE'
import { writeFileSync } from 'node:fs';
const [path, systemIdentifier] = process.argv.slice(2);
writeFileSync(path, JSON.stringify({schema_version:1,compose_project:"pkc-onboarding-postgres",service:"postgres",image:"postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",volume:"pkc_onboarding_postgres_data",private_dns:"pkc-postgres",database:"pkc_founder_mfa",environment:"production",postgres_major:16,system_identifier:systemIdentifier,tls:{enabled:true,minimum_protocol:"TLSv1.3",client_certificate_verification:"verify-full",server_name:"pkc-postgres"},durability:{fsync:true,synchronous_commit:"on",full_page_writes:true,data_checksums:true}}));
NODE

source_backup_pgpass="$temporary/source/client/backup.pgpass"
source_verifier_pgpass="$temporary/source/client/verifier.pgpass"
printf '127.0.0.1:%s:*:pkc_backup_reader:%s\n' "$source_port" "$source_auth" >"$source_backup_pgpass"
printf '127.0.0.1:%s:*:pkc_mfa_verifier:%s\n' "$source_port" "$source_auth" >"$source_verifier_pgpass"
chmod 0600 "$source_backup_pgpass" "$source_verifier_pgpass"
source_dump_pgpass="$temporary/source/client/dump.pgpass"
printf 'localhost:5432:*:pkc_backup_reader:%s\n' "$source_auth" >"$source_dump_pgpass"
chmod 0600 "$source_dump_pgpass"
docker cp "$source_dump_pgpass" "$source_name:/tmp/pkc-dump.pgpass" >/dev/null
fake_bin="$temporary/fake-bin"
mkdir "$fake_bin"
printf '%s\n' '#!/bin/sh' 'set -eu' 'if [ "${1-}" = "--version" ]; then printf "%s\\n" "pg_dump (PostgreSQL) 16.15"; exit 0; fi' 'docker exec -e PGPASSFILE=/tmp/pkc-dump.pgpass "$PKC_TEST_SOURCE_NAME" pg_dump -U pkc_backup_reader -d pkc_founder_mfa --format=custom --no-owner --schema=pkc_auth' >"$fake_bin/pg_dump"
printf '%s\n' '#!/bin/sh' 'set -eu' 'output=""' 'input=""' 'while [ "$#" -gt 0 ]; do case "$1" in --encrypt|--decrypt) shift ;; --identity|--recipients-file) shift 2 ;; --output) output="$2"; shift 2 ;; *) input="$1"; shift ;; esac; done' 'if [ "$input" = "-" ] || [ -z "$input" ]; then if [ -n "$output" ]; then dd of="$output" status=none; else dd status=none; fi; else cp -- "$input" "$output"; fi' >"$fake_bin/age"
chmod 0700 "$fake_bin/pg_dump" "$fake_bin/age"
recipients="$temporary/test-recipients"
identity="$temporary/test-identity"
printf '%s\n' 'age1testonlyrecipient' >"$recipients"
printf '%s\n' 'TEST_ONLY_FAKE_AGE_IDENTITY' >"$identity"
backup_destination="$temporary/backup-destination"
mkdir "$backup_destination"
source_backup_dsn="$(dsn_for "$temporary/source" "$source_port" pkc_backup_reader pkc_founder_mfa)"
source_verifier_dsn="$(dsn_for "$temporary/source" "$source_port" pkc_mfa_verifier pkc_founder_mfa)"
backup_result="$(PATH="$fake_bin:$PATH" PKC_TEST_SOURCE_NAME="$source_name" "$root/ops/pkc-onboarding-postgres/scripts/backup-encrypted.sh" \
  --source-dsn "$source_backup_dsn" \
  --pgpass-file "$source_backup_pgpass" \
  --verifier-dsn "$source_verifier_dsn" \
  --verifier-pgpass-file "$source_verifier_pgpass" \
  --recipients-file "$recipients" \
  --destination "$backup_destination" \
  --source-receipt "$source_receipt")"
archive="$(python3 -c 'import sys; print(dict(line.split("=",1) for line in sys.stdin.read().splitlines())["encrypted_backup"])' <<<"$backup_result")"
receipt="$(python3 -c 'import sys; print(dict(line.split("=",1) for line in sys.stdin.read().splitlines())["backup_receipt"])' <<<"$backup_result")"
checksum="$archive.sha256"
docker exec "$source_name" rm -f -- /tmp/pkc-dump.pgpass

run_psql "$temporary/target" "$target_bootstrap_pgpass" -h 127.0.0.1 -p "$target_port" -U pkc_bootstrap_admin -d pkc_founder_mfa_restore_drill -v ON_ERROR_STOP=1 -c "ALTER DATABASE pkc_founder_mfa_restore_drill SET pkc.environment='production'" >/dev/null
for sql in 000_roles.sql 004_onboarding_roles.sql 006_backup_reader.sql; do
  extra=()
  [[ "$sql" == 000_roles.sql ]] && extra=(-v expected_empty_cluster=true)
  run_psql "$temporary/target" "$target_bootstrap_pgpass" -h 127.0.0.1 -p "$target_port" -U pkc_bootstrap_admin -d pkc_founder_mfa_restore_drill -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa_restore_drill "${extra[@]}" -f "$root/db/roles/$sql" >/dev/null
done
export PKC_NATIVE_TARGET_VERIFIER_AUTH="$target_verifier_auth"
run_psql "$temporary/target" "$target_bootstrap_pgpass" -h 127.0.0.1 -p "$target_port" -U pkc_bootstrap_admin -d pkc_founder_mfa_restore_drill -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
\getenv role_auth PKC_NATIVE_TARGET_VERIFIER_AUTH
ALTER ROLE pkc_mfa_verifier PASSWORD :'role_auth';
SQL
unset PKC_NATIVE_TARGET_VERIFIER_AUTH
target_system_id="$(run_psql "$temporary/target" "$target_bootstrap_pgpass" -h 127.0.0.1 -p "$target_port" -U pkc_bootstrap_admin -d pkc_founder_mfa_restore_drill -Atc "SELECT (pg_catalog.pg_control_system()).system_identifier")"
target_address="$(run_psql "$temporary/target" "$target_bootstrap_pgpass" -h 127.0.0.1 -p "$target_port" -U pkc_bootstrap_admin -d pkc_founder_mfa_restore_drill -Atc "SELECT pg_catalog.inet_server_addr()::text")"
[[ "$source_system_id" != "$target_system_id" ]]

target_restore_pgpass="$temporary/target/client/restore.pgpass"
printf 'localhost:5432:*:pkc_bootstrap_admin:%s\n' "$target_bootstrap_auth" >"$target_restore_pgpass"
chmod 0600 "$target_restore_pgpass"
docker cp "$target_restore_pgpass" "$target_name:/tmp/pkc-restore.pgpass" >/dev/null
printf '%s\n' '#!/bin/sh' 'set -eu' 'if [ "${1-}" = "--version" ]; then printf "%s\\n" "pg_restore (PostgreSQL) 16.15"; exit 0; fi' 'docker exec -i -e PGPASSFILE=/tmp/pkc-restore.pgpass "$PKC_TEST_TARGET_NAME" pg_restore -U pkc_bootstrap_admin -d pkc_founder_mfa_restore_drill --exit-on-error --single-transaction --no-owner --role=pkc_mfa_owner' >"$fake_bin/pg_restore"
chmod 0700 "$fake_bin/pg_restore"
target_bootstrap_dsn="$(dsn_for "$temporary/target" "$target_port" pkc_bootstrap_admin pkc_founder_mfa_restore_drill)"
target_verifier_dsn="$(dsn_for "$temporary/target" "$target_port" pkc_mfa_verifier pkc_founder_mfa_restore_drill)"
PATH="$fake_bin:$PATH" PKC_TEST_TARGET_NAME="$target_name" PKC_NATIVE_TEST_DIAGNOSTICS=1 PKC_RESTORE_DRILL_ISOLATED=yes "$root/ops/pkc-onboarding-postgres/scripts/restore-drill.sh" \
  --backup "$archive" \
  --checksum "$checksum" \
  --backup-receipt "$receipt" \
  --source-receipt "$source_receipt" \
  --identity-file "$identity" \
  --target-bootstrap-dsn "$target_bootstrap_dsn" \
  --target-bootstrap-pgpass-file "$target_bootstrap_pgpass" \
  --target-verifier-dsn "$target_verifier_dsn" \
  --target-verifier-pgpass-file "$target_verifier_pgpass" \
  --target-system-identifier "$target_system_id" \
  --target-address "$target_address" \
  --target-port 5432 >/dev/null
printf '%s\n' 'native_restore_drill_pass'
