import { gsap } from 'gsap';

const root = document.documentElement;
root.classList.add('pkc-boot-pending', 'pkc-motion-prep');

const BOOT = Object.freeze({
  normal: Object.freeze({ exitMs: 4380, removeMs: 5000, cadenceMs: 625 }),
  reduced: Object.freeze({ exitMs: 950, removeMs: 1570, cadenceMs: 135 }),
  frameReadyMs: 220,
  frameFallbackMs: 1200,
});

const STEPS = Object.freeze([
  'Establishing PKC link',
  'Loading ProjectKidCreations assets',
  'Loading onboarding schema',
  'Compiling launch routing',
  'Restoring secure session',
  'Calibrating project experience',
  'Ready',
]);

const timerIds = [];
const schedule = (delayMs, callback) => {
  const timer = window.setTimeout(callback, delayMs);
  timerIds.push(timer);
  return timer;
};

const INTERACTION = Object.freeze({
  controlMs: 180,
  cardStaggerMs: 70,
  routeMs: 420,
  controlSelector: 'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])',
  cardSelector: 'article, section[data-question], #end-section, .state, .section, .review-row, .session-row, .timeline-row, .full-state, .chat-message, .pkc-showcase__item, .pkc-social__quote, .pkc-social__stat, .pkc-spec-strip__item, [class*="card"], [class*="panel"], [class*="tile"]',
  nativeCardSelector: '.pkc-product-card, .pkc-value-card, .pkc-social__quote, section[data-question], #end-section, .state, .section, .tabpanel',
  universalCardSelector: 'article, .panel, .sec-card, .notif-card, .pulse-card, .accounts-panel, .chat-panel, .radio-card, .review-row, .session-row, .timeline-row, .full-state, .chat-message, .pkc-showcase__item, .pkc-social__stat, .pkc-spec-strip__item',
  controlAttribute: 'data-pkc-control',
  cardAttribute: 'data-pkc-card',
  routeAttribute: 'data-pkc-route-state',
});

