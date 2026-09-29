# Forward-only post-enrollment recovery

## Non-negotiable invariant

After enrollment or any founder `auth_epoch` increment, password-only founder authority can never return. Keep PostgreSQL epoch enforcement, factor rows, recovery state, audit/outbox/finalization history, and every key version needed by live rows or retained backups. Recovery is a roll-forward operation requiring explicit approval at each provider mutation.

## Procedure

1. Fail founder login and sensitive routes closed. Verify customer paths independently before leaving them available.
2. Stop MFA writers only after entry is blocked. Snapshot affected systems under approved scope; preserve damaged state read-only.
3. Reconcile every `pending`, `dispatching`, `unknown`, terminal, and DLQ finalization/outbox operation using immutable identity and external readback. Treat unresolved disposition as non-retryable unknown.
4. Restore an immutable snapshot/PITR to a new disposable isolated database, never in place. Verify exact ledger, catalog, owners, role graph, ACLs, function contracts, constraints, RPO/RTO, and every required historical key-version envelope.
5. Compare durable events and external receipts. If completeness cannot be proven, increment epoch and revoke founder sessions; never decrement/reset epoch.
6. Roll forward to the last verified MFA-capable candidate. Switch runtime database or alias only after actual runtime/worker readiness and its own approved mutation/readback.
7. If factor recovery is impossible, Aíel performs a separately authorized identity-verified re-enrollment. Authenticator values and recovery codes remain user-only and never enter agent channels.
8. Observe readiness, key reads, queues, auth anomalies, customers, exact deployment/alias, and retention before declaring recovery.

Never delete old keys merely to resolve configuration, restore permissive n8n retention, revive old sessions, drop schema, or use the pre-MFA login workflow as an emergency shortcut.
