import React from 'react';
import { createRoot } from 'react-dom/client';
import { Nav } from './components/Nav.jsx';
import { Hero } from './components/Hero.jsx';
import { Products } from './components/Products.jsx';
import { ValueProps } from './components/ValueProps.jsx';
import { Showcase, Social, SpecStrip, FinalCTA, Footer } from './components/Sections.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';

const ACCENT = '#FF5F1F';

function App() {
  return (
    <ErrorBoundary>
      <Nav accent={ACCENT} />
      <Hero accent={ACCENT} />
      <Products accent={ACCENT} />
      <SpecStrip accent={ACCENT} />
      <ValueProps accent={ACCENT} />
      <Showcase accent={ACCENT} />
      <Social accent={ACCENT} />
      <FinalCTA accent={ACCENT} />
      <Footer accent={ACCENT} />
    </ErrorBoundary>
  );
}

createRoot(document.getElementById('root')).render(<App />);
