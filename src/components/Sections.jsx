import React from 'react';

const PKC_GRID = [
  { label: '// DETAIL SHOT — TEXTURE CLOSE-UP', wide: true },
  { label: '// MOUNTED ON BLASTER', wide: false },
  { label: '// WORKSHOP / PRINT PROCESS', wide: false },
  { label: '// FULL MOD LINEUP', wide: true },
];

export function Showcase() {
  return (
    <section id="gallery" className="pkc-section pkc-showcase">
      <div className="pkc-container">
        <div className="pkc-eyebrow">// GALLERY</div>
        <h2 className="pkc-section-title pkc-showcase__title">THE CRAFT</h2>
        <div className="pkc-showcase__grid">
          {PKC_GRID.map((item, i) => (
            <div key={i} className={`pkc-showcase__item ${item.wide ? 'pkc-showcase__item--wide' : ''}`}>
              <div className="pkc-showcase__label">{item.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Social() {
  const ref = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  React.useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVis(true); }, { threshold: 0.2 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <section ref={ref} className={`pkc-section pkc-social ${vis ? 'pkc-visible' : ''}`}>
      <div className="pkc-container pkc-container--narrow">
        <div className="pkc-eyebrow pkc-social__eyebrow">// INTEL</div>

        <div className="pkc-social__quote">
          <p className="pkc-social__quote-text">
            "The fitment is insane — dropped right in, zero modifications. Best mods I've bought."
          </p>
          <p className="pkc-social__quote-source">— @tacticalbuilds</p>
        </div>

        <div className="pkc-social__stats">
          {[['500+', 'MODS SOLD'], ['50+', 'UNIQUE DESIGNS'], ['4.9', 'AVG RATING']].map(([n, l], i) => (
            <div key={i} className="pkc-social__stat">
              <div className="pkc-social__stat-number">{n}</div>
              <div className="pkc-social__stat-label">{l}</div>
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
    <section ref={ref} className="pkc-spec-strip">
      <div className="pkc-marquee-viewport">
        <div className={`pkc-marquee-track pkc-spec-strip__track ${inView ? '' : 'pkc-paused'}`}>
          {ROW.map(([label, val], i) => (
            <div key={i} className="pkc-spec-strip__item">
              <span className="pkc-spec-strip__label">{label}</span>
              <span className="pkc-spec-strip__value">{val}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCTA() {
  return (
    <section id="contact" className="pkc-section pkc-final-cta">
      <div aria-hidden="true" className="pkc-final-cta__glow" />

      <div className="pkc-container pkc-container--narrow pkc-final-cta__content">
        <div className="pkc-eyebrow pkc-final-cta__eyebrow">// READY?</div>
        <h2 className="pkc-section-title pkc-final-cta__title">BUILD YOUR SETUP</h2>
        <p className="pkc-final-cta__description">// Custom mods. Premium quality. Your style.</p>

        <div className="pkc-final-cta__actions">
          <a href="#mods" className="pkc-button pkc-button--primary">
            VIEW MODS <span aria-hidden="true">→</span>
          </a>
          <a href="mailto:hello@projectkidcreations.com" className="pkc-button pkc-button--secondary">
            CONTACT US
          </a>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="pkc-footer">
      <div className="pkc-container pkc-footer__inner">
        <div>
          <div className="pkc-footer__brand">
            PROJECT<span className="pkc-accent-text">KID</span>CREATIONS
          </div>
          <div className="pkc-footer__copyright">{`// ${year} PROJECTKIDCREATIONS. ALL RIGHTS RESERVED.`}</div>
        </div>
        <div className="pkc-footer__links">
          {[
            ['TIKTOK', 'https://www.tiktok.com/@projectkidcreations'],
            ['PRIVACY', '/privacy/'],
            ['TERMS', '/terms/'],
          ].map(([l, href]) => (
            <a
              key={l}
              href={href || '#'}
              aria-disabled={!href || href === '#' ? 'true' : undefined}
              rel={href && href !== '#' && href.startsWith('http') ? 'noopener noreferrer' : undefined}
              target={href && href !== '#' && href.startsWith('http') ? '_blank' : undefined}
              className="pkc-footer__link"
            >
              {l}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
