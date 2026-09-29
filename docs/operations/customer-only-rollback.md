# Customer-only rollback

## Purpose

This path preserves ordinary customers without restoring password-only founder authority. It is available only after verified cutover preparation and requires rollback approval binding exact prior/new IDs and alias pointers. Hardened retention remains permanent.

## Before founder enrollment

1. Set mode `disabled` and create a new deployment; do not assume an environment edit changes an old deployment.
2. Fail founder sign-in closed.
3. Activate the prebuilt hardened customer-only rollback login. Read back assigned ID, active state, one webhook, semantic digest, ordinary-customer credentials only, and explicit denial of immutable founder subject, canonical `PK Blick`, and ambiguous matches before JWT/session construction.
4. Restore bootstrap/profile/sessions/revoke/logout versions only where independent verification proves founder authority is not weakened.
5. Restore the exact prior public alias under separate approval and read it back.
6. Run full customer regression and founder-denial probes. Database tables may remain dormant; schema/key deletion is never implicit.

Never reactivate the pre-MFA login workflow: it can issue a password-only founder session independently of the Vercel mode flag. Never restore `all/all/true/true` retention.

## After enrollment or epoch increment

This rollback is no longer sufficient. Keep PostgreSQL epoch enforcement, factors, recovery state, and historical keyrings; block founder access and follow `forward-only-post-enrollment-recovery.md`. Never reset epoch, revive old sessions, delete factor/schema/keys, or downgrade to password-only founder login.
