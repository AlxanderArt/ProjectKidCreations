# Gate 0 production operations lane

These repository tools prepare and verify metadata/evidence only. They do not authorize or perform live provider, PostgreSQL, n8n, Vercel, key, deployment, activation, enrollment, or cleanup operations. The approved plan digest is `7f9b6d6f5c17e80649e42fefd860f476160be6bd1a809511543e4a27814e5454`.

## Manual Production rollout

Use [`manual-founder-mfa-rollout.md`](manual-founder-mfa-rollout.md) for the human-controlled provider-native sequence. Every external mutation has its own approval and native readback; repository monitoring remains a diagnostic, non-sending evaluator and is not a scheduler or release authority.

## Commands

```sh
node scripts/ops/candidate.mjs --help
node scripts/ops/keys.mjs --help
node scripts/ops/restore.mjs --help
node scripts/ops/vercel.mjs --help
node scripts/ops/n8n-retention.mjs --help
node scripts/ops/monitor.mjs --help
node scripts/ops/receipt.mjs --help
npm run test:contracts
```

All executables have a no-action default. Help is accepted only as the sole argument `--help`. Every command has one documented ordered grammar: unknown, trailing, duplicate, reordered, missing, and empty-value arguments fail before file access. Verification consumes sanitized JSON. No command needs provider credentials for Gate 0. Local state changes are limited to explicitly approved disposable targets: candidate `manifest --output` writes one no-clobber mode-`0600` manifest only with `--execute-local --target-kind disposable-local` and its exact typed approval; key `generate` writes four no-clobber mode-`0600` files; key `cleanup` deletes only files bound by the exact interrupted-run marker. Both key commands require an explicit command, the same local/target assertions, and their command-specific exact typed approval. Production-like paths are rejected; this repository exposes no production file-write or key-cleanup path. Key values are never emitted.

## Canonical JSON and candidate fingerprint

Canonical serialization is UTF-8 JSON with object keys sorted recursively by Unicode code-unit order, original array order preserved, no insignificant whitespace, and exactly one final LF. Own keys such as `__proto__` are copied with data-property definitions so they remain visible to closed schemas without mutating prototypes. Unsupported values, cycles, accessors, exotic prototypes, non-finite numbers, and negative zero are rejected without executing getters. The candidate inventory uses Git's tracked file list plus nonignored untracked file list, sorts path bytes, and rejects duplicates, symlinks, non-regular files, absolute/parent paths, dumps/databases, ad-hoc screenshots/images, logs, Playwright output, unapproved reports, and unsafe sensitive assignments. The only admitted SQL authorities are `db/migrations/*.sql` and the three exact case-sensitive role paths `db/roles/000_roles.sql`, `db/roles/005_unseal_migrator.sql`, and `db/roles/010_seal_migrator.sql`; all must be canonical UTF-8 text and remain credential-marker and sensitive-assignment scanned. For each file it snapshots the canonical root and every parent directory, rejects every symlink ancestor, opens the leaf with `O_NOFOLLOW`, binds `/proc/self/fd/<fd>` to the exact intended canonical path on Linux, compares regular-file device/inode/mode/size/mtime/ctime before and after the bounded descriptor read, and rechecks root/ancestor identities afterward. If containment or identity cannot be proven, it fails closed. Every candidate other than the narrow reviewed raster/font/model source-asset classes must round-trip as strict NUL-free canonical UTF-8; an initial UTF-8 BOM, malformed/overlong/surrogate encoding, NUL, or non-roundtripping bytes is rejected. The bounded assignment scanner reconstructs the complete sensitive RHS through a statement delimiter and defaults to denial: concatenated literals, decoding/base64/`Buffer.from`/`atob` calls, templates, prefix-disguised long literals, and direct literals are forbidden. Exact reviewed markers and simple runtime identifiers/member references without embedded literals remain accepted under the existing JavaScript policy. Executable text means any `.sh`, `.bash`, `.dash`, `.ksh`, or `.zsh` path, or any text whose first two bytes are `#!`, regardless of the named or malformed interpreter. In that lane only, a sensitive RHS may additionally be exactly `$NAME`, `${NAME}`, `"$NAME"`, or `"${NAME}"`, where `NAME` matches `[A-Za-z_][A-Za-z0-9_]*`; single quotes, direct command/arithmetic substitution, static literals, prefixes/suffixes, fallback or indirect expansion, concatenation, and compound expressions remain forbidden. Sensitive-assignment scanning in that lane is deliberately comment-blind: `#`, quoting, URL fragments, escapes, continuations, substitutions, and GNU `env` spellings do not hide an assignment; an unsafe assignment in a comment is rejected, while exact approved placeholders remain allowed. This is a bounded conservative lexical policy, not a shell parser or environment interpreter: admitting a variable reference makes no claim that its indirection is safe, and the scanner does not promise detection of `eval`, indirection, or dynamically constructed variable names. Unknown extensionless text without `#!` retains the existing conservative generic-text comment handling. GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and `github_pat_` families, other credential prefixes, and private-key markers remain forbidden even in comments. Explicit binary policy permits only reviewed raster assets under `assets/badges` and `assets/og`, WOFF2 files under `assets/fonts`, and GLB files under `assets/models`; SVG remains scanned text. The tracked boot-performance JSON is an explicit test fixture, not a general reports exception. File and aggregate byte limits are enforced before bounded reads. Each entry binds relative path, byte count, POSIX mode, and SHA-256. Snapshot metadata binds exact HEAD commit, HEAD tree, dirty state, and status digest without invoking a tree-writing Git operation. The fingerprint is lowercase SHA-256 of canonical manifest bytes before adding the `fingerprint` property. `verify` rebuilds and compares the complete canonical manifest.

Monitoring and receipt inputs are closed descriptor-safe JSON data. They reject accessors/exotic prototypes, scan key names and string values for secret-like content, and enforce depth/node/array/string/aggregate-byte limits before copying. Monitoring accepts opaque `eventId` and `operationKey` inputs only through 128 characters and emits only their SHA-256 digests. Successful mutation receipts use closed `{stateReceiptId,stateDigest}` prior/new references and require every verification item to be `pass`.

The restore CLI is only a non-authoritative sanitized syntax/parity evaluator. Accepted output is always `authoritative=false` and `releaseEligible=false`; trusted provider provenance and direct readback remain external release gates. Vercel candidate evidence derives its entire nonempty `api/**/*.js` function inventory from the frozen manifest and enforces the exact ceiling of 10 before deployment evidence can be checked.

## Artifact map

- `server/ops/`: deterministic pure validators/planners.
- `scripts/ops/`: CLI surfaces.
- `schemas/operations/` and `evidence/templates/`: closed mutation/approval receipts.
- `monitoring/founder-mfa-alert-policy.json`: alert contract; evaluator never sends externally.
- `docs/operations/manual-founder-mfa-rollout.md`: authoritative manual rollout sequence, approvals, native readback, rollback, and stop rules.
- `docs/operations/`: supporting stage-specific procedures and diagnostic contracts.

## Deferred live gates

Provider selection/provisioning, snapshots/restores, role/migration apply, production key generation/upload, n8n retention changes, history purge, inactive import, credential binding, Preview activation, merge, Production variables/deployments, alias cutover, workflow activation, founder enrollment, destructive cleanup, and live monitoring delivery remain unperformed. Use the stage runbook and exact mutation receipt for each separately approved window. Never infer approval for a later stage.
