# Founder enrollment

## High-risk approval and human boundary

Enrollment requires a separate approval after production cutover is verified and observed. It revokes existing founder sessions and creates real recovery codes. The founder alone handles authenticator enrollment, the TOTP value, QR/manual seed, and recovery codes in the browser/authenticator/offline store. Agents, chat, automation, screenshots, logs, clipboard tooling, and reports must never receive them.

## Procedure

1. Aíel opens a fresh private session at the canonical production URL and authenticates the canonical founder account.
2. Read back metadata proving immutable subject, exact compatibility username `PK Blick`, and `is_admin=true`; never display the subject value in routine reports.
3. Create and independently read back one unconsumed database enrollment authorization bound to the exact founder UUID, source commit, deployment ID, reviewed workflow digest, approval ID, issue/expiry, current factor state, and auth epoch. Verify password success issues no session cookie before MFA. Seed generation/disclosure must remain impossible until this exact row is locked and matched; render QR locally with no remote enrollment asset and keep the manual fallback in page memory.
4. Aíel adds the factor and enters a valid current TOTP. Present recovery codes once for offline storage by Aíel.
5. Verify the enrollment transaction consumes that authorization atomically, increments `auth_epoch`, records revocation cutoff, consumes the challenge, stores versioned encrypted/hash state, and enqueues revocation without exposing values.
6. Require outbox revocation `succeeded` by immutable operation key. Verify all prior founder sessions fail against PostgreSQL epoch before projection completes.
7. Verify a fresh session has expected `amr`, current epoch, bounded MFA time; sensitive routes reject stale and accept recent MFA.
8. Run ordinary customer regression and observe alerts for 30 minutes.

Stop on any leaked value, session-before-MFA, stale session acceptance, outbox ambiguity, key-read failure, retention evidence, or customer regression. After this point rollback is forward-only; password-only founder authority is permanently forbidden.
