# Migration and role sealing

## Approval and prerequisites

Production database creation, migration, credential creation, and cleanup are separate approvals. Require the exact source SHA/tree, plan digest, completed immutable snapshot/isolated restore evidence, expected database identity, PostgreSQL major version, and founder mode `disabled`. Never use owner/admin credentials in Vercel or n8n.

## Apply window

For a fresh dedicated cluster only, run `db/roles/000_roles.sql` exactly once with the exact `expected_database` and `expected_empty_cluster=true`. Its empty-cluster guards must prove there are no non-system roles, no `pkc_auth` schema, and no target user relations. Never use `000_roles.sql` as repair authority. Next run idempotent `db/roles/004_onboarding_roles.sql` for the three isolated onboarding LOGIN roles and idempotent `db/roles/006_backup_reader.sql` for the dedicated read-only backup LOGIN. Establish credentials only through an owner-only descriptor-validated secret mechanism, never SQL text, URLs, `PGPASSWORD`, process arguments, repository files, logs, or chat.

1. Verify the exact target database, environment, PostgreSQL 16 server address/port, cluster system identifier, certificate-verified TLS, and `fsync=on`, `full_page_writes=on`, `synchronous_commit=on`. Run `db/roles/005_unseal_migrator.sql` with the exact `expected_database` only for the approved window, then require readiness with `authorityState:"migration-window"`. Apply the append-only checksummed migrations in the only valid order: `001_founder_mfa.sql`, `002_founder_mfa_production_authority.sql`, `003_onboarding_email_outbox.sql`, then `004_backup_read_authority.sql`. Apply one transaction at a time with `pkc_mfa_migrator`, setting role to the NOLOGIN owner only for the approved statements. Migration SQL containing top-level transaction control is rejected because the runner owns transaction boundaries.
2. Insert each exact file checksum in the ledger in the same transaction. Rerun and require zero changes.
3. Run `db/roles/010_seal_migrator.sql` immediately after migration `004`: revoke owner membership and set the migrator `NOLOGIN`. Then run `db/roles/020_seal_bootstrap.sql` from the exact `pkc_bootstrap_admin` session with both `expected_database` and `bootstrap_role` bound. It refuses an incomplete ledger or unsealed migrator and closes bootstrap LOGIN while retaining the emergency superuser role as unreachable operationally. Require readiness with `authorityState:"runtime-sealed"`; actual migrator and bootstrap logins must fail. Record metadata only.
4. Connect independently as verifier, actual runtime, and actual worker. Attest database/schema ownership, role flags and both membership directions, exact migration ledger, object inventory, constraints, indexes, triggers, function owner/security/search path/ACLs, table/column/default ACLs, RLS, and absence of unexpected objects.
5. Prove runtime owns nothing and cannot DDL, `TRUNCATE`, set role, or write the ledger. Direct runtime DML on the reviewed MFA tables is an explicit trust decision backed by constraints/immutable triggers and hostile invalid-row probes, not an ownership grant. Prove worker has only reviewed outbox function execution and no direct MFA table reads.
6. Read back zero real factor/challenge/recovery/finalization/outbox/audit rows before first use. Capture a post-migration immutable snapshot and complete isolated restore/key-version-envelope proof.

## Rollback and stops

On any failed or ambiguous transaction, stop, destroy the client, preserve evidence, and reconcile the ledger before retry. Do not drop schema or roles without destructive approval. Before enrollment, leave dormant state intact. After enrollment, migration recovery is forward-only; preserve epoch, factors, keyrings, and audit state.
