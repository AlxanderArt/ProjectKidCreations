import { randomBytes } from "node:crypto";
import { expect, test } from "./fixtures.mjs";

function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let value = 0;
  let bits = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

async function mockProfile(page) {
  await page.route("**/api/account/profile", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "unauthorized" }),
  }));
}

async function submitPassword(page) {
  await expect(page.locator("#pkc-boot")).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel("Username").fill("PK Blick");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

async function dispatchPageTransition(page, type, persisted = false) {
  await page.evaluate(({ eventType, isPersisted }) => {
    const event = new Event(eventType);
    Object.defineProperty(event, "persisted", { value: isPersisted });
    window.dispatchEvent(event);
  }, { eventType: type, isPersisted: persisted });
}

test("founder enrollment renders a local QR, confirms TOTP, discloses recovery codes once, then finalizes", async ({ page }) => {
  const generatedEnrollmentMaterial = base32(randomBytes(20));
  const secret = generatedEnrollmentMaterial;
  const recoveryCodes = Array.from({ length: 10 }, () => base32(randomBytes(18)).slice(0, 28).match(/.{1,4}/g).join("-"));
  const finalizeId = crypto.randomUUID();
  let loginAttemptId;
  let finalized = 0;

  await mockProfile(page);
  await page.route("**/api/account/login", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.username).toBe("PK Blick");
    expect(body.login_attempt_id).toMatch(/^[0-9a-f-]{36}$/i);
    loginAttemptId = body.login_attempt_id;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "mfa_required", mode: "enroll", csrf: base32(randomBytes(32)).slice(0, 43) }) });
  });
  await page.route("**/api/account/mfa-enrollment", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.csrf).toBeTruthy();
    const uri = `otpauth://totp/ProjectKidCreations%3AFounder?secret=${secret}&issuer=ProjectKidCreations&algorithm=SHA1&digits=6&period=30`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "enrollment_required", manualSecret: secret, otpauthUri: uri }) });
  });
  await page.route("**/api/account/mfa-verify", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.code).toBe("123456");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "finalize_pending", finalizeId, recoveryCodes }) });
  });
  await page.route("**/api/account/mfa-finalize", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.finalizeId).toBe(finalizeId);
    finalized += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "authenticated" }) });
  });

  await page.goto("/account/login/?next=%2Faccount%2Fadmin%2F", { waitUntil: "domcontentloaded" });
  await submitPassword(page);

  await expect(page.getByRole("heading", { name: /set up authenticator/i })).toBeVisible();
  const qr = page.getByRole("img", { name: /authenticator enrollment qr code/i });
  await expect(qr).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.getByTestId("mfa-manual-secret")).toHaveText(secret);
  await expect(page.getByLabel("Password")).toHaveValue("");

  await page.getByLabel("6-digit authenticator code").fill("123456");
  await page.getByRole("button", { name: /confirm authenticator/i }).click();
  await expect(page.getByRole("heading", { name: /save recovery codes/i })).toBeVisible();
  await expect(page.getByTestId("recovery-code-list").locator("li")).toHaveCount(10);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  await page.getByRole("button", { name: /i stored these codes offline/i }).click();
  await expect.poll(() => finalized).toBe(1);
  expect(loginAttemptId).toMatch(/^[0-9a-f-]{36}$/i);
});

