const KiB = 1024;
const DEFAULT_BODY = 16 * KiB;
const DEFAULT_RESPONSE = 256 * KiB;
const LARGE_RESPONSE = 1024 * KiB;

const route = (sourceFile, runtime, methods, upstream, allowedFields, options = {}) => Object.freeze({
  file: runtime === "nodejs" ? "api/node.js" : sourceFile,
  publicPath: `/${sourceFile.slice(0, -3)}`,
  runtime,
  methods: Object.freeze(methods),
  upstream: typeof upstream === "object" ? Object.freeze(upstream) : upstream,
  allowedFields: Object.freeze(allowedFields || {}),
  bodyLimit: options.bodyLimit || DEFAULT_BODY,
  responseLimit: options.responseLimit || DEFAULT_RESPONSE,
  session: options.session === true,
  admin: options.admin === true,
  founderConfigurationRequired: options.founderConfigurationRequired !== false,
  founderSensitiveMethods: Object.freeze(options.founderSensitiveMethods || []),
  timeoutMs: options.timeoutMs,
  setCookie: options.setCookie === true,
  query: Object.freeze(options.query || []),
});

export const ROUTES = Object.freeze({
  onboarding: route("api/onboarding.js", "edge", ["POST"], "/webhook/pkc-onboarding", { POST: ["version", "submissionId", "data", "consent"] }, { founderConfigurationRequired: false, timeoutMs: 45_000 }),
  phaseTwoVerify: route("api/phase-two/verify.js", "edge", ["POST"], "/webhook/pkc-phase-two/verify", { POST: ["token"] }, { founderConfigurationRequired: false }),
  phaseTwoSave: route("api/phase-two/save.js", "nodejs", ["POST"], "/webhook/pkc-phase-two/save", { POST: ["token"] }, { founderConfigurationRequired: false }),
  phaseTwoEvent: route("api/phase-two/event.js", "edge", ["POST"], "/webhook/pkc-phase-two/event", { POST: ["event_type", "submissionId", "data"] }, { founderConfigurationRequired: false }),
  phaseThreeVerify: route("api/phase-three/verify.js", "edge", ["POST"], "/webhook/pkc-phase-three/verify", { POST: ["token"] }, { founderConfigurationRequired: false }),
  phaseThreeSave: route("api/phase-three/save.js", "nodejs", ["POST"], "/webhook/pkc-phase-three/save", { POST: ["token", "profile"] }, { bodyLimit: 128 * KiB, founderConfigurationRequired: false }),
  phaseThreeEvent: route("api/phase-three/event.js", "edge", ["POST"], "/webhook/pkc-phase-three/event", { POST: ["event_type", "submissionId", "data"] }, { founderConfigurationRequired: false }),
  phaseThreeCheckUsername: route("api/phase-three/check-username.js", "edge", ["POST"], "/webhook/pkc-phase-three/check-username", { POST: ["token", "username"] }, { founderConfigurationRequired: false }),
  accountLogin: route("api/account/login.js", "nodejs", ["POST"], "/webhook/pkc-accounts/login", { POST: ["username", "password", "login_attempt_id"] }, { setCookie: true }),
  accountBootstrap: route("api/account/bootstrap.js", "edge", ["POST"], "/webhook/pkc-accounts/bootstrap", { POST: ["activation_proof"] }),
  accountBootstrapRedeem: route("api/account/bootstrap-redeem.js", "nodejs", ["POST"], "/webhook/pkc-accounts/bootstrap/redeem", { POST: ["token", "username", "password"] }, { setCookie: true }),
  accountPasswordRequest: route("api/account/password-request.js", "edge", ["POST"], "/webhook/pkc-accounts/password/request-reset", { POST: ["email"] }),
  accountPasswordComplete: route("api/account/password-complete.js", "nodejs", ["POST"], "/webhook/pkc-accounts/password/complete-reset", { POST: ["token", "new_password"] }),
  accountPasswordChange: route("api/account/password-change.js", "nodejs", ["POST"], "/webhook/pkc-accounts/password/change", { POST: ["current_password", "new_password"] }, { session: true, founderSensitiveMethods: ["POST"] }),
  accountEmailChange: route("api/account/email-change.js", "nodejs", ["POST"], "/webhook/pkc-accounts/email/change", { POST: ["current_password", "new_email"] }, { session: true, founderSensitiveMethods: ["POST"] }),
  accountDelete: route("api/account/delete.js", "nodejs", ["POST"], "/webhook/pkc-accounts/delete", { POST: ["current_password", "i_am_sure"] }, { session: true, founderSensitiveMethods: ["POST"] }),
  accountLogout: route("api/account/logout.js", "edge", ["POST"], "/webhook/pkc-accounts/logout", { POST: [] }, { session: true, setCookie: true }),
  accountActivity: route("api/account/activity.js", "nodejs", ["GET"], "/webhook/pkc-accounts/activity", {}, { session: true, responseLimit: LARGE_RESPONSE, query: ["limit", "cursor"] }),
  accountProfile: route("api/account/profile.js", "nodejs", ["GET", "PATCH"], "/webhook/pkc-accounts/profile", { PATCH: ["display_name", "first_name", "last_name", "pronouns", "bio", "notif_marketing"] }, { session: true }),
  accountSessions: route("api/account/sessions.js", "nodejs", ["GET", "POST"], { GET: "/webhook/pkc-accounts/sessions", POST: "/webhook/pkc-accounts/sessions/revoke" }, { POST: ["session_id"] }, { session: true, founderSensitiveMethods: ["POST"] }),
  accountAdminList: route("api/account/admin/list.js", "nodejs", ["POST"], "/webhook/pkc-admin/accounts/list", { POST: ["offset", "limit", "sort_by", "sort_dir", "status"] }, { session: true, admin: true, responseLimit: LARGE_RESPONSE }),
  accountAdminSearch: route("api/account/admin/search.js", "nodejs", ["POST"], "/webhook/pkc-admin/accounts/search", { POST: ["q", "status", "lockout_tier", "last_login_before"] }, { session: true, admin: true, responseLimit: LARGE_RESPONSE }),
  accountAdminChat: route("api/account/admin/chat.js", "nodejs", ["POST"], "/webhook/pkc-accounts-agent/chat", { POST: ["message", "sessionId"] }, { session: true, admin: true, bodyLimit: 64 * KiB, responseLimit: LARGE_RESPONSE }),
});
