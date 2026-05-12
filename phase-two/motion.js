/* ProjectKidCreations — phase-two/motion.js
 * GSAP-driven loading + state-change choreography.
 *
 * Hooks into the existing setState() data-active flips (no app.js refactor).
 * Replaces the simple CSS pop + scan-line reveal with a richer multi-element
 * stagger and triggers the verified-state accent swap (orange → neon green)
 * the moment the SUCCESS state activates.
 *
 * Graceful fallbacks:
 *   - GSAP CDN didn't load → CSS keyframes do the job
 *   - prefers-reduced-motion → suppresses GSAP, CSS handles minimal version
 */

(function () {
  "use strict";

  const gsap = window.gsap;
  if (!gsap) return;

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (REDUCED) return;

  const ENTER_EASE = "power3.out";
  const STAGGER = 0.045;

  // ──────────────────────────────────────────────
  // Defuse the CSS @keyframe entry so GSAP owns the timing
  // ──────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .state[data-active="true"] { animation: none !important; opacity: 1; }
    .gsap-managed { opacity: 0; }
  `;
  document.head.appendChild(style);

  // ──────────────────────────────────────────────
  // Entrance choreography for any .state element
  // ──────────────────────────────────────────────
  function enterState(stateEl) {
    if (!stateEl) return;
    gsap.set(stateEl, { opacity: 1 });

    const stepLabel = stateEl.querySelector(".step-label");
    const prompt = stateEl.querySelector(".prompt, h1");
    const bodyLines = stateEl.querySelectorAll(
      ":scope > .confirm-line, :scope > .momentum, :scope > .idle-hint, :scope > .kill-line, :scope > .kill-meta"
    );
    const formFields = stateEl.querySelectorAll(":scope form > *");
    const cta = stateEl.querySelectorAll(".cta");

    const tl = gsap.timeline({ defaults: { ease: ENTER_EASE } });

    if (stepLabel) tl.fromTo(stepLabel, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28 }, 0);
    if (prompt)    tl.fromTo(prompt,    { y: 16, opacity: 0, scale: 0.985 }, { y: 0, opacity: 1, scale: 1, duration: 0.44 }, 0.06);
    if (bodyLines.length) tl.fromTo(bodyLines, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, stagger: STAGGER }, 0.20);
    if (formFields.length) tl.fromTo(formFields, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.36, stagger: STAGGER * 1.2 }, 0.24);
    if (cta.length) tl.fromTo(cta, { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32 }, 0.40);

    return tl;
  }

  // ──────────────────────────────────────────────
  // Loading state: gentler GSAP pulse on the idle-hint
  // ──────────────────────────────────────────────
  function enhanceLoader(stateEl) {
    const hint = stateEl.querySelector(".idle-hint");
    if (!hint) return;
    gsap.fromTo(hint, { opacity: 0.4 }, { opacity: 1, duration: 0.9, repeat: -1, yoyo: true, ease: "sine.inOut" });
  }

  // ──────────────────────────────────────────────
  // VERIFIED swap: flip body[data-verified] when SUCCESS lands
  // Triggers the CSS variable rebind (--pkc-accent → neon green)
  // and the cinematic 480ms color cross-fade on every accent element.
  // ──────────────────────────────────────────────
  function activateVerified(stateEl) {
    // Brief beat so the SUCCESS entry choreography reads first
    gsap.delayedCall(0.45, () => {
      document.body.dataset.verified = "true";
      // Optional flourish: pulse the prompt heading once with the new color
      const prompt = stateEl.querySelector(".prompt");
      if (prompt) {
        gsap.fromTo(
          prompt,
          { filter: "brightness(1)" },
          { filter: "brightness(1.25)", duration: 0.32, yoyo: true, repeat: 1, ease: "sine.inOut" }
        );
      }
    });
  }

  function deactivateVerified() {
    delete document.body.dataset.verified;
  }

  // ──────────────────────────────────────────────
  // Observe state activation
  // ──────────────────────────────────────────────
  const stage = document.querySelector("#stage");
  if (!stage) return;

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName !== "data-active") continue;
      const el = r.target;
      if (!el.classList || !el.classList.contains("state")) continue;
      const active = el.getAttribute("data-active") === "true";
      const name = el.getAttribute("data-state");

      if (!active) {
        if (name === "SUCCESS" || name === "ALREADY_DONE") deactivateVerified();
        continue;
      }

      enterState(el);
      if (name === "LOADING" || name === "SUBMITTING") enhanceLoader(el);
      if (name === "SUCCESS" || name === "ALREADY_DONE") activateVerified(el);
    }
  });

  stage.querySelectorAll(".state").forEach((el) =>
    observer.observe(el, { attributes: true, attributeFilter: ["data-active"] })
  );

  // First paint: animate whatever's already active
  const initial = stage.querySelector('.state[data-active="true"]');
  if (initial) {
    enterState(initial);
    const name = initial.getAttribute("data-state");
    if (name === "LOADING" || name === "SUBMITTING") enhanceLoader(initial);
    if (name === "SUCCESS" || name === "ALREADY_DONE") activateVerified(initial);
  }
})();
