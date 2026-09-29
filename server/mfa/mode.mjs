const MODES = new Set(["disabled", "armed", "enforced"]);
const ACTIONS = new Set(["customer", "synthetic-denial", "challenge", "disclose", "verify", "finalize", "recovery", "sensitive"]);

export function parseFounderMfaMode(env = process.env) {
  const raw = env?.PKC_FOUNDER_MFA_MODE;
  if ((raw === undefined || raw === "") && env?.NODE_ENV === "production") throw new Error("founder_mfa_mode_not_configured");
  const mode = raw === undefined || raw === "" ? "disabled" : raw;
  if (!MODES.has(mode)) throw new Error("invalid_founder_mfa_mode");
  return mode;
}

export function requireFounderMfaAction(mode, action) {
  if (!MODES.has(mode)) throw new Error("invalid_founder_mfa_mode");
  if (!ACTIONS.has(action)) throw new TypeError("invalid_founder_mfa_action");
  if (action === "customer") return false;
  if (action === "synthetic-denial" && mode === "armed") return true;
  if (mode !== "enforced") throw new Error("founder_mfa_mode_denied");
  return true;
}

export function founderMfaModeEvidence(mode) {
  if (!MODES.has(mode)) throw new Error("invalid_founder_mfa_mode");
  return Object.freeze({ founderMfaMode: mode });
}
