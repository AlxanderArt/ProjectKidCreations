import React from 'react';

const PKC_VALUES = [
  { icon: '◆', title: 'CUSTOM DESIGN', desc: 'Every mod designed in-house. Unique geometry you won\'t find anywhere else.' },
  { icon: '▣', title: 'QUALITY MATERIALS', desc: 'Premium PLA+ and PETG filaments. Durability, precision, clean finish.' },
  { icon: '◎', title: 'UNIQUE AESTHETIC', desc: 'Tactical meets creative. Parts that perform and look like they belong.' },
  { icon: '⬡', title: 'PERFORMANCE FIT', desc: 'Engineered tolerances for drop-in fitment. No filing. No forcing.' },
];

export function ValueProps() {
  const ref = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  React.useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVis(true); }, { threshold: 0.12 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <section id="about" ref={ref} className={`pkc-section pkc-values ${vis ? 'pkc-visible' : ''}`}>
      <div className="pkc-container">
        <div className="pkc-eyebrow">// WHY PKC</div>

        <h2 className="pkc-section-title pkc-values__title">
          BUILT DIFFERENT.<br/><span className="pkc-accent-text">BY DESIGN.</span>
        </h2>

        <div className="pkc-values__grid">
          {PKC_VALUES.map((v, i) => (
            <div key={i} className="pkc-value-card">
              <div aria-hidden="true" className="pkc-value-card__icon">{v.icon}</div>
              <h3 className="pkc-value-card__title">{v.title}</h3>
              <p className="pkc-value-card__description">{v.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
