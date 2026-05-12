/* ProjectKidCreations — phase-four/motion.js
 * GSAP-driven choreography for the ACCESS GRANTED dashboard.
 *
 * Owns 5 named primitives — opCardFill, badgePop, xpTick, rankPromote,
 * streakFlame — plus the state-enter observer pattern mirrored from
 * phase-three/motion.js. Honors prefers-reduced-motion.
 *
 * Exposed on window.PKC_MOTION for app.js + dev panel triggers.
 */

(function () {
  "use strict";

  const gsap = window.gsap;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Reduced-motion fallback: still expose API, no-op the choreography
  if (!gsap || REDUCED) {
    window.PKC_MOTION = {
      opCardFill: () => {},
      badgePop: () => {},
      xpTick: (el, _from, to) => { if (el) el.textContent = String(to); },
      rankPromote: () => {},
      streakFlame: () => {},
      enterState: () => {}
    };
    return;
  }

  const ENTER_EASE = "power3.out";
  const STAGGER = 0.045;

  // Defuse the CSS @keyframe entries so GSAP owns timing
  const style = document.createElement("style");
  style.textContent = `
    .state[data-active="true"] { animation: none !important; opacity: 1; }
  `;
  document.head.appendChild(style);

  // ──────────────────────────────────────────────────────────────────
  // PRIMITIVE 1 — opCardFill
  // XP bar 0% → target over 1.2s + scan-line wipe under bar.
  // ──────────────────────────────────────────────────────────────────
  function opCardFill(barFillEl, targetPct) {
    if (!barFillEl) return;
    const scan = barFillEl.parentElement && barFillEl.parentElement.querySelector(".xp-scanline");
    gsap.set(barFillEl, { width: "0%" });
    gsap.to(barFillEl, {
      width: `${targetPct}%`,
      duration: 1.2,
      ease: "power2.out"
    });
    if (scan) {
      gsap.fromTo(
        scan,
        { x: "-100%", opacity: 0.8 },
        { x: "100%", opacity: 0, duration: 1.2, ease: "power2.out" }
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // PRIMITIVE 2 — badgePop
  // Spring scale 0.6 → 1.05 → 1.0 + green ribbon scan.
  // ──────────────────────────────────────────────────────────────────
  function badgePop(cell) {
    if (!cell) return;
    const ribbon = cell.querySelector(".badge-ribbon");
    gsap.fromTo(
      cell,
      { scale: 0.6 },
      { scale: 1.05, duration: 0.18, ease: "power2.out",
        onComplete: () => gsap.to(cell, { scale: 1.0, duration: 0.22, ease: "power2.inOut" })
      }
    );
    if (ribbon) {
      gsap.fromTo(
        ribbon,
        { x: "-110%", opacity: 1 },
        { x: "110%", opacity: 0.4, duration: 0.4, ease: "power2.out" }
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // PRIMITIVE 3 — xpTick
  // Count from → to over 800ms with digit stagger.
  // ──────────────────────────────────────────────────────────────────
  function xpTick(el, from, to) {
    if (!el) return;
    const obj = { v: from };
    gsap.to(obj, {
      v: to,
      duration: 0.8,
      ease: "power1.inOut",
      onUpdate: () => { el.textContent = Math.round(obj.v).toString(); },
      onComplete: () => { el.textContent = String(to); }
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // PRIMITIVE 4 — rankPromote
  // Full-viewport takeover, 1.5s. Giant rank name + green scan-wipe.
  // Dashboard re-reveals underneath.
  // ──────────────────────────────────────────────────────────────────
  function rankPromote(rankLabel) {
    let overlay = document.getElementById("rank-promote-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "rank-promote-overlay";
      overlay.className = "rank-promote";
      overlay.innerHTML = `
        <div class="rank-promote-scan"></div>
        <p class="rank-promote-caption">// RANK PROMOTED</p>
        <h1 class="rank-promote-label"></h1>
        <p class="rank-promote-meta">// HOLD POSITION</p>
      `;
      document.body.appendChild(overlay);
    }
    overlay.querySelector(".rank-promote-label").textContent = rankLabel;

    const tl = gsap.timeline();
    tl.set(overlay, { display: "flex", opacity: 1 });
    tl.fromTo(overlay.querySelector(".rank-promote-scan"),
      { y: "-100%" }, { y: "100%", duration: 0.6, ease: "power2.inOut" }, 0);
    tl.fromTo(overlay.querySelector(".rank-promote-caption"),
      { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: "power3.out" }, 0.18);
    tl.fromTo(overlay.querySelector(".rank-promote-label"),
      { y: 24, opacity: 0, scale: 0.96 }, { y: 0, opacity: 1, scale: 1, duration: 0.42, ease: "power3.out" }, 0.22);
    tl.fromTo(overlay.querySelector(".rank-promote-meta"),
      { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: "power3.out" }, 0.42);
    tl.to(overlay, { opacity: 0, duration: 0.32, ease: "power2.in" }, 1.2);
    tl.set(overlay, { display: "none" });
  }

  // ──────────────────────────────────────────────────────────────────
  // PRIMITIVE 5 — streakFlame
  // Single green-glow pulse on a streak ticker / cell.
  // ──────────────────────────────────────────────────────────────────
  function streakFlame(cell) {
    if (!cell) return;
    gsap.fromTo(
      cell,
      { boxShadow: "0 0 0 0 rgba(57, 255, 20, 0.0)" },
      { boxShadow: "0 0 14px 4px rgba(57, 255, 20, 0.55)", duration: 0.28, ease: "power2.out",
        onComplete: () => gsap.to(cell, {
          boxShadow: "0 0 0 0 rgba(57, 255, 20, 0.0)",
          duration: 0.34,
          ease: "power2.inOut"
        })
      }
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // State-enter timeline — mirrors phase-three pattern
  // ──────────────────────────────────────────────────────────────────
  function enterState(stateEl) {
    if (!stateEl) return;
    gsap.set(stateEl, { opacity: 1 });

    const stepLabel = stateEl.querySelector(":scope > .step-label");
    const prompt = stateEl.querySelector(":scope > .prompt, :scope > h1");
    const bodyLines = stateEl.querySelectorAll(
      ":scope > .confirm-line, :scope > .momentum, :scope > .idle-hint, :scope > .kill-line, :scope > .kill-meta, :scope > .auth-form, :scope > .lockout-block, :scope > .dashboard-grid"
    );
    const cta = stateEl.querySelectorAll(":scope > .cta, :scope .cta");

    const tl = gsap.timeline({ defaults: { ease: ENTER_EASE } });
    if (stepLabel)        tl.fromTo(stepLabel, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28 }, 0);
    if (prompt)           tl.fromTo(prompt,    { y: 16, opacity: 0, scale: 0.985 }, { y: 0, opacity: 1, scale: 1, duration: 0.44 }, 0.06);
    if (bodyLines.length) tl.fromTo(bodyLines, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, stagger: STAGGER }, 0.18);
    if (cta.length)       tl.fromTo(cta, { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32 }, 0.34);
    return tl;
  }

  function enhanceLoader(stateEl) {
    const hint = stateEl.querySelector(".idle-hint");
    if (!hint) return;
    gsap.fromTo(hint, { opacity: 0.4 }, { opacity: 1, duration: 0.9, repeat: -1, yoyo: true, ease: "sine.inOut" });
  }

  // ──────────────────────────────────────────────────────────────────
  // Observer wiring
  // ──────────────────────────────────────────────────────────────────
  const stage = document.querySelector("#stage");
  if (stage) {
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName !== "data-active") continue;
        const el = r.target;
        if (!el.classList || !el.classList.contains("state")) continue;
        if (el.getAttribute("data-active") !== "true") continue;
        enterState(el);
        const name = el.getAttribute("data-state");
        if (name === "LOADING" || name === "BOOTSTRAP") enhanceLoader(el);
        if (name === "DASHBOARD") {
          // Dashboard panel stagger
          const panels = el.querySelectorAll(".dash-panel");
          if (panels.length) {
            gsap.fromTo(panels, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.42, stagger: 0.06, ease: ENTER_EASE });
          }
          // Animate XP bar after a beat
          const fill = el.querySelector("#xp-bar-fill");
          if (fill) {
            const pct = Number(fill.getAttribute("data-pct") || "0");
            gsap.delayedCall(0.25, () => opCardFill(fill, pct));
          }
        }
      }
    });
    stage.querySelectorAll(".state").forEach((el) =>
      observer.observe(el, { attributes: true, attributeFilter: ["data-active"] })
    );

    // First paint
    const initialState = stage.querySelector('.state[data-active="true"]');
    if (initialState) {
      enterState(initialState);
      const name = initialState.getAttribute("data-state");
      if (name === "LOADING" || name === "BOOTSTRAP") enhanceLoader(initialState);
    }
  }

  // Expose primitives for app.js + dev panel
  window.PKC_MOTION = {
    opCardFill,
    badgePop,
    xpTick,
    rankPromote,
    streakFlame,
    enterState
  };
})();
