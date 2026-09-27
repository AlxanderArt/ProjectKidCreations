const WORKFLOW_ID = "s4erDMlvnW8vLIxI";
const PRIVACY_VERSION = "2026-09-26";
const INSERT_BEFORE = "const socials = p.socials && typeof p.socials === 'object' ? p.socials : {};";

const V2_BLOCK = `const privacy_contract_version = clean(p.privacy_contract_version, 20);
if (privacy_contract_version === '${PRIVACY_VERSION}') {
  if (p.age_confirmed !== true) return [{ json: { ...item, _code: 'UNDER_AGE', _message: 'Account onboarding requires age 18 or older.' } }];
  if (p.terms_accepted !== true) return [{ json: { ...item, _code: 'VALIDATION_ERROR', _message: 'Privacy Notice and Terms acceptance required.' } }];
  const email_drops = p.email_drops === true;
  const completed_at = new Date().toISOString();
  const row = { submissionId: item.submissionId, email: item.email, username, display_name, avatar_url: '', bio, skill_level, blasters_owned: blasters_owned.join(', '), accessory_interests: accessory_interests.join(', '), socials_insta: '', socials_yt: '', socials_tiktok: '', birthday: '', is_adult: 'true', shipping_line1: '', shipping_line2: '', shipping_city: '', shipping_region: '', shipping_postal: '', shipping_country: '', email_drops: email_drops ? 'true' : 'false', sms_optin: 'false', completed_at, redeemed_via_token: 'true', ip: item.ip, userAgent: item.userAgent, phase2_completed_at: phase2RedeemedAt, age_confirmed: 'true', terms_accepted: 'true', privacy_contract_version };
  return [{ json: { ...item, _row: row, age_confirmed: true, terms_accepted: true, privacy_contract_version } }];
}
`;

const AUDIT_CODE = `const item = $('Validate + Compose Row').first().json;
const row = item._row;
const privacyV2 = row.privacy_contract_version === '${PRIVACY_VERSION}';
return [{ json: { timestamp: new Date().toISOString(), event_type: 'PHASE_THREE_PROFILE_SAVED', source: 'pkc-phase-three-save', workspace_slug: 'pkc-phase-three-save', action: 'profile_persist', status: 'committed', request_id: item.request_id, details_json: JSON.stringify({ submissionId: row.submissionId, email: row.email, username: row.username, is_adult: row.is_adult === 'true', privacy_contract_version: row.privacy_contract_version || 'legacy', age_confirmed: privacyV2, terms_accepted: privacyV2, marketing_opt_in: row.email_drops === 'true', deferred_fields_collected: !privacyV2 }) } }];`;

export function patchLaunchPrivacyWorkflow(input) {
  if (input?.id !== WORKFLOW_ID) throw new Error("unsupported workflow");
  const workflow = structuredClone(input);
  const validate = workflow.nodes?.find((node) => node.name === "Validate + Compose Row");
  const audit = workflow.nodes?.find((node) => node.name === "Compose Event");
  if (!validate || typeof validate.parameters?.jsCode !== "string") throw new Error("Validate + Compose Row missing");
  if (!audit || typeof audit.parameters?.jsCode !== "string") throw new Error("Compose Event missing");
  const source = validate.parameters.jsCode;
  if (!source.includes("const birthday = clean(p.birthday, 10);") || !source.includes(INSERT_BEFORE)) {
    throw new Error("unexpected privacy validation source");
  }
  if (source.includes("privacy_contract_version = clean(p.privacy_contract_version")) throw new Error("privacy patch already present");
  if (!audit.parameters.jsCode.includes("PHASE_THREE_PROFILE_SAVED")) throw new Error("unexpected audit source");
  validate.parameters.jsCode = source.replace(INSERT_BEFORE, `${V2_BLOCK}${INSERT_BEFORE}`);
  audit.parameters.jsCode = AUDIT_CODE;
  return workflow;
}
