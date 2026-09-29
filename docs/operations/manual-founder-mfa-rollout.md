# Manual founder-MFA provider rollout

## Operating contract

**No automated provider mutation.** This repository does not implement a release ledger, attestor, scheduler, supervisor, or release control plane. Repository evaluators are diagnostic, local, and non-sending. Production work is a manual provider rollout performed by a human operator through provider-native controls.

Every external mutation requires a **separate explicit approval** for one exact action and target. Approval for one action never authorizes the next action, its rollback, or cleanup. After each approved mutation, a different operator or verification pass performs **provider-native readback** from the target provider before the rollout can continue. A successful request, command exit, local receipt, screenshot, or caller-supplied digest is not readback authority.

This SOP documents a future production procedure; it does not claim that any provider command, migration, import, activation, deployment, enrollment, rollback, or external send has run.

## Roles and evidence

Assign before Gate 0:

- **Change operator:** performs only the currently approved provider action.
- **Verifier:** reads the resulting state through the provider's native UI/API and compares it with the frozen expectation.
- **Founder:** alone performs founder enrollment and takes custody of recovery material.
- **Incident owner:** owns stop, reconciliation, and rollback decisions.

For each gate, record only non-secret identifiers: approved action, target account/project/environment, frozen commit and tree, provider object IDs, predecessor IDs, readback time, verifier identity, observed state, and rollback pointer. Keep approvals and provider evidence outside this repository in the approved operational record.

## Universal stop rules

Stop immediately and do not start the next gate if any of these is true:

- the exact source commit/tree, target account, project, database, environment, workflow ID, deployment ID, alias, or predecessor differs from the approved value;
- an approval is missing, reused, broader than one action, expired, or bound to another target;
- provider-native readback is unavailable, incomplete, stale, or conflicts with local diagnostics;
- a mutation times out, returns a transport error, has a missing acknowledgement, or may have succeeded without a conclusive readback;
- an unexpected active workflow, webhook, alias move, database role/grant, environment scope, function, credential binding, real founder row, session, or external delivery appears;
- customer login regresses, founder access becomes password-only, or secret-bearing execution data may be retained;
- backup, rollback, reconciliation, retention, or zero-residue evidence is absent;
- any secret, seed, OTP, recovery code, password, cookie, handoff, grant, private key, connection string, or credential value appears in logs, screenshots, reports, tickets, terminal output, or Git.

Any uncertain external outcome is `UNKNOWN_REQUIRES_RECONCILIATION`. Freeze retries and later gates. Read the exact target through the provider's native inventory/history, determine whether the original operation committed, and either adopt the observed object under a new explicit decision or obtain a separate explicit approval for a narrowly scoped rollback. Never blind-retry an uncertain mutation.

## Protected-source and topology gate

Before any provider access:

1. Confirm the frozen candidate contains **exactly 10 API functions**, using the complete `api/**/*.js` inventory from the frozen bytes. The accepted current topology is:
   - `api/[...route].js`
   - `api/account/bootstrap.js`
   - `api/account/logout.js`
   - `api/account/password-request.js`
   - `api/onboarding.js`
   - `api/phase-three/check-username.js`
   - `api/phase-three/event.js`
   - `api/phase-three/verify.js`
   - `api/phase-two/event.js`
   - `api/phase-two/verify.js`
2. Prove `api/**`, `db/migrations/**`, and `db/roles/**` match the reviewed protected bytes. Any drift is a hard stop requiring a new review; do not repair protected bytes during rollout.
3. Keep protected n8n source exports root-only and outside Git. Descriptor-read the authorized sources without displaying their contents, derive the complete expected workflow set, and compare the reviewed source/semantic digests. Missing, duplicate, unknown, symlinked, unreadable, or changed sources stop the rollout.
4. Verify the repository's diagnostic evaluators remain non-authoritative and non-sending. They may check sanitized evidence shape; they cannot approve or perform a provider action.

## Current coupling caveat

Founder MFA currently spans Vercel functions, PostgreSQL transactional state, and the existing n8n account/session workflows. The current active login workflow can retain successful/error execution data and progress while password-bearing items pass through it. Do not activate founder MFA until provider-native n8n settings and canary readback prove execution persistence is disabled or minimized, password material is removed immediately after verification, retention is hardened, and no password, handoff, grant, OTP, seed, URI, recovery code, or MFA proof is retained. Customer authentication must remain available throughout; founder mode stays `disabled` until the later approved gates.

## Gate 0 — local exact-byte acceptance

No provider credentials or network mutation are permitted in this gate.

