import { expect, test } from '@playwright/test';

const cspErrors = (page) => {
  const errors = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/content security policy|refused to (?:execute|apply|frame|load).*policy/i.test(text)) errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__pkcBootEvents = [];
    window.__pkcBootCompleteEvents = [];
    window.addEventListener('pkc:boot-ready', (event) => {
      window.__pkcBootEvents.push({ at: performance.now(), detail: event.detail });
    });
    window.addEventListener('pkc:boot-complete', (event) => {
      if (typeof event.detail?.reduced === 'boolean') {
        window.__pkcBootCompleteEvents.push({ at: performance.now(), detail: event.detail });
      }
    });
  });
});

test('normal boot owns the viewport, loads the native globe, then removes cleanly', async ({ page }) => {
  const errors = cspErrors(page);
  await page.goto('/landing.html?entry=browse', { waitUntil: 'domcontentloaded' });

  const boot = page.locator('#pkc-boot');
  await expect(boot).toBeVisible();
  await page.evaluate(() => {
    const host = document.getElementById('pkc-boot');
    window.__pkcStepHistory = [host?.dataset.step];
    new MutationObserver(() => window.__pkcStepHistory.push(host?.dataset.step))
      .observe(host, { attributes: true, attributeFilter: ['data-step'] });
  });
  await expect(boot).toHaveAttribute('role', 'status');
  await expect(boot).toHaveAttribute('aria-live', 'polite');

  const overlayPresentation = await page.locator('.pkc-boot__chrome').evaluate((element) => {
    const style = getComputedStyle(element);
    const track = element.querySelector('.pkc-boot__track');
    const bounds = element.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      borderLeftWidth: style.borderLeftWidth,
      boxShadow: style.boxShadow,
      backdropFilter: style.backdropFilter,
      padding: style.padding,
      textAlign: style.textAlign,
      trackDisplay: track ? getComputedStyle(track).display : null,
      centerDelta: Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2),
    };
  });
  expect(overlayPresentation).toMatchObject({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopWidth: '0px',
    borderLeftWidth: '0px',
    boxShadow: 'none',
    backdropFilter: 'none',
    padding: '0px',
    textAlign: 'center',
    trackDisplay: 'block',
  });
  expect(overlayPresentation.centerDelta).toBeLessThanOrEqual(1);
  await expect(page.locator('.pkc-boot__meta')).toBeVisible();
  await expect(page.locator('.pkc-boot__status')).toBeVisible();
  await expect(boot).toHaveAttribute('data-frame-ready', /renderer|load|fallback/, { timeout: 2_000 });

  const frameElement = page.locator('.pkc-boot__globe');
  const frameBox = await frameElement.boundingBox();
  const viewport = page.viewportSize();
  expect(frameBox.x).toBe(0);
  expect(frameBox.y).toBe(0);
  expect(frameBox.width).toBe(viewport.width);
  expect(frameBox.height).toBe(viewport.height);

  const frame = page.frameLocator('.pkc-boot__globe');
  await expect(frame.locator('#pkc-globe-canvas')).toBeVisible();
  await expect(frame.locator('html')).toHaveAttribute('data-pkc-globe-ready', 'true');
  await expect.poll(() => frame.locator('html').evaluate(() => window.__pkcBootProbe?.clock ?? 0)).toBeGreaterThan(0.1);
  await expect.poll(() => frame.locator('html').evaluate(() => window.__pkcBootProbe?.radius ?? 0)).toBeGreaterThan(0);

  await expect.poll(() => frame.locator('html').evaluate(() => window.__pkcBootProbe?.assemble ?? 0), { timeout: 5_500 }).toBe(1);
  await expect(boot).not.toHaveAttribute('data-exiting', 'true');
  await expect.poll(() => frame.locator('html').evaluate(() => window.__pkcBootProbe?.running ?? false)).toBe(true);

  await expect.poll(() => page.evaluate(() => window.__pkcBootEvents.length), { timeout: 9_000 }).toBe(1);
  await expect(boot).toHaveCount(0, { timeout: 3_000 });
  expect(await page.evaluate(() => window.__pkcStepHistory)).toContain('6');
  await expect(page.locator('html')).toHaveClass(/pkc-boot-ready/);
  await expect.poll(() => page.evaluate(() => window.__pkcBootEvents)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__pkcBootCompleteEvents)).toHaveLength(1);

  const event = await page.evaluate(() => window.__pkcBootEvents[0]);
  expect(event.detail).toMatchObject({ reduced: false, exitMs: 6380, removeMs: 7000 });
  expect(event.detail.assembledAtMs).toBeGreaterThanOrEqual(4_300);
  expect(event.detail.elapsedMs - event.detail.assembledAtMs).toBeGreaterThanOrEqual(1_950);
  expect(event.detail.elapsedMs).toBeGreaterThanOrEqual(6_300);
  expect(event.detail.reason).toBe('assembled-hold');
  const completeEvent = await page.evaluate(() => window.__pkcBootCompleteEvents[0]);
  expect(completeEvent.detail.readyAtMs).toBe(event.detail.elapsedMs);
  expect(completeEvent.detail.elapsedMs - completeEvent.detail.readyAtMs).toBeGreaterThanOrEqual(600);
  expect(completeEvent.detail.elapsedMs - event.detail.assembledAtMs).toBeGreaterThanOrEqual(2_570);
  expect(errors).toEqual([]);
});

