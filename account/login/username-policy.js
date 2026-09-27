(function (root, factory) {
  "use strict";
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  if (root) root.PKCUsernamePolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OWNER_LOGIN_USERNAME = "PK Blick";
  const PUBLIC_USERNAME_RE = /^[a-z0-9_.\-]{3,32}$/;

  function isAllowedPublicUsername(value) {
    return typeof value === "string" && PUBLIC_USERNAME_RE.test(value);
  }

  function isAllowedLoginUsername(value) {
    return value === OWNER_LOGIN_USERNAME || isAllowedPublicUsername(value);
  }

  return Object.freeze({
    OWNER_LOGIN_USERNAME,
    isAllowedLoginUsername,
    isAllowedPublicUsername,
  });
});