1. Freeze the complete working candidate with a disposable index for review without changing the real index. After acceptance, commit the exact bytes locally; only the resulting clean commit and tree can become publication or deployment authority.
2. Run the contract, founder-MFA, PostgreSQL disposable, build, boot-motion, browser, syntax, secret-scan, diff-hygiene, and protected-drift checks required by the release review.
3. Confirm exactly 10 API functions and zero drift under `api/**`, `db/migrations/**`, and `db/roles/**`.
4. Confirm all rejected release-authority and monitoring control-plane files are absent.
5. Obtain independent backend/security, QA, release, and documentation review against the same final bytes.

**Pass:** one unchanged local candidate satisfies all required gates.
**Stop:** any failed check, warning treated as a release blocker, changed byte after review, staged file, secret finding, protected drift, or residue. Return to local correction and restart Gate 0.

## Gate 1 — read-only Production preflight

This gate is read-only and does not authorize later changes.

1. Obtain explicit approval for read-only Production inventory only.
2. Through native provider readback, identify the exact Vercel project/environment/current public alias and rollback deployment; PostgreSQL project/database/version/region/backup posture and current role/catalog state; and n8n runtime version, active workflow IDs, webhook paths, credential names/types, retention settings, and execution-data policy.
3. Confirm the target is Production, n8n runtime compatibility is exact, the database target is not a drill target, current customer workflows are unchanged, and founder mode is `disabled`.
4. Compare native observations with the frozen expectations without copying secret values.

**Pass:** identities, versions, inventories, rollback pointers, and privacy posture are complete and consistent.
**Stop:** identity/version drift, missing rollback pointer, unexpected workflow/webhook/alias, incompatible shared n8n runtime, or any need to reveal a secret. Resolve separately; do not mutate during preflight.

## Gate 2 — backup and isolated restore

Snapshot creation, isolated-target creation, restore, and drill-target deletion are four external mutations. Each needs its own separate explicit approval and provider-native readback.

1. Approve only creation of one immutable Production snapshot. Create it through the database provider, then read back its stable object ID, source identity, completion state, capture/recovery time, PostgreSQL version, region, encryption state, and immutability.
2. Approve only creation of one uniquely named non-Production isolated drill target. Create it, then read back its identity, isolation, labels, network exposure, and proof that it differs from Production.
3. Approve only restoration of the exact snapshot into that exact drill target. Restore it, then read back the restored source/snapshot identity and completion state.
4. Verify migration ledger, catalog, roles, usable historical key-version metadata, synthetic write behavior, RPO/RTO, and absence of real pre-activation founder-MFA rows. Never expose key values.
5. Approve only deletion of the exact drill target. Delete it, then independently read back zero drill databases, files/plaintext trees, containers, volumes, and networks for that scope.

**Pass:** immutable backup identity, isolated semantic restore, bounded recovery objectives, and zero scoped residue are proven by native readback.
**Stop:** source/target ambiguity, real data in a synthetic check, unusable KID, parity mismatch, RPO/RTO breach, cleanup uncertainty, or residue. Preserve evidence and seek a separate scoped cleanup decision.

## Gate 3 — PostgreSQL migration

Opening the migration window, applying role/migration bytes, resealing the migrator, and any rollback are separate external mutations with separate approvals and readbacks.

1. Approve only the exact migration-window role change against the verified Production database. Apply `db/roles/005_unseal_migrator.sql`, then read back database/user identity, TLS posture, role flags, memberships, ownership, and ACLs. `db/roles/000_roles.sql` remains the reviewed baseline role authority and is not reapplied blindly.
2. Approve only application of `db/migrations/manifest.json`. Verify its checksums, then apply its exact ordered files once: `db/migrations/001_founder_mfa.sql`, followed by `db/migrations/002_founder_mfa_production_authority.sql`. Read back the migration ledger, schema/catalog digests, functions, constraints, triggers, policies, table/column ACLs, ownership, and zero real founder-MFA rows.
3. Approve only resealing the migrator with `db/roles/010_seal_migrator.sql`. Apply it, then read back `NOLOGIN`, revoked owner membership, runtime non-ownership, and denied DDL/TRUNCATE/role/ledger paths.
4. Run readiness through the least-privilege runtime and verifier identities. A second migration check must report zero pending applications without changing Production.

**Pass:** the exact ledger/catalog is present and the migration identity is sealed.
**Stop:** wrong database/user, checksum or ledger drift, unexpected grant/owner/policy, partially applied migration, nonzero real rows, or uncertain commit. Mark uncertainty for reconciliation; do not reapply or advance.

## Gate 4 — inactive n8n import

Retention hardening, each workflow import, and each credential binding are separate external mutations. Activation is forbidden in this gate.

