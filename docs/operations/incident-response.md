# Founder MFA incident response

## First actions

Classify impact without exposing identities or secrets. Preserve event IDs, operation keys, states, attempt counts, bounded error classes, timestamps, exact deployment/workflow IDs, and source SHA. Do not paste payloads, cookies, OTPs, seeds, recovery codes, grants, database URLs, or keys. Open an incident snapshot under its own approval when state completeness is uncertain.

1. Block founder entry and sensitive routes fail-closed. Keep ordinary customers active only after independent regression.
2. Freeze new MFA writers. Do not stop dispatcher until founder entry is blocked; then reconcile `dispatching`, `unknown`, terminal, and DLQ records by immutable operation key.
3. Read back readiness, migration checksum/role/ACL drift, key-version failures, n8n version/workflow/retention drift, Vercel source/alias, backup state, auth/session anomalies, and oldest queue age.
4. Preserve damaged databases and quarantined n8n snapshots read-only. Never restore quarantined history into a networked/shared instance without recovery approval and immediate retention hardening.
5. If a key may be exposed, do not print/fingerprint it. Disable affected authority, preserve all historical decryption keys required by backups, and prepare separately approved rotation/re-enrollment.
6. If commit disposition is unknown, never blind-retry with a new identity. Reconcile exact idempotency/operation keys.

## Recovery and communication

Roll forward to the last known MFA-capable exact SHA. Use customer-only rollback only within its documented boundary. After enrollment, never restore password-only founder access, reset epoch, revive sessions, delete factors/schema/keys, or loosen retention. Record a mutation receipt for every mitigation and verification readback. Communicate verified impact, actions, next checkpoint, and unknowns; do not claim root cause or recovery before evidence supports it.
