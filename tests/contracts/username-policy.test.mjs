import assert from "node:assert/strict";
import { test } from "node:test";
import "../../account/login/username-policy.js";

const {
  OWNER_LOGIN_USERNAME,
  isAllowedLoginUsername,
  isAllowedPublicUsername,
} = globalThis.PKCUsernamePolicy;

test("PK Blick is the one exact owner login username exception", () => {
  assert.equal(OWNER_LOGIN_USERNAME, "PK Blick");
  assert.equal(isAllowedLoginUsername("PK Blick"), true);
  assert.equal(isAllowedLoginUsername("PK blick"), false);
  assert.equal(isAllowedLoginUsername("pk Blick"), false);
  assert.equal(isAllowedLoginUsername("Another Founder"), false);
});

test("public usernames remain lowercase-only and cannot claim the owner identity", () => {
  assert.equal(isAllowedPublicUsername("pkblick"), true);
  assert.equal(isAllowedPublicUsername("PK Blick"), false);
  assert.equal(isAllowedPublicUsername("Customer Name"), false);
});