test('the page fails visible when animation frames are suspended', async ({ page }) => {
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });

  await page.goto('/landing.html?entry=browse', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#pkc-boot')).toHaveCount(0, { timeout: 8_500 });
  await expect(page.locator('html')).toHaveClass(/pkc-motion-ready/, { timeout: 2_000 });
  await expect(page.locator('html')).not.toHaveClass(/pkc-motion-prep/);

  await expect.poll(() => page.evaluate(() => {
    const appRoot = document.querySelector('#root');
    const actions = document.querySelector('.pkc-hero__actions');
    const rootStyle = getComputedStyle(appRoot);
    const actionStyle = getComputedStyle(actions);
    return {
      rootOpacity: rootStyle.opacity,
      rootFilter: rootStyle.filter,
      actionOpacity: actionStyle.opacity,
    };
  }), { timeout: 2_000 }).toEqual({
    rootOpacity: '1',
    rootFilter: 'none',
    actionOpacity: '1',
  });
});

test('reduced motion reaches the same ready state on the bounded path', async ({ page }) => {
  const errors = cspErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/account/login/', { waitUntil: 'domcontentloaded' });

  const boot = page.locator('#pkc-boot');
  await expect(boot).toBeVisible();
  await expect(boot).toHaveCount(0, { timeout: 3_000 });

  const event = await page.evaluate(() => window.__pkcBootEvents[0]);
  const completeEvent = await page.evaluate(() => window.__pkcBootCompleteEvents[0]);
  expect(await page.evaluate(() => window.__pkcBootEvents.length)).toBe(1);
  expect(await page.evaluate(() => window.__pkcBootCompleteEvents.length)).toBe(1);
  expect(event.detail).toMatchObject({
    reduced: true,
    exitMs: 950,
    removeMs: 1570,
    frameTelemetry: { assemble: 1, running: false },
  });
  expect(event.detail.elapsedMs).toBeGreaterThanOrEqual(900);
  expect(event.detail.elapsedMs - event.detail.exitMs).toBeLessThan(400);
  expect(completeEvent.detail).toMatchObject({ reduced: true, removeMs: 1570 });
  expect(completeEvent.detail.elapsedMs).toBeGreaterThanOrEqual(1_500);
  expect(completeEvent.detail.elapsedMs).toBeLessThan(2_500);
  expect(await page.locator('body').getAttribute('data-pkc-boot')).toBe('reduced');
  expect(errors).toEqual([]);
});

test('boot inerting prevents hidden-page focus and restores focusability after removal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing.html?entry=browse', { waitUntil: 'domcontentloaded' });

  const focusWhileInert = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const target = document.createElement('button');
    target.id = 'pkc-inert-focus-probe';
    target.textContent = 'Focus probe';
    root.append(target);
    target.focus();
    return document.activeElement === target;
  });
  expect(focusWhileInert).toBe(false);
  await expect(page.locator('#pkc-boot')).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  const focusAfterRemoval = await page.evaluate(() => {
    const target = document.createElement('button');
    target.id = 'pkc-restored-focus-probe';
    target.textContent = 'Restored focus probe';
    document.body.append(target);
    target.focus();
    return document.activeElement === target;
  });
  expect(focusAfterRemoval).toBe(true);
});

test('every configured launch entry exposes an executable boot host', async ({ page }) => {
  const entries = [
    '/',
    '/landing.html',
    '/phase-one/',
    '/phase-two/',
    '/phase-three/',
    '/account/',
    '/account/admin/',
    '/account/bootstrap/',
    '/account/forgot/',
    '/account/reset/',
    '/account/login/',
  ];

  await page.goto('/landing.html?entry=browse', { waitUntil: 'domcontentloaded' });
  const results = await page.evaluate(async (paths) => {
    const checks = [];
    for (const entry of paths) {
      const response = await fetch(entry);
      const html = await response.text();
      const documentCopy = new DOMParser().parseFromString(html, 'text/html');
      checks.push({
        entry,
        status: response.status,
        bootHosts: documentCopy.querySelectorAll('#pkc-boot').length,
        bootRuntimes: documentCopy.querySelectorAll('script[src="/dist/pkc-motion.js"]').length,
      });
    }
    return checks;
  }, entries);

  for (const result of results) {
    expect(result.status, `${result.entry}: HTTP status`).toBe(200);
    expect(result.bootHosts, `${result.entry}: boot host`).toBe(1);
    expect(result.bootRuntimes, `${result.entry}: boot runtime`).toBe(1);
  }
});

test('persisted page transitions cannot strand the overlay or inert content', async ({ page }) => {
  await page.goto('/landing.html?entry=browse', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#pkc-boot')).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });

  await expect(page.locator('#pkc-boot')).toHaveCount(0);
  await expect(page.locator('html')).toHaveClass(/pkc-boot-ready/);
  const stranded = await page.evaluate(() => [...document.body.children]
    .filter((element) => element.tagName !== 'SCRIPT')
    .some((element) => element.inert));
  expect(stranded).toBe(false);
});

test('low-frame-rate WebKit timing reaches the globe before parent exit', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'WebKit-specific low-frame-rate regression');
  await page.addInitScript(() => {
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const timers = new Map();
    let nextId = 1;
    window.requestAnimationFrame = (callback) => {
      const id = nextId++;
      const timer = window.setTimeout(() => {
        timers.delete(id);
        callback(performance.now());
      }, 250);
      timers.set(id, timer);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const timer = timers.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(id);
      } else {
        nativeCancel(id);
      }
    };
  });

  await page.goto('/landing.html?entry=browse', { waitUntil: 'domcontentloaded' });
  const frame = page.frameLocator('.pkc-boot__globe');
  await expect(frame.locator('#pkc-globe-canvas')).toBeVisible();
  await page.waitForTimeout(3_800);
  const probe = await frame.locator('html').evaluate(() => ({
    clock: window.__pkcBootProbe?.clock ?? 0,
    assemble: window.__pkcBootProbe?.assemble ?? 0,
  }));
  expect(probe.assemble).toBeGreaterThan(0.25);
});
