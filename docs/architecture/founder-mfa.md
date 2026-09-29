# ADR-001: Founder-only TOTP MFA authority

**Status:** Accepted for local implementation; production mutation approval pending
**Date:** 2026-09-27
**Decider:** Aíel

## Context

ProjectKidCreations currently verifies passwords, creates JWT sessions, and persists account/session/audit records through n8n and Google Sheets. The founder account is authorized only by the canonical server-side tuple already enforced by the account workflows. Google Sheets is not suitable for encrypted TOTP seed custody, atomic challenge consumption, accepted-counter replay prevention, or one-use recovery-code consumption.

The public founder action will be removed from the chooser. The public wordmark will remain a normal, accessible link to the existing founder-intent login route. This is visual decluttering only; it is not an authorization boundary.

## Decision

Use transactional PostgreSQL for founder MFA state while preserving n8n/Vercel and the existing customer authentication flow.

### Trust boundaries

- **n8n:** validates the existing founder password against canonical account records; preserves customer login; issues the final PKC session only after a Vercel-signed MFA grant.
- **Vercel Node functions:** validate browser origin/body/cookies; verify signed founder handoffs; generate, encrypt, disclose once, and verify TOTP enrollment; consume recovery codes; call the internal n8n finalizer.
- **PostgreSQL:** owns encrypted founder TOTP state, last accepted counter, hashed pre-auth challenges, single-use recovery-code hashes, finalize state, and MFA audit events.
- **Browser:** holds only an HttpOnly pre-auth cookie and the one-time rendered enrollment/recovery material in page memory. It never receives database credentials or authorization authority.

### Runtime mode authority

`PKC_FOUNDER_MFA_MODE` is the closed runtime authority. Production rejects a missing or unknown value. `disabled` preserves customer traffic while denying founder challenge, disclosure, verification, finalization, recovery, and sensitive operations. `armed` adds only synthetic founder-denial probes; it still cannot disclose a seed or issue a founder session. `enforced` permits those operations only after their independent identity, database, enrollment, and receipt checks pass. Evidence reports only the mode label.

### Authentication sequence

1. Browser submits username/password to `/api/account/login`.
2. n8n verifies the password and canonical founder tuple.
3. Customer success follows the current session path unchanged.
4. Founder success branches immediately after password and canonical-tuple verification, **before any session ID, JWT, session lookup, or session write**. n8n returns a typed, signed, short-lived handoff to the Vercel login orchestrator with no session cookie.
5. Vercel consumes and verifies the handoff server-side, hashes a random pre-auth token, creates or deduplicates a five-minute Postgres challenge, and returns only `{status:"mfa_required"}` plus an HttpOnly `__Host-pkc_mfa` cookie. The handoff and finalize grant are never returned to browser JavaScript.
6. If unenrolled, a same-origin no-store endpoint may disclose the QR/manual secret once only after locking and matching an unconsumed database enrollment authorization. The authorization binds founder UUID, exact source commit/deployment, reviewed workflow digest, approval ID, issue/expiry, factor state, and auth epoch. A valid current TOTP consumes that authorization atomically while activating MFA and generating recovery codes.
7. If enrolled, a valid TOTP atomically advances `last_accepted_counter` and consumes the challenge.
8. The successful MFA transaction preallocates one immutable finalize ID, session ID, issued-at time, expiry, auth epoch, MFA claims, request digest, and grant JTI. Vercel signs a short-lived finalize grant over those exact values. n8n rechecks the canonical founder tuple and deterministically issues the same PKC JWT/session identity on every bounded replay.
9. Enrollment atomically increments the Postgres founder `auth_epoch` and sets `revoked_before`, immediately invalidating every older or epoch-less founder session. Sheet-backed revocation is a keyed, retryable projection/outbox operation and is not treated as part of the Postgres security transaction.
10. Sensitive founder operations require the canonical founder tuple, a signed session with `amr` containing both `pwd` and `otp`, the current Postgres auth epoch, and a non-future `mfa_verified_at` no older than 15 minutes.

### Recovery

