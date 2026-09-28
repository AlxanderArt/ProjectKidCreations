# Key ceremony, rotation, and recovery

## Boundary

Generating or writing production key material requires a dedicated approval. Do not paste, echo, hash, fingerprint, log, screenshot, commit, or report key bytes. The Gate 0 CLI defaults to no action; no production keys were generated during repository work.

## Ceremony

1. Use four independently generated 32-byte values for handoff, encryption, finalize, and recovery pepper. Never reuse `PKC_AUTH_KEY`, JWT keys, or database credentials.
2. Run only against a disposable local non-production directory. `keys.mjs generate` requires the explicit command plus `--execute-local --target-kind disposable-local --typed-approval "APPROVE LOCAL KEY GENERATION"`; it creates no-clobber `0600` files and an exact directory/version-bound ownership marker, and emits only metadata. Production-like paths are rejected and no production generation path exists in this repository.
3. Compare bytes in memory and reject any duplicate. Upload through provider-specific stdin so shell arguments/history never contain values. Verify only variable names/scopes and KIDs.
4. Handoff and finalize versions must agree exactly between Vercel and n8n. Deploy only after variables are staged because a prior Vercel deployment cannot inherit later variables.
5. Delete caller files only after provider write and metadata readback are proven. Interrupted cleanup requires the explicit `cleanup` command plus `--execute-local --target-kind disposable-local --typed-approval "APPROVE LOCAL KEY CLEANUP"` and the exact mode-`0600` directory/version-bound marker. It deletes only the four exact ceremony filenames and marker, rejects production-like paths, and offers no production cleanup path. Never broad-delete.

## Rotation and historical recovery

New encryption writes use the new active version while reads retain every approved historical version. Re-encrypt under row locks, count dependent envelopes by KID, probe a synthetic envelope from every retained version after isolated restore, and remove an old key only after zero live dependencies **and** backup retention no longer needs it. Rollback restores write-version selection but keeps read keys.

Recovery-pepper rotation cannot make existing hashes verifiable under a new pepper. Require founder re-enrollment/recovery-code regeneration, or an explicitly designed bounded dual-version migration. Recovery codes and authenticator values are handled only by the user in the browser/authenticator/offline store; agents never receive them.
