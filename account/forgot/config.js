// Same-origin proxy. Backend enforces opacity — every well-formed request
    // returns 200 regardless of whether the email matched a real account.
    window.PKC_FORGOT_CONFIG = {
      REQUEST_RESET_URL:   "/api/account/password-request",
      LOGIN_URL:           "/account/login",
      FETCH_TIMEOUT_MS:    12000,
      AUTO_RETRY_DELAY_MS: 1500
    };
