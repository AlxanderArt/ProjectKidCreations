/* ProjectKidCreations — phase-three/motion.js
 * GSAP-driven loading + state-change choreography.
 *
 * Handles both top-level state transitions (LOADING / FORM / SUBMITTING /
 * SUCCESS / ...) AND the 4 sub-section transitions inside FORM
 * (identity → maker → contact → review). Triggers the verified-state
 * accent swap (orange → neon green) the moment the SUCCESS state lands.
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

  // Defuse the CSS @keyframe entries so GSAP owns timing
  const style = document.createElement("style");
  style.textContent = `
    .state[data-active="true"]   { animation: none !important; opacity: 1; }
    .section[data-active="true"] { animation: none !important; opacity: 1; }
  `;
  document.head.appendChild(style);

  function enterState(stateEl) {
    if (!stateEl) return;
    gsap.set(stateEl, { opacity: 1 });

    const stepLabel = stateEl.querySelector(":scope > .step-label");
    const prompt = stateEl.querySelector(":scope > .prompt, :scope > h1");
    const bodyLines = stateEl.querySelectorAll(
      ":scope > .confirm-line, :scope > .momentum, :scope > .idle-hint, :scope > .kill-line, :scope > .kill-meta"
    );
    const cta = stateEl.querySelectorAll(":scope > .cta");

    const tl = gsap.timeline({ defaults: { ease: ENTER_EASE } });
    if (stepLabel)        tl.fromTo(stepLabel, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28 }, 0);
    if (prompt)           tl.fromTo(prompt,    { y: 16, opacity: 0, scale: 0.985 }, { y: 0, opacity: 1, scale: 1, duration: 0.44 }, 0.06);
    if (bodyLines.length) tl.fromTo(bodyLines, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, stagger: STAGGER }, 0.20);
    if (cta.length)       tl.fromTo(cta, { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32 }, 0.38);
    return tl;
  }

  function enterSection(sectionEl) {
    if (!sectionEl) return;
    gsap.set(sectionEl, { opacity: 1 });

    const legend = sectionEl.querySelector(":scope > .section-legend");
    const fields = sectionEl.querySelectorAll(":scope > .field");
    const nav = sectionEl.querySelectorAll(":scope > .section-nav");

    const tl = gsap.timeline({ defaults: { ease: ENTER_EASE } });
    if (legend)       tl.fromTo(legend, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.26 }, 0);
    if (fields.length) tl.fromTo(fields, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, stagger: STAGGER * 1.4 }, 0.10);
    if (nav.length)   tl.fromTo(nav, { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28 }, 0.28);
    return tl;
  }

  function enhanceLoader(stateEl) {
    const hint = stateEl.querySelector(".idle-hint");
    if (!hint) return;
    gsap.fromTo(hint, { opacity: 0.4 }, { opacity: 1, duration: 0.9, repeat: -1, yoyo: true, ease: "sine.inOut" });
  }

  function activateVerified(stateEl) {
    gsap.delayedCall(0.45, () => {
      document.body.dataset.verified = "true";
      const prompt = stateEl.querySelector(".prompt");
      if (prompt) {
        gsap.fromTo(
          prompt,
          { filter: "brightness(1)" },
          { filter: "brightness(1.3)", duration: 0.34, yoyo: true, repeat: 1, ease: "sine.inOut" }
        );
      }
    });
  }
  function deactivateVerified() {
    delete document.body.dataset.verified;
  }

  // ──────────────────────────────────────────────
  // Observer
  // ──────────────────────────────────────────────
  const stage = document.querySelector("#stage");
  if (!stage) return;

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName !== "data-active") continue;
      const el = r.target;
      if (!el.classList) continue;
      const active = el.getAttribute("data-active") === "true";

      if (el.classList.contains("state")) {
        const name = el.getAttribute("data-state");
        if (!active) {
          if (name === "SUCCESS" || name === "ALREADY_DONE") deactivateVerified();
          continue;
        }
        enterState(el);
        if (name === "LOADING" || name === "SUBMITTING") enhanceLoader(el);
        if (name === "SUCCESS" || name === "ALREADY_DONE") activateVerified(el);
      } else if (el.classList.contains("section") && active) {
        enterSection(el);
      }
    }
  });

  stage.querySelectorAll(".state, .section").forEach((el) =>
    observer.observe(el, { attributes: true, attributeFilter: ["data-active"] })
  );

  // First paint
  const initialState = stage.querySelector('.state[data-active="true"]');
  if (initialState) {
    enterState(initialState);
    const name = initialState.getAttribute("data-state");
    if (name === "LOADING" || name === "SUBMITTING") enhanceLoader(initialState);
    if (name === "SUCCESS" || name === "ALREADY_DONE") activateVerified(initialState);
  }
  const initialSection = stage.querySelector('.section[data-active="true"]');
  if (initialSection) enterSection(initialSection);
})();
