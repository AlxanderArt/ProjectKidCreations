# Inactive n8n imports and readback

## Approval boundary

Retention hardening, inactive imports, credential binding, activation, and execution are different approvals. This runbook starts only after exact source snapshot transforms and disposable n8n `2.19.5` rehearsal pass. Raw protected exports remain root-only and uncommitted.

## Import

1. Verify the registry handled each of the six protected source IDs exactly once and rejected missing, duplicate, or unknown IDs. Verify raw and normalized semantic digests.
2. Inspect every derived candidate: unique name, `active:false`, hardened retention, no pin/static data, no server-owned ID/version/timestamps/tags, and no secret values. Include finalizer, outbox dispatcher/reconciler, and customer-only rollback login.
3. Under inactive-import approval, import one candidate at a time. Read back newly assigned ID, inactive state, webhook path, settings, normalized semantic hash, node/connection topology, and credential reference names/types only.
4. Confirm original workflow IDs, active states, versions, and semantic digests remain unchanged after every import.
5. Under separate credential-binding approval, bind least-privilege named credentials without execution. The rollback login receives only ordinary-customer credentials and must deny immutable founder subject, canonical `PK Blick`, and ambiguous founder matches before JWT/session construction.

## Stops and rollback

Stop on overwrite-capable retained IDs, active/published import, duplicate webhook, topology drift, broader credential, retained secret/canary, or original-workflow mutation. Scoped deletion of newly imported candidates is destructive and separately approved. Hardened retention is never rolled back.
