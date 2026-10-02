#!/usr/bin/env sh
set -eu
umask 077
stage=/var/run/postgresql/pkc-tls
mkdir -p "$stage"
chown postgres:postgres "$stage"
chmod 0700 "$stage"
cp /run/secrets/postgres_server_cert "$stage/server.crt"
cp /run/secrets/postgres_server_key "$stage/server.key"
cp /run/secrets/postgres_client_ca "$stage/client-ca.crt"
chown postgres:postgres "$stage/server.crt" "$stage/server.key" "$stage/client-ca.crt"
chmod 0644 "$stage/server.crt" "$stage/client-ca.crt"
chmod 0600 "$stage/server.key"
exec /usr/local/bin/docker-entrypoint.sh "$@"
