/* ProjectKidCreations — account/motion-soft.js
 * Shared motion module for the SOFT sub-theme (Phase 4 / /account/*).
 *
 * Tiny vanilla wrapper around the Web Animations API (Element.animate).
 * No GSAP dependency for the T1 canary — keep the page lean, add GSAP
 * later only if a transition actually needs spring physics.
 *
 * Public API:
 *   enterPage(rootEl)  → Promise<void>   stagger entrance: eyebrow → headline → body → CTA
 *   exitPage(rootEl)   → Promise<void>   reverse stagger, faster
 *   settle(panelEl)    → void            hover lift + shadow expand (idempotent)
 *   breath(idleHintEl) → () => void      ambient 1.5s sine pulse; returns a cancel fn
 *
 * Honors prefers-reduced-motion: under that flag enter/exit complete
 * instantly, settle is a no-op, and breath emits a single immediate
 * tick with no oscillation. Cached at module load — one matchMedia read,
 * not one per call.
 *
 * The whole point of this module: every soft-theme page uses the SAME
 * choreography. Future passes (T2 bootstrap/forgot/reset, T3 SPA, T4
 * admin) import these same four functions. If the motion feels wrong,
 * we tune it here once.
 */

/* ── Reduced-motion check (cached) ─────────────────────────────── */
const RM = (() => {
  try {
    return typeof window !== "undefined"
      && window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
})();

/* Tokens — kept in sync with the soft-theme CSS block. JS can't read
 * computed CSS custom properties off :root reliably across all browsers
 * for keyframe values, so we mirror the durations/easings here. If the
 * CSS changes, change these too. */
const EASE_SOFT      = "cubic-bezier(0.2, 0.6, 0.2, 1)";
const DUR_SNAP_MS    = 240;
const DUR_FLOW_MS    = 480;
const DUR_BREATHE_MS = 1500;

/* The selectors a soft-theme page section uses for its staggered
 * entrance. Order matches the visual hierarchy: eyebrow → headline →
 * body copy → CTA / form. Missing elements are skipped silently. */
const STAGGER_SELECTORS = [
  ".step-label",
  ".prompt",
  ".momentum, .idle-hint, .confirm-line",
  ".account-form, .cta, .retry-row, .lock-countdown"
];

/* ── enterPage ─────────────────────────────────────────────────── */
export function enterPage(rootEl) {
  if (!rootEl) return Promise.resolve();
  if (RM) return Promise.resolve();

  const groups = STAGGER_SELECTORS.map((sel) =>
    Array.from(rootEl.querySelectorAll(sel))
  ).filter((g) => g.length > 0);

  if (groups.length === 0) return Promise.resolve();

  const stepGap = 60;
  const finals = [];

  groups.forEach((group, i) => {
    const delay = i * stepGap;
    group.forEach((el) => {
      const anim = el.animate(
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "translateY(0)" }
        ],
        { duration: DUR_SNAP_MS, easing: EASE_SOFT, delay, fill: "backwards" }
      );
      finals.push(anim.finished.catch(() => {}));
    });
  });

  return Promise.all(finals).then(() => {});
}

/* ── exitPage ──────────────────────────────────────────────────── */
export function exitPage(rootEl) {
  if (!rootEl) return Promise.resolve();
  if (RM) return Promise.resolve();

  // Reverse order, faster (180ms each) so the page feels like it's
  // exhaling out before the next one inhales in.
  const groups = STAGGER_SELECTORS
    .slice()
    .reverse()
    .map((sel) => Array.from(rootEl.querySelectorAll(sel)))
    .filter((g) => g.length > 0);

  if (groups.length === 0) return Promise.resolve();

  const stepGap = 40;
  const dur = 180;
  const finals = [];

  groups.forEach((group, i) => {
    const delay = i * stepGap;
    group.forEach((el) => {
      const anim = el.animate(
        [
          { opacity: 1, transform: "translateY(0)" },
          { opacity: 0, transform: "translateY(-4px)" }
        ],
        { duration: dur, easing: EASE_SOFT, delay, fill: "forwards" }
      );
      finals.push(anim.finished.catch(() => {}));
    });
  });

  return Promise.all(finals).then(() => {});
}

/* ── settle ────────────────────────────────────────────────────── *
 * Hover-lift affordance. Attaches pointer listeners once; safe to
 * call repeatedly on the same element (idempotent via a flag). */
export function settle(panelEl) {
  if (!panelEl || RM) return;
  if (panelEl.__pkcSoftSettled) return;
  panelEl.__pkcSoftSettled = true;

  const enter = () => {
    panelEl.animate(
      [
        { transform: "translateY(0)", boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
        { transform: "translateY(-2px)", boxShadow: "0 4px 16px rgba(255,95,31,0.06)" }
      ],
      { duration: DUR_SNAP_MS, easing: EASE_SOFT, fill: "forwards" }
    );
  };
  const leave = () => {
    panelEl.animate(
      [
        { transform: "translateY(-2px)", boxShadow: "0 4px 16px rgba(255,95,31,0.06)" },
        { transform: "translateY(0)", boxShadow: "0 2px 8px rgba(0,0,0,0.15)" }
      ],
      { duration: DUR_SNAP_MS, easing: EASE_SOFT, fill: "forwards" }
    );
  };
  panelEl.addEventListener("pointerenter", enter);
  panelEl.addEventListener("pointerleave", leave);
  panelEl.addEventListener("focusin", enter);
  panelEl.addEventListener("focusout", leave);
}

/* ── breath ────────────────────────────────────────────────────── *
 * Ambient 1.5s sine pulse on a loading hint. Returns a cancel fn
 * that the caller invokes when transitioning out of the loading
 * state. Under reduced motion this is a no-op + identity cancel. */
export function breath(idleHintEl) {
  if (!idleHintEl) return () => {};
  if (RM) return () => {};

  const anim = idleHintEl.animate(
    [
      { transform: "scale(1)",    opacity: 0.85 },
      { transform: "scale(1.02)", opacity: 1    },
      { transform: "scale(0.98)", opacity: 0.7  },
      { transform: "scale(1)",    opacity: 0.85 }
    ],
    { duration: DUR_BREATHE_MS, easing: EASE_SOFT, iterations: Infinity }
  );

  return () => {
    try { anim.cancel(); } catch (_) { /* element unmounted */ }
  };
}
