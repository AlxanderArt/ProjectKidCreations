#!/usr/bin/env bash
set -euo pipefail
umask 077

BACKUP=""
CHECKSUM=""
BACKUP_RECEIPT=""
SOURCE_RECEIPT=""
IDENTITY_FILE=""
TARGET_BOOTSTRAP_DSN=""
TARGET_BOOTSTRAP_PGPASS=""
TARGET_VERIFIER_DSN=""
TARGET_VERIFIER_PGPASS=""
TARGET_SYSTEM_IDENTIFIER=""
TARGET_ADDRESS=""
TARGET_PORT=""
while (($#)); do
  case "$1" in
    --backup) BACKUP="${2-}"; shift 2 ;;
    --checksum) CHECKSUM="${2-}"; shift 2 ;;
    --backup-receipt) BACKUP_RECEIPT="${2-}"; shift 2 ;;
    --source-receipt) SOURCE_RECEIPT="${2-}"; shift 2 ;;
    --identity-file) IDENTITY_FILE="${2-}"; shift 2 ;;
    --target-bootstrap-dsn) TARGET_BOOTSTRAP_DSN="${2-}"; shift 2 ;;
    --target-bootstrap-pgpass-file) TARGET_BOOTSTRAP_PGPASS="${2-}"; shift 2 ;;
    --target-verifier-dsn) TARGET_VERIFIER_DSN="${2-}"; shift 2 ;;
    --target-verifier-pgpass-file) TARGET_VERIFIER_PGPASS="${2-}"; shift 2 ;;
    --target-system-identifier) TARGET_SYSTEM_IDENTIFIER="${2-}"; shift 2 ;;
    --target-address) TARGET_ADDRESS="${2-}"; shift 2 ;;
    --target-port) TARGET_PORT="${2-}"; shift 2 ;;
    *) printf '%s\n' 'restore rejected: unknown argument' >&2; exit 64 ;;
  esac
done
[[ "${PKC_RESTORE_DRILL_ISOLATED-}" == "yes" ]] || { printf '%s\n' 'restore rejected: explicit isolated-drill gate required' >&2; exit 1; }
for value in "$BACKUP" "$CHECKSUM" "$BACKUP_RECEIPT" "$SOURCE_RECEIPT" "$IDENTITY_FILE" "$TARGET_BOOTSTRAP_DSN" "$TARGET_BOOTSTRAP_PGPASS" "$TARGET_VERIFIER_DSN" "$TARGET_VERIFIER_PGPASS" "$TARGET_SYSTEM_IDENTIFIER" "$TARGET_ADDRESS" "$TARGET_PORT"; do
  [[ -n "$value" ]] || { printf '%s\n' 'restore rejected: all arguments are required' >&2; exit 64; }
