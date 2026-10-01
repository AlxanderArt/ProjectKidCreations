import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertPhaseThreeSourceAuthority,
  CANDIDATE_PATH,
  classifyPrivacyContractVersion,
  derivePhaseThree14PlusCandidate,
  loadBoundPhaseThreeSource,
  patchLaunchPrivacyWorkflow,
  PRIVACY_VERSION,
  PREVIOUS_PRIVACY_VERSION,
} from "../../scripts/n8n-launch-privacy.mjs";

const source = () => loadBoundPhaseThreeSource().value;
const code = (workflow, name) => workflow.nodes.find((node) => node.name === name).parameters.jsCode;

test("Phase Three source is bound to the exact protected live authority", () => {
  const workflow = source();
  assert.doesNotThrow(() => assertPhaseThreeSourceAuthority(workflow));
  for (const mutate of [
    (value) => { value.versionId = "drift"; },
    (value) => { value.connections = {}; },
    (value) => { code(value, "Guard + Verify Token"); value.nodes.find((node) => node.name === "Guard + Verify Token").parameters.jsCode += "\n// drift"; },
    (value) => {
      const node = value.nodes.find((item) => item.credentials);
      const type = Object.keys(node.credentials)[0];
      node.credentials[type].name += " drift";
    },
  ]) {
    const drift = structuredClone(workflow);
    mutate(drift);
    assert.throws(() => assertPhaseThreeSourceAuthority(drift), /source authority drift/);
    assert.throws(() => patchLaunchPrivacyWorkflow(drift), /source authority drift/);
  }
});

test("Phase Three transition accepts only the two exact consent contracts", () => {
  const patched = patchLaunchPrivacyWorkflow(source());
  const validate = code(patched, "Validate + Compose Row");
  assert.match(validate, new RegExp(`value === "${PREVIOUS_PRIVACY_VERSION}"`));
  assert.match(validate, new RegExp(`value === "${PRIVACY_VERSION}"`));
  assert.match(validate, /p\.age_confirmed !== true/);
  assert.match(validate, /p\.terms_accepted !== true/);
  assert.match(validate, /requires age 14 or older/);
  assert.match(validate, /privacy_contract_class === 'unsupported'/);
  assert.match(validate, /function classifyPrivacyContractVersion/);
  assert.doesNotMatch(validate, /clean\(p\.privacy_contract_version/);
  assert.doesNotMatch(validate, /requires age 18 or older/);
});

test("privacy contract classifier rejects padded, whitespace-only, and wrong-type versions", () => {
  assert.equal(classifyPrivacyContractVersion(PREVIOUS_PRIVACY_VERSION), "consent");
  assert.equal(classifyPrivacyContractVersion(PRIVACY_VERSION), "consent");
  assert.equal(classifyPrivacyContractVersion(undefined), "legacy");
  assert.equal(classifyPrivacyContractVersion(""), "legacy");
  for (const value of ["2026-09-26 ", " 2026-10-01", "   ", null, 20261001, {}, []]) {
    assert.equal(classifyPrivacyContractVersion(value), "unsupported", JSON.stringify(value));
  }
});

test("consent-only 14+ records do not assert adult status while legacy DOB logic remains", () => {
  const patched = patchLaunchPrivacyWorkflow(source());
  const validate = code(patched, "Validate + Compose Row");
  const strictBranch = validate.slice(validate.indexOf("const privacy_contract_version"), validate.indexOf("const socials ="));
  assert.doesNotMatch(strictBranch, /p\.birthday|p\.shipping|p\.socials/);
  assert.match(strictBranch, /birthday: ''/);
  assert.match(strictBranch, /is_adult: ''/);
  assert.doesNotMatch(strictBranch, /is_adult: 'true'/);
  assert.match(strictBranch, /age_confirmed: 'true'/);
  assert.match(strictBranch, /terms_accepted: 'true'/);
  assert.match(validate, /const is_adult = age >= 18/);
});

test("Phase Three audit durably records truthful 14+ semantics", () => {
  const audit = code(patchLaunchPrivacyWorkflow(source()), "Compose Event");
  assert.match(audit, /minimum_age_confirmed: consentContract/);
  assert.match(audit, /minimum_age: consentContract \? 14 : null/);
  assert.match(audit, /adult_status: consentContract \? 'not_collected'/);
  assert.match(audit, /terms_accepted: consentContract/);
  assert.doesNotMatch(audit, /is_adult: row\.is_adult === 'true'/);
});

test("Phase Three response is versioned and omits adult inference", () => {
  const response = code(patchLaunchPrivacyWorkflow(source()), "Build Response");
  assert.match(response, /const API_VERSION = '1\.1\.0'/);
  assert.match(response, /minimum_age_confirmed: row\.age_confirmed === 'true'/);
  assert.match(response, /minimum_age: 14/);
  assert.doesNotMatch(response, /is_adult:/);
});

test("candidate remains inactive and preserves topology, settings, and credential bindings", () => {
  const original = source();
  const patched = patchLaunchPrivacyWorkflow(original);
  assert.equal(patched.active, false);
  assert.deepEqual(patched.connections, original.connections);
  assert.deepEqual(patched.settings, original.settings);
  assert.deepEqual(
    patched.nodes.map(({ id, name, type, typeVersion, position, credentials }) => ({ id, name, type, typeVersion, position, credentials })),
    original.nodes.map(({ id, name, type, typeVersion, position, credentials }) => ({ id, name, type, typeVersion, position, credentials })),
  );
});

test("isolated Phase Three candidate uses a distinct inactive webhook and name-only credentials", () => {
  const candidate = derivePhaseThree14PlusCandidate(source());
  assert.equal(candidate.active, false);
  assert.match(candidate.name, /14\+ Candidate v1/);
  const webhooks = candidate.nodes.filter((node) => node.type === "n8n-nodes-base.webhook");
  assert.deepEqual(webhooks.map((node) => node.parameters.path), [CANDIDATE_PATH, CANDIDATE_PATH]);
  for (const node of candidate.nodes) {
    assert.equal(node.id, undefined);
    assert.equal(node.webhookId, undefined);
    for (const reference of Object.values(node.credentials || {})) {
      assert.deepEqual(Object.keys(reference), ["name"]);
      assert.equal(typeof reference.name, "string");
      assert.ok(reference.name.length > 0);
    }
  }
  assert.equal(candidate.settings.availableInMCP, false);
});