- Generate high-entropy, single-use recovery codes.
- Return them once for offline storage.
- Store only HMAC-SHA-256 hashes under a dedicated recovery pepper.
- Ordinary recovery uses either the enrolled TOTP or one stored single-use recovery code. A recovery code is consumed atomically, revokes founder sessions/challenges, disables the old seed, and mandates TOTP re-enrollment before a general founder session can be issued.
- Password reset never clears or bypasses MFA.
- No-code administrative recovery is structurally disabled and absent from the service API. Caller labels are never authority. It may be exposed only after a closed trusted API can inject two independently authenticated, founder/operation-bound, expiring, one-use approvals that are consumed atomically under the factor lock. Until then, recovery requires a stored recovery code and forces re-enrollment.

### Cryptography and storage

- TOTP: RFC 6238, SHA-1 for authenticator compatibility, six digits, 30-second period, at most ±1 time-step.
- Seed envelope: AES-256-GCM with a dedicated 32-byte key and explicit key version; never reuse `PKC_AUTH_KEY`.
- Challenge/session-finalize tokens: 256-bit random values; store only SHA-256 hashes.
- Recovery codes: at least 128 bits of entropy; store keyed hashes only.
- Accepted TOTP counters advance under a row lock and must be strictly greater than the last accepted counter.
- Seed encryption uses a unique 96-bit nonce and authenticated additional data binding the immutable founder ID, enrollment generation, algorithm, and envelope version.
- `PKC_FOUNDER_SUBJECT` is required and must be the canonical founder account UUID. Founder classification requires that UUID to equal `account_id`, the username to equal `PK Blick` exactly, and `is_admin` to be true; email is never an authority signal and partial matches fail closed.
- Password handoffs and finalize grants use separate versioned signing keys. Claims are closed and bind `iss`, `aud`, `typ`, version, UUID `sub`, exact `username`, `is_admin`, purpose, key version, JTI, challenge/finalize ID, password-authentication time, `iat`, `nbf`, and short `exp`.

### Privacy and observability

TOTP seeds, `otpauth://` URIs, QR payloads, submitted OTPs, recovery codes, passwords, cookies, handoffs, and grants must never enter URLs, analytics, local/session storage, IndexedDB, logs, committed fixtures, screenshots, or audit detail. MFA responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and frame denial. QR rendering is same-origin and repository-owned; no remote QR service is permitted.

The current active login workflow saves all successful/error execution data and execution progress while password-bearing items flow between nodes. Production MFA activation is blocked until secret-bearing workflow execution persistence is disabled or minimized, password material is removed immediately after verification, manual/execution retention is verified, and canary tests prove that no password, handoff, grant, OTP, seed, URI, or recovery code is retained. MFA proof material never enters n8n.

### Failure behavior

- Missing database/key configuration fails closed with `503 not_configured` only after a trusted founder handoff or on an MFA endpoint. Customer login and unrelated routes remain operational.
- MFA responses remain generic enough to avoid founder/enrollment enumeration before valid password proof.
- Five OTP/recovery attempts are allowed per five-minute challenge; no automatic OTP retry.
- The pre-auth cookie is `__Host-pkc_mfa=<opaque 256-bit value>; Secure; HttpOnly; SameSite=Strict; Path=/`, has no `Domain`, and expires in at most five minutes. Only its hash is stored. Duplicate/malformed cookies fail closed.
- Every MFA mutation requires exact allowlisted `Origin`, non-cross-site Fetch Metadata, JSON content type, a challenge-bound anti-CSRF nonce, and a bounded body. State-changing GET is forbidden.
- Founder login retries reuse one cryptographic `login_attempt_id`; no automatic retry may mint a replacement challenge after an unknown response.
- Unknown session-finalize outcomes retain the same finalize, session, and grant identity for bounded reconciliation; they never mint a new grant or accept a second TOTP counter. Only a matching finalizer receipt can mark success.
- Timeout, network failure, 5xx, malformed response, mismatched receipt, audit failure, key/database failure, envelope tampering, clock anomaly, or revocation uncertainty produces no founder session success.
- Existing password-only founder sessions cannot authorize sensitive founder operations after enforcement.

### Transaction boundaries

All entry points use the lock order `factor → challenge → finalize`. Database time is authoritative.

