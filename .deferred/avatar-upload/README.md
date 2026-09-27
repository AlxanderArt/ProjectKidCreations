# Deferred avatar upload

Avatar upload is intentionally excluded from the production launch.

The preserved `upload-worker.js` is reference source only and is not loaded by any launch page. Restore it only after all of the following exist and are reviewed:

1. a same-origin `/api/avatar-upload` server handler;
2. authenticated account ownership checks;
3. MIME sniffing and decoded-image validation;
4. byte, dimension, rate, and storage quotas;
5. child/privacy review and retention/deletion policy;
6. malware/abuse handling;
7. strict-CSP browser tests;
8. a dependency audit with zero high/critical findings.

Do not restore `@vercel/blob` merely to satisfy the old worker. Select and pin the server-side storage implementation during the post-launch feature review.
