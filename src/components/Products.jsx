import React from 'react';
import { useAccent } from '../AccentContext.jsx';
import { useIsMobile } from '../hooks.js';
import { PRODUCTS } from '../data/products.js';

export function Products() {
  const a = useAccent();
  const isMobile = useIsMobile();

  const sectionRef = React.useRef(null);
  const trackRef = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  const [inView, setInView] = React.useState(false);

  // Reveal + marquee-pause both keyed off the same section observer —
  // animation stops while off-screen so the GPU layer is not kept warm
  // for a track nobody is looking at.
  React.useEffect(() => {
    if (!sectionRef.current) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVis(true);
      setInView(entry.isIntersecting);
    }, { threshold: 0.05, rootMargin: '120px 0px' });
    obs.observe(sectionRef.current);
    return () => obs.disconnect();
  }, []);

  const ROW = PRODUCTS.concat(PRODUCTS);

  return (
    <section id="mods" ref={sectionRef} style={{ padding: '80px 0', background: 'var(--pkc-tac-black)', borderTop: '1px solid var(--pkc-slate)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'flex-end',
          marginBottom: 32, flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 12 : 0,
        }}>
          <div>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: 'var(--pkc-border-strong)', letterSpacing: '0.08em', marginBottom: 8,
            }}>{'// CATALOG'}</div>
            <h2 style={{
              fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
              fontSize: 32, color: 'var(--pkc-concrete)', textTransform: 'uppercase',
              letterSpacing: '-0.01em', margin: 0, lineHeight: 1.2,
            }}>FEATURED MODS</h2>
          </div>
          <button style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 12, fontWeight: 500,
            color: a, cursor: 'pointer', border: 'none', background: 'none',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            transition: 'color 120ms',
          }}
            onMouseEnter={e => e.currentTarget.style.color='var(--pkc-concrete)'}
            onMouseLeave={e => e.currentTarget.style.color=a}>VIEW ALL <span aria-hidden="true">→</span></button>
        </div>
      </div>

      <div
        className="pkc-marquee-viewport"
        style={{
          overflow: 'hidden',
          maskImage:        'linear-gradient(to right, transparent 0, #000 80px, #000 calc(100% - 80px), transparent 100%)',
          WebkitMaskImage:  'linear-gradient(to right, transparent 0, #000 80px, #000 calc(100% - 80px), transparent 100%)',
        }}
      >
        <div
          ref={trackRef}
          className={`pkc-marquee-track ${inView ? '' : 'pkc-paused'}`}
          style={{
            display: 'flex',
            gap: 16,
            width: 'max-content',
            animation: 'pkc-marquee 60s linear infinite',
            willChange: inView ? 'transform' : 'auto',
          }}
        >
          {ROW.map((p, i) => {
            const baseIdx = i % PRODUCTS.length;
            return (
              <a
                key={`${p.slug}-${i}`}
                href={`#mods`}
                aria-label={`${p.name} — ${p.blurb}`}
                onMouseEnter={e => { e.currentTarget.style.borderColor = a; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--pkc-slate)'; }}
                onFocus={e => { e.currentTarget.style.borderColor = a; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--pkc-slate)'; }}
                style={{
                  minWidth: 260, maxWidth: 300, flex: '0 0 auto',
                  background: 'var(--pkc-ghost)', border: '1px solid var(--pkc-slate)',
                  borderRadius: 2,
                  textDecoration: 'none', color: 'inherit', display: 'block',
                  outline: 'none',
                  opacity: vis ? 1 : 0,
                  transform: vis ? 'translateY(0)' : 'translateY(12px)',
                  transitionProperty: 'border-color, opacity, transform',
                  transitionDuration: '120ms, 480ms, 480ms',
                  transitionDelay: `0ms, ${baseIdx * 60}ms, ${baseIdx * 60}ms`,
                  transitionTimingFunction: 'cubic-bezier(0.2,0.8,0.2,1)',
                }}>

                <div style={{
                  height: 180, background: 'var(--pkc-surface-sunken)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  position: 'relative', borderBottom: '1px solid var(--pkc-slate)',
                  overflow: 'hidden',
                }}>
                  {p.tag && <span style={{
                    position: 'absolute', top: 0, left: 0,
                    background: a, color: 'var(--pkc-tac-black)', fontSize: 10,
                    fontWeight: 700, padding: '2px 8px',
                    letterSpacing: '0.08em', fontFamily: '"JetBrains Mono", monospace',
                    textTransform: 'uppercase',
                  }}>{p.tag}</span>}
                  {p.image ? (
                    <img src={p.image} alt="" loading="lazy"
                         style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{
                      fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                      color: 'var(--pkc-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em',
                    }}>// PRODUCT IMAGE</span>
                  )}
                </div>

                <div style={{ padding: '16px 18px 20px' }}>
                  <h3 style={{
                    fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
                    fontSize: 14, color: 'var(--pkc-concrete)', margin: '0 0 6px',
                    textTransform: 'uppercase', letterSpacing: '-0.01em',
                  }}>{p.name}</h3>
                  <p style={{
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                    color: 'var(--pkc-text-muted)', lineHeight: 1.5, margin: '0 0 14px',
                    letterSpacing: '0.01em',
                  }}>{p.blurb}</p>
                  <span style={{
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 11, fontWeight: 500,
                    color: a, letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>{'> DETAILS'}</span>
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
