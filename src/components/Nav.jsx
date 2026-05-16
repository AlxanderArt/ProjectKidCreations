import React from 'react';
import { useAccent } from '../AccentContext.jsx';
import { useIsMobile } from '../hooks.js';

const navStyles = {
  nav: {
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
    background: 'rgba(10,10,10,0.95)', backdropFilter: 'blur(8px)',
    borderBottom: '1px solid #3F4448',
  },
  inner: {
    maxWidth: 1280, margin: '0 auto',
    padding: '0 32px', height: 56,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  logo: {
    fontFamily: '"Archivo Black", sans-serif',
    fontWeight: 900, fontSize: 15, letterSpacing: '-0.02em',
    color: '#E8E8E8', textTransform: 'uppercase', cursor: 'pointer',
  },
  links: {
    display: 'flex', gap: 28, alignItems: 'center',
    listStyle: 'none', margin: 0, padding: 0,
  },
  link: {
    color: '#9AA0A4', fontSize: 12, fontWeight: 500,
    letterSpacing: '0.05em', textTransform: 'uppercase',
    cursor: 'pointer', transition: 'color 120ms cubic-bezier(0.2,0.8,0.2,1)',
    textDecoration: 'none', fontFamily: '"JetBrains Mono", monospace',
  },
  mobileToggle: {
    display: 'block', background: 'none', border: 'none',
    color: '#E8E8E8', fontSize: 16, cursor: 'pointer', padding: 8,
    fontFamily: '"JetBrains Mono", monospace', letterSpacing: '0.1em',
  },
  mobileMenu: {
    position: 'fixed', top: 56, left: 0, right: 0, bottom: 0,
    background: '#0A0A0A', zIndex: 99,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    padding: '32px', gap: 24,
    borderTop: '1px solid #3F4448',
  },
  mobileLink: {
    color: '#9AA0A4', fontSize: 13, fontWeight: 500,
    textTransform: 'uppercase', letterSpacing: '0.05em',
    cursor: 'pointer', fontFamily: '"JetBrains Mono", monospace',
    textDecoration: 'none',
  },
};

const NAV_ITEMS = [
  { label: '// MODS',    href: '#mods' },
  { label: '// ABOUT',   href: '#about' },
  { label: '// GALLERY', href: '#gallery' },
  { label: '// CONTACT', href: '#contact' },
];

function ctaStyle(accent) {
  return {
    background: 'transparent', color: accent, border: `1px solid ${accent}`,
    padding: '8px 18px', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', fontFamily: '"JetBrains Mono", monospace',
    letterSpacing: '0.05em', textTransform: 'uppercase',
    transition: 'background 120ms cubic-bezier(0.2,0.8,0.2,1), color 120ms cubic-bezier(0.2,0.8,0.2,1)',
    clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)',
    borderRadius: '2px',
  };
}

export function Nav() {
  const a = useAccent();
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => { if (!isMobile && open) setOpen(false); }, [isMobile, open]);

  return (
    <nav style={navStyles.nav} aria-label="Primary">
      <div style={navStyles.inner}>
        <a href="#top" style={navStyles.logo} aria-label="ProjectKidCreations — home">
          PROJECT<span style={{color: a}}>KID</span>CREATIONS
        </a>
        {!isMobile ? (
          <ul style={navStyles.links}>
            {NAV_ITEMS.map(item => (
              <li key={item.href}>
                <a href={item.href} style={navStyles.link}
                   onMouseEnter={e => e.currentTarget.style.color=a}
                   onMouseLeave={e => e.currentTarget.style.color='#9AA0A4'}>
                  {item.label}
                </a>
              </li>
            ))}
            <li>
              <a href="#contact" style={ctaStyle(a)} role="button"
                 onMouseEnter={e => { e.currentTarget.style.background=a; e.currentTarget.style.color='#0A0A0A'; }}
                 onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color=a; }}>
                ENTER
              </a>
            </li>
          </ul>
        ) : (
          <button style={navStyles.mobileToggle}
                  aria-expanded={open}
                  aria-controls="pkc-mobile-menu"
                  aria-label={open ? 'Close menu' : 'Open menu'}
                  onClick={() => setOpen(!open)}>
            {open ? '[ X ]' : '[ = ]'}
          </button>
        )}
      </div>
      {open && isMobile && (
        <div id="pkc-mobile-menu" style={navStyles.mobileMenu}>
          {NAV_ITEMS.map(item => (
            <a key={item.href} href={item.href} style={navStyles.mobileLink}
               onClick={() => setOpen(false)}>{item.label}</a>
          ))}
          <a href="#contact" style={{...ctaStyle(a), fontSize: 13, padding: '12px 24px', marginTop: 8}}
             role="button" onClick={() => setOpen(false)}>ENTER</a>
        </div>
      )}
    </nav>
  );
}
