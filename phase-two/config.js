// Same-origin proxy. n8n base URL + auth key live in Vercel env vars
    // (PKC_N8N_BASE_URL, PKC_AUTH_KEY) and never reach the browser.
    window.PKC_PHASE_TWO = {
      VERIFY_URL: "/api/phase-two/verify",
      SAVE_URL:   "/api/phase-two/save",
      EVENT_URL:  "/api/phase-two/event",
      EXPECTED_API_VERSION: "1.1.0",
      LOADING_TIMEOUT_MS: 12000,
      AUTO_RETRY_DELAY_MS: 1500,
      ABANDON_AFTER_MS: 90000
    };
