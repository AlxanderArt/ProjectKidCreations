import React from 'react';
import { useAccent } from '../AccentContext.jsx';
import { useIsMobile } from '../hooks.js';

const PKC_GRID = [
  { label: '// DETAIL SHOT — TEXTURE CLOSE-UP', span: 'span 2' },
  { label: '// MOUNTED ON BLASTER', span: 'auto' },
  { label: '// WORKSHOP / PRINT PROCESS', span: 'auto' },
  { label: '// FULL MOD LINEUP', span: 'span 2' },
];

export function Showcase() {
  const a = useAccent();
  const isMobile = useIsMobile();

  return (
    <section id="gallery" style={{ padding: '80px 0', background: 'var(--pkc-tac-black)', borderTop: '1px solid var(--pkc-slate)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: 'var(--pkc-text-faint)', letterSpacing: '0.08em', marginBottom: 8,
        }}>{'// GALLERY'}</div>
        <h2 style={{
          fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
          fontSize: isMobile ? 28 : 40, color: 'var(--pkc-concrete)', textTransform: 'uppercase',
          margin: '0 0 40px', letterSpacing: '-0.02em', lineHeight: 1.1,
        }}>THE CRAFT</h2>
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
          gridTemplateRows: isMobile ? 'auto' : '220px 220px',
          gap: 12,
        }}>
          {PKC_GRID.map((item, i) => (
            <div key={i} style={{
              background: 'var(--pkc-ghost)', border: '1px solid var(--pkc-slate)', borderRadius: 2,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative', gridColumn: isMobile ? 'auto' : item.span,
              minHeight: 180, transition: 'border-color 120ms cubic-bezier(0.2,0.8,0.2,1)',
              overflow: 'hidden',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor=a}
              onMouseLeave={e => e.currentTarget.style.borderColor='var(--pkc-slate)'}>
              <div style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                color: 'var(--pkc-text-faint)', textTransform: 'uppercase',
                letterSpacing: '0.08em', textAlign: 'center', padding: 20,
              }}>{item.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


export function Social() {
  const a = useAccent();
  const isMobile = useIsMobile();

  const ref = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  React.useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVis(true); }, { threshold: 0.2 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <section ref={ref} style={{ padding: '80px 0', background: 'var(--pkc-tac-black)', borderTop: '1px solid var(--pkc-slate)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: 'var(--pkc-text-faint)', letterSpacing: '0.08em', marginBottom: 24,
        }}>{'// INTEL'}</div>

        <div style={{
          borderLeft: `4px solid ${a}`, paddingLeft: 20, marginBottom: 48,
          opacity: vis ? 1 : 0, transform: vis ? 'translateX(0)' : 'translateX(-12px)',
          transition: 'opacity 480ms cubic-bezier(0.2,0.8,0.2,1), transform 480ms cubic-bezier(0.2,0.8,0.2,1)',
        }}>
          <p style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 15,
            color: 'var(--pkc-concrete)', lineHeight: 1.7, margin: '0 0 12px',
            letterSpacing: '0.01em', opacity: 0.8,
          }}>
            "The fitment is insane — dropped right in, zero modifications. Best mods I've bought."
          </p>
          <p style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
            color: 'var(--pkc-text-faint)', margin: 0, letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}>— @tacticalbuilds</p>
        </div>

        <div style={{ display: 'flex', gap: isMobile ? 32 : 56, flexWrap: 'wrap' }}>
          {[['500+', 'MODS SOLD'], ['50+', 'UNIQUE DESIGNS'], ['4.9', 'AVG RATING']].map(([n, l], i) => (
            <div key={i} style={{
              opacity: vis ? 1 : 0, transform: vis ? 'translateY(0)' : 'translateY(12px)',
              transition: `opacity 480ms cubic-bezier(0.2,0.8,0.2,1) ${200 + i*100}ms, transform 480ms cubic-bezier(0.2,0.8,0.2,1) ${200 + i*100}ms`,
            }}>
              <div style={{
                fontFamily: '"Archivo Black", sans-serif', fontSize: 36, fontWeight: 900,
                color: a, margin: '0 0 2px', letterSpacing: '-0.02em',
              }}>{n}</div>
              <div style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                color: 'var(--pkc-text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>{l}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


export function SpecStrip() {
  const specs = [
    ['LAYER HEIGHT', '0.12mm'], ['TOLERANCE', '±0.1mm'],
    ['INFILL', '60%'], ['MATERIAL', 'PLA+ / PETG'],
  ];

  // Counter-rotating marquee — runs left→right against the products' right→left
  // at the same 60s cadence. Two copies so translateX(-50%) wraps seamlessly.
  // Pause-on-hover + pause-when-off-screen inherited via the .pkc-marquee-*
  // classes.
  const ref = React.useRef(null);
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([e]) => setInView(e.isIntersecting), {
      threshold: 0.05, rootMargin: '120px 0px',
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  const ROW = specs.concat(specs);

  return (
    <section ref={ref} style={{
      padding: '24px 0', background: 'var(--pkc-ghost)',
      borderTop: '1px solid var(--pkc-slate)', borderBottom: '1px solid var(--pkc-slate)',
    }}>
      <div
        className="pkc-marquee-viewport"
        style={{
          overflow: 'hidden',
          maskImage:        'linear-gradient(to right, transparent 0, #000 80px, #000 calc(100% - 80px), transparent 100%)',
          WebkitMaskImage:  'linear-gradient(to right, transparent 0, #000 80px, #000 calc(100% - 80px), transparent 100%)',
        }}
      >
        <div
          className={`pkc-marquee-track ${inView ? '' : 'pkc-paused'}`}
          style={{
            display: 'flex',
            gap: 48,
            width: 'max-content',
            animation: 'pkc-marquee 60s linear infinite reverse',
            willChange: inView ? 'transform' : 'auto',
          }}
        >
          {ROW.map(([label, val], i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 12, flex: '0 0 auto' }}>
              <span style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                color: 'var(--pkc-text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 500,
              }}>{label}</span>
              <span style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 14,
                color: 'var(--pkc-concrete)', letterSpacing: '0.01em',
              }}>{val}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


export function FinalCTA() {
  const a = useAccent();
  const isMobile = useIsMobile();

  return (
    <section id="contact" style={{
      padding: '80px 0', position: 'relative', overflow: 'hidden',
      background: 'var(--pkc-tac-black)', borderTop: `4px solid ${a}`,
    }}>
      <div aria-hidden="true" style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 200,
        background: `linear-gradient(180deg, ${a}08, transparent)`,
        pointerEvents: 'none',
      }} />

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px', position: 'relative', zIndex: 2 }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: 'var(--pkc-text-faint)', letterSpacing: '0.08em', marginBottom: 16,
        }}>{'// READY?'}</div>

        <h2 style={{
          fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
          fontSize: isMobile ? 32 : 48, color: 'var(--pkc-concrete)', textTransform: 'uppercase',
          margin: '0 0 12px', lineHeight: 1.1, letterSpacing: '-0.02em',
        }}>BUILD YOUR SETUP</h2>

        <p style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
          color: 'var(--pkc-text-muted)', margin: '0 0 32px', letterSpacing: '0.01em',
        }}>{'// Custom mods. Premium quality. Your style.'}</p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <a href="#mods" style={{
            background: 'transparent', color: a, border: `2px solid ${a}`,
            padding: '14px 24px', fontSize: 12, fontWeight: 700,
            fontFamily: '"JetBrains Mono", monospace',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            cursor: 'pointer', borderRadius: 2,
            textDecoration: 'none', display: 'inline-block',
            clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)',
            transition: 'background 120ms, color 120ms, transform 120ms',
          }}
            onMouseEnter={e => { e.currentTarget.style.background=a; e.currentTarget.style.color='var(--pkc-tac-black)'; e.currentTarget.style.transform='translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color=a; e.currentTarget.style.transform='translateY(0)'; }}>
            SHOP MODS <span aria-hidden="true">→</span>
          </a>
          <a href="mailto:hello@projectkidcreations.com" style={{
            background: 'transparent', color: 'var(--pkc-concrete)',
            border: '1px solid var(--pkc-slate)', padding: '14px 24px',
            fontSize: 12, fontWeight: 500, fontFamily: '"JetBrains Mono", monospace',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            cursor: 'pointer', borderRadius: 2,
            textDecoration: 'none', display: 'inline-block',
            transition: 'border-color 120ms',
          }}
            onMouseEnter={e => e.currentTarget.style.borderColor='var(--pkc-text-faint)'}
            onMouseLeave={e => e.currentTarget.style.borderColor='var(--pkc-slate)'}>
            CONTACT US
          </a>
        </div>
      </div>
    </section>
  );
}