test("founder can choose one-time recovery and must sign in again for re-enrollment", async ({ page }) => {
  const csrf = base32(randomBytes(32)).slice(0, 43);
  let recoveryCalls = 0;
  await mockProfile(page);
  await page.route("**/api/account/login", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, status: "mfa_required", mode: "verify", csrf }),
  }));
  await page.route("**/api/account/mfa-recovery", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.csrf).toBe(csrf);
    expect(body.code).toMatch(/^[A-Z2-9-]+$/);
    recoveryCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "reenrollment_required" }) });
  });

  await page.goto("/account/login/?next=%2Faccount%2Fadmin%2F", { waitUntil: "domcontentloaded" });
  await submitPassword(page);
  await expect(page.getByRole("heading", { name: /authenticator verification/i })).toBeVisible();
  const authenticatorInput = page.getByLabel("6-digit authenticator code");
  await expect(authenticatorInput).toHaveAttribute("aria-describedby", "mfa-error");
  await expect(authenticatorInput).toHaveAttribute("aria-invalid", "false");
  await page.getByRole("button", { name: /verify authenticator/i }).click();
  await expect(authenticatorInput).toHaveAttribute("aria-invalid", "true");
  await authenticatorInput.fill("1");
  await expect(authenticatorInput).toHaveAttribute("aria-invalid", "false");
  await page.getByRole("button", { name: /use a recovery code/i }).click();
  const recoveryInput = page.getByRole("textbox", { name: "Recovery code", exact: true });
  await expect(recoveryInput).toHaveAttribute("aria-describedby", "mfa-recovery-error");
  await expect(recoveryInput).toHaveAttribute("aria-invalid", "false");
  await page.getByRole("button", { name: /use recovery code/i }).click();
  await expect(recoveryInput).toHaveAttribute("aria-invalid", "true");
  await recoveryInput.fill("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345");
  await expect(recoveryInput).toHaveAttribute("aria-invalid", "false");
  await page.getByRole("button", { name: /use recovery code/i }).click();
  await expect.poll(() => recoveryCalls).toBe(1);
  await expect(page.getByText(/sign in again to set up a new authenticator/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /return to sign-in/i })).toBeVisible();
});

test("unknown finalization retries the same finalize identity without resubmitting an OTP", async ({ page }) => {
  const csrf = base32(randomBytes(32)).slice(0, 43);
  const finalizeId = crypto.randomUUID();
  let verifyCalls = 0;
  const finalizeBodies = [];
  await mockProfile(page);
  await page.route("**/api/account/login", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "mfa_required", mode: "verify", csrf }) }));
  await page.route("**/api/account/mfa-verify", async (route) => {
    verifyCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "finalize_pending", finalizeId }) });
  });
  await page.route("**/api/account/mfa-finalize", async (route) => {
    finalizeBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ status: "unknown", finalizeId }) });
  });

  await page.goto("/account/login/?next=%2Faccount%2Fadmin%2F", { waitUntil: "domcontentloaded" });
  await submitPassword(page);
  await page.getByLabel("6-digit authenticator code").fill("654321");
  await page.getByRole("button", { name: /verify authenticator/i }).click();
  await expect(page.getByText(/sign-in result is still being reconciled/i)).toBeVisible();
  await expect(page.locator("#mfa-finalize-retry")).toBeFocused();
  await page.getByRole("button", { name: /check sign-in status/i }).click();
  await expect.poll(() => finalizeBodies.length).toBe(2);
  expect(finalizeBodies[0].finalizeId).toBe(finalizeId);
  expect(finalizeBodies[1].finalizeId).toBe(finalizeId);
  expect(verifyCalls).toBe(1);
});

test("network loss after committed finalization recovers the same session identity", async ({ page }) => {
  const csrf = base32(randomBytes(32)).slice(0, 43);
  const finalizeId = crypto.randomUUID();
  let verifyCalls = 0;
  let committed = false;
  const finalizeBodies = [];
  await mockProfile(page);
  await page.route("**/api/account/login", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "mfa_required", mode: "verify", csrf }) }));
  await page.route("**/api/account/mfa-verify", async (route) => {
    verifyCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "finalize_pending", finalizeId }) });
  });
  await page.route("**/api/account/mfa-finalize", async (route) => {
    finalizeBodies.push(route.request().postDataJSON());
    if (finalizeBodies.length === 1) {
      committed = true;
      await route.abort("connectionfailed");
      return;
    }
    expect(committed).toBe(true);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "authenticated" }) });
  });

  await page.goto("/account/login/?next=%2Faccount%2Fadmin%2F", { waitUntil: "domcontentloaded" });
  await submitPassword(page);
  await page.getByLabel("6-digit authenticator code").fill("654321");
  await page.getByRole("button", { name: /verify authenticator/i }).click();
  await expect(page.getByText(/sign-in result is still being reconciled/i)).toBeVisible();
  await expect(page.locator("#mfa-finalize-retry")).toBeFocused();
  await page.getByRole("button", { name: /check sign-in status/i }).click();
  await expect.poll(() => finalizeBodies.length).toBe(2);
  expect(finalizeBodies.map((body) => body.finalizeId)).toEqual([finalizeId, finalizeId]);
  expect(verifyCalls).toBe(1);
  await expect(page).toHaveURL(/\/account\/admin\/$/);
});

