// Same-origin proxies. The httpOnly session cookie set by /api/account/login
    // attaches automatically to subsequent same-origin fetches.
    window.PKC_ACCOUNT_CONFIG = {
      LOGIN_URL:           "/api/account/login",
      PROFILE_URL:         "/api/account/profile",
      ACCOUNT_HOME:        "/landing.html",
      FORGOT_URL:          "/account/forgot",
      FETCH_TIMEOUT_MS:    12000,
      AUTO_RETRY_DELAY_MS: 1500,
      INVALID_HOLD_MS:     2000
    };
