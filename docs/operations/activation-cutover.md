# Production activation and cutover

## Approval

Require explicit activation approval binding the exact deployed SHA, immutable Vercel deployment, exact old/new workflow IDs, plan digest, current backups, monitoring state, and rollback handles. Founder enrollment is not authorized by cutover approval.

## Pre-cutover

Announce founder-only maintenance, keep customers available, set founder mode `disabled`, capture non-identifying session counts, and read back database readiness, backup/restore evidence, hardened retention/history clearance, empty/reconciled queues, workflow states, Vercel source/alias, and monitoring. Abort on drift.

## Ordered cutover

1. Before any activation, validate the immutable rollout receipt against independent repository authority: canonical ordered roles `login`, `bootstrap`, `profile`, `sessions`, `revoke`, `logout`, `finalizer`, `dispatcher`, `rollback-login`; exact source commit/tree; n8n `2.19.5` and the repository-pinned image digest; exact role→artifact hashes; globally unique old IDs, new IDs, and webhook paths with no old/new overlap; every import inactive; nonempty trimmed unique credential name/type metadata; and exact approval ID, **live** traffic class, backup handle, rollback handle, and delivery/reconciliation adapter IDs, versions, contract digest, and readiness. Reject coordinated malformed receipt/authority values rather than treating equality as semantic proof.
2. Activate finalizer; verify internal authentication and synthetic deterministic receipt.
3. Every activation receipt must bind its repository-authorized role, imported ID/version/path, a canonical valid ISO activation instant, and the exact SHA-256 import-receipt digest. Test traffic, unknown roles, malformed dates/digests, and unbound or unready delivery/reconciliation adapter metadata are non-activatable for every role. Activate dispatcher/reconciler only after the same global adapter gate passes; verify empty queue and restricted database authority.
4. Cut over hardened bootstrap, revoke, and logout one at a time, reading exact active state/webhook and running customer regression after each.
5. Cut over profile and session assurance.
6. Move the public alias to the exact deployment while mode remains `disabled`; read back alias and ordinary customer paths.
7. Cut over login last: deactivate old ID, activate new ID, and require exactly one registered production webhook.
8. Change mode to `armed` and redeploy; run synthetic customer and founder-denial probes.
9. Only under the next explicit approval, change mode to `enforced` and redeploy. Observe monitoring before enrollment.

Stop on duplicate webhooks, unknown outbox/finalization disposition, source/alias drift, retention/privacy failure, customer regression, or any password-only founder session. Every state change gets a mutation receipt and independent readback.
