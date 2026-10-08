import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("token journeys strip query parameters immediately after capture", () => {
  for (const path of [
    "phase-two/app.js",
    "phase-three/app.js",
    "account/bootstrap/app.js",
    "account/reset/app.js",
  ]) {
    const source = read(path);
    assert.match(source, /history\.replaceState\([^)]*location\.pathname[^)]*location\.hash/,
      `${path} must remove token-bearing search parameters`);
    const captureNeedle = path === "account/bootstrap/app.js"
      ? "const parsed = parseURL();"
      : path === "account/reset/app.js"
        ? "const parsedCredential = safeParseToken();"
        : "tokenString = safeParseToken();";
    const capture = source.indexOf(captureNeedle);
    const strip = source.indexOf("history.replaceState", capture);
    const request = source.indexOf("fetch(", strip);
    assert.ok(capture >= 0 && strip > capture, `${path} strips only after capture`);
    assert.ok(request < 0 || strip < request, `${path} strips before requests`);
  }
});

test("canonical onboarding route uses route-stable Phase One asset URLs", () => {
  const html = read("phase-one/index.html");
  assert.match(html, /href="\/phase-one\/styles\.css"/);
  assert.match(html, /src="\/phase-one\/app\.js"/);
  assert.doesNotMatch(html, /href="styles\.css"|src="app\.js"/);
});

test("Phase One requires explicit 14+ and policy consent before exposing PII", () => {
  const html = read("phase-one/index.html");
  const app = read("phase-one/app.js");
  assert.match(html, /id="eligibility-section"/);
  assert.match(html, /id="minimum-age-confirm-input"[^>]*type="checkbox"[^>]*required/s);
  assert.match(html, /at least 14 years old/i);
  assert.doesNotMatch(html, /18 years old|age 18|adult-only/i);
  assert.match(html, /id="policy-consent-input"[^>]*type="checkbox"[^>]*required/s);
  assert.match(html, /href="\/terms\/"/);
  assert.match(html, /href="\/privacy\/"/);
  assert.doesNotMatch(html, /<label[^>]*>(?:(?!<\/label>)[\s\S])*?<a\s/i);
  assert.match(app, /eligible:\s*false/);
  assert.match(app, /minimumAgeConfirmed:\s*true/);
  assert.doesNotMatch(app, /adultConfirmed/);
  assert.match(app, /termsAccepted:\s*true/);
  assert.match(app, /privacyAcknowledged:\s*true/);
  assert.match(app, /policyVersion:\s*"pkc-onboarding-14-plus-v1"/);
  assert.ok(app.indexOf("renderEligibility") < app.indexOf("render(target)"));
});

