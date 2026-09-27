import React from 'react';
import { PRODUCTS } from '../data/products.js';

export function Products() {
  const sectionRef = React.useRef(null);
  const [vis, setVis] = React.useState(false);

  React.useEffect(() => {
    if (!sectionRef.current) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVis(true);
    }, { threshold: 0.05, rootMargin: '120px 0px' });
    observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="mods" ref={sectionRef} className={`pkc-section pkc-products ${vis ? 'pkc-visible' : ''}`}>
      <div className="pkc-container">
        <div className="pkc-products__heading">
          <div>
            <div className="pkc-eyebrow">// CATALOG</div>
            <h2 className="pkc-products__title">FEATURED MODS</h2>
          </div>
          <p className="pkc-products__launch-note">// DETAIL PAGES LAUNCH WITH THE SHOP</p>
        </div>

        <div className="pkc-products__track">
          {PRODUCTS.map((product, index) => (
            <article key={product.slug} className="pkc-product-card">
              <div
                className={`pkc-product-card__visual pkc-product-card__visual--${(index % 3) + 1}`}
                aria-hidden="true"
              >
                <span className="pkc-product-card__reticle" />
                <span className="pkc-product-card__part" />
                <span className="pkc-product-card__rail" />
                <span className="pkc-product-card__index">{String(index + 1).padStart(2, '0')}</span>
                {product.tag && <span className="pkc-product-card__tag">{product.tag}</span>}
              </div>

              <div className="pkc-product-card__body">
                <h3 className="pkc-product-card__title">{product.name}</h3>
                <p className="pkc-product-card__description">{product.blurb}</p>
                <p className="pkc-product-card__status">// PREVIEW CATALOG</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
