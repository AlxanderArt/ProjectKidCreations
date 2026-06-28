# Phase Four — ACCESS GRANTED

> Source-of-truth plan for the authenticated dashboard. Companion to the
> operational checklist in `Project Kid Creations/PHASE-FOUR-SETUP-CHECKLIST.md`
> and the schema in `supabase/migrations/0001_phase_four_init.sql`.

## What Phase Four is

Phase Four is the **verified-state home** an operator reaches *after* completing
onboarding (Phase One → Two → Three) and holding a session. The accent flips from
hi-vis orange to neon green (`#39FF14`) to signal "you're in." It is where a
granted operator browses everything, manages their account, and buys mods.

## Current reality (as built, 2026-06-28)

Three surfaces exist today, and they are **not** the same thing:

| Surface | What it actually is | State |
|---|---|---|
| `/account/*` | Real account-management system — login, profile, sessions, password, email change, delete, admin. Wired to n8n (`api/account/*`). | **Live** |
| `/phase-four/` | The ACCESS GRANTED dashboard UI — XP, ranks, streak grid, badges, builds, orders, activity. | **Mock only** — runs on `phase-four/mock-data.js`; no `/api/dashboard/*` backend exists; not a routing destination. |
| `/landing.html` | Post-auth "showcase." A marketing brochure (hero, product marquee, value props). | **Live but a brochure** — products are 6 hardcoded mock SKUs, every CTA is an in-page anchor or `mailto:`. No cart, no checkout, no real catalog. |

So `/account` = account management, `/phase-four` = the intended dashboard
(unwired), `/landing.html` = the showcase. **None of them is a storefront yet** —
the "browse everything and buy" commerce layer has not been built in any repo.

## The gap (why "access granted" feels locked)

Completing onboarding does not visibly unlock anything, for three compounding
reasons:

1. **Phase Three SUCCESS dead-ends on an async email.** On completion, the page
   fires a best-effort `POST /api/account/bootstrap` to *email* a bootstrap link,
   then shows "WELCOME TO THE REBELLION" with only a "didn't get the email?"
   resend button. There is no on-screen "ENTER THE SITE →" path. If the email
   is slow or never arrives, a freshly-completed operator is stranded.
   → **Fixed in this change** (see below).
2. **The root router is session-only.** `index.html` probes
   `GET /api/account/profile`; 200 → `/landing.html`, else → `/phase-one/`.
   Completion sets no cookie the probe recognizes, so reloading root bounces a
   just-finished user back to onboarding until they redeem the email + set a
   password (which is what finally mints the session).
3. **The destination is a brochure / mock.** Even once you're in, `/landing.html`
   is marketing and `/phase-four/` is mock data. There is nothing to *do* yet.

## What this change ships now

A small, safe fix for cause #1, plus the missing source-controlled artifacts:

- **Phase Three SUCCESS now offers a direct hand-off.** When the bootstrap POST
  returns a token, the success screen renders an explicit **`ENTER THE SITE →`**
  button to `/account/bootstrap?token=…` (fall back to `/account/login` when no
  token). Completion no longer depends solely on an email round-trip.
- **This plan + the SQL migration are now under source control**
  (`docs/phase-four-access-granted.md`, `supabase/migrations/0001_phase_four_init.sql`).
  Previously the checklist *claimed* they existed; they did not.

## What is still required to truly "unlock the site"

This is a build, not a bug fix — tracked here so it isn't lost:

1. **Decide the real destination and build commerce.** Either promote
   `landing.html` into an actual storefront (real catalog, product/detail, cart,
   checkout, on-page sign-in) **or** make `/phase-four/` the authenticated home
   and build its live backend. The owner's goal (browse, log in, buy) requires a
   genuine commerce layer that does not exist in any repo today.
2. **Provision Supabase** (blocked on billing — checklist §1) and apply
   `0001_phase_four_init.sql`.
3. **Build the `api/dashboard/*` Edge functions** and flip
   `window.PKC_DATA_MODE` to `"live"` in `phase-four/`.
4. **Register `/phase-four/` (or `/dashboard`) as a routing destination** and make
   the root router completion-aware so a just-finished operator routes straight in.

## Security requirements (Supabase)

The migration already encodes these; any further schema work must keep them:

- **RLS enabled** on every exposed table; per-user tables scoped via `auth.uid()`.
- **No service-role key in browser code** — writes happen server-side in Edge
  functions; `SUPABASE_SERVICE_ROLE_KEY` is Production/Preview env only.
- **No auth decisions from user-editable metadata** — ownership derives from the
  verified session, never the request body.
- **Views use `security_invoker = true`** (see `dashboard_me`).
- **Policies combine `TO authenticated` with an ownership predicate.**