1. Approve only the exact retention/privacy change for existing affected workflows. Apply it, then read back execution-save/progress/pruning settings and run a secret-free canary proving prohibited material is not retained.
2. For each reviewed workflow candidate, obtain a separate explicit approval to import that one workflow inactive. Import it, then read back its provider-assigned ID, `active:false`/unpublished state, webhook path, node/connection topology, settings, normalized semantics, and absence of pinned/static/secret data. Read back the predecessor unchanged after every import.
3. For each required credential reference, obtain a separate approval to bind only the named least-privilege credential to one inactive workflow. Bind it without execution, then read back credential name/type and workflow inactivity; never read or record values.
4. Read back the complete n8n inventory: no candidate active or published, no duplicate live webhook, no unexpected execution, and all predecessor workflows unchanged.

**Pass:** every candidate exists inactive with exact native semantics and least-privilege metadata.
**Stop:** overwrite, auto-activation/publication, topology drift, broader credential, duplicate webhook, retained canary/secret, execution, or predecessor mutation. Candidate deletion is a separate destructive approval.

## Gate 5 — Vercel disabled deployment

Production variable changes, deployment creation, smoke traffic, and alias movement are distinct actions. This gate does not move the public alias.

1. For each reviewed Production variable name/scope change, obtain a separate explicit approval. Set values only through the provider secret interface. Read back names, scopes, branch/custom-environment bindings, and version metadata only—never values. Founder mode must be `disabled`.
2. Obtain separate approval to create one immutable Production deployment from the frozen source. Create it without changing the public alias.
3. Read back deployment ID, exact provider source SHA, independently resolved source tree, Production environment, `READY` state, creation time after variable staging, and the complete provider function inventory. The resolved tree must equal the accepted candidate tree even when a merge commit gives the provider source a different SHA. The function inventory must equal the frozen inventory of exactly 10 API functions.
4. With separately approved synthetic smoke traffic, test only the isolated deployment URL: ordinary customer paths remain valid and founder MFA actions remain denied in `disabled` mode. Read back request/deployment association and secret-free results.
5. Confirm the public alias still points to the recorded rollback deployment.

**Pass:** an isolated immutable disabled deployment is ready, exact, and customer-safe; the public alias is unchanged.
**Stop:** wrong source/environment/scope, deployment predating variables, missing/extra function, non-ready state, early alias movement, customer regression, or founder action availability.

## Gate 6 — n8n activation

Each workflow deactivation or activation and public alias movement is a separate mutation with its own approval and native readback. Keep founder mode `disabled`.

1. Activate internal finalizer and dispatcher/reconciler roles one at a time, each under separate approval. After each activation, read back exact ID/version/active state/webhook inventory and perform only the approved synthetic check.
2. Cut over bootstrap, revoke, logout, profile, and sessions one role at a time. For each role: separately approve predecessor deactivation, read it back inactive; separately approve candidate activation, read it back active; then prove exactly one webhook owner and run customer regression.
3. Separately approve moving the public alias to the disabled Vercel deployment. Move it once, then read back the alias target and ordinary customer behavior.
4. Cut over login last: separately approve old-login deactivation and read it back; separately approve candidate-login activation and read it back; require exactly one production login webhook and retained customer success.

**Pass:** one exact owner exists per live role/webhook, the alias points to the disabled deployment, queues are empty/reconciled, and customer paths pass.
**Stop:** duplicate or missing webhook, unknown queue/finalization state, predecessor still active, alias/source drift, retained execution data, customer regression, or password-only founder session. Do not blindly retry.

## Gate 7 — armed mode

Changing the mode and creating the resulting deployment are separate external mutations. Armed mode cannot disclose a seed or issue a founder session.

1. Obtain separate approval to change only `PKC_FOUNDER_MFA_MODE` to `armed`; change it and read back the variable name/scope/version metadata without the value.
2. Obtain separate approval to create one new immutable Production deployment; create it without alias movement and read back source, environment, mode label from safe runtime evidence, readiness, and exactly 10 functions.
3. Obtain separate approval to move the public alias to that armed deployment; move it and read back the exact alias target.
4. Run separately approved synthetic customer and founder-denial probes. Read back that customer login succeeds while founder challenge, disclosure, verification, finalization, recovery, sensitive actions, and enrollment remain denied.

**Pass:** armed deployment is exact, customer-safe, denial-only for founder MFA, and observably non-sending.
**Stop:** any founder session/seed disclosure, wrong alias/source/mode, retained proof material, or customer regression. Roll back only under a new approval.

## Gate 8 — enforced mode

Enforcement is not enrollment. Mode change, deployment, alias move, and any rollback are separately approved mutations.

