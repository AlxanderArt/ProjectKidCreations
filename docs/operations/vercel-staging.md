# Vercel staging and deployment verification

## Separate stages

Preview variables, Preview deployment/alias, merge, Production variables, Production deployment, and public alias movement each require their own approval. Gate 0 is metadata verify-only and performs no Vercel operation.

## Preview or Production staging

1. Freeze the exact integration candidate first with a disposable Git index and native Git tree, never the real index. A dirty-worktree tree is review evidence only and is never deployment authority. After the accepted bytes are committed, read back the **clean committed** commit and tree from GitHub, generate supplemental closed diagnostic evidence from that clean checkout, and require Vercel's source commit and source tree to match. The diagnostic builder derives the exhaustive function inventory under the closed `api/**/*.js` policy; callers cannot select or omit paths. Any `api/` entry outside that policy, an empty inventory, or more than 10 functions is rejected.
2. Stage required variable **names** in the named scope. Read back names/scopes only. Require `PKC_DATABASE_URL` (runtime only, never owner/migrator), `PKC_DATABASE_NAME`, `PKC_DATABASE_USER`, `PKC_DATABASE_ENVIRONMENT`, founder subject, four versioned keyrings/versions, existing auth/n8n origins, and `PKC_FOUNDER_MFA_MODE`. Bind each check to the exact expected mode for that gate: `disabled` at isolated staging, `armed` only after the separately approved arming gate, and `enforced` only at the separately approved enforcement gate. Require exact `handoff-vN` and `finalize-vN` agreement with n8n metadata.
3. Set variables before creating the deployment snapshot. Require immutable deployment ID, environment equal to the approved target, exact provider source commit and source tree equal to the clean frozen candidate, `READY`, and actual provider function inventory exactly equal to the exhaustive manifest-derived candidate inventory. The configured release ceiling is exactly **10**—not “at least 10,” not a caller-selected larger value, and never `Number.MAX_SAFE_INTEGER`. The inventory can contain fewer than 10 functions, but it cannot be empty.
4. Record the current alias as the rollback deployment pointer. During the `isolated` phase the alias must still resolve to that rollback deployment, never the candidate. Only the separately approved `promoted` phase may require the alias to resolve to the candidate deployment. For Production staging, smoke only the isolated deployment URL.
5. Verify ordinary customer baselines, source binding, deployment environment, and variable names/scopes. Never display values or provider-managed local credentials.

## Stop/rollback

Stop on wrong environment, missing/wrong scope, KID mismatch, deployment predating env staging, function limit, non-Ready state, source mismatch, missing rollback pointer, or early public alias movement. Alias rollback requires a separate approved mutation and exact target readback; environment changes require a new deployment.
