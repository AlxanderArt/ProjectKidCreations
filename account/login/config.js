// Same-origin proxies. The httpOnly session cookie set by /api/account/login
    // attaches automatically to subsequent same-origin fetches.
    window.PKC_ACCOUNT_CONFIG = {
      LOGIN_URL:           "/api/account/login",
      PROFILE_URL:         "/api/account/profile",
      MFA_ENROLL_URL:      "/api/account/mfa-enrollment",
      MFA_VERIFY_URL:      "/api/account/mfa-verify",
      MFA_RECOVERY_URL:    "/api/account/mfa-recovery",
      MFA_FINALIZE_URL:    "/api/account/mfa-finalize",
      ACCOUNT_HOME:        "/landing.html",
      FORGOT_URL:          "/account/forgot",
      FETCH_TIMEOUT_MS:    12000,
      INVALID_HOLD_MS:     2000
    };
