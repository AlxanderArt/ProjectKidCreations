#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/pkc-n8n-permission-gate.XXXXXX")"
allowed_tmp="$test_root/allowed"
denied_dir="$test_root/test-only-denied/root/.hermes/protected/pkc-founder-mfa/source-workflows"
mkdir -p "$allowed_tmp" "$denied_dir"
printf '%s\n' 'harmless permission-boundary canary' > "$denied_dir/canary.txt"
chmod 0700 "$test_root" "$allowed_tmp" "$test_root/test-only-denied" "$test_root/test-only-denied/root" "$test_root/test-only-denied/root/.hermes" "$test_root/test-only-denied/root/.hermes/protected" "$test_root/test-only-denied/root/.hermes/protected/pkc-founder-mfa" "$denied_dir"
chmod 0600 "$denied_dir/canary.txt"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT INT TERM HUP

node_command=(node)
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
  node_command=(npx --yes node@24)
fi

cd "$repo_root"
TMPDIR="$allowed_tmp" \
PKC_N8N_TEST_AUTHORITY=synthetic \
PKC_N8N_DENIED_CANARY="$denied_dir/canary.txt" \
"${node_command[@]}" \
  --permission \
  --allow-fs-read="$repo_root/scripts/**" \
  --allow-fs-read="$repo_root/tests/**" \
  --allow-fs-read="$repo_root/db/migrations/**" \
  --allow-fs-read="$repo_root/ops/n8n-disposable/compose.yml" \
  --allow-fs-read="$repo_root/ops/n8n-disposable/rehearse.mjs" \
  --allow-fs-read="$repo_root/.github/workflows/ci.yml" \
  --allow-fs-read="$repo_root/package.json" \
  --allow-fs-read="$allowed_tmp/**" \
  --allow-fs-write="$allowed_tmp/**" \
  tests/contracts/n8n-synthetic-permission-gate.test.mjs
