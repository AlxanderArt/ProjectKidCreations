import { expect, test } from '@playwright/test';

const waitForMotionReady = async (page) => {
  await page.waitForFunction(() => document.documentElement.classList.contains('pkc-motion-ready'));
};

const styleAttributeCount = (page) => page.locator('[style]').count();

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing.html', { waitUntil: 'domcontentloaded' });
  await waitForMotionReady(page);
});

test('universal runtime registers every control and content card without inline styles', async ({ page }) => {
  const result = await page.evaluate(() => {
    const controlSelector = 'a[href], button, input, select, textarea, summary';
    const cardSelector = 'article, [class*="card"], [class*="panel"], [class*="tile"]';
    const controls = [...document.querySelectorAll(controlSelector)];
    const cards = [...document.querySelectorAll(cardSelector)];
    return {
      controls: controls.length,
      registeredControls: controls.filter((element) => element.hasAttribute('data-pkc-control')).length,
      cards: cards.length,
      registeredCards: cards.filter((element) => element.hasAttribute('data-pkc-card')).length,
    };
  });

  expect(result.controls).toBeGreaterThan(0);
  expect(result.registeredControls).toBe(result.controls);
  expect(result.cards).toBeGreaterThan(0);
  expect(result.registeredCards).toBe(result.cards);
  expect(await styleAttributeCount(page)).toBe(0);
});

test('dynamic controls and cards inherit motion behavior and keyboard feedback', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMotionReady(page);

  await page.evaluate(() => {
    const card = document.createElement('article');
    card.id = 'dynamic-motion-card';
    const button = document.createElement('button');
    button.id = 'dynamic-motion-button';
    button.textContent = 'Dynamic control';
    card.append(button);
    document.body.append(card);
  });

  const card = page.locator('#dynamic-motion-card');
  const button = page.locator('#dynamic-motion-button');
  await expect(card).toHaveAttribute('data-pkc-card', 'ready');
  await expect(button).toHaveAttribute('data-pkc-control', 'true');

  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('data-pkc-feedback', 'active');
  await expect(button).not.toHaveAttribute('data-pkc-feedback', 'active', { timeout: 1_000 });
  expect(await styleAttributeCount(page)).toBe(0);
});

test('normal-motion dynamic cards traverse pending before their final ready state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMotionReady(page);

  const initialState = await page.evaluate(() => {
    const card = document.createElement('article');
    card.id = 'normal-motion-card';
    window.__pkcDynamicCardStates = [];
    new MutationObserver(() => window.__pkcDynamicCardStates.push(card.dataset.pkcCard ?? null))
      .observe(card, { attributes: true, attributeFilter: ['data-pkc-card'] });
    document.body.append(card);
    return card.dataset.pkcCard ?? null;
  });
  expect(initialState).toBe(null);
  await expect(page.locator('#normal-motion-card')).toHaveAttribute('data-pkc-card', 'ready', { timeout: 1_000 });
  expect(await page.evaluate(() => window.__pkcDynamicCardStates)).toEqual(['pending', 'ready']);
});

test('native motion owners, universal card roots, and nested members do not conflict', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMotionReady(page);

  await expect(page.locator('.pkc-product-card').first()).toHaveAttribute('data-pkc-card', 'native');
  await expect(page.locator('.pkc-product-card__title').first()).toHaveAttribute('data-pkc-card', 'member');
  await expect(page.locator('.pkc-showcase__item').first()).toHaveAttribute('data-pkc-card', 'ready');
});

test('typing keys do not trigger universal control feedback', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMotionReady(page);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'motion-text-input';
    document.body.append(input);
  });
  const input = page.locator('#motion-text-input');
  await input.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(input).not.toHaveAttribute('data-pkc-feedback', 'active');
});

test('programmatic route exits collapse duplicate navigation attempts', async ({ page }) => {
  const result = await page.evaluate(() => {
    let leaves = 0;
    window.addEventListener('pkc:route-leave', () => { leaves += 1; });
    const first = window.PKCMotion.navigate('/account/login/', { replace: true, reason: 'test' });
    const second = window.PKCMotion.navigate('/phase-one/', { reason: 'duplicate' });
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return { first, second, leaves };
  });
  expect(result).toEqual({ first: true, second: true, leaves: 1 });
});

test('repeated BFCache cycles rehydrate dynamic registration without duplication', async ({ page }) => {
  await page.evaluate(() => {
    for (let index = 0; index < 3; index += 1) {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }
    const button = document.createElement('button');
    button.id = 'post-bfcache-control';
    button.textContent = 'After BFCache';
    document.body.append(button);
  });
  await expect(page.locator('#post-bfcache-control')).toHaveAttribute('data-pkc-control', 'true');
});

test('every shipped page registers all present controls and cards without inline styles', async ({ page }) => {
  test.setTimeout(90_000);
  const routes = [
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

  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await waitForMotionReady(page);
    const coverage = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('a[href], button, input, select, textarea, summary')];
      const cards = [...document.querySelectorAll('article, [class*="card"], [class*="panel"], [class*="tile"]')];
      return {
        missingControls: controls.filter((element) => !element.hasAttribute('data-pkc-control')).length,
        missingCards: cards.filter((element) => !element.hasAttribute('data-pkc-card')).length,
        inlineStyles: document.querySelectorAll('[style]').length,
      };
    });
    expect(coverage, route).toEqual({ missingControls: 0, missingCards: 0, inlineStyles: 0 });
  }
});

test('navigation exclusions stay native while eligible same-origin links enter leaving state', async ({ page }) => {
  const states = await page.evaluate(() => {
    const make = (id, href, extra = {}) => {
      const link = document.createElement('a');
      link.id = id;
      link.href = href;
      link.textContent = id;
      Object.assign(link, extra);
      document.body.append(link);
      return link;
    };
    const hash = make('motion-hash', '#motion-target');
    const external = make('motion-external', 'https://example.com/');
    const blank = make('motion-blank', '/account/login/', { target: '_blank' });
    const download = make('motion-download', '/assets/og/landing.png');
    download.setAttribute('download', 'landing.png');
    const eligible = make('motion-eligible', '/account/login/');

    const click = (element, options = {}) => {
      element.addEventListener('click', (event) => event.preventDefault(), { once: true });
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options }));
      return document.documentElement.dataset.pkcRouteState ?? null;
    };

    const result = {
      hash: click(hash),
      external: click(external),
      blank: click(blank),
      download: click(download),
      modified: click(eligible, { ctrlKey: true }),
    };
    delete document.documentElement.dataset.pkcRouteState;
    eligible.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    result.eligible = document.documentElement.dataset.pkcRouteState ?? null;
    return result;
  });

  expect(states).toEqual({
    hash: null,
    external: null,
    blank: null,
    download: null,
    modified: null,
    eligible: 'leaving',
  });
  expect(await styleAttributeCount(page)).toBe(0);
});

test('persisted lifecycle restores the ready state and clears transient interaction state', async ({ page }) => {
  await page.evaluate(() => {
    document.documentElement.dataset.pkcRouteState = 'leaving';
    const button = document.querySelector('[data-pkc-control]');
    button.dataset.pkcFeedback = 'active';
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });

  await expect(page.locator('html')).not.toHaveAttribute('data-pkc-route-state', 'leaving');
  expect(await page.locator('[data-pkc-feedback="active"]').count()).toBe(0);
  await expect(page.locator('html')).toHaveClass(/pkc-motion-ready/);
});