done
[[ "$TARGET_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]{15,24}$ && "$TARGET_PORT" =~ ^[0-9]+$ ]] || { printf '%s\n' 'restore rejected: target identity invalid' >&2; exit 1; }
for path in "$BACKUP" "$CHECKSUM" "$BACKUP_RECEIPT" "$SOURCE_RECEIPT" "$IDENTITY_FILE" "$TARGET_BOOTSTRAP_PGPASS" "$TARGET_VERIFIER_PGPASS"; do
  [[ -f "$path" && ! -L "$path" ]] || { printf '%s\n' 'restore rejected: protected files must be regular and non-symlinked' >&2; exit 1; }
done
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
project_root="$(CDPATH= cd -- "$script_dir/../../.." && pwd -P)"
for command_name in node age pg_restore psql; do command -v "$command_name" >/dev/null || { printf 'restore rejected: missing command %s\n' "$command_name" >&2; exit 1; }; done
[[ "$(pg_restore --version)" =~ ^pg_restore\ \(PostgreSQL\)\ 16\. ]] || { printf '%s\n' 'restore rejected: pg_restore major 16 required' >&2; exit 1; }
validation_result="$(node "$script_dir/decrypt-validated-backup.mjs" --validate-only \
  --artifact "$BACKUP" \
  --checksum "$CHECKSUM" \
  --backup-receipt "$BACKUP_RECEIPT" \
  --source-receipt "$SOURCE_RECEIPT")"
validation_first="${validation_result%%$'\n'*}"
validation_second="${validation_result#*$'\n'}"
[[ "$validation_first" =~ ^set_proof=([a-f0-9]{64})$ && "$validation_second" =~ ^source_receipt_base64=([A-Za-z0-9+/]+={0,2})$ ]] || { printf '%s\n' 'restore rejected: validated set handoff invalid' >&2; exit 1; }
set_proof="${validation_first#set_proof=}"
source_receipt_base64="${validation_second#source_receipt_base64=}"
node "$project_root/db/validate-client-authority.mjs" --connection-string "$TARGET_BOOTSTRAP_DSN" --pgpass-file "$TARGET_BOOTSTRAP_PGPASS" --expected-user pkc_bootstrap_admin >/dev/null
node "$project_root/db/validate-client-authority.mjs" --connection-string "$TARGET_VERIFIER_DSN" --pgpass-file "$TARGET_VERIFIER_PGPASS" --expected-user pkc_mfa_verifier >/dev/null
node "$script_dir/preflight-restore-target.mjs" \
  --connection-string "$TARGET_BOOTSTRAP_DSN" \
  --pgpass-file "$TARGET_BOOTSTRAP_PGPASS" \
  --source-receipt-base64 "$source_receipt_base64" \
  --expected-system-identifier "$TARGET_SYSTEM_IDENTIFIER" \
  --expected-server-address "$TARGET_ADDRESS" \
  --expected-server-port "$TARGET_PORT" \
  --expected-database pkc_founder_mfa_restore_drill \
  --expected-user pkc_bootstrap_admin >/dev/null

export PGPASSFILE="$TARGET_BOOTSTRAP_PGPASS"
node "$script_dir/decrypt-validated-backup.mjs" --decrypt-stdout \
  --artifact "$BACKUP" \
  --checksum "$CHECKSUM" \
  --backup-receipt "$BACKUP_RECEIPT" \
  --source-receipt "$SOURCE_RECEIPT" \
  --identity-file "$IDENTITY_FILE" \
  --expected-set-proof "$set_proof" | \
  pg_restore --exit-on-error --single-transaction --no-owner --role=pkc_mfa_owner --dbname="$TARGET_BOOTSTRAP_DSN"
psql "$TARGET_BOOTSTRAP_DSN" -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa_restore_drill -f "$project_root/db/roles/004_onboarding_roles.sql" >/dev/null
psql "$TARGET_BOOTSTRAP_DSN" -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa_restore_drill -f "$project_root/db/roles/006_backup_reader.sql" >/dev/null
psql "$TARGET_BOOTSTRAP_DSN" -v ON_ERROR_STOP=1 -c "ALTER DATABASE pkc_founder_mfa_restore_drill SET pkc.environment='production'" >/dev/null
psql "$TARGET_BOOTSTRAP_DSN" -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa_restore_drill -f "$project_root/db/roles/010_seal_migrator.sql" >/dev/null
psql "$TARGET_BOOTSTRAP_DSN" -v ON_ERROR_STOP=1 -v expected_database=pkc_founder_mfa_restore_drill -v bootstrap_role=pkc_bootstrap_admin -f "$project_root/db/roles/020_seal_bootstrap.sql" >/dev/null

export PKC_DATABASE_URL="$TARGET_VERIFIER_DSN"
export PGPASSFILE="$TARGET_VERIFIER_PGPASS"
export PKC_DATABASE_NAME="pkc_founder_mfa_restore_drill"
export PKC_DATABASE_USER="pkc_mfa_verifier"
export PKC_DATABASE_ENVIRONMENT="production"
export PKC_DATABASE_SYSTEM_IDENTIFIER="$TARGET_SYSTEM_IDENTIFIER"
export PKC_DATABASE_SERVER_ADDRESS="$TARGET_ADDRESS"
export PKC_DATABASE_SERVER_PORT="$TARGET_PORT"
node "$project_root/db/readiness.mjs" >/dev/null
printf '%s\n' \
  'restore_target_identity_verified_before_mutation=true' \
  'restore_content_verified=true' \
  'restore_runtime_authority_sealed=true' \
  'restore_resource_isolation_requires_operator_receipt=true'