test("Phase One rate limits only actual network submissions, never question navigation", () => {
  const source = read("phase-one/app.js");
  const advance = source.slice(source.indexOf("const tryAdvance ="), source.indexOf("const shake ="));
  const submit = source.slice(source.indexOf("const submit ="), source.indexOf("//  Idle recovery"));
  assert.doesNotMatch(advance, /getAttempts\(|pushAttempt\(/);
  assert.match(submit, /getAttempts\(\)\.length\s*>=\s*CONFIG\.RATE_LIMIT/);
  assert.match(submit, /pushAttempt\(\)/);
  assert.ok(submit.indexOf("getAttempts().length") < submit.indexOf("fetch(CONFIG.ENDPOINT"));
  assert.ok(submit.indexOf("pushAttempt()") < submit.indexOf("fetch(CONFIG.ENDPOINT"));
});

test("Phase One requires authoritative persistence before success and draft clearing", () => {
  const source = read("phase-one/app.js");
  assert.match(source, /body\.ok\s*===\s*true/);
  assert.match(source, /body\.persisted === true \|\| body\.duplicate === true/);
  assert.match(source, /body\.email !== "queued"/);
  assert.match(source, /render\("done"\);\s*setStatus\("\/\/ EMAIL QUEUED", "success", \{ sticky: true \}\)/);
  assert.match(source, /return showSubmitError/);
  const submit = source.slice(source.indexOf("const submit ="), source.indexOf("//  Idle recovery"));
  assert.doesNotMatch(submit, /enqueue\(payload\)/);
});

test("Phase One removes obsolete automatic queue replay instead of resubmitting stale entries", () => {
  const source = read("phase-one/app.js");
  assert.doesNotMatch(source, /const drainQueue|fetch\(CONFIG\.ENDPOINT[^]*entry\.payload|PKC_QUEUE\.drain/);
  assert.match(source, /sessionStorage\.removeItem\(LEGACY_QUEUE_KEY\)/);
  assert.match(source, /const LEGACY_QUEUE_KEY\s*=\s*"pkc_queue"/);
});

test("Phase One completion copy directs users to email without transmission language", () => {
  const html = read("phase-one/index.html");
  assert.match(html, /Check your email to continue onboarding/i);
  assert.match(html, /Email delivery may take a few minutes/i);
  assert.match(html, /check your spam or junk folder/i);
  assert.doesNotMatch(html, /TRANSMISSION RECEIVED|SECURE CHANNEL CONFIRMED/i);
  assert.match(html, /aria-labelledby="completion-heading"/);
  assert.match(html, /aria-describedby="confirm-line delivery-help"/);
});

test("Phase One field errors are associated, announced, and cleared deterministically", () => {
  const source = read("phase-one/app.js");
  assert.match(source, /aria-describedby="q-\$\{idx\}-hint q-\$\{idx\}-error"/);
  assert.match(source, /id="q-\$\{idx\}-error"[^>]*role="alert"/);
  assert.match(source, /f\.input\.setAttribute\("aria-invalid", "true"\)/);
  assert.match(source, /f\.input\.removeAttribute\("aria-invalid"\)/);
});

test("Phase Three confirms account activation before showing success", () => {
  const source = read("phase-three/app.js");
  assert.match(source, /await issueAccountActivation\(/);
  assert.ok(source.indexOf("await issueAccountActivation(") < source.indexOf("showSuccess("));
  assert.doesNotMatch(source, /fireBootstrapHandoff/);
  assert.ok((source.match(/if \(!response\.ok\) throw/g) || []).length >= 2);
  const payloadBuilder = source.slice(
    source.indexOf("function buildBootstrapPayload"),
    source.indexOf("async function issueAccountActivation"),
  );
  assert.match(payloadBuilder, /activation_proof/);
  assert.doesNotMatch(payloadBuilder, /submission_id|username:|email:|first_name/);
});

test("login return path is normalized and allowlisted", () => {
  const source = read("account/login/app.js");
  assert.match(source, /SAFE_POST_LOGIN_PATHS/);
  assert.match(source, /next\.includes\("\\\\"\)/);
  assert.doesNotMatch(source, /next && next\.startsWith\("\/"\)/);
});

test("onboarding drafts are tab-scoped and exclude sensitive Phase Three PII", () => {
  const phaseOne = read("phase-one/app.js");
  const phaseThree = read("phase-three/app.js");
  assert.doesNotMatch(phaseOne, /localStorage/);
  assert.match(phaseOne, /sessionStorage/);
  assert.doesNotMatch(phaseThree, /localStorage/);
  assert.match(phaseThree, /sessionStorage/);
  const saveDraft = phaseThree.slice(
    phaseThree.indexOf("function saveDraft"),
    phaseThree.indexOf("function restoreDraft"),
  );
  assert.match(saveDraft, /const safeDraft/);
  assert.doesNotMatch(saveDraft, /birthday|shipping|socials|email_drops|sms_optin/);
});

test("launch onboarding is 14+, consented, and does not collect deferred PII", () => {
  const html = read("phase-three/index.html");
  const app = read("phase-three/app.js");
  assert.doesNotMatch(html, /id="birthday-input"|id="ship-|id="social-/);
  assert.match(html, /id="age-confirm-input"/);
  assert.match(html, /at least 14 years old/i);
  assert.doesNotMatch(html, /18 years old|adults only/i);
  assert.match(html, /id="terms-accept-input"/);
  assert.match(html, /href="\/privacy\/"/);
  assert.match(html, /href="\/terms\/"/);
  assert.doesNotMatch(html, /id="email-drops-input"\s+checked/);
  assert.match(app, /age_confirmed:\s*checked\("#age-confirm-input"\)/);
  assert.match(app, /at least 14 years old/);
  assert.match(app, /14\+ CONFIRMED/);
  assert.doesNotMatch(app, /at least 18 years old|18\+ CONFIRMED/);
  assert.match(app, /terms_accepted:\s*checked\("#terms-accept-input"\)/);
  const formStart = app.indexOf("function readForm()");
  const formEnd = app.indexOf("function restoreDraft", formStart);
  const form = app.slice(formStart, formEnd);
  assert.doesNotMatch(form, /birthday:|shipping:|socials:/);
});

test("Privacy and Terms describe the 14+ launch boundary and non-public profiles", () => {
  const privacy = read("privacy/index.html");
  const terms = read("terms/index.html");
  assert.match(privacy, /Effective October 1, 2026/);
  assert.match(privacy, /14 or older/i);
  assert.doesNotMatch(privacy, /18 or older|under 18/i);
  assert.match(privacy, /Phase One: first name, last name, email address, minimum-age confirmation/i);
  assert.doesNotMatch(privacy, /Phase One:[^<]*(project interests|optional message)/i);
  assert.match(privacy, /not publicly displayed/i);
  assert.match(privacy, /deletion requests/i);
  assert.match(terms, /Effective October 1, 2026/);
  assert.match(terms, /at least 14 years old/i);
  assert.doesNotMatch(terms, /18\+|18 years old|adults only/i);
  assert.match(terms, /payment processing[^.]*not available/i);
});

test("Phase Three consent and pre-shop UX remain accurate and accessible", () => {
  const app = read("phase-three/app.js");
  const config = read("phase-three/config.js");
  const styles = read("phase-three/styles.css");
  const sections = read("src/components/Sections.jsx");
  assert.match(config, /EXPECTED_API_VERSION:\s*"1\.1\.0"/);
  assert.match(app, /contact:\s*"ACCOUNT CONSENT"/);
  assert.match(app, /setAttribute\("aria-invalid",\s*"true"\)/);
  assert.match(app, /setAttribute\("aria-describedby"/);
  assert.match(app, /removeAttribute\("aria-invalid"\)/);
  assert.match(styles, /\.section-legend\s*\{[^}]*display:\s*block;/s);
  assert.match(sections, /VIEW MODS/);
  assert.doesNotMatch(sections, /SHOP MODS/);
});

test("Phase One Back control remains hidden when the hidden attribute is present", () => {
  const css = read("phase-one/styles.css");
  assert.match(css, /\.back\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/);
});