test("page lifecycle clears rendered MFA secrets and a bfcache restore requires a fresh sign-in", async ({ page }) => {
  const generatedEnrollmentMaterial = base32(randomBytes(20));
  const generatedReplacementMaterial = base32(randomBytes(20));
  const secret = generatedEnrollmentMaterial;
  const replacementSecret = generatedReplacementMaterial;
  const recoveryCodes = Array.from({ length: 10 }, () => base32(randomBytes(18)).slice(0, 28).match(/.{1,4}/g).join("-"));
  let loginCalls = 0;
  let enrollmentCalls = 0;

  await mockProfile(page);
  await page.route("**/api/account/login", (route) => {
    loginCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, status: "mfa_required", mode: "enroll", csrf: base32(randomBytes(32)).slice(0, 43) }),
    });
  });
  await page.route("**/api/account/mfa-enrollment", (route) => {
    enrollmentCalls += 1;
    const selectedEnrollmentMaterial = enrollmentCalls === 1 ? secret : replacementSecret;
    const manualSecret = selectedEnrollmentMaterial;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "enrollment_required",
        manualSecret,
        otpauthUri: `otpauth://totp/ProjectKidCreations%3AFounder?secret=${manualSecret}&issuer=ProjectKidCreations`,
      }),
    });
  });
  await page.route("**/api/account/mfa-verify", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "finalize_pending", finalizeId: crypto.randomUUID(), recoveryCodes }),
  }));

  await page.goto("/account/login/?next=%2Faccount%2Fadmin%2F", { waitUntil: "domcontentloaded" });
  await submitPassword(page);
  await expect(page.getByTestId("mfa-manual-secret")).toHaveText(secret);
  await expect(page.locator("#mfa-qr")).toHaveAttribute("src", /^data:image\/png;base64,/);

  await dispatchPageTransition(page, "pagehide");
  await expect(page.locator("#mfa-qr")).not.toHaveAttribute("src", /.+/);
  await expect(page.getByTestId("mfa-manual-secret")).toBeEmpty();

  await dispatchPageTransition(page, "pageshow", true);
  await expect(page.getByRole("heading", { name: /operator sign-in/i })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveValue("");
  expect(loginCalls).toBe(1);

  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByTestId("mfa-manual-secret")).toHaveText(replacementSecret);
  expect(loginCalls).toBe(2);

  await page.getByLabel("6-digit authenticator code").fill("123456");
  await page.getByRole("button", { name: /confirm authenticator/i }).click();
  await expect(page.getByTestId("recovery-code-list").locator("li")).toHaveCount(10);
  await dispatchPageTransition(page, "pagehide");
  await expect(page.getByTestId("recovery-code-list").locator("li")).toHaveCount(0);
});

test("fatal MFA state focuses its retry action", async ({ page }) => {
  await mockProfile(page);
  await page.route("**/api/account/login", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, status: "mfa_required", mode: "unexpected", csrf: base32(randomBytes(32)).slice(0, 43) }),
  }));

  await page.goto("/account/login/?next=%2Faccount%2Fadmin%2F", { waitUntil: "domcontentloaded" });
  await submitPassword(page);
  await expect(page.getByRole("heading", { name: /something went wrong/i })).toBeVisible();
  await expect(page.locator("#fatal-retry-btn")).toBeFocused();
});
