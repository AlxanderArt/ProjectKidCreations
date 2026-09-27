// Same-origin proxy. Real n8n base URL + auth key live in Vercel env vars
    // (PKC_N8N_BASE_URL, PKC_AUTH_KEY) and never reach the browser.
    window.PKC_ENDPOINT = "/api/onboarding";