1. **Challenge creation:** verify the signed handoff, lock the factor, deduplicate by login-attempt/handoff JTI, rotate the challenge token hash, supersede competing active challenges where required, and append a safe audit event in one transaction.
2. **OTP/recovery attempt:** lock factor then challenge, enforce expiry/state/rolling limits, and commit failed-attempt counters and safe audit data on rejection.
3. **TOTP success:** atomically advance `last_accepted_counter`, consume the challenge, create one stable finalize row/grant identity, and audit.
4. **Enrollment success:** atomically consume the exact locked enrollment authorization, activate the encrypted seed, store the accepted enrollment counter, insert recovery hashes, increment auth epoch/set revocation cutoff, consume competing challenges, create finalization and projection-outbox rows, and audit.
5. **Recovery:** atomically consume one code, increment auth epoch, invalidate challenges/finalizations, disable the old seed, enter `recovery_required`, enqueue Sheet revocation, and require new TOTP enrollment before any general founder session.
6. **Finalize dispatch:** outside the security transaction, claim a leased/fenced finalization, send the stable grant to n8n, and mark `succeeded` only from a matching receipt. Any ambiguous result becomes `unknown` and is reconciled with the same identity.
7. **Prospective no-code recovery (unimplemented):** the owner-only inert schema records the shape of a future dual-control transaction, but no trusted principal-injection API exists and no runtime role has `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` authority on it. A future implementation would require a separate reviewed migration and service API before any factor-lock transaction could exist.

### Sensitive founder routes

The deny-by-default sensitive inventory includes `accountAdminList`, `accountAdminSearch`, `accountAdminChat`, password change, email change, account deletion, founder session revocation, recovery-code regeneration, and factor rotation/disable. New founder mutation routes are sensitive unless explicitly classified otherwise. Customer authorization behavior remains unchanged.

### Minimum PostgreSQL authority

- `founder_mfa_factors`: founder ID, factor state, encrypted envelope and key version, TOTP parameters/counter, enrollment generation/timestamps, auth epoch, revocation cutoff, row version.
- `founder_mfa_challenges`: hashed token, unique login-attempt/handoff identity, purpose/state, password-auth time, expiry, attempt budget, consumed/superseded timestamps, anti-CSRF hash.
- `founder_mfa_recovery_codes`: factor ID, pepper version, keyed hash, created/used timestamps, consuming challenge.
- `founder_mfa_finalizations`: unique challenge, grant hash/JTI, stable session identity/times/claims, auth epoch, request digest, state, lease/fence, attempts, receipt/finalized timestamps.
- `founder_mfa_outbox`: uniquely keyed Sheet session/audit/revocation projections with bounded retry and reconciliation state.
- `founder_mfa_audit_events`: append-only non-secret event metadata.
- `founder_mfa_enrollment_authorizations`: one-use source/deployment/workflow/approval/expiry/factor-state/epoch authority.
- `founder_mfa_recovery_operations`: owner-only inert future schema for prospective dual-control recovery identities and prior/resulting epochs; it is not a runtime recovery path.

n8n/Sheets writes are idempotent projections. They are never represented as transactionally atomic with PostgreSQL.

## Gate 0 database operational contract

The repository ships an ordered, checksum-pinned migration lane:

- `db/roles/000_roles.sql`, `db/roles/005_unseal_migrator.sql`, and `db/roles/010_seal_migrator.sql` are the only admitted role-authority scripts. They create the dedicated `NOLOGIN` owner and confined migrator/runtime/verifier/outbox-worker identities, open the approved migration window idempotently, and reseal it idempotently. They are operator-run and require an explicit target database variable.
- `db/migrations/manifest.json` is append-only migration authority. `db/migrate.mjs` validates every file checksum before connecting, verifies the exact database and migrator identity, takes a fixed transaction advisory lock, and records the file and digest in the same transaction as its migration. A second run must apply zero migrations.
- `db/readiness.mjs` is the runtime/catalog gate and pins PostgreSQL major 16 only. It separately attests `migration-window` (migrator login plus SET-only owner membership) and `runtime-sealed` (migrator NOLOGIN with membership revoked), together with database/public/schema ownership and ACLs, column ACL absence, an explicit no-RLS/no-policy inventory, runtime ownership absence, ledger, exact catalog digests, and optional zero-real-row state. Production TLS and provider evidence remain deployment gates; local Docker verification passes `expectedTls:false` only for its loopback disposable database.
- `npm run test:mfa:postgres` creates a loopback-only disposable pinned PostgreSQL 16 container, proves migration-window and sealed-runtime states, zero rows before activation, migrator sealing, runtime DDL/TRUNCATE/role/ledger denials, the explicitly accepted constrained direct-DML path, native enrollment/recovery/finalization/outbox behavior, and scoped container removal. It never reads production configuration.

