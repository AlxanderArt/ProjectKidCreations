import React from 'react';

const NAV_ITEMS = [
  { label: '// MODS', href: '#mods' },
  { label: '// ABOUT', href: '#about' },
  { label: '// GALLERY', href: '#gallery' },
  { label: '// CONTACT', href: '#contact' },
];

export function Nav() {
  const [open, setOpen] = React.useState(false);
  const toggleRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const restoreToggleFocusRef = React.useRef(false);

  React.useEffect(() => {
    if (open || !restoreToggleFocusRef.current) return;
    restoreToggleFocusRef.current = false;
    toggleRef.current?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return undefined;
    const menu = menuRef.current;
    const focusable = [...(menu?.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    focusable[0]?.focus();
    const dismiss = (event) => {
      if (event.key === 'Escape') {
        restoreToggleFocusRef.current = true;
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open]);

  return (
    <nav className="pkc-nav" aria-label="Primary">
      <div className="pkc-nav__brand-row">
        <a href="#top" className="pkc-nav__logo" aria-label="ProjectKidCreations — home">
          PROJECT<span className="pkc-accent-text">KID</span>CREATIONS
        </a>
      </div>

      <div className="pkc-nav__tabs">
        <ul className="pkc-nav__links">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <a href={item.href} className="pkc-nav__link">{item.label}</a>
            </li>
          ))}
          <li>
            <a href="#contact" className="pkc-nav__cta pkc-button pkc-button--primary">
              ENTER
            </a>
          </li>
        </ul>
        <button
          ref={toggleRef}
          className="pkc-nav__toggle"
          aria-expanded={open}
          aria-controls="pkc-mobile-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(!open)}
        >
          {open ? '[ X ]' : '[ = ]'}
        </button>
      </div>

      {open && (
        <div
          ref={menuRef}
          id="pkc-mobile-menu"
          className="pkc-nav__mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation"
        >
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="pkc-nav__mobile-link"
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
          <a
            href="#contact"
            className="pkc-nav__mobile-cta pkc-button pkc-button--primary"
            onClick={() => setOpen(false)}
          >
            ENTER
          </a>
        </div>
      )}
    </nav>
  );
}
