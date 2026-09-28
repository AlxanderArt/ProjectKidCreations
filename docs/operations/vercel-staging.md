# Vercel staging and deployment verification

## Separate stages

Preview variables, Preview deployment/alias, merge, Production variables, Production deployment, and public alias movement each require their own approval. Gate 0 is metadata verify-only and performs no Vercel operation.

## Preview or Production staging

1. Freeze the exact integration candidate first. Generate the canonical candidate manifest from those bytes, then generate a closed Vercel candidate evidence object with `buildVercelCandidateEvidence(manifest)`. The builder derives the exhaustive function inventory from every frozen manifest path under the closed `api/**/*.js` policy; callers cannot select or omit paths. Any `api/` manifest entry outside that policy, an empty derived inventory, or more than 10 derived functions is rejected. The evidence binds exact candidate commit/tree/status/fingerprint, every manifest file, and the derived canonical function inventory plus its digest. The isolated contract fixture uses the accepted single catch-all router `api/[...route].js`; that fixture is not a claim about the current obsolete-base API tree or a future release. Integration must re-freeze its real candidate after routing consolidation.
2. Stage required variable **names** in the named scope. Read back names/scopes only. Require database runtime URL (never owner/migrator), founder subject, four versioned keyrings/versions, existing auth/n8n origins, and mode. Require exact `handoff-vN` and `finalize-vN` agreement with n8n metadata.
3. Set variables before creating the deployment snapshot. Require immutable deployment ID, environment equal to the approved target, exact source SHA equal to the frozen candidate commit, `READY`, and actual provider function inventory exactly equal to the exhaustive manifest-derived candidate inventory. The configured release ceiling is exactly **10**—not “at least 10,” not a caller-selected larger value, and never `Number.MAX_SAFE_INTEGER`. The inventory can contain fewer than 10 functions, but it cannot be empty. Caller-supplied expectations outside the closed frozen candidate evidence are not authority.
4. Record current alias and rollback deployment pointer. For Preview, point only an approved non-production alias. For Production staging, leave the public alias unchanged and smoke only the isolated deployment URL.
5. Verify ordinary customer baselines, source binding, deployment environment, and variable names/scopes. Never display values or provider-managed local credentials.

## Stop/rollback

Stop on wrong environment, missing/wrong scope, KID mismatch, deployment predating env staging, function limit, non-Ready state, source mismatch, missing rollback pointer, or early public alias movement. Alias rollback requires a separate approved mutation and exact target readback; environment changes require a new deployment.
