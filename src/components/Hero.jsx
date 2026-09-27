import React from 'react';
import { usePrefersReducedMotion } from '../hooks.js';

export function Hero() {
  const reducedMotion = usePrefersReducedMotion();
  const [bootComplete, setBootComplete] = React.useState(() => (
    typeof document === 'undefined' || (
      document.documentElement.classList.contains('pkc-boot-ready') && !document.querySelector('#pkc-boot')
    )
  ));

  React.useEffect(() => {
    if (document.documentElement.classList.contains('pkc-boot-ready') && !document.querySelector('#pkc-boot')) {
      setBootComplete(true);
      return undefined;
    }
    const handleComplete = () => setBootComplete(true);
    window.addEventListener('pkc:boot-complete', handleComplete, { once: true });
    return () => window.removeEventListener('pkc:boot-complete', handleComplete);
  }, []);

  const [phase, setPhase] = React.useState(0);
  React.useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 100);
    const t2 = setTimeout(() => setPhase(2), 400);
    const t3 = setTimeout(() => setPhase(3), 700);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  const [authState, setAuthState] = React.useState('checking');
  React.useEffect(() => {
    // Skip the auth probe entirely for visitors with no cookies — they
    // can't be authed, so a request would just 401 and log a console
    // error. Anonymous visitor is the overwhelming case for a public
    // landing page; once the user logs in elsewhere, a cookie lands and
    // the probe runs on their next visit.
    const hasCookie = typeof document !== 'undefined' && !!document.cookie;
    if (!hasCookie) { setAuthState('unverified'); return; }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    fetch('/api/account/profile', {
      method: 'GET', credentials: 'include', cache: 'no-store', signal: ctrl.signal,
    })
      .then((r) => { clearTimeout(t); setAuthState(r.ok ? 'verified' : 'unverified'); })
      .catch(() => { clearTimeout(t); setAuthState('unverified'); });
    return () => { clearTimeout(t); ctrl.abort(); };
  }, []);

  const STATUS_TEXT = authState === 'verified' ? '// STATUS: VERIFIED'
    : authState === 'unverified' ? '// STATUS: UNVERIFIED'
      : '// STATUS: CHECKING';

  // 3D hero: dynamic import + fine-pointer gate (no GPU work on touch).
  // The mount() helper returns a dispose() that we call on unmount.
  const mountRef = React.useRef(null);
  const [modelReady, setModelReady] = React.useState(false);
  React.useEffect(() => {
    if (!bootComplete) return;
    const el = mountRef.current;
    if (!el) return;
    const capableViewport = typeof window !== 'undefined' &&
      window.matchMedia && window.matchMedia('(pointer: fine) and (min-width: 768px)').matches;
    if (!capableViewport) return;
    let dispose = null;
    let cancelled = false;
    let idleId = null;
    const MOTION_SETTLE_MS = 1400;
    const mountModel = () => {
      import('../hero3d.js').then(({ mount }) => {
        if (cancelled) return;
        dispose = mount(el, { trackPointer: !reducedMotion, onReady: () => setModelReady(true) });
      }).catch((err) => console.error('[hero-3d] module load failed:', err));
    };
    const scheduleIdleMount = () => {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(mountModel, { timeout: 4000 });
      } else {
        mountModel();
      }
    };
    const settleTimer = window.setTimeout(scheduleIdleMount, MOTION_SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
      if (dispose) dispose();
    };
  }, [bootComplete, reducedMotion]);

  return (
    <section id="top" className={`pkc-hero pkc-phase-${phase}`}>
      <div aria-hidden="true" className="pkc-hero__scanlines" />
      <div aria-hidden="true" className="pkc-hero__grid" />
      <div aria-hidden="true" className="pkc-hero__glow" />

      <div className="pkc-hero__inner">
        <div className="pkc-hero__copy">
          <div
            role="status"
            aria-live="polite"
            className={`pkc-hero__status pkc-reveal-1 pkc-status--${authState}`}
          >
            {STATUS_TEXT}
          </div>

          <div className="pkc-hero__badge pkc-reveal-1">3D PRINTED PRECISION</div>

          <h1 className="pkc-hero__title pkc-reveal-1">
            ENGINEERED<br/>
            <span className="pkc-accent-text">REBELLION.</span>
          </h1>

          <p className="pkc-hero__description pkc-reveal-2">
            Custom-engineered gel blaster mods and tactical accessories. Designed for performance. Built for those who refuse generic parts.
          </p>

          <div className="pkc-hero__actions pkc-reveal-3">
            <a href="#mods" className="pkc-button pkc-button--primary">
              EXPLORE MODS <span aria-hidden="true">→</span>
            </a>
            <a href="#gallery" className="pkc-button pkc-button--secondary">
              VIEW COLLECTION
            </a>
          </div>
        </div>

        <div className="pkc-hero__visual">
          <div
            ref={mountRef}
            id="hero-3d-mount"
            data-model-url="/assets/models/splatrball-400.glb"
            data-ready={modelReady ? 'true' : 'false'}
            aria-hidden="true"
            className="pkc-hero__model"
          />
        </div>
      </div>
    </section>
  );
}
