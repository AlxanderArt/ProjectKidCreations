import { expect, test } from "@playwright/test";

function browserFailures(page) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" || /content security policy|refused to/i.test(text)) {
      failures.push(`console: ${text}`);
    }
  });
  return failures;
}

async function mockEntry(page, body, status = 200) {
  await page.route("**/api/account/entry-state", (route) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  }));
}

async function waitForBootHandoff(page) {
  await expect(page.locator("#pkc-boot")).toHaveCount(0, { timeout: 10_000 });
}

test("public root exposes explicit launch choices under strict CSP", async ({ page }) => {
  const failures = browserFailures(page);
  await mockEntry(page, { ok: true, state: "public" });
  const response = await page.goto("/");
  await expect(page.getByRole("heading", { name: "WHAT ARE YOU HERE TO DO?" })).toBeVisible();
  await expect(page.getByRole("link", { name: /browse projects/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /start onboarding/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /founder sign-in/i })).toBeVisible();
  expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(response.headers()["content-security-policy"]).toContain("style-src-attr 'none'");
  expect(failures).toEqual([]);
});

test("customer and Founder states are server-routed without identity inference", async ({ page }) => {
  await mockEntry(page, { ok: true, state: "customer_active", account: { username: "sampleuser", display_name: "Sample User" } });
  await page.goto("/");
  await expect(page.getByText("// SESSION ACTIVE")).toBeVisible();
  await expect(page.getByRole("link", { name: /continue to account/i })).toHaveAttribute("href", "/account/");

  await page.unroute("**/api/account/entry-state");
  await mockEntry(page, { ok: true, state: "owner_active", account: { username: "PK Blick", display_name: "PK Blick" } });
  await page.reload();
  await expect(page.getByText("// FOUNDER SESSION ACTIVE")).toBeVisible();
  await expect(page.getByRole("link", { name: /continue to founder admin/i })).toHaveAttribute("href", "/account/admin/");
});

test("authority failure is degraded, never automatic onboarding", async ({ page }) => {
  await page.route("**/api/account/entry-state", (route) => route.abort("timedout"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "WE COULDN'T VERIFY THIS SESSION." })).toBeVisible();
  await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  expect(page.url()).not.toContain("phase-one");
});

test("Phase Four is quarantined before mock HTML is served", async ({ page }) => {
  await mockEntry(page, { ok: true, state: "public" });
  await page.goto("/phase-four/dev-state?dev=1");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("// CHOOSE YOUR NEXT STEP")).toBeVisible();
});

test("token routes scrub query secrets immediately", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: "invalid_or_expired" }),
  }));
  for (const path of ["/phase-two/?token=secret", "/phase-three/?token=secret", "/account/bootstrap/?token=secret", "/account/reset/?token=secret"]) {
    await page.goto(path);
    await expect.poll(() => new URL(page.url()).search).toBe("");
  }
});

test("landing hydrates without runtime inline styles", async ({ page }) => {
  const failures = browserFailures(page);
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
  const modelLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/assets/models/splatrball-400.glb"),
    { timeout: 3_000 },
  ).catch(() => null);
  await page.goto("/landing.html");
  await expect(page.locator("#root")).not.toBeEmpty();
  await modelLoaded;
  await page.waitForTimeout(500);
  const inlineStyles = await page.locator("[style]").evaluateAll((elements) =>
    elements.map((element) => ({ tag: element.tagName, className: element.className, style: element.getAttribute("style") })),
  );
  expect(inlineStyles).toEqual([]);
  expect(failures).toEqual([]);
});

test("landing catalog is an honest static article grid with a main landmark", async ({ page }) => {
  await page.goto("/landing.html");

  const main = page.getByRole("main");
  await expect(main).toHaveCount(1);
  await expect(page.locator(".pkc-skip")).toHaveAttribute("href", "#mods");
  await expect(main.locator("#mods")).toHaveCount(1);

  const catalog = page.locator("#mods");
  await expect(catalog.getByRole("article")).toHaveCount(6);
  await expect(catalog.getByRole("link")).toHaveCount(0);
  await expect(catalog).not.toContainText("PRODUCT IMAGE");
  await expect(catalog).not.toContainText("VIEW ALL");
  await expect(catalog.getByText(/detail pages launch with the shop/i)).toBeVisible();

  const layout = await catalog.locator(".pkc-products__track").evaluate((element) => {
    const style = getComputedStyle(element);
    return { display: style.display, animationName: style.animationName };
  });
  expect(layout.display).toBe("grid");
  expect(layout.animationName).toBe("none");
});

test("landing honors reduced motion for every decorative loop", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/landing.html");
  await waitForBootHandoff(page);
  const animationNames = await page.locator(".pkc-spec-strip__track, .pkc-status--unverified").evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).animationName),
  );
  expect(animationNames).toEqual(["none", "none"]);
});

