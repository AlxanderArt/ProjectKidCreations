# PKC Phase One consent-persistence candidate

This repository derives one deterministic, **inactive** n8n workflow candidate from the protected Phase One source snapshot. It does not modify, import into, execute against, bind credentials in, or activate any live n8n instance.

## Authority and runtime

- Source identity is pinned in `scripts/n8n-phase-one-persistence.mjs` by workflow ID, name, version ID, update timestamp, node count, raw SHA-256, and canonical SHA-256.
- Source reads use one `O_NOFOLLOW` descriptor with regular-file, `0600`, size, fatal UTF-8, JSON depth/node/string, duplicate-key, prototype-key, and pre/post descriptor identity checks.
- Runtime compatibility is exactly n8n `2.19.5` at digest `sha256:b1b0c592735e24acd3cc64db83f94ef4efd8e331e47c6883249cc51cc1bea16b`.

## Candidate contract

- Name: `PKC — Onboarding Submissions — Consent Persistence Candidate v1`
- Candidate-only workflow ID: `pkcConsentCandV1` (distinct from the protected source ID)
- Webhook path: `pkc-onboarding-consent-v1`
- State: `active: false`, `availableInMCP: false`
- Timeout: 40 seconds (above the verified ~29-second workflow runtime and below the 45-second onboarding proxy timeout)
- Execution retention: error/success `none`; progress/manual `false`
- External body is closed to exactly `version`, `submissionId`, `firstName`, `lastName`, `email`, `minimumAgeConfirmed`, `termsAccepted`, `privacyAcknowledged`, `policyVersion`, and `hash`.
- All three consent booleans must be literal `true`; `policyVersion` must equal `pkc-onboarding-14-plus-v1`.
- The legacy digest remains SHA-256 of `firstName|lastName|email|submissionId|version`. No consent timestamp or consent digest is created.
- The four consent fields are retained by Enrich and explicitly mapped into the Sheets append.
- Credential references retain only credential type and credential name. IDs and other credential-reference values are removed.
- Sheets native retry and regular-output continuation are disabled. Its error output releases the submission lock only when the stored owner still matches the failing execution, then enters a fixed, privacy-minimized HTTP 503 response.
- An in-flight duplicate terminates with a privacy-minimized HTTP 409 (`submission_in_progress`, `persisted: false`). It cannot enter Aggregate, reach the success response, or claim durable persistence.
- Gmail behavior is preserved with at most two attempts and a 1-second retry delay.
- This candidate does **not** claim exactly-once processing, and it does not treat n8n-local throttling or in-memory deduplication as authoritative distributed control.

## Focused verification

```bash
node --test tests/contracts/n8n-phase-one-persistence.test.mjs
```

The contract covers hostile descriptor inputs, immutable source binding, deterministic derivation, closed consent validation, legacy hash behavior, consent mapping, retry/error routing, source immutability, credential minimization, retention, and manifest hashes.

## Package command (do not run during implementation)

The CLI requires a caller-supplied path that does not already exist:

```bash
node scripts/n8n-phase-one-candidate.mjs build --out /approved/new/output-directory
```

It writes `workflow.json` and `manifest.json` with directory mode `0700`, file mode `0600`, deterministic serialization, source raw/semantic hashes, and candidate raw/semantic hashes. Packaging does not import or run the workflow.

## Optional disposable native rehearsal (manual only)

After an approved package exists, a disposable local Docker rehearsal can import and export it using the pinned image:

```bash
node ops/n8n-phase-one-disposable/rehearse.mjs /approved/package-directory
```

The rehearsal uses an internal-only network, checks the inactive/zero-credential/zero-execution/zero-published-webhook database state, compares native readback semantics, and removes its exact Compose project, volume, network, and temporary directories. It performs no live API operation and must not be used as authorization to deploy, bind credentials, expose the webhook, execute, or activate the candidate.
