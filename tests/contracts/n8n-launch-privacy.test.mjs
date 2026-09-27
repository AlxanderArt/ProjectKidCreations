import assert from "node:assert/strict";
import { test } from "node:test";

import { patchLaunchPrivacyWorkflow } from "../../scripts/n8n-launch-privacy.mjs";

const code = (name, jsCode) => ({ name, type: "n8n-nodes-base.code", parameters: { jsCode } });

const fixture = () => ({
  id: "s4erDMlvnW8vLIxI",
  nodes: [
    code("Validate + Compose Row", "const birthday = clean(p.birthday, 10);\nconst socials = p.socials && typeof p.socials === 'object' ? p.socials : {};\nreturn [];"),
    code("Compose Event", "const event = 'PHASE_THREE_PROFILE_SAVED';\nreturn [];"),
  ],
  connections: {},
});

test("Phase Three launch privacy requires adult and terms consent", () => {
  const patched = patchLaunchPrivacyWorkflow(fixture());
  const validate = patched.nodes.find((node) => node.name === "Validate + Compose Row").parameters.jsCode;
  assert.match(validate, /p\.age_confirmed !== true/);
  assert.match(validate, /p\.terms_accepted !== true/);
  assert.match(validate, /UNDER_AGE/);
  assert.match(validate, /requires age 18 or older/);
});

test("Phase Three launch privacy blanks deferred PII and defaults marketing off", () => {
  const patched = patchLaunchPrivacyWorkflow(fixture());
  const validate = patched.nodes.find((node) => node.name === "Validate + Compose Row").parameters.jsCode;
  const strictBranch = validate.slice(validate.indexOf("const privacy_contract_version"), validate.indexOf("const socials ="));
  assert.doesNotMatch(strictBranch, /p\.birthday|p\.shipping|p\.socials/);
  assert.match(validate, /birthday: ''/);
  assert.match(validate, /socials_insta: ''/);
  assert.match(validate, /shipping_line1: ''/);
  assert.match(validate, /email_drops = p\.email_drops === true/);
  assert.match(validate, /sms_optin: 'false'/);
  assert.match(validate, /privacy_contract_version/);
});

test("Phase Three audit durably records consent without deferred PII", () => {
  const patched = patchLaunchPrivacyWorkflow(fixture());
  const audit = patched.nodes.find((node) => node.name === "Compose Event").parameters.jsCode;
  assert.match(audit, /age_confirmed: privacyV2/);
  assert.match(audit, /terms_accepted: privacyV2/);
  assert.match(audit, /deferred_fields_collected: !privacyV2/);
});

test("privacy transformer fails closed on drift and unsupported workflows", () => {
  assert.throws(() => patchLaunchPrivacyWorkflow({ ...fixture(), id: "other" }), /unsupported/);
  const drift = fixture();
  drift.nodes[0].parameters.jsCode = "return [];";
  assert.throws(() => patchLaunchPrivacyWorkflow(drift), /unexpected privacy validation source/);
});