1. Confirm database readiness, sealed roles, empty/reconciled queues, retention/privacy canary, exact active workflows, current backup, rollback deployment, and armed denial evidence.
2. Obtain separate approval for each Production variable change required by enforced mode: set `PKC_SOURCE_COMMIT` to the accepted source commit and `PKC_MFA_WORKFLOW_DIGEST` to the accepted workflow digest through the provider interface. These two values are non-secret lineage identities: read back their exact provider-native values, Production-only target, absence of branch/custom-environment bindings, and version metadata, then require exact equality. Do not read any secret-bearing variable value.
3. Obtain separate approval to change only `PKC_FOUNDER_MFA_MODE` to `enforced`; change it and read back scope/version metadata.
4. Obtain separate approval to create a new immutable Production deployment; create it and read back exact source, environment, readiness, mode label through safe runtime evidence, and exactly 10 functions. The isolated deployment must safely attest that its runtime `PKC_SOURCE_COMMIT` and `PKC_MFA_WORKFLOW_DIGEST` equal the accepted candidate commit and workflow digest. Independently resolve the provider source SHA and require its Git tree to equal the accepted candidate tree; a post-merge provider SHA is not required to equal `PKC_SOURCE_COMMIT`.
5. Before public traffic, verify the isolated deployment returns the expected generic pre-enrollment founder flow without creating a general founder session or disclosing a seed absent valid enrollment authority.
6. Obtain separate approval to move the public alias to the enforced deployment; move it and read back the exact target. Observe provider-native application, database, and n8n state before enrollment.

**Pass:** enforced code is exact and live, but no founder factor has been enrolled and no founder session has been issued.
**Stop:** unexpected enrollment/factor row, password-only founder success, privacy failure, queue ambiguity, source/alias drift, or customer regression.

## Gate 9 — founder enrollment

Enrollment is a high-risk, one-time security mutation. It requires a separate explicit approval bound to the exact founder UUID, source commit, deployment ID, workflow digest, factor state, auth epoch, and expiry. No earlier approval authorizes it.

1. The founder confirms the exact Production identity and opens the same-origin enrollment flow on a trusted device. No screen sharing, recording, analytics, remote QR service, or copied terminal output is allowed.
2. Create the one-use enrollment authorization only under its own approval, then read back non-secret binding metadata and unused/unexpired state.
3. The founder alone receives the QR/manual secret, enrolls the authenticator, and submits a current TOTP. The founder stores recovery codes offline; operators never view, copy, log, or ticket them.
4. Read back only non-secret state: factor active, authorization consumed, accepted counter advanced, auth epoch incremented, old founder sessions revoked, challenge consumed, finalization disposition conclusive, and one exact MFA-assured founder session receipt.
5. Verify replay denial, password-only denial, sensitive-action freshness enforcement, customer regression, and absence of prohibited material in Vercel/n8n/provider logs and execution data.

**Pass:** the founder has one active factor, offline recovery custody, conclusive finalization, and MFA-assured access; customer behavior remains unchanged.
**Stop:** secret exposure, unknown finalization, duplicate factor/session, replay acceptance, retained proof material, or any mismatch. Disable/rotate/recover only through a new reviewed and separately approved procedure.

## Rollback and reconciliation

Rollback is never implicit and never reuses rollout approval.

1. Stop traffic-changing work and preserve non-secret native evidence.
2. Classify each affected provider object as definitely unchanged, definitely changed, or `UNKNOWN_REQUIRES_RECONCILIATION`.
3. Resolve unknowns through provider-native readback before any retry or inverse action.
4. Prefer the narrowest reversible action: restore the exact prior alias deployment, deactivate only the exact candidate workflow after confirming a single predecessor owner, or restore the prior mode through a fresh deployment. Each action requires a separate explicit approval and post-action native readback.
5. Do not roll back hardened retention. Do not down-migrate Production in place. For database failure, keep founder mode disabled/armed, preserve customer service, and choose a separately reviewed forward repair or verified snapshot recovery.
6. Founder enrollment rollback means a reviewed factor recovery/rotation path, not deletion of evidence or bypass of MFA.
7. Close the incident only when exact provider inventories, customer regression, founder denial/assurance state as intended, queues/finalizations, aliases, workflows, database authority, and scoped residue all have conclusive native readback.

## Completion record

The rollout is complete only when Gates 0–9 each have gate-specific approval, provider-native readback, a conclusive disposition, no secret exposure, no unresolved unknown, and no unapproved residue. Local diagnostics may support the record but remain `authoritative:false` and `releaseEligible:false`; they never replace the human approval or native provider evidence.
