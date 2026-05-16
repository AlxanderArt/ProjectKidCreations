import React from 'react';

const PKC_GRID = [
  { label: '// DETAIL SHOT — TEXTURE CLOSE-UP', span: 'span 2' },
  { label: '// MOUNTED ON BLASTER', span: 'auto' },
  { label: '// WORKSHOP / PRINT PROCESS', span: 'auto' },
  { label: '// FULL MOD LINEUP', span: 'span 2' },
];

export function Showcase({ accent }) {
  const a = accent || '#FF5F1F';
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  React.useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);

  return (
    <section style={{ padding: '80px 0', background: '#0A0A0A', borderTop: '1px solid #3F4448' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: '#3F4448', letterSpacing: '0.08em', marginBottom: 8,
        }}>{'// GALLERY'}</div>
        <h2 style={{
          fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
          fontSize: isMobile ? 28 : 40, color: '#E8E8E8', textTransform: 'uppercase',
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
              background: '#1A1C1E', border: '1px solid #3F4448', borderRadius: 2,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative', gridColumn: isMobile ? 'auto' : item.span,
              minHeight: 180, transition: 'border-color 120ms cubic-bezier(0.2,0.8,0.2,1)',
              overflow: 'hidden',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor=a}
              onMouseLeave={e => e.currentTarget.style.borderColor='#3F4448'}>
              <div style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                color: '#3F4448', textTransform: 'uppercase',
                letterSpacing: '0.08em', textAlign: 'center', padding: 20,
              }}>{item.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


export function Social({ accent }) {
  const a = accent || '#FF5F1F';
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  React.useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);

  const ref = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  React.useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVis(true); }, { threshold: 0.2 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <section ref={ref} style={{ padding: '80px 0', background: '#0A0A0A', borderTop: '1px solid #3F4448' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: '#3F4448', letterSpacing: '0.08em', marginBottom: 24,
        }}>{'// INTEL'}</div>

        <div style={{
          borderLeft: `4px solid ${a}`, paddingLeft: 20, marginBottom: 48,
          opacity: vis ? 1 : 0, transform: vis ? 'translateX(0)' : 'translateX(-12px)',
          transition: 'opacity 480ms cubic-bezier(0.2,0.8,0.2,1), transform 480ms cubic-bezier(0.2,0.8,0.2,1)',
        }}>
          <p style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 15,
            color: '#E8E8E8', lineHeight: 1.7, margin: '0 0 12px',
            letterSpacing: '0.01em', opacity: 0.8,
          }}>
            "The fitment is insane — dropped right in, zero modifications. Best mods I've bought."
          </p>
          <p style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
            color: '#3F4448', margin: 0, letterSpacing: '0.05em',
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
                color: '#3F4448', textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>{l}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


export function SpecStrip({ accent }) {
  const a = accent || '#FF5F1F';
  const specs = [
    ['LAYER HEIGHT', '0.12mm'], ['TOLERANCE', '±0.1mm'],
    ['INFILL', '60%'], ['MATERIAL', 'PLA+ / PETG'],
  ];

  return (
    <section style={{ padding: '32px 0', background: '#1A1C1E', borderTop: '1px solid #3F4448', borderBottom: '1px solid #3F4448' }}>
      <div style={{
        maxWidth: 1280, margin: '0 auto', padding: '0 32px',
        display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px 48px',
      }}>
        {specs.map(([label, val], i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: '#9AA0A4', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 500,
            }}>{label}</span>
            <span style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 14,
              color: '#E8E8E8', letterSpacing: '0.01em',
            }}>{val}</span>
          </div>
        ))}
      </div>
    </section>
  );
}


export function FinalCTA({ accent }) {
  const a = accent || '#FF5F1F';
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  React.useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);

  return (
    <section style={{
      padding: '80px 0', position: 'relative', overflow: 'hidden',
      background: '#0A0A0A', borderTop: `4px solid ${a}`,
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 200,
        background: `linear-gradient(180deg, ${a}08, transparent)`,
        pointerEvents: 'none',
      }} />

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px', position: 'relative', zIndex: 2 }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: '#3F4448', letterSpacing: '0.08em', marginBottom: 16,
        }}>{'// READY?'}</div>

        <h2 style={{
          fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
          fontSize: isMobile ? 32 : 48, color: '#E8E8E8', textTransform: 'uppercase',
          margin: '0 0 12px', lineHeight: 1.1, letterSpacing: '-0.02em',
        }}>BUILD YOUR SETUP</h2>

        <p style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
          color: '#9AA0A4', margin: '0 0 32px', letterSpacing: '0.01em',
        }}>{'// Custom mods. Premium quality. Your style.'}</p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button style={{
            background: 'transparent', color: a, border: `2px solid ${a}`,
            padding: '14px 24px', fontSize: 12, fontWeight: 700,
            fontFamily: '"JetBrains Mono", monospace',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            cursor: 'pointer', borderRadius: 2,
            clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)',
            transition: 'background 120ms, color 120ms, transform 120ms',
          }}
            onMouseEnter={e => { e.target.style.background=a; e.target.style.color='#0A0A0A'; e.target.style.transform='translateY(-1px)'; }}
            onMouseLeave={e => { e.target.style.background='transparent'; e.target.style.color=a; e.target.style.transform='translateY(0)'; }}>
            SHOP MODS →
          </button>
          <button style={{
            background: 'transparent', color: '#E8E8E8',
            border: '1px solid #3F4448', padding: '14px 24px',
            fontSize: 12, fontWeight: 500, fontFamily: '"JetBrains Mono", monospace',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            cursor: 'pointer', borderRadius: 2, transition: 'border-color 120ms',
          }}
            onMouseEnter={e => e.target.style.borderColor='#5A5F63'}
            onMouseLeave={e => e.target.style.borderColor='#3F4448'}>
            CONTACT US
          </button>
        </div>
      </div>
    </section>
  );
}


export function Footer({ accent }) {
  const a = accent || '#FF5F1F';
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  React.useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);

  return (
    <footer style={{
      padding: '32px 0 24px', background: '#0A0A0A',
      borderTop: '1px solid #3F4448',
    }}>
      <div style={{
        maxWidth: 1280, margin: '0 auto', padding: '0 32px',
        display: isMobile ? 'block' : 'flex', justifyContent: 'space-between',
        alignItems: 'center', gap: 24,
      }}>
        <div>
          <div style={{
            fontFamily: '"Archivo Black", sans-serif', fontWeight: 900, fontSize: 13,
            color: '#E8E8E8', letterSpacing: '-0.01em', textTransform: 'uppercase',
            marginBottom: 4,
          }}>
            PROJECT<span style={{color: a}}>KID</span>CREATIONS
          </div>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: '#3F4448', letterSpacing: '0.05em',
          }}>{'// 2026 PROJECTKIDCREATIONS. ALL RIGHTS RESERVED.'}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, marginTop: isMobile ? 16 : 0, flexWrap: 'wrap' }}>
          {['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'PRIVACY', 'TERMS'].map(l => (
            <a key={l} style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: '#3F4448', textDecoration: 'none', cursor: 'pointer',
              letterSpacing: '0.05em', textTransform: 'uppercase',
              transition: 'color 120ms cubic-bezier(0.2,0.8,0.2,1)',
            }}
              onMouseEnter={e => e.target.style.color=a}
              onMouseLeave={e => e.target.style.color='#3F4448'}>{l}</a>
          ))}
        </div>
      </div>
    </footer>
  );
}
