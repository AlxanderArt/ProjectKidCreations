#!/usr/bin/env bash
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$script_dir/publish-a1of1-backup.mjs" "$@"
