#!/usr/bin/env bash
set -euo pipefail
umask 077

SOURCE_DSN=""
PGPASS_PATH=""
VERIFIER_DSN=""
VERIFIER_PGPASS_PATH=""
RECIPIENTS=""
DESTINATION=""
SOURCE_RECEIPT=""
while (($#)); do
  case "$1" in
    --source-dsn) SOURCE_DSN="${2-}"; shift 2 ;;
    --pgpass-file) PGPASS_PATH="${2-}"; shift 2 ;;
    --verifier-dsn) VERIFIER_DSN="${2-}"; shift 2 ;;
    --verifier-pgpass-file) VERIFIER_PGPASS_PATH="${2-}"; shift 2 ;;
    --recipients-file) RECIPIENTS="${2-}"; shift 2 ;;
    --destination) DESTINATION="${2-}"; shift 2 ;;
    --source-receipt) SOURCE_RECEIPT="${2-}"; shift 2 ;;
    *) printf '%s\n' 'backup rejected: unknown argument' >&2; exit 64 ;;
  esac
done
[[ -n "$SOURCE_DSN" && -n "$PGPASS_PATH" && -n "$VERIFIER_DSN" && -n "$VERIFIER_PGPASS_PATH" && -n "$RECIPIENTS" && -n "$DESTINATION" && -n "$SOURCE_RECEIPT" ]] || {
  printf '%s\n' 'usage: backup-encrypted.sh --source-dsn BACKUP_READER_DSN --pgpass-file FILE --verifier-dsn VERIFIER_DSN --verifier-pgpass-file FILE --recipients-file FILE --destination EXISTING_OFF_HOST_MOUNT --source-receipt FILE' >&2
  exit 64
}
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
project_root="$(CDPATH= cd -- "$script_dir/../../.." && pwd -P)"
[[ -f "$PGPASS_PATH" && ! -L "$PGPASS_PATH" && -f "$VERIFIER_PGPASS_PATH" && ! -L "$VERIFIER_PGPASS_PATH" && -f "$RECIPIENTS" && ! -L "$RECIPIENTS" && -f "$SOURCE_RECEIPT" && ! -L "$SOURCE_RECEIPT" && -d "$DESTINATION" && ! -L "$DESTINATION" ]] || {
  printf '%s\n' 'backup rejected: inputs/destination must pre-exist and may not be symlinks' >&2; exit 1
}
[[ "$DESTINATION" = /* && "$DESTINATION" != "/" ]] || { printf '%s\n' 'backup rejected: bounded absolute destination required' >&2; exit 1; }
for command_name in node pg_dump age sha256sum mktemp ln; do command -v "$command_name" >/dev/null || { printf 'backup rejected: missing command %s\n' "$command_name" >&2; exit 1; }; done
[[ "$(pg_dump --version)" =~ ^pg_dump\ \(PostgreSQL\)\ 16\. ]] || { printf '%s\n' 'backup rejected: pg_dump major 16 required' >&2; exit 1; }
node "$project_root/db/validate-client-authority.mjs" --connection-string "$SOURCE_DSN" --pgpass-file "$PGPASS_PATH" --expected-user pkc_backup_reader >/dev/null
node "$project_root/db/validate-client-authority.mjs" --connection-string "$VERIFIER_DSN" --pgpass-file "$VERIFIER_PGPASS_PATH" --expected-user pkc_mfa_verifier >/dev/null
node "$script_dir/validate-cluster-receipt.mjs" "$SOURCE_RECEIPT" >/dev/null
attestation="$(node "$script_dir/attest-backup-source.mjs" \
  --backup-dsn "$SOURCE_DSN" \
  --backup-pgpass-file "$PGPASS_PATH" \
  --verifier-dsn "$VERIFIER_DSN" \
  --verifier-pgpass-file "$VERIFIER_PGPASS_PATH" \
  --source-receipt "$SOURCE_RECEIPT")"
attested_source_receipt_sha="$(node -e 'const value=JSON.parse(process.argv[1]); if(!/^[a-f0-9]{64}$/.test(value.sourceReceiptSha256||"")) process.exit(1); process.stdout.write(value.sourceReceiptSha256)' "$attestation")"

export PGPASSFILE="$PGPASS_PATH"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="pkc-onboarding-$stamp.dump.age"
final="$DESTINATION/$base"
checksum_final="$final.sha256"
receipt_final="$final.receipt.json"
temporary="$(mktemp "$DESTINATION/.pkc-backup.XXXXXX")"
checksum_temporary="$(mktemp "$DESTINATION/.pkc-checksum.XXXXXX")"
receipt_temporary="$(mktemp "$DESTINATION/.pkc-receipt.XXXXXX")"
published_final=0
published_checksum=0
published_receipt=0
success=0
cleanup() {
  rm -f -- "$temporary" "$checksum_temporary" "$receipt_temporary"
  if [[ "$success" != 1 ]]; then
    [[ "$published_receipt" = 0 ]] || rm -f -- "$receipt_final"
    [[ "$published_checksum" = 0 ]] || rm -f -- "$checksum_final"
    [[ "$published_final" = 0 ]] || rm -f -- "$final"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

pg_dump --format=custom --no-owner --schema=pkc_auth --dbname="$SOURCE_DSN" \
  | age --encrypt --recipients-file "$RECIPIENTS" --output "$temporary"
[[ -s "$temporary" ]] || { printf '%s\n' 'backup rejected: encrypted output is empty' >&2; exit 1; }
artifact_sha="$(sha256sum -- "$temporary" | cut -d' ' -f1)"
source_receipt_sha="$attested_source_receipt_sha"
printf '%s  %s\n' "$artifact_sha" "$base" >"$checksum_temporary"
node - "$base" "$artifact_sha" "$source_receipt_sha" "$stamp" >"$receipt_temporary" <<'NODE'
const [artifact, artifactSha256, sourceReceiptSha256, createdAt] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({schema:"pkc-encrypted-backup-receipt-v1",artifact,artifactSha256,sourceReceiptSha256,createdAt},null,2)}\n`);
NODE
ln -- "$temporary" "$final" || { printf '%s\n' 'backup rejected: artifact collision' >&2; exit 1; }
published_final=1
ln -- "$checksum_temporary" "$checksum_final" || { printf '%s\n' 'backup rejected: checksum collision' >&2; exit 1; }
published_checksum=1
ln -- "$receipt_temporary" "$receipt_final" || { printf '%s\n' 'backup rejected: receipt collision' >&2; exit 1; }
published_receipt=1
success=1
printf 'encrypted_backup=%s\nbackup_receipt=%s\n' "$final" "$receipt_final"