const beginInteractionMotion = () => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const delayedCalls = new Set();
  const controlCalls = new WeakMap();
  let motionReady = root.classList.contains('pkc-motion-ready');
  let observing = false;
  let routePending = false;

  const later = (delayMs, callback) => {
    let call;
    call = gsap.delayedCall(delayMs / 1000, () => {
      delayedCalls.delete(call);
      callback();
    });
    delayedCalls.add(call);
    return call;
  };

  const controlsIn = (scope) => {
    const controls = [];
    if (scope instanceof Element && scope.matches(INTERACTION.controlSelector)) controls.push(scope);
    if (scope.querySelectorAll) controls.push(...scope.querySelectorAll(INTERACTION.controlSelector));
    return controls;
  };

  const cardsIn = (scope) => {
    const cards = [];
    if (scope instanceof Element && scope.matches(INTERACTION.cardSelector)) cards.push(scope);
    if (scope.querySelectorAll) cards.push(...scope.querySelectorAll(INTERACTION.cardSelector));
    return cards;
  };

  const revealCards = (cards) => {
    cards.filter((card) => card.dataset.pkcCard === 'pending').forEach((card, index) => {
      const reveal = () => { card.dataset.pkcCard = 'ready'; };
      if (reduced) reveal();
      else later((index % 8) * INTERACTION.cardStaggerMs, reveal);
    });
  };

  const registerTree = (scope) => {
    controlsIn(scope).forEach((control) => { control.dataset.pkcControl = 'true'; });
    const freshCards = cardsIn(scope).filter((card) => !card.hasAttribute(INTERACTION.cardAttribute));
    freshCards.forEach((card) => {
      if (card.matches(INTERACTION.nativeCardSelector)) {
        card.dataset.pkcCard = 'native';
        return;
      }
      if (!card.matches(INTERACTION.universalCardSelector) && card.parentElement?.closest(INTERACTION.cardSelector)) {
        card.dataset.pkcCard = 'member';
        return;
      }
      card.dataset.pkcCard = reduced ? 'ready' : 'pending';
    });
    if (motionReady) revealCards(freshCards);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) registerTree(node);
      }
    }
  });

  const findControl = (target) => target instanceof Element
    ? target.closest(INTERACTION.controlSelector)
    : null;
  const isDisabled = (control) => control.matches(':disabled, [aria-disabled="true"]') || Boolean(control.closest('[inert]'));
  const acceptsKeyboardFeedback = (control, key) => {
    if (control.matches('a[href]')) return key === 'Enter';
    if (control.matches('button, summary, [role="button"], [role="tab"]')) return key === 'Enter' || key === ' ';
    if (control.matches('input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"]')) {
      return key === 'Enter' || key === ' ';
    }
    return false;
  };

  const activateControl = (control) => {
    if (!control || isDisabled(control)) return;
    control.dataset.pkcFeedback = 'active';
    const previous = controlCalls.get(control);
    if (previous) {
      previous.kill();
      delayedCalls.delete(previous);
    }
    const call = later(reduced ? 0 : INTERACTION.controlMs, () => {
      delete control.dataset.pkcFeedback;
      controlCalls.delete(control);
    });
    controlCalls.set(control, call);
  };

  const onPointerDown = (event) => activateControl(findControl(event.target));
  const onKeyDown = (event) => {
    const control = findControl(event.target);
    if (!control || !acceptsKeyboardFeedback(control, event.key)) return;
    activateControl(control);
  };

  const eligibleNavigation = (event, anchor) => {
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    if (anchor.hasAttribute('download') || anchor.dataset.pkcRoute === 'native') return null;
    const target = anchor.getAttribute('target');
    if (target && target.toLowerCase() !== '_self') return null;
    const destination = new URL(anchor.href, window.location.href);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.origin !== window.location.origin) return null;
    const current = new URL(window.location.href);
    if (destination.pathname === current.pathname && destination.search === current.search) return null;
    return destination;
  };

  const navigate = (href, options = {}) => {
    if (routePending) return true;
    const destination = new URL(href, window.location.href);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.origin !== window.location.origin) return false;
    routePending = true;
    root.dataset.pkcRouteState = 'leaving';
    window.dispatchEvent(new CustomEvent('pkc:route-leave', {
      detail: { href: destination.href, reason: options.reason ?? 'navigation', replace: options.replace === true },
    }));
    later(reduced || !motionReady ? 16 : INTERACTION.routeMs, () => {
      if (options.replace === true) window.location.replace(destination.href);
      else window.location.assign(destination.href);
    });
    return true;
  };

  window.PKCMotion = Object.freeze({ navigate });

  const onClick = (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const destination = eligibleNavigation(event, anchor);
    if (!destination) return;
    event.preventDefault();
    navigate(destination.href, { reason: 'link' });
  };

  const restoreInteractionState = () => {
    delete root.dataset.pkcRouteState;
    document.querySelectorAll('[data-pkc-feedback="active"]').forEach((control) => {
      delete control.dataset.pkcFeedback;
    });
    document.querySelectorAll('[data-pkc-card="pending"]').forEach((card) => {
      card.dataset.pkcCard = 'ready';
    });
  };

  const onMotionReady = () => {
    motionReady = true;
    revealCards([...document.querySelectorAll('[data-pkc-card="pending"]')]);
  };
  const onPageShow = (event) => {
    if (!event.persisted) return;
    motionReady = true;
    restoreInteractionState();
    registerTree(document);
    if (!observing) {
      observer.observe(document.body, { childList: true, subtree: true });
      observing = true;
    }
  };
  const onPageHide = () => {
    delayedCalls.forEach((call) => call.kill());
    delayedCalls.clear();
    observer.disconnect();
    observing = false;
    routePending = false;
    restoreInteractionState();
  };

  registerTree(document);
  observer.observe(document.body, { childList: true, subtree: true });
  observing = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick);
  window.addEventListener('pkc:motion-ready', onMotionReady);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
};

const revealPage = (reduced) => {
  let motionSettled = false;
  let failVisibleTimer = null;
  const markMotionReady = (reason = 'timeline') => {
    if (motionSettled) return;
    motionSettled = true;
    if (failVisibleTimer !== null) window.clearTimeout(failVisibleTimer);
    root.classList.remove('pkc-motion-prep', 'pkc-motion-shell', 'pkc-motion-navigation', 'pkc-motion-content');
    root.classList.add('pkc-motion-ready');
    root.dataset.pkcMotionReady = reason;
    window.dispatchEvent(new CustomEvent('pkc:motion-ready', { detail: { reason } }));
  };
  if (reduced) {
    markMotionReady('reduced');
    return;
  }
  failVisibleTimer = window.setTimeout(() => markMotionReady('fail-visible'), 1_500);
  gsap.timeline({ defaults: { ease: 'power3.out' } })
    .call(() => root.classList.add('pkc-motion-shell'), [], 0)
    .call(() => root.classList.add('pkc-motion-navigation'), [], 0.1)
    .call(() => root.classList.add('pkc-motion-content'), [], 0.2)
    .call(() => markMotionReady('timeline'), [], 0.6);
  return markMotionReady;
};

