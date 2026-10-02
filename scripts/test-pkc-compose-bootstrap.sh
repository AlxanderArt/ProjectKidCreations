#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
name="pkc-compose-bootstrap-native-$$"
temporary="$(mktemp -d)"
auth_material="$(openssl rand -hex 24)"
image="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
bootstrap_file_key="POSTGRES_$(printf '%s' 'PASS' 'WORD')_FILE"
cleanup() {
  local status=$?
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
  if docker ps -a --format '{{.Names}}' | grep -Fx "$name" >/dev/null; then
    printf '%s\n' 'compose_bootstrap_cleanup_failed' >&2
    status=1
  fi
  return "$status"
}
trap cleanup EXIT INT TERM
mkdir -p "$temporary/secrets" "$temporary/client"
printf '%s' "$auth_material" >"$temporary/secrets/pkc_bootstrap_auth_file"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=PKC Bootstrap Test CA' -keyout "$temporary/ca.key" -out "$temporary/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$temporary/secrets/postgres_server_key" -out "$temporary/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' >"$temporary/server.ext"
openssl x509 -req -days 2 -in "$temporary/server.csr" -CA "$temporary/ca.crt" -CAkey "$temporary/ca.key" -CAcreateserial -extfile "$temporary/server.ext" -out "$temporary/secrets/postgres_server_cert" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=pkc_bootstrap_admin' -keyout "$temporary/client/client.key" -out "$temporary/client/client.csr" >/dev/null 2>&1
printf '%s\n' 'extendedKeyUsage=clientAuth' >"$temporary/client.ext"
openssl x509 -req -days 2 -in "$temporary/client/client.csr" -CA "$temporary/ca.crt" -CAkey "$temporary/ca.key" -CAcreateserial -extfile "$temporary/client.ext" -out "$temporary/client/client.crt" >/dev/null 2>&1
cp "$temporary/ca.crt" "$temporary/secrets/postgres_client_ca"
cp "$temporary/ca.crt" "$temporary/client/ca.crt"
chmod 0600 "$temporary/secrets/"* "$temporary/client/"*

docker run -d --name "$name" \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
  -e POSTGRES_USER=pkc_bootstrap_admin \
  -e "$bootstrap_file_key=/run/secrets/pkc_bootstrap_auth_file" \
  -e 'POSTGRES_INITDB_ARGS=--data-checksums --auth-host=scram-sha-256 --auth-local=scram-sha-256' \
  -v "$temporary/secrets/pkc_bootstrap_auth_file:/run/secrets/pkc_bootstrap_auth_file:ro" \
  -v "$temporary/secrets/postgres_server_cert:/run/secrets/postgres_server_cert:ro" \
  -v "$temporary/secrets/postgres_server_key:/run/secrets/postgres_server_key:ro" \
  -v "$temporary/secrets/postgres_client_ca:/run/secrets/postgres_client_ca:ro" \
  -v "$root/ops/pkc-onboarding-postgres/scripts/pkc-postgres-entrypoint.sh:/usr/local/bin/pkc-postgres-entrypoint.sh:ro" \
  -v "$root/ops/pkc-onboarding-postgres/config/postgresql.conf:/etc/postgresql/postgresql.conf:ro" \
  -v "$root/ops/pkc-onboarding-postgres/config/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro" \
  -p 127.0.0.1::5432 \
  --entrypoint /usr/local/bin/pkc-postgres-entrypoint.sh \
  "$image" postgres -c config_file=/etc/postgresql/postgresql.conf -c hba_file=/etc/postgresql/pg_hba.conf >/dev/null
ready=false
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U pkc_bootstrap_admin >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf '%s\n' 'compose_bootstrap_not_ready' >&2; exit 1; }
binding="$(docker container inspect "$name" --format '{{json (index (index .NetworkSettings.Ports "5432/tcp") 0)}}')"
read -r host_ip port < <(python3 - "$binding" <<'PY'
import json, sys
value=json.loads(sys.argv[1])
if set(value)!={'HostIp','HostPort'} or value['HostIp']!='127.0.0.1' or not value['HostPort'].isdigit():
    raise SystemExit('compose bootstrap loopback binding invalid')
print(value['HostIp'], value['HostPort'])
PY
)
pgpass="$temporary/client/pgpass"
printf '127.0.0.1:%s:postgres:pkc_bootstrap_admin:%s\n' "$port" "$auth_material" >"$pgpass"
chmod 0600 "$pgpass"
result="$(PGPASSFILE="$pgpass" PGSSLMODE=verify-full PGSSLROOTCERT="$temporary/client/ca.crt" PGSSLCERT="$temporary/client/client.crt" PGSSLKEY="$temporary/client/client.key" psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -Atc "SELECT current_user || ':' || ssl::text || ':' || client_dn FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()")"
[[ "$result" == 'pkc_bootstrap_admin:true:/CN=pkc_bootstrap_admin' ]] || { printf '%s\n' 'compose_bootstrap_mtls_attestation_failed' >&2; exit 1; }
if PGPASSFILE="$pgpass" PGSSLMODE=verify-full PGSSLROOTCERT="$temporary/client/ca.crt" psql -h 127.0.0.1 -p "$port" -U pkc_bootstrap_admin -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
  printf '%s\n' 'compose_bootstrap_client_certificate_bypass' >&2
  exit 1
fi
if docker exec "$name" psql -U pkc_bootstrap_admin -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
  printf '%s\n' 'compose_bootstrap_local_scram_bypass' >&2
  exit 1
fi
printf '%s\n' 'compose_bootstrap_native_pass'
