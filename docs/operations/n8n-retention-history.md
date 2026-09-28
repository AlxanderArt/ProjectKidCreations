# n8n retention, history quarantine, and purge

## Exact scope

Protected IDs only: `wfDsutVsW15DHGr3`, `nvgxxBPinPmsEmZq`, `uuNgivASLQZ08gX7`, `GVVnbelFG97UjJDw`, `W63ETZfmKVI7UDFW`, `jb0I4CqlJuuG6fXs`. Retention edits and historical deletion are separate approvals. No raw protected workflow export belongs in Git.

## Prospective retention

Read current IDs, names, versions, active states, topology digest, and settings without payloads. Generate the exact retention-only desired state: errors `none`, successes `none`, progress `false`, manual `false`, and pin/static data absent. Under retention approval, modify one exact workflow, read it back, run customer regression/privacy canaries, then continue. Never restore permissive retention during rollback.

## Historical quarantine plan

Inventory execution IDs/times/statuses and aggregate counts without reading bodies. Include execution payload storage, associated binary objects, database/volume storage, and every container/host log generation. Create an encrypted access-restricted immutable snapshot with a nonempty stable ID, recording ACL metadata, deletion date, and ordinary-restore prohibition. The purge-plan input is closed: exact protected workflow IDs; exact snapshot keys `id` and `immutable=true`; strict ISO-UTC `createdAt`; exact interval keys with `from < to <= createdAt`; and exact nonnegative safe-integer counts for `executions`, `binaryObjects`, and `logGenerations`. Unknown, missing, string, negative, or unsafe values are rejected before digesting. Generate the deterministic plan receipt bound to those validated inputs, binary/log scope, snapshot ID, and postconditions.

## Destructive gate

Apply is disabled by default and does nothing without both `--enable-destructive` and a closed typed approval receipt whose plan digest, purge-plan digest, action, exact protected six-ID set, bounded nonempty actor, and strict ISO-UTC time match exactly. Any other six IDs fail. Gate 0 allows only a fake adapter. A later live implementation must use n8n-supported deletion/pruning and provider-safe compaction. Read back zero scoped executions/binaries for the interval, current hardened settings, log disposition, and absence of runtime canaries. Stop on count drift, unrelated IDs, snapshot failure, accessible historical payloads, or any missing approval.

The CLI grammar is closed and ordered: `retention-manifest`; `scan --input FILE [--canaries VALUE[,VALUE]]`; `purge-plan --input FILE`; `apply --plan FILE`; or `apply --plan FILE --approval FILE --enable-destructive`. `--help` is valid only by itself. Unknown, trailing, duplicate, reordered, missing, and empty-value arguments are rejected before reads or simulated apply.
