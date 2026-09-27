import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './landing.css';
import { AccentProvider } from './AccentContext.jsx';
import { Nav } from './components/Nav.jsx';
import { Hero } from './components/Hero.jsx';
import { Products } from './components/Products.jsx';
import { ValueProps } from './components/ValueProps.jsx';
import { Showcase, Social, SpecStrip, FinalCTA, Footer } from './components/Sections.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';

function App() {
  const [experienceReady, setExperienceReady] = useState(() => document.documentElement.classList.contains('pkc-motion-ready'));

  useEffect(() => {
    if (experienceReady) return undefined;
    let settled = false;
    let fallbackTimer = null;
    const onMotionReady = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      setExperienceReady(true);
    };
    const failVisible = () => {
      if (settled) return;
      settled = true;
      const root = document.documentElement;
      document.getElementById('pkc-boot')?.remove();
      [...document.body.children].forEach((element) => { element.inert = false; });
      root.classList.remove('pkc-boot-pending', 'pkc-motion-prep', 'pkc-motion-shell', 'pkc-motion-navigation', 'pkc-motion-content');
      root.classList.add('pkc-boot-ready', 'pkc-motion-ready');
      root.dataset.pkcMotionReady = 'landing-fail-visible';
      document.body.dataset.pkcBoot = 'fallback';
      window.dispatchEvent(new CustomEvent('pkc:boot-complete', { detail: { reason: 'landing-fail-visible' } }));
      setExperienceReady(true);
    };
    window.addEventListener('pkc:motion-ready', onMotionReady, { once: true });
    fallbackTimer = window.setTimeout(failVisible, 6_500);
    return () => {
      window.removeEventListener('pkc:motion-ready', onMotionReady);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };
  }, [experienceReady]);

  return (
    <ErrorBoundary>
      <AccentProvider value="#FF5F1F">
        <Nav />
        <main>
          <Hero />
          {experienceReady ? (
            <>
              <Products />
              <SpecStrip />
              <ValueProps />
              <Showcase />
              <Social />
              <FinalCTA />
            </>
          ) : null}
        </main>
        <Footer />
      </AccentProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById('root')).render(<App />);
