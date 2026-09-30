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

test("Phase One requires explicit adult and policy consent before exposing PII", () => {
  const html = read("phase-one/index.html");
  const app = read("phase-one/app.js");
  assert.match(html, /id="eligibility-section"/);
  assert.match(html, /id="adult-confirm-input"[^>]*type="checkbox"[^>]*required/s);
  assert.match(html, /id="policy-consent-input"[^>]*type="checkbox"[^>]*required/s);
  assert.match(html, /href="\/terms\/"/);
  assert.match(html, /href="\/privacy\/"/);
  assert.doesNotMatch(html, /<label[^>]*>(?:(?!<\/label>)[\s\S])*?<a\s/i);
  assert.match(app, /eligible:\s*false/);
  assert.match(app, /adultConfirmed:\s*true/);
  assert.match(app, /termsAccepted:\s*true/);
  assert.match(app, /privacyAcknowledged:\s*true/);
  assert.match(app, /policyVersion:\s*"pkc-onboarding-launch-v1"/);
  assert.ok(app.indexOf("renderEligibility") < app.indexOf("render(target)"));
});

test("Phase One requires authoritative persistence before success and draft clearing", () => {
  const source = read("phase-one/app.js");
  assert.match(source, /body\.ok\s*===\s*true/);
  assert.match(source, /body\.persisted\s*===\s*true\s*\|\|\s*body\.duplicate\s*===\s*true/);
  assert.match(source, /return showSubmitError/);
  const submit = source.slice(source.indexOf("const submit ="), source.indexOf("//  Idle recovery"));
  assert.doesNotMatch(submit, /enqueue\(payload\)/);
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

test("launch onboarding is adult-only, consented, and does not collect deferred PII", () => {
  const html = read("phase-three/index.html");
  const app = read("phase-three/app.js");
  assert.doesNotMatch(html, /id="birthday-input"|id="ship-|id="social-/);
  assert.match(html, /id="age-confirm-input"/);
  assert.match(html, /id="terms-accept-input"/);
  assert.match(html, /href="\/privacy\/"/);
  assert.match(html, /href="\/terms\/"/);
  assert.doesNotMatch(html, /id="email-drops-input"\s+checked/);
  assert.match(app, /age_confirmed:\s*checked\("#age-confirm-input"\)/);
  assert.match(app, /terms_accepted:\s*checked\("#terms-accept-input"\)/);
  const formStart = app.indexOf("function readForm()");
  const formEnd = app.indexOf("function restoreDraft", formStart);
  const form = app.slice(formStart, formEnd);
  assert.doesNotMatch(form, /birthday:|shipping:|socials:/);
});

test("Privacy and Terms describe adult-only launch and non-public profiles", () => {
  const privacy = read("privacy/index.html");
  const terms = read("terms/index.html");
  assert.match(privacy, /18 or older/i);
  assert.match(privacy, /not publicly displayed/i);
  assert.match(privacy, /deletion requests/i);
  assert.match(terms, /guardian-consent workflow is not available/i);
  assert.match(terms, /payment processing[^.]*not available/i);
});

test("Phase Three consent and pre-shop UX remain accurate and accessible", () => {
  const app = read("phase-three/app.js");
  const styles = read("phase-three/styles.css");
  const sections = read("src/components/Sections.jsx");
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
