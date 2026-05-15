/* ── PKC Products — horizontal scroll, brutalist cards ── */

const PKC_PRODUCTS = [
  { name: 'VIPER SHROUD', desc: 'Barrel-mounted tactical shroud with integrated rail system.', tag: '// POPULAR' },
  { name: 'HEX GRIP PRO', desc: 'Ergonomic foregrip with hexagonal texture pattern.', tag: '// NEW' },
  { name: 'PHANTOM STOCK', desc: 'Adjustable lightweight stock with cheek riser.', tag: null },
  { name: 'APEX MUZZLE', desc: 'Flash hider with spiral porting. Clean aesthetics.', tag: '// LIMITED' },
  { name: 'TAC RAIL KIT', desc: 'Modular picatinny rail segments. Mount anywhere.', tag: null },
  { name: 'GHOST MAG', desc: 'Extended magazine housing with window cutout.', tag: '// NEW' },
];

function Products({ accent }) {
  const a = accent || '#FF5F1F';
  const [isMobile, setIsMobile] = React.useState(window.innerWidth < 768);
  React.useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);

  const ref = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  React.useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVis(true); }, { threshold: 0.1 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <section ref={ref} style={{ padding: '80px 0', background: '#0A0A0A', borderTop: '1px solid #3F4448' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 32px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'flex-end',
          marginBottom: 32, flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 12 : 0,
        }}>
          <div>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: '#3F4448', letterSpacing: '0.08em', marginBottom: 8,
            }}>{'// CATALOG'}</div>
            <h2 style={{
              fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
              fontSize: 32, color: '#E8E8E8', textTransform: 'uppercase',
              letterSpacing: '-0.01em', margin: 0, lineHeight: 1.2,
            }}>FEATURED MODS</h2>
          </div>
          <button style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 12, fontWeight: 500,
            color: a, cursor: 'pointer', border: 'none', background: 'none',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            transition: 'color 120ms',
          }}
            onMouseEnter={e => e.target.style.color='#E8E8E8'}
            onMouseLeave={e => e.target.style.color=a}>VIEW ALL →</button>
        </div>

        <div style={{
          display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8,
          scrollSnapType: 'x mandatory', scrollbarWidth: 'none',
        }}>
          {PKC_PRODUCTS.map((p, i) => (
            <div key={i} style={{
              minWidth: 260, maxWidth: 300, flex: '0 0 auto',
              background: '#1A1C1E', border: '1px solid #3F4448',
              borderRadius: 2, scrollSnapAlign: 'start', cursor: 'pointer',
              transition: 'border-color 120ms cubic-bezier(0.2,0.8,0.2,1)',
              opacity: vis ? 1 : 0, transform: vis ? 'translateY(0)' : 'translateY(12px)',
              transitionProperty: 'border-color, opacity, transform',
              transitionDuration: `120ms, 480ms, 480ms`,
              transitionDelay: `0ms, ${i * 60}ms, ${i * 60}ms`,
              transitionTimingFunction: 'cubic-bezier(0.2,0.8,0.2,1)',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor=a}
              onMouseLeave={e => e.currentTarget.style.borderColor='#3F4448'}>

              <div style={{
                height: 180, background: '#141416',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative', borderBottom: '1px solid #3F4448',
              }}>
                {p.tag && <span style={{
                  position: 'absolute', top: 0, left: 0,
                  background: a, color: '#0A0A0A', fontSize: 10,
                  fontWeight: 700, padding: '2px 8px',
                  letterSpacing: '0.08em', fontFamily: '"JetBrains Mono", monospace',
                  textTransform: 'uppercase',
                }}>{p.tag}</span>}
                <span style={{
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                  color: '#3F4448', textTransform: 'uppercase', letterSpacing: '0.08em',
                }}>// PRODUCT IMAGE</span>
              </div>

              <div style={{ padding: '16px 18px 20px' }}>
                <h3 style={{
                  fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
                  fontSize: 14, color: '#E8E8E8', margin: '0 0 6px',
                  textTransform: 'uppercase', letterSpacing: '-0.01em',
                }}>{p.name}</h3>
                <p style={{
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                  color: '#9AA0A4', lineHeight: 1.5, margin: '0 0 14px',
                  letterSpacing: '0.01em',
                }}>{p.desc}</p>
                <button style={{
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 11, fontWeight: 500,
                  color: a, background: 'none', border: 'none', cursor: 'pointer',
                  padding: 0, letterSpacing: '0.05em', textTransform: 'uppercase',
                  transition: 'color 120ms',
                }}
                  onMouseEnter={e => e.target.style.color='#E8E8E8'}
                  onMouseLeave={e => e.target.style.color=a}>{'> DETAILS'}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

window.Products = Products;