const beginBoot = () => {
  const bootStartedAt = performance.now();
  const host = document.getElementById('pkc-boot');
  if (!host) {
    root.classList.remove('pkc-boot-pending', 'pkc-motion-prep');
    root.classList.add('pkc-boot-ready', 'pkc-motion-ready');
    window.dispatchEvent(new CustomEvent('pkc:boot-complete'));
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timing = reduced ? BOOT.reduced : BOOT.normal;
  const frame = host.querySelector('.pkc-boot__globe');
  const status = host.querySelector('.pkc-boot__status');
  const inerted = [];
  let finished = false;
  let frameReady = false;
  let frameTelemetry = null;
  let readyDispatched = false;
  let settlePageMotion = null;

  for (const sibling of [...document.body.children]) {
    if (sibling === host || sibling.tagName === 'SCRIPT') continue;
    inerted.push({ element: sibling, wasInert: sibling.inert });
    sibling.inert = true;
  }

  const setFrameReady = (reason) => {
    if (frameReady || finished) return;
    frameReady = true;
    host.dataset.frameReady = reason;
  };

  const onMessage = (event) => {
    if (event.origin !== window.location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type === 'pkc:boot-globe-ready') {
      frameTelemetry = {
        assemble: Number(event.data.assemble),
        running: event.data.rendererRunning === true,
      };
      setFrameReady('renderer');
    }
  };
  window.addEventListener('message', onMessage);

  if (frame) {
    frame.addEventListener('load', () => schedule(BOOT.frameReadyMs, () => setFrameReady('load')), { once: true });
  }
  schedule(BOOT.frameFallbackMs, () => setFrameReady('fallback'));

  STEPS.forEach((label, index) => {
    schedule(index * timing.cadenceMs, () => {
      if (finished) return;
      host.dataset.step = String(index);
      if (status) status.textContent = label;
    });
  });

  const signalReady = (reason = 'timer') => {
    if (readyDispatched) return;
    readyDispatched = true;
    host.dataset.exiting = 'true';
    host.dataset.bootReady = reduced ? 'reduced' : 'true';
    root.classList.add('pkc-boot-ready');
    document.body.dataset.pkcBoot = reduced ? 'reduced' : 'ready';
    window.dispatchEvent(new CustomEvent('pkc:boot-ready', {
      detail: {
        reduced,
        exitMs: timing.exitMs,
        removeMs: timing.removeMs,
        elapsedMs: Math.round(performance.now() - bootStartedAt),
        frameTelemetry,
        reason,
      },
    }));
    settlePageMotion = revealPage(reduced);
  };

  const onPageHide = (event) => {
    timerIds.forEach((timer) => window.clearTimeout(timer));
    window.removeEventListener('message', onMessage);
    if (event.persisted) complete('bfcache-pagehide');
  };
  const onPageShow = (event) => {
    if (event.persisted && !finished) complete('bfcache-pageshow');
  };

  const complete = (reason = 'timer') => {
    if (finished) return;
    signalReady(reason);
    finished = true;
    timerIds.forEach((timer) => window.clearTimeout(timer));
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    inerted.forEach(({ element, wasInert }) => { element.inert = wasInert; });
    host.remove();
    settlePageMotion?.('boot-complete-fail-visible');
    root.classList.remove('pkc-boot-pending');
    root.classList.add('pkc-boot-ready');
    window.dispatchEvent(new CustomEvent('pkc:boot-complete', {
      detail: { reduced, removeMs: timing.removeMs, reason },
    }));
  };

  schedule(timing.exitMs, signalReady);
  schedule(timing.removeMs, complete);

  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
};

const start = () => {
  beginInteractionMotion();
  beginBoot();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
