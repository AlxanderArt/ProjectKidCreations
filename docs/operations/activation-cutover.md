# Production activation and cutover

## Approval

Require explicit activation approval binding the exact deployed SHA, immutable Vercel deployment, exact old/new workflow IDs, plan digest, current backups, monitoring state, and rollback handles. Founder enrollment is not authorized by cutover approval.

## Pre-cutover

Announce founder-only maintenance, keep customers available, set founder mode `disabled`, capture non-identifying session counts, and read back database readiness, backup/restore evidence, hardened retention/history clearance, empty/reconciled queues, workflow states, Vercel source/alias, and monitoring. Abort on drift.

## Ordered cutover

1. Activate finalizer; verify internal authentication and synthetic deterministic receipt.
2. Activate dispatcher/reconciler; verify empty queue and restricted database authority.
3. Cut over hardened bootstrap, revoke, and logout one at a time, reading exact active state/webhook and running customer regression after each.
4. Cut over profile and session assurance.
5. Move the public alias to the exact deployment while mode remains `disabled`; read back alias and ordinary customer paths.
6. Cut over login last: deactivate old ID, activate new ID, and require exactly one registered production webhook.
7. Change mode to `armed` and redeploy; run synthetic customer and founder-denial probes.
8. Only under the next explicit approval, change mode to `enforced` and redeploy. Observe monitoring before enrollment.

Stop on duplicate webhooks, unknown outbox/finalization disposition, source/alias drift, retention/privacy failure, customer regression, or any password-only founder session. Every state change gets a mutation receipt and independent readback.
