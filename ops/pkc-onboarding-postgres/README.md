# PKC onboarding PostgreSQL source contract

This directory is an isolated, repository-only infrastructure and recovery contract. It does not provision anything by itself. It must not be combined with the root Compose project, and it does not authorize Docker, database, credential, backup, restore, or deletion activity.

## Fixed authority

- Compose project: `pkc-onboarding-postgres`
- Service: `postgres`
- Image: `postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`
- Private network: `pkc_onboarding_private` (`internal: true` in this project)
- Private DNS: `pkc-postgres`
- Data volume: `pkc_onboarding_postgres_data`
- Database: `pkc_founder_mfa`
- No host port
- PostgreSQL never joins `root_default`
- Encrypted off-host recovery destination: fixed SSH alias `a1of1` at `/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres`

The A1of1 PostgreSQL 17 cluster remains the canonical local ProjectKidCreations universe database. A VPS PostgreSQL 16 onboarding backup is an encrypted exported recovery artifact only; the publisher has no decryption, database connection, import, or scheduling capability.

The root n8n project may join `pkc_onboarding_private` as an external network only. Its `/home/node/.n8n` volume and SQLite database authority remain unchanged. `root-compose.network.override.example.yaml` is an operator-reviewed example; never apply it by editing `/root/docker-compose.yml` from this repository workflow.

## Secrets and TLS

`secrets/` is intentionally absent from source control. At operation time it must contain exactly:

- `postgres_bootstrap_password`
- `postgres_server_cert`
- `postgres_server_key`
- `postgres_client_ca`

That server directory contains exactly those four files. Client credential
files are not members of the server secret schema.

- Client credential files are provisioned in separate per-role roots for
  `pkc_bootstrap_admin`, `pkc_backup_reader`, `pkc_mfa_migrator`, `pkc_mfa_verifier`, `pkc_onboarding_runtime`,
  `pkc_onboarding_email_worker`, and `pkc_onboarding_email_reconciler`.
  Each root has its own certificate, key, and PGPASSFILE and is validated
  independently; no authority shares credential bytes. The bootstrap identity is used only for the one-time guarded role bootstrap and is not distributed to n8n.

Server files must be regular, non-symlink files owned by the invoking user, root, or the pinned container PostgreSQL UID; mode `0400` or `0600`. The exact validation bundle is bootstrap auth material, server certificate, server private key, server CA, and client CA. `validate-secrets.py` opens the directory and each file with no-follow descriptors, validates with `fstat`, reads from that same descriptor, compares pre/post identity, and uses OpenSSL against inherited descriptors to check validity, trust, parseability, and certificate/key correspondence. It never prints values. Each client root is checked independently through `db/client-authority.mjs` and operational credential provisioning; the Compose service never receives client PGPASS files or private keys.

The committed TLS files are non-cryptographic fixtures only. Real certificates and keys are forbidden in this repository. Server TLS is TLS 1.3 minimum, and `pg_hba.conf` requires `hostssl`, SCRAM, and verified client certificates. Clients use `sslmode=verify-full` with explicit CA/cert/key paths. DSNs contain no password; passwords are resolved only through `PGPASSFILE`.

## Host-only verification

```sh
node --test tests/contracts/pkc-onboarding-postgres-infra.test.mjs
scripts/test-pkc-compose-bootstrap.sh
scripts/test-pkc-restore-postgres.sh
python3 -m py_compile ops/pkc-onboarding-postgres/scripts/validate-secrets.py \
  ops/pkc-onboarding-postgres/scripts/publish-a1of1-remote.py
node --check ops/pkc-onboarding-postgres/scripts/publish-a1of1-backup.mjs \
  ops/pkc-onboarding-postgres/scripts/decrypt-validated-backup.mjs
bash -n ops/pkc-onboarding-postgres/scripts/backup-encrypted.sh \
  ops/pkc-onboarding-postgres/scripts/publish-a1of1-backup.sh \
  ops/pkc-onboarding-postgres/scripts/restore-drill.sh \
  ops/pkc-onboarding-postgres/scripts/cleanup-exact-labels.sh
```

`npm run test:contracts` discovers the contract test automatically. The contract, Python, and shell-syntax checks are host-only. The two explicit native scripts are disposable Docker tests: the first exercises the official image entrypoint and mTLS bootstrap; the second performs a two-cluster schema backup/restore/sealing drill. Both require the exact pinned image and must leave zero scoped container residue.

## Rendered Compose verification

An operator may separately render baseline root Compose, candidate root Compose, and this PostgreSQL project to JSON. Supply those already-rendered files to:

```sh
node scripts/verify-rendered-compose.mjs BASELINE_ROOT.json CANDIDATE_ROOT.json POSTGRES.json
```

The verifier requires byte-equivalent JSON structure after removing exactly the new n8n private-network attachment and external network declaration. It rejects PostgreSQL database variables on n8n, loss of its SQLite volume, any PostgreSQL `root_default` attachment, a host port, or image/network drift.

See `RUNBOOK.md` for gated provisioning, evidence, recovery, cleanup, and rollback procedure.