export function Footer() {
  const a = useAccent();
  const isMobile = useIsMobile();
  const year = new Date().getFullYear();

  return (
    <footer style={{
      padding: '32px 0 24px', background: 'var(--pkc-tac-black)',
      borderTop: '1px solid var(--pkc-slate)',
    }}>
      <div style={{
        maxWidth: 1280, margin: '0 auto', padding: '0 32px',
        display: isMobile ? 'block' : 'flex', justifyContent: 'space-between',
        alignItems: 'center', gap: 24,
      }}>
        <div>
          <div style={{
            fontFamily: '"Archivo Black", sans-serif', fontWeight: 900, fontSize: 13,
            color: 'var(--pkc-concrete)', letterSpacing: '-0.01em', textTransform: 'uppercase',
            marginBottom: 4,
          }}>
            PROJECT<span style={{color: a}}>KID</span>CREATIONS
          </div>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: 'var(--pkc-text-faint)', letterSpacing: '0.05em',
          }}>{`// ${year} PROJECTKIDCREATIONS. ALL RIGHTS RESERVED.`}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, marginTop: isMobile ? 16 : 0, flexWrap: 'wrap' }}>
          {[
            ['INSTAGRAM', null],
            ['TIKTOK',    'https://www.tiktok.com/@projectkidcreations'],
            ['YOUTUBE',   null],
            ['PRIVACY',   '#'],
            ['TERMS',     '#'],
          ].map(([l, href]) => (
            <a key={l}
               href={href || '#'}
               aria-disabled={!href || href === '#' ? 'true' : undefined}
               rel={href && href !== '#' && href.startsWith('http') ? 'noopener noreferrer' : undefined}
               target={href && href !== '#' && href.startsWith('http') ? '_blank' : undefined}
               style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: 'var(--pkc-text-muted)', textDecoration: 'none', cursor: 'pointer',
              letterSpacing: '0.05em', textTransform: 'uppercase',
              transition: 'color 120ms cubic-bezier(0.2,0.8,0.2,1)',
            }}
              onMouseEnter={e => e.currentTarget.style.color=a}
              onMouseLeave={e => e.currentTarget.style.color='var(--pkc-text-muted)'}>{l}</a>
          ))}
        </div>
      </div>
    </footer>
  );
}
