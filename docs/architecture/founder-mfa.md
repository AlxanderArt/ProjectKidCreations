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

### Authentication sequence

1. Browser submits username/password to `/api/account/login`.
2. n8n verifies the password and canonical founder tuple.
3. Customer success follows the current session path unchanged.
4. Founder success branches immediately after password and canonical-tuple verification, **before any session ID, JWT, session lookup, or session write**. n8n returns a typed, signed, short-lived handoff to the Vercel login orchestrator with no session cookie.
5. Vercel consumes and verifies the handoff server-side, hashes a random pre-auth token, creates or deduplicates a five-minute Postgres challenge, and returns only `{status:"mfa_required"}` plus an HttpOnly `__Host-pkc_mfa` cookie. The handoff and finalize grant are never returned to browser JavaScript.
6. If unenrolled, a same-origin no-store endpoint discloses the QR/manual secret once. A valid current TOTP activates MFA and generates recovery codes.
7. If enrolled, a valid TOTP atomically advances `last_accepted_counter` and consumes the challenge.
8. The successful MFA transaction preallocates one immutable finalize ID, session ID, issued-at time, expiry, auth epoch, MFA claims, request digest, and grant JTI. Vercel signs a short-lived finalize grant over those exact values. n8n rechecks the canonical founder tuple and deterministically issues the same PKC JWT/session identity on every bounded replay.
9. Enrollment atomically increments the Postgres founder `auth_epoch` and sets `revoked_before`, immediately invalidating every older or epoch-less founder session. Sheet-backed revocation is a keyed, retryable projection/outbox operation and is not treated as part of the Postgres security transaction.
10. Sensitive founder operations require the canonical founder tuple, a signed session with `amr` containing both `pwd` and `otp`, the current Postgres auth epoch, and a non-future `mfa_verified_at` no older than 15 minutes.

### Recovery

- Generate high-entropy, single-use recovery codes.
- Return them once for offline storage.
- Store only HMAC-SHA-256 hashes under a dedicated recovery pepper.
- Recovery requires a valid password challenge, atomically consumes one code, revokes founder sessions/challenges, and forces immediate TOTP re-enrollment.
- Password reset never clears or bypasses MFA.

### Cryptography and storage

- TOTP: RFC 6238, SHA-1 for authenticator compatibility, six digits, 30-second period, at most ±1 time-step.
- Seed envelope: AES-256-GCM with a dedicated 32-byte key and explicit key version; never reuse `PKC_AUTH_KEY`.
- Challenge/session-finalize tokens: 256-bit random values; store only SHA-256 hashes.
- Recovery codes: at least 128 bits of entropy; store keyed hashes only.
- Accepted TOTP counters advance under a row lock and must be strictly greater than the last accepted counter.
- Seed encryption uses a unique 96-bit nonce and authenticated additional data binding the immutable founder ID, enrollment generation, algorithm, and envelope version.
- Password handoffs and finalize grants use separate versioned signing keys. Claims are closed and bind `iss`, `aud`, `typ`, version, immutable founder subject, purpose, key version, JTI, challenge/finalize ID, password-authentication time, `iat`, `nbf`, and short `exp`.

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
4. **Enrollment success:** atomically activate the encrypted seed, store the accepted enrollment counter, insert recovery hashes, increment auth epoch/set revocation cutoff, consume competing challenges, create finalization and projection-outbox rows, and audit.
5. **Recovery:** atomically consume one code, increment auth epoch, invalidate challenges/finalizations, disable the old seed, enter `recovery_required`, enqueue Sheet revocation, and require new TOTP enrollment before any general founder session.
6. **Finalize dispatch:** outside the security transaction, claim a leased/fenced finalization, send the stable grant to n8n, and mark `succeeded` only from a matching receipt. Any ambiguous result becomes `unknown` and is reconciled with the same identity.

### Sensitive founder routes

The deny-by-default sensitive inventory includes `accountAdminList`, `accountAdminSearch`, `accountAdminChat`, password change, email change, account deletion, founder session revocation, recovery-code regeneration, and factor rotation/disable. New founder mutation routes are sensitive unless explicitly classified otherwise. Customer authorization behavior remains unchanged.

### Minimum PostgreSQL authority

- `founder_mfa_factors`: founder ID, factor state, encrypted envelope and key version, TOTP parameters/counter, enrollment generation/timestamps, auth epoch, revocation cutoff, row version.
- `founder_mfa_challenges`: hashed token, unique login-attempt/handoff identity, purpose/state, password-auth time, expiry, attempt budget, consumed/superseded timestamps, anti-CSRF hash.
- `founder_mfa_recovery_codes`: factor ID, pepper version, keyed hash, created/used timestamps, consuming challenge.
- `founder_mfa_finalizations`: unique challenge, grant hash/JTI, stable session identity/times/claims, auth epoch, request digest, state, lease/fence, attempts, receipt/finalized timestamps.
- `founder_mfa_outbox`: uniquely keyed Sheet session/audit/revocation projections with bounded retry and reconciliation state.
- `founder_mfa_audit_events`: append-only non-secret event metadata.

n8n/Sheets writes are idempotent projections. They are never represented as transactionally atomic with PostgreSQL.

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
