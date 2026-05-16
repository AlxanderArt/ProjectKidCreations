import React from 'react';
import { useAccent } from '../AccentContext.jsx';
import { useIsMobile } from '../hooks.js';

const PKC_VALUES = [
  { icon: '◆', title: 'CUSTOM DESIGN', desc: 'Every mod designed in-house. Unique geometry you won\'t find anywhere else.' },
  { icon: '▣', title: 'QUALITY MATERIALS', desc: 'Premium PLA+ and PETG filaments. Durability, precision, clean finish.' },
  { icon: '◎', title: 'UNIQUE AESTHETIC', desc: 'Tactical meets creative. Parts that perform and look like they belong.' },
  { icon: '⬡', title: 'PERFORMANCE FIT', desc: 'Engineered tolerances for drop-in fitment. No filing. No forcing.' },
];

export function ValueProps() {
  const a = useAccent();
  const isMobile = useIsMobile();

  const ref = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  React.useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVis(true); }, { threshold: 0.12 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <section id="about" ref={ref} style={{ padding: '80px 0', background: '#0A0A0A', borderTop: '1px solid #3F4448' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          color: '#5A5F63', letterSpacing: '0.08em', marginBottom: 8,
        }}>{'// WHY PKC'}</div>

        <h2 style={{
          fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
          fontSize: isMobile ? 28 : 40, color: '#E8E8E8', textTransform: 'uppercase',
          margin: '0 0 48px', maxWidth: 500, lineHeight: 1.1, letterSpacing: '-0.02em',
        }}>
          BUILT DIFFERENT.<br/><span style={{ color: a }}>BY DESIGN.</span>
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)',
          gap: 16,
        }}>
          {PKC_VALUES.map((v, i) => (
            <div key={i} style={{
              padding: '24px 20px', background: '#1A1C1E',
              border: '1px solid #3F4448', borderRadius: 2,
              transition: 'border-color 120ms cubic-bezier(0.2,0.8,0.2,1), opacity 480ms, transform 480ms',
              transitionDelay: `0ms, ${i*80}ms, ${i*80}ms`,
              transitionTimingFunction: 'cubic-bezier(0.2,0.8,0.2,1)',
              opacity: vis ? 1 : 0, transform: vis ? 'translateY(0)' : 'translateY(16px)',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor=a}
              onMouseLeave={e => e.currentTarget.style.borderColor='#3F4448'}>

              <div aria-hidden="true" style={{
                width: 36, height: 36, background: '#0A0A0A',
                border: `1px solid ${a}40`, borderRadius: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, color: a, marginBottom: 16,
              }}>{v.icon}</div>

              <h3 style={{
                fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
                fontSize: 13, color: '#E8E8E8', margin: '0 0 8px',
                textTransform: 'uppercase', letterSpacing: '-0.01em',
              }}>{v.title}</h3>

              <p style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                color: '#9AA0A4', lineHeight: 1.6, margin: 0,
                letterSpacing: '0.01em',
              }}>{v.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
