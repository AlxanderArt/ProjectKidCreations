// Same-origin proxies. n8n base URL + auth key live in Vercel env vars
    // (PKC_N8N_BASE_URL, PKC_AUTH_KEY) and never reach the browser.
    window.PKC_PHASE_THREE = {
      VERIFY_URL:         "/api/phase-three/verify",
      SAVE_URL:           "/api/phase-three/save",
      EVENT_URL:          "/api/phase-three/event",
      CHECK_USERNAME_URL: "/api/phase-three/check-username",
      EXPECTED_API_VERSION: "1.1.0",
      LOADING_TIMEOUT_MS: 12000,
      AUTO_RETRY_DELAY_MS: 1500,
      ABANDON_AFTER_MS: 120000,
      USERNAME_DEBOUNCE_MS: 300
    };
