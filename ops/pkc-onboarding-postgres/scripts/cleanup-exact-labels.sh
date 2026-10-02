#!/usr/bin/env bash
set -euo pipefail

PROJECT_LABEL='com.docker.compose.project=pkc-onboarding-postgres'
SERVICE_LABEL='com.docker.compose.service=postgres'
NETWORK_LABEL='com.docker.compose.network=pkc_private'
EXPECTED_VOLUME='pkc_onboarding_postgres_data'
EXPECTED_NETWORK='pkc_onboarding_private'

query() {
  local output
  output="$("$@")" || { printf '%s\n' 'cleanup rejected: Docker inventory failed' >&2; exit 1; }
  printf '%s' "$output"
}
containers="$(query docker ps -aq --filter "label=$PROJECT_LABEL" --filter "label=$SERVICE_LABEL")"
networks="$(query docker network ls -q --filter "label=$PROJECT_LABEL" --filter "label=$NETWORK_LABEL")"
volumes="$(query docker volume ls -q --filter "label=$PROJECT_LABEL")"
[[ "$volumes" == "$EXPECTED_VOLUME" ]] || { printf '%s\n' 'cleanup rejected: exact preserved volume mismatch' >&2; exit 1; }
for id in $containers $networks; do [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || { printf '%s\n' 'cleanup rejected: invalid Docker object identifier' >&2; exit 1; }; done
network_names=""
for id in $networks; do
  name="$(query docker network inspect --format '{{.Name}}' "$id")"
  [[ "$name" == "$EXPECTED_NETWORK" ]] || { printf '%s\n' 'cleanup rejected: unexpected network label match' >&2; exit 1; }
  network_names="$network_names $name"
done
if [[ "${1-}" != "--execute" ]]; then
  printf '%s\n' 'dry-run only; execution requires --execute and PKC_EXACT_CLEANUP_APPROVED=yes' "containers=$containers" "networks=$network_names" "preserved_volume=$volumes"
  exit 0
fi
[[ "${PKC_EXACT_CLEANUP_APPROVED-}" == "yes" ]] || { printf '%s\n' 'cleanup rejected: explicit exact-label approval required' >&2; exit 1; }
for id in $containers; do docker rm -f -- "$id"; done
for id in $networks; do docker network rm -- "$id"; done
remaining_containers="$(query docker ps -aq --filter "label=$PROJECT_LABEL" --filter "label=$SERVICE_LABEL")"
remaining_networks="$(query docker network ls -q --filter "label=$PROJECT_LABEL" --filter "label=$NETWORK_LABEL")"
remaining_volumes="$(query docker volume ls -q --filter "label=$PROJECT_LABEL")"
[[ -z "$remaining_containers" && -z "$remaining_networks" && "$remaining_volumes" == "$EXPECTED_VOLUME" ]] || {
  printf '%s\n' 'cleanup rejected: readback did not prove container/network removal with volume preservation' >&2
  exit 1
}
printf '%s\n' 'cleanup_complete=true' "preserved_volume=$remaining_volumes"
