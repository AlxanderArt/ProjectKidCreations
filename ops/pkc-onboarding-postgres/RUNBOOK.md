# Private PostgreSQL provisioning and recovery runbook

## Authority and stop boundary

This runbook describes a future, separately approved operation. The repository changes are source-only. Do not start or stop Docker, access n8n or a database, create credentials, inspect secret values, or mutate live state during source verification. Do not edit /root/docker-compose.yml. Do not delete volumes. Every mutation gate needs explicit operator approval and readback evidence.

## Gate 1 — source and capacity

1. Verify the exact source commit/worktree and require a clean reviewed diff.
2. Record host CPU, memory, disk, and inode evidence without secret output.
3. Fill a copy of `capacity.input.example.json` from read-only measurements.
4. Run `check-capacity.mjs`. Current CPU, memory, and disk use/allocation must each be **capacity below 80%**, and projected PostgreSQL allocation plus bounded reserve must remain at or below 80%. Do not provision when the gate fails.
5. Verify Compose has 0.75 CPU, 768 MiB memory, 200 PIDs, 128 MiB shared memory, bounded logs, and 60-second stop grace.

## Gate 2 — credentials and TLS

1. Generate real credentials and certificates only in an approved secret store, never in this repository.
2. Stage the exact five-file server-validation bundle—bootstrap auth file, server certificate, server private key, server CA, and client CA—with `0400`/`0600` modes and approved ownership, then run `validate-secrets.py` against that directory. The validator checks certificate validity, server-CA trust, client-CA validity, private-key parseability, and server certificate/key correspondence from no-follow descriptors. Never print or hash password material into a receipt. Compose mounts only the four runtime-required files; the server CA remains validation-only.
3. Stage `pkc_bootstrap_admin`, `pkc_backup_reader`, and every operational client in separate root-owned directories containing only that role's CA, certificate, private key, and PGPASS file. Validate each client authority independently; never reuse client credentials between roles or distribute bootstrap/backup authority to n8n.
4. Verify server TLS 1.3 minimum, server-name identity `pkc-postgres`, CA trust, and client certificate verification `verify-full`.
5. Verify all client DSNs are credential-free and all password lookup uses `PGPASSFILE`. Reject password URI, password environment values, and password command arguments.

## Gate 3 — rendered Compose review

1. Render the current root Compose to baseline JSON without changing it.
2. Prepare a candidate that adds only external `pkc_onboarding_private` to n8n. SQLite remains authoritative through the unchanged `/home/node/.n8n` volume and unchanged n8n environment.
3. Render the candidate and the separate PostgreSQL Compose project to JSON.
4. Run the rendered Compose verifier. PostgreSQL must have no host port, must never join `root_default`, and must join only its internal private network. n8n must retain `root_default` and add only the external private PKC network.
5. Review the JSON diff before requesting any mutation approval.

## Gate 4 — provisioning and cluster identity receipt

Only after explicit provisioning approval, create the separate project. Fresh initialization uses SCRAM for both local and host authentication because the official image enters PostgreSQL as the custom `pkc_bootstrap_admin` database role while its operating-system process runs as `postgres`; peer authentication is forbidden. As `pkc_bootstrap_admin`, run guarded `000_roles.sql` exactly once, idempotent `004_onboarding_roles.sql`, idempotent `006_backup_reader.sql`, migrations `001`, `002`, `003`, and `004` in manifest order, `010_seal_migrator.sql`, then `020_seal_bootstrap.sql`. Read back—not infer—the project, service, immutable image digest, named volume, private DNS, database, environment, PostgreSQL 16 major, `pg_control_system().system_identifier`, TLS posture, exact superuser and `pg_control_system()` ACL inventories, both sealed LOGIN states, and durability settings (`fsync`, `synchronous_commit`, `full_page_writes`, data checksums). Record the exact cluster identity receipt using `cluster-identity.receipt.example.json`, then run `validate-cluster-receipt.mjs` and runtime-sealed readiness.

A healthy container alone is not acceptance. Missing or mismatched receipt fields are a HOLD.

## Gate 5 — encrypted backup and A1of1 custody