The runtime DML trust model is explicit: the application runtime role has direct DML only on its reviewed MFA tables because transactions coordinate several rows. Database constraints, immutable triggers, exact closed-world ACL/catalog readiness, and hostile actual-login probes are the enforcement backstop; the runtime owns no database object and cannot DDL, truncate, assume owner, or mutate the migration ledger.

This repository does not implement a release control plane. Production uses the manual provider rollout in `docs/operations/manual-founder-mfa-rollout.md`; local monitoring remains a diagnostic, non-sending evaluator and never schedules work, sends alerts, mutates a provider, or grants release authority. Every Production mutation is separately approved and followed by provider-native readback.

n8n and Vercel repository evaluators are diagnostic, local, non-sending, non-authoritative, and non-release-eligible. They may validate sanitized evidence shape but cannot import, activate, deploy, attest Production, or mint approval. The manual provider rollout keeps protected-source verification, PostgreSQL backup/isolated restore, inactive n8n import, activation, deployment, mode changes, and founder enrollment as distinct human-controlled gates with separately approved native readback; no provider evidence is claimed here.

Runtime URLs must name the expected database and user, require certificate-verified TLS, use an approved pool/proxy hostname, omit connection `options` overrides, and remain within the declared pool/connection budget. Transactions install local 5-second statement, 2-second lock, and 10-second idle-in-transaction limits. A missing commit acknowledgement or failed rollback poisons the client and returns `outcome_unknown` instead of a retryable success/failure guess.

All four MFA purposes use closed versioned keyrings. New writes use the configured active version; reads select the stored/KID version, retain historical versions during rotation, fail closed on unknown versions, and reject byte reuse across every purpose/version. No key values belong in logs, tests, reports, or readiness output.

The outbox worker has no table privilege. It can only claim, settle, mark unknown, reconcile, defer unresolved reconciliation, list unknown, and monitor through owner-owned SECURITY DEFINER functions with fixed `search_path`. Claims are bounded to 25, use `FOR UPDATE SKIP LOCKED`, require expired leases before reclaim, increment fences monotonically, use immutable `operation_key` idempotency, apply bounded exponential backoff, and terminate at the row-defined retry ceiling. Ambiguous deliveries are never blindly redispatched: readback reconciliation is separately scheduled, counted, and moved to terminal/DLQ state only when its bounded reconciliation ceiling is exhausted. An expired final claim is moved to unknown for reconciliation without incrementing past its delivery ceiling. The JavaScript dispatcher accepts injected transport/readback dependencies; tests use no production credentials or network.

## Options considered

### Keep MFA state in Google Sheets

Rejected. It cannot prove atomic replay prevention, safe encrypted seed custody, or one-use challenge/recovery consumption.

### Managed identity provider

Not selected. It offers mature MFA but would replace or bridge more of the existing account/session authority than requested.

### Transactional PostgreSQL with current n8n/Vercel

Selected. It preserves the customer path and current operational system while moving only security-critical founder MFA state to transactional storage.

## Production approval gates

Local code, tests, inactive transforms, and disposable Postgres rehearsal may proceed. Separate explicit approval is required before any of the following:

- provisioning paid/cloud PostgreSQL;
- adding or rotating production secrets;
- applying a production schema or role grants;
- editing/importing/activating n8n workflows or changing execution retention;
- revoking live founder sessions;
- enrolling or rotating the production TOTP seed or generating production recovery codes;
- pushing, merging, or deploying the resulting exact candidate revision.

## Verification requirements

- RED-first unit/contract tests for challenge expiry, attempt limits, malformed input, wrong/expired/replayed TOTP, concurrent replay, recovery-code reuse, encryption-envelope tampering, generic responses, no pre-MFA session, and finalize idempotency.
- Native disposable-Postgres migration and transaction tests.
- Desktop Chromium and Mobile WebKit enrollment/challenge/recovery accessibility tests.
- Full contract/build/CSP suite, secret scan, clean diff, independent security/backend/QA review, and final parent verification.
