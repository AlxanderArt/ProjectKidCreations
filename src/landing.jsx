import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccentProvider } from './AccentContext.jsx';
import { Nav } from './components/Nav.jsx';
import { Hero } from './components/Hero.jsx';
import { Products } from './components/Products.jsx';
import { ValueProps } from './components/ValueProps.jsx';
import { Showcase, Social, SpecStrip, FinalCTA, Footer } from './components/Sections.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';

function App() {
  return (
    <ErrorBoundary>
      <AccentProvider value="#FF5F1F">
        <Nav />
        <Hero />
        <Products />
        <SpecStrip />
        <ValueProps />
        <Showcase />
        <Social />
        <FinalCTA />
        <Footer />
      </AccentProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById('root')).render(<App />);