test("landing fails fully visible when the optional motion runtime cannot load", async ({ page }) => {
  await page.route("**/dist/pkc-motion.js", (route) => route.abort("failed"));
  await page.goto("/landing.html", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#pkc-boot")).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator("html")).toHaveClass(/pkc-motion-ready/);
  await expect(page.locator(".pkc-products__heading")).toBeAttached();
  await expect(page.locator("#contact")).toBeAttached();
  const state = await page.evaluate(() => ({
    reason: document.documentElement.dataset.pkcMotionReady,
    inert: [...document.body.children].some((element) => element.inert),
    rootOpacity: getComputedStyle(document.querySelector("#root")).opacity,
    rootFilter: getComputedStyle(document.querySelector("#root")).filter,
  }));
  expect(state).toEqual({
    reason: "landing-fail-visible",
    inert: false,
    rootOpacity: "1",
    rootFilter: "none",
  });
});

test("secondary CTA has a perceivable boundary", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/landing.html");
  await waitForBootHandoff(page);
  const ratio = await page.locator(".pkc-hero__actions .pkc-button--secondary").evaluate((element) => {
    const parse = (value) => value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
    const luminance = (rgb) => {
      const channels = rgb.map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const style = getComputedStyle(element);
    const foreground = luminance(parse(style.borderTopColor));
    const background = luminance(parse(style.backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(document.body).backgroundColor : style.backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3);
});

test("landing keeps vertical sections while the desktop hero and two-row header use the requested composition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const viewports = [
    { name: "compact-phone", width: 320, height: 568 },
    { name: "phone", width: 390, height: 844 },
    { name: "large-phone", width: 430, height: 932 },
    { name: "tablet-portrait", width: 768, height: 1024 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "tablet-landscape", width: 1024, height: 768 },
    { name: "desktop", width: 1440, height: 1000 },
    { name: "wide-desktop", width: 1920, height: 1080 },
  ];
  await page.setViewportSize(viewports[0]);
  await page.goto("/landing.html");
  await waitForBootHandoff(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, viewport);

    const geometry = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } : null;
      };
      const centerDelta = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return Math.abs((box.left + box.width / 2) - (innerWidth / 2));
      };
      const centerWithin = (childSelector, parentSelector) => {
        const child = document.querySelector(childSelector).getBoundingClientRect();
        const parent = document.querySelector(parentSelector).getBoundingClientRect();
        return Math.abs((child.left + child.width / 2) - (parent.left + parent.width / 2));
      };
      const styles = (selector) => getComputedStyle(document.querySelector(selector));
      const buttons = [...document.querySelectorAll(".pkc-hero__actions .pkc-button")]
        .map((button) => button.getBoundingClientRect());
      return {
        brandCenter: centerWithin(".pkc-nav__logo", ".pkc-nav__brand-row"),
        brand: rect(".pkc-nav__logo"),
        navLinksCenter: centerWithin(".pkc-nav__links", ".pkc-nav__tabs"),
        brandRow: rect(".pkc-nav__brand-row"),
        navToggle: rect(".pkc-nav__toggle"),
        navToggleCenter: centerWithin(".pkc-nav__toggle", ".pkc-nav__tabs"),
        tabRow: rect(".pkc-nav__tabs"),
        navLinksDisplay: styles(".pkc-nav__links").display,
        heroCenter: centerDelta(".pkc-hero__copy"),
        descriptionCenter: centerDelta(".pkc-hero__description"),
        actionCenter: centerDelta(".pkc-hero__actions"),
        heroCopy: rect(".pkc-hero__copy"),
        heroVisual: rect(".pkc-hero__visual"),
        heroVisualDisplay: styles(".pkc-hero__visual").display,
        heroTextAlign: styles(".pkc-hero__copy").textAlign,
        actionDirection: styles(".pkc-hero__actions").flexDirection,
        actionAlign: styles(".pkc-hero__actions").alignItems,
        buttonWidths: buttons.map((box) => Math.round(box.width)),
        sectionTitleAlign: styles(".pkc-products__heading").textAlign,
        cardTextAlign: styles(".pkc-product-card__body").textAlign,
        valueTextAlign: styles(".pkc-value-card").textAlign,
        footerDirection: styles(".pkc-footer__inner").flexDirection,
        footerTextAlign: styles(".pkc-footer__inner").textAlign,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });

    const usesPcLayout = viewport.width >= 1200;
    if (usesPcLayout) {
      expect(geometry.brandCenter, `${viewport.name} centered brand`).toBeLessThanOrEqual(2);
      expect(geometry.navLinksDisplay).toBe("flex");
      expect(geometry.navLinksCenter, `${viewport.name} centered tabs`).toBeLessThanOrEqual(2);
      expect(geometry.tabRow.top).toBeGreaterThanOrEqual(geometry.brandRow.bottom - 1);
    } else if (viewport.width >= 768) {
      expect(geometry.navLinksDisplay).toBe("flex");
      expect(geometry.tabRow.top).toBeLessThanOrEqual(geometry.brandRow.top + 1);
    } else {
      expect(geometry.navLinksDisplay).toBe("none");
      expect(geometry.tabRow.top).toBeLessThanOrEqual(geometry.brandRow.top + 1);
    }

    if (usesPcLayout) {
      expect(geometry.heroVisualDisplay).toBe("flex");
      expect(geometry.heroCopy.right, `${viewport.name} copy before visual`).toBeLessThanOrEqual(geometry.heroVisual.left);
      expect(geometry.heroTextAlign).toBe("left");
      expect(geometry.actionDirection).toBe("row");
    } else {
      expect(geometry.heroCenter, `${viewport.name} hero center`).toBeLessThanOrEqual(2);
      expect(geometry.descriptionCenter, `${viewport.name} description center`).toBeLessThanOrEqual(2);
      expect(geometry.actionCenter, `${viewport.name} actions center`).toBeLessThanOrEqual(2);
      expect(geometry.heroTextAlign).toBe("center");
      expect(geometry.actionDirection).toBe("column");
      expect(geometry.actionAlign).toBe("center");
      expect(new Set(geometry.buttonWidths).size).toBe(1);
    }

    expect(geometry.sectionTitleAlign).toBe("center");
    expect(geometry.cardTextAlign).toBe("center");
    expect(geometry.valueTextAlign).toBe("center");
    expect(geometry.footerDirection).toBe("column");
    expect(geometry.footerTextAlign).toBe("center");
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  }
});