1. The fixed off-host destination is A1of1 at `/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres`. A1of1's PostgreSQL 17 cluster remains the canonical local universe database; the VPS PostgreSQL 16 backup is only an encrypted exported recovery artifact and must never be imported into, update, or imply authority over that cluster. Backblaze or other S3-compatible storage is optional tertiary redundancy, not the required destination.
2. Revalidate strict key-only SSH alias `a1of1`, private Tailscale reachability, exact remote user `aiel`, FileVault On, owner-only `0700` destination directories, same-filesystem staging/bundles/receipts, and at least the encrypted artifact size plus 1 GiB free before transfer. Do not accept a caller-supplied host, user, or destination root.
3. Use the dedicated `pkc_backup_reader` credential-free strict-TLS source DSN and its restricted `PGPASSFILE` for data access, plus the separate `pkc_mfa_verifier` DSN and `PGPASSFILE` for pre-dump provenance attestation. Before any temporary artifact or `pg_dump`, bind live database/user/server/TLS/durability identity, the immutable `system_identifier`, environment, and full runtime-sealed catalog readiness to the validated source receipt; require the backup reader and verifier to resolve to the same live server/database. Prove the backup reader can read every `pkc_auth` table and sequence needed by `pg_dump`, cannot write, cannot execute application functions, owns nothing, and has no role memberships.
4. Require `pg_dump` major 16. The script rejects other client majors because newer clients may emit session settings unsupported by PostgreSQL 16. Archive only `pkc_auth` with its application ACLs/default ACLs; do not archive modified `pg_catalog` ACLs.
5. Run `backup-encrypted.sh` only under separate backup approval. Verify encrypted output is non-empty and preserve its generated SHA-256 sidecar plus receipt. The receipt binds the exact artifact digest to the exact source cluster identity-receipt digest. Never retain a plaintext dump.
6. Run `publish-a1of1-backup.sh` manually with the exact encrypted artifact, checksum sidecar, backup receipt, and source cluster receipt. The publisher validates the complete set from held no-follow descriptors before SSH, uses only the fixed strict alias/root, and binds every receive/finalize/cleanup process to the exact preflight ancestor, layout, and staging inode identity proofs. It transfers only ciphertext and non-secret integrity metadata, including both receipts required for restore. It recomputes every hash on A1of1, publishes the artifact/checksum bundle plus the original backup and source receipts with create-only hard links, tears down staging, requires final link count one, fsyncs the finalized bundle, bundles parent, receipts directory, and staging metadata, and then unlinks the validated temporary pathname while retaining its descriptor and atomically publishes an A1of1 custody receipt from that descriptor with macOS `fclonefileat(..., flags=0)` as the create-only sole completeness marker. The custody receipt binds the exact artifact, checksum, backup-receipt and source-receipt hashes; fixed alias, observed hostname, owner, platform, destination root, layout identity, and publication timestamp.
7. Treat an existing custody receipt as idempotent success only when the artifact, checksum, original backup receipt, source cluster receipt, and custody receipt all remain owner-only regular files with link count one, exact hashes, and exact custody bindings, and the bundle contains exactly its two data files. The restore path validates and decrypts from the same held no-follow descriptors; it rejects symlinks, unsafe ownership/modes, and multi-link inputs. Preserve matching pre-custody partials for safe replay; refuse mismatches, custody-only state, identity-proof drift, or collisions without overwrite or deletion.
8. No recurring schedule is authorized in this source phase. Scheduling, retention pruning, missed-backup alerts, and any tertiary object-storage copy are separate automation approvals.

## Gate 6 — isolated restore drill

1. Create a disposable, loopback-only destination outside production under separate approval. Its database name must end `_restore_drill`; it must not share the production volume, network, project, or credentials.
2. Initialize only the disposable target cluster and empty database `pkc_founder_mfa_restore_drill`: run guarded `000_roles.sql` once, then idempotent `004_onboarding_roles.sql` and `006_backup_reader.sql`. Do not run migrations on the empty restore target because the archive owns the restored schema and migration ledger.
3. Set `PKC_RESTORE_DRILL_ISOLATED=yes` only for the reviewed command. Provide the exact generated SHA-256 sidecar, original backup receipt, source cluster identity receipt, explicit age identity file, separate strict-TLS credential-free loopback DSNs and `PGPASSFILE`s for target bootstrap and verifier identities, and exact target system identifier/internal address/port.
4. Require `pg_restore` major 16. `decrypt-validated-backup.mjs` first opens the encrypted artifact, checksum, and both receipts with no-follow owner/mode/link controls, validates the exact held bytes, and emits a non-secret cryptographic set proof plus validated source-receipt bytes for target preflight. Before any database mutation, `restore-drill.sh` verifies the DSN pathname is exactly `pkc_founder_mfa_restore_drill`, the endpoint is loopback, the session is exactly `pkc_bootstrap_admin`, the database is empty, the target identity matches every declared field, and the target system identifier differs from the validated source receipt. The restore phase reopens the four-file set with the same controls, requires the exact set proof, and passes its held artifact descriptor through `age` directly into transactional `pg_restore --no-owner --role=pkc_mfa_owner`; plaintext is never written to disk. It then reasserts `004_onboarding_roles.sql` and `006_backup_reader.sql`, seals migrator and bootstrap authority, and runs full runtime-sealed `db/readiness.mjs` through `pkc_mfa_verifier`.
5. Independently prove unique drill project, volume, network, credentials, loopback exposure, source unavailability to the drill path, and teardown with zero residue. Record exact target labels/identity. Never treat a restore into the source cluster as a drill.

## Gate 7 — exact-label runtime teardown with volume preservation

`cleanup-exact-labels.sh` performs no Docker command by default. A future approved cleanup requires both `--execute` and the exact confirmation token. It selects only resources bearing `com.docker.compose.project=pkc-onboarding-postgres`; the PostgreSQL container additionally requires `com.docker.compose.service=postgres`. It may remove the exact container and network, but it never deletes a labeled volume. It reads back zero matching containers and networks, then reports every preserved labeled volume.

The legacy cleanup-manifest validator is read-only. It requires exactly 215 unique, unmounted, `review_only` volume records and `deletion_enabled: false`. It contains no deletion command. Do not delete volumes based on a manifest validation result.

## Rollback

Before application data exists, rollback means: remove only the root candidate's private-network attachment, verify n8n's original rendered Compose equals baseline and SQLite remains authoritative, then stop. Runtime-resource teardown is a distinct approval and must use exact project labels; the PostgreSQL volume remains preserved even when empty.

After any application data exists, do not delete the PostgreSQL volume. Disable routing to the new database, retain the cluster identity receipt, retain TLS/credential authority in the secret store, produce and verify an encrypted backup, and complete an isolated restore drill before any separately approved retirement. Never point n8n at PostgreSQL as a rollback shortcut and never migrate n8n SQLite authority in this lane.

## HOLD conditions

Stop on capacity at/above 80%, insufficient projected reserve, mutable image tag, host port, `root_default` on PostgreSQL, root Compose drift beyond one external network, n8n database-authority drift, missing strict TLS, password-bearing URI/env/argument, secret schema drift, symlink/permissive secret file, missing receipt field, unencrypted backup, non-isolated restore target, ambiguous labels, mounted legacy volume, or any unapproved live mutation.
