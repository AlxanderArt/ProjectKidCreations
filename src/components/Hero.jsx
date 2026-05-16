import React from 'react';

export function Hero({ accent }) {
  const a = accent || '#FF5F1F';
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [phase, setPhase] = React.useState(0);

  React.useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    const t1 = setTimeout(() => setPhase(1), 100);
    const t2 = setTimeout(() => setPhase(2), 400);
    const t3 = setTimeout(() => setPhase(3), 700);
    return () => { window.removeEventListener('resize', h); clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  const fade = (delay) => ({
    opacity: phase >= delay ? 1 : 0,
    transform: phase >= delay ? 'translateY(0)' : 'translateY(8px)',
    transition: 'opacity 480ms cubic-bezier(0.2,0.8,0.2,1), transform 480ms cubic-bezier(0.2,0.8,0.2,1)',
  });

  const [authState, setAuthState] = React.useState('checking');

  React.useEffect(() => {
    const ctrl = new AbortController();
    // 1500ms — fast enough that the chip doesn't visibly hang on slow links,
    // long enough to cover normal API latency on Vercel.
    const t = setTimeout(() => ctrl.abort(), 1500);
    fetch('/api/account/profile', {
      method: 'GET', credentials: 'include', cache: 'no-store', signal: ctrl.signal,
    })
      .then((r) => { clearTimeout(t); setAuthState(r.ok ? 'verified' : 'unverified'); })
      .catch(() => { clearTimeout(t); setAuthState('unverified'); });
    return () => { clearTimeout(t); ctrl.abort(); };
  }, []);

  const STATUS_TEXT  = authState === 'verified'   ? '// STATUS: VERIFIED'
                     : authState === 'unverified' ? '// STATUS: UNVERIFIED'
                     :                              '// STATUS: CHECKING';
  const STATUS_COLOR = authState === 'verified'   ? '#39FF14'
                     : authState === 'unverified' ? '#FF3333'
                     :                              '#3F4448';

  // Lazy-mount the 3D hero only on devices with a fine pointer (skip touch).
  // The hero3d module is dynamically imported so three.js doesn't block LCP.
  const mountRef = React.useRef(null);
  React.useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const finePointer = typeof window !== 'undefined' &&
      window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (!finePointer) return;
    let dispose = null;
    let cancelled = false;
    import('../hero3d.js').then(({ mount }) => {
      if (cancelled) return;
      dispose = mount(el);
    }).catch((err) => console.error('[hero-3d] module load failed:', err));
    return () => { cancelled = true; if (dispose) dispose(); };
  }, []);

  return (
    <section style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      position: 'relative', overflow: 'hidden', background: '#0A0A0A',
    }}>
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.02, pointerEvents: 'none',
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 3px)',
      }} />
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.015, pointerEvents: 'none',
        backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 119px, rgba(255,255,255,0.5) 120px)',
      }} />
      <div style={{
        position: 'absolute', top: '20%', right: '-10%', width: 600, height: 600,
        background: `radial-gradient(circle, ${a}06 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      <div style={{
        maxWidth: 1280, margin: '0 auto', padding: isMobile ? '100px 24px 60px' : '0 48px',
        display: isMobile ? 'block' : 'flex', alignItems: 'center', gap: 64,
        position: 'relative', zIndex: 2, width: '100%',
      }}>
        <div style={{ flex: isMobile ? 'unset' : '1 1 55%' }}>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            letterSpacing: '0.08em',
            marginBottom: 12,
            color: STATUS_COLOR,
            opacity: phase >= 1 ? 1 : 0,
            transform: phase >= 1 ? 'translateY(0)' : 'translateY(8px)',
            transition: 'opacity 480ms cubic-bezier(0.2,0.8,0.2,1), transform 480ms cubic-bezier(0.2,0.8,0.2,1), color 200ms cubic-bezier(0.2,0.8,0.2,1)',
            animation: (authState === 'unverified' && phase >= 1)
              ? 'pkc-status-pulse 3.2s ease-in-out infinite'
              : 'none',
          }}>{STATUS_TEXT}</div>

          <div style={{
            ...fade(1),
            display: 'inline-flex', padding: '2px 8px',
            border: `1px solid ${a}`, color: a,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10, fontWeight: 500, letterSpacing: '0.08em',
            textTransform: 'uppercase', marginBottom: 24, borderRadius: 2,
          }}>3D PRINTED PRECISION</div>

          <h1 style={{
            ...fade(1),
            fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
            fontSize: isMobile ? 44 : 64, lineHeight: 1.1,
            color: '#E8E8E8', margin: '0 0 20px', textTransform: 'uppercase',
            letterSpacing: '-0.02em',
          }}>
            ENGINEERED<br/>
            <span style={{ color: a }}>REBELLION.</span>
          </h1>

          <p style={{
            ...fade(2),
            fontFamily: '"JetBrains Mono", monospace', fontSize: 14,
            color: '#9AA0A4', lineHeight: 1.6,
            margin: '0 0 32px', maxWidth: 440, letterSpacing: '0.01em',
          }}>
            Custom-engineered gel blaster mods and tactical accessories. Designed for performance. Built for those who refuse generic parts.
          </p>

          <div style={{ ...fade(3), display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button style={{
              background: 'transparent', color: a, border: `2px solid ${a}`,
              padding: '14px 24px', fontSize: 12, fontWeight: 700,
              fontFamily: '"JetBrains Mono", monospace',
              letterSpacing: '0.05em', textTransform: 'uppercase',
              cursor: 'pointer', borderRadius: 2,
              clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)',
              transition: 'background 120ms cubic-bezier(0.2,0.8,0.2,1), color 120ms cubic-bezier(0.2,0.8,0.2,1), transform 120ms',
            }}
              onMouseEnter={e => { e.target.style.background=a; e.target.style.color='#0A0A0A'; e.target.style.transform='translateY(-1px)'; }}
              onMouseLeave={e => { e.target.style.background='transparent'; e.target.style.color=a; e.target.style.transform='translateY(0)'; }}>
              EXPLORE MODS →
            </button>
            <button style={{
              background: 'transparent', color: '#E8E8E8',
              border: '1px solid #3F4448', padding: '14px 24px',
              fontSize: 12, fontWeight: 500, fontFamily: '"JetBrains Mono", monospace',
              letterSpacing: '0.05em', textTransform: 'uppercase',
              cursor: 'pointer', borderRadius: 2,
              transition: 'border-color 120ms, color 120ms',
            }}
              onMouseEnter={e => e.target.style.borderColor='#5A5F63'}
              onMouseLeave={e => e.target.style.borderColor='#3F4448'}>
              VIEW COLLECTION
            </button>
          </div>
        </div>

        <div style={{
          flex: isMobile ? 'unset' : '1 1 45%',
          marginTop: isMobile ? 40 : 0,
          display: 'flex', justifyContent: 'center',
        }}>
          <div
            ref={mountRef}
            id="hero-3d-mount"
            data-model-url="/assets/models/splatrball-400.glb"
            style={{
              ...fade(2),
              width: isMobile ? '100%' : 380,
              height: isMobile ? 260 : 380,
              position: 'relative',
            }}
          />
        </div>
      </div>
    </section>
  );
}