test("PC section navigation and skip link clear the fixed two-row header", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/landing.html");
  await waitForBootHandoff(page);

  const assertTargetClearsHeader = async () => {
    await page.waitForFunction(() => location.hash === "#mods");
    await page.waitForFunction(() => {
      const nav = document.querySelector(".pkc-nav")?.getBoundingClientRect();
      const target = document.querySelector("#mods")?.getBoundingClientRect();
      return nav && target && target.top >= nav.bottom + 12;
    });
    const clearance = await page.evaluate(() => {
      const nav = document.querySelector(".pkc-nav").getBoundingClientRect();
      const target = document.querySelector("#mods").getBoundingClientRect();
      return target.top - nav.bottom;
    });
    expect(clearance).toBeGreaterThanOrEqual(12);
  };

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "// MODS" }).click();
  await assertTargetClearsHeader();

  await page.goto("/landing.html");
  await waitForBootHandoff(page);
  const skip = page.locator(".pkc-skip");
  await skip.focus();
  await page.keyboard.press("Enter");
  await assertTargetClearsHeader();
});

test("landing controls expose focus and the mobile menu dismisses with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/landing.html");
  await waitForBootHandoff(page);

  const toggle = page.locator(".pkc-nav__toggle");
  await expect(toggle).toHaveAccessibleName("Open menu");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const menu = page.locator("#pkc-mobile-menu");
  const firstMenuLink = menu.getByRole("link").first();
  const lastMenuLink = menu.getByRole("link").last();
  await expect(menu).toHaveAttribute("aria-modal", "true");
  await expect(firstMenuLink).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastMenuLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstMenuLink).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  const explore = page.getByRole("link", { name: /explore mods/i });
  await explore.focus();
  const focus = await explore.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focus.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);
});

test("root onboarding action has a visible keyboard focus indicator", async ({ page }) => {
  await mockEntry(page, { ok: true, state: "public" });
  await page.goto("/");
  await waitForBootHandoff(page);
  const start = page.getByRole("link", { name: /start onboarding/i });
  await start.focus();
  const focus = await start.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focus.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);
});

test("Phase One questions use heading semantics", async ({ page }) => {
  await page.goto("/phase-one/");
  await expect(page.locator("#form > h1.sr-only")).toHaveText("PROJECTKIDCREATIONS ONBOARDING");
});

for (const phase of ["phase-two", "phase-three"]) {
  test(`${phase} missing-token state offers visible recovery routes`, async ({ page }) => {
    await page.goto(`/${phase}/`);
    await expect(page.getByRole("heading", { name: "LINK NOT RECOGNIZED" })).toBeVisible();
    await expect(page.getByRole("link", { name: /restart onboarding/i })).toHaveAttribute("href", "/phase-one/");
    await expect(page.getByRole("link", { name: /^sign in/i })).toHaveAttribute("href", "/account/login/");
    await expect(page.getByRole("link", { name: /browse projects/i })).toHaveAttribute("href", "/landing.html");
  });
}

test("footer exposes only real social destinations", async ({ page }) => {
  await page.goto("/landing.html");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "INSTAGRAM" })).toHaveCount(0);
  await expect(footer.getByRole("link", { name: "YOUTUBE" })).toHaveCount(0);
  await expect(footer.getByRole("link", { name: "TIKTOK" })).toHaveAttribute("href", "https://www.tiktok.com/@projectkidcreations");
});
