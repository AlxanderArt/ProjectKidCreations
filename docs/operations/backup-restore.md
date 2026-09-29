# PostgreSQL backup and isolated restore

## Required approval

Snapshot creation, restore creation, credentials, and drill-target destruction are separate production/provider mutations. The repository harness evaluates sanitized evidence only. It does not call a provider.

## Snapshot

Confirm automated backups and PITR, then request an immutable on-demand snapshot. Sanitized evaluator evidence must include a stable snapshot object ID, `immutable=true`, snapshot SHA-256 digest, stable provider receipt object ID and receipt SHA-256 digest, plus the captured strict ISO-UTC timestamp/recovery point. Provider/project/database IDs, PostgreSQL version, region, encryption state, and completed state remain operator-side evidence. Store secret-manager references and key versions separately; never place keys in dumps or reports.

## Restore drill

1. Name a new exact target with a unique drill scope. Set `disposable=true`, `isolated=true`, and the exact label object `{purpose: "restore-drill", production: "false"}`. Refuse source==target, production-like names, shared/networked production targets, boolean/unknown production labels, extra labels, or mutable snapshot labels such as `latest`.
2. Restore while source is unavailable to the drill path. Bind evidence to the immutable snapshot ID/digest and immutable provider receipt ID/digest. Self-written booleans are not restore authority.
3. Pre-migration proof checks only prior-state inventory, timestamp/LSN, TLS, RPO/RTO, and backup completeness.
4. Post-migration syntax/parity input names the bounded claimed verifier identity and stable evidence IDs. Supply expected and separately collected observed SHA-256 digests for migration ledger, catalog, roles, and usable key-version inventory. The local evaluator can compare those values but cannot establish that either side came from an independent verifier; caller-provided `exact:true` or `allUsable:true` booleans are rejected. Insert only a synthetic non-production envelope, then remove the whole drill target.
5. Supply expected and independently observed residue-inventory digests plus exact expected/observed `{databases, files, containers}` nonnegative safe-integer counts. All observed counts must be zero and both inventory and counts must match—not merely an empty object or cleanup command success. Inventory volumes, networks, and plaintext trees under the operator procedure before digesting.
6. Times are strict ordered UTC instants: `capturedAt < restoredAt < observedAt < completedAt`. RPO is capture-to-restore and must be ≤5 minutes; RTO is capture-to-completion and must be ≤60 minutes.

The repository evaluator only checks closed sanitized syntax, timestamp/count rules, and caller-supplied digest parity. Every accepted result is explicitly `status: "syntax-and-parity-only"`, `authoritative: false`, and `releaseEligible: false`; it has no `ok` field and makes no immutable-receipt verification claim. It does not contact the provider, perform a restore, prove that an identifier or digest exists, prove verifier independence, or replace independent custody and direct provider readback. Complete invented IDs and digests can therefore satisfy local parity but can never produce an authoritative success verdict. Release authority requires separately trusted provider/operator evidence outside this evaluator. Stop on identity drift, digest mismatch, unusable historical KID, RPO/RTO breach, real MFA rows in the pre-activation snapshot, cleanup ambiguity, or residue. Preserve failed evidence and request scoped cleanup approval rather than broad pruning.
