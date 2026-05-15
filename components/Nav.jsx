/* ── PKC Nav — matches live site exactly ── */

const pkcNavStyles = {
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
  cta: (a) => ({
    background: 'transparent', color: a, border: `1px solid ${a}`,
    padding: '8px 18px', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', fontFamily: '"JetBrains Mono", monospace',
    letterSpacing: '0.05em', textTransform: 'uppercase',
    transition: 'background 120ms cubic-bezier(0.2,0.8,0.2,1), color 120ms cubic-bezier(0.2,0.8,0.2,1)',
    clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)',
    borderRadius: '2px',
  }),
  mobileToggle: {
    display: 'none', background: 'none', border: 'none',
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
  },
};

function Nav({ accent }) {
  const a = accent || '#FF5F1F';
  const [open, setOpen] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(window.innerWidth < 768);

  React.useEffect(() => {
    const h = () => { setIsMobile(window.innerWidth < 768); if (window.innerWidth >= 768) setOpen(false); };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  const navItems = ['// MODS', '// ABOUT', '// GALLERY', '// CONTACT'];

  return (
    <nav style={pkcNavStyles.nav}>
      <div style={pkcNavStyles.inner}>
        <div style={pkcNavStyles.logo}>
          PROJECT<span style={{color: a}}>KID</span>CREATIONS
        </div>
        {!isMobile ? (
          <ul style={pkcNavStyles.links}>
            {navItems.map(l => (
              <li key={l}><a style={pkcNavStyles.link}
                onMouseEnter={e => e.target.style.color=a}
                onMouseLeave={e => e.target.style.color='#9AA0A4'}>{l}</a></li>
            ))}
            <li><button style={pkcNavStyles.cta(a)}
              onMouseEnter={e => { e.target.style.background=a; e.target.style.color='#0A0A0A'; }}
              onMouseLeave={e => { e.target.style.background='transparent'; e.target.style.color=a; }}>ENTER</button></li>
          </ul>
        ) : (
          <button style={{...pkcNavStyles.mobileToggle, display:'block'}} onClick={() => setOpen(!open)}>
            {open ? '[ X ]' : '[ = ]'}
          </button>
        )}
      </div>
      {open && isMobile && (
        <div style={pkcNavStyles.mobileMenu}>
          {navItems.map(l => <a key={l} style={pkcNavStyles.mobileLink} onClick={() => setOpen(false)}>{l}</a>)}
          <button style={{...pkcNavStyles.cta(a), fontSize: 13, padding: '12px 24px', marginTop: 8}}
            onMouseEnter={e => { e.target.style.background=a; e.target.style.color='#0A0A0A'; }}
            onMouseLeave={e => { e.target.style.background='transparent'; e.target.style.color=a; }}>ENTER</button>
        </div>
      )}
    </nav>
  );
}

window.Nav = Nav;
