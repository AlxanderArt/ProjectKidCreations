import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[pkc] uncaught error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        minHeight: '100vh', background: 'var(--pkc-tac-black)', color: 'var(--pkc-concrete)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"JetBrains Mono", monospace', padding: 32,
      }}>
        <div style={{ maxWidth: 480, textAlign: 'left' }}>
          <div style={{
            fontSize: 11, letterSpacing: '0.08em', color: 'var(--pkc-error)',
            marginBottom: 16, textTransform: 'uppercase',
          }}>// SYSTEM ERROR</div>

          <h1 style={{
            fontFamily: '"Archivo Black", sans-serif', fontWeight: 900,
            fontSize: 36, lineHeight: 1.1, margin: '0 0 16px',
            textTransform: 'uppercase', letterSpacing: '-0.02em',
          }}>
            SOMETHING<br/>
            <span style={{ color: 'var(--pkc-hi-vis)' }}>BROKE.</span>
          </h1>

          <p style={{
            fontSize: 13, color: 'var(--pkc-text-muted)', lineHeight: 1.6, margin: '0 0 24px',
          }}>
            The page hit an unexpected error. Reloading usually fixes it.
            If this keeps happening, drop us a note.
          </p>

          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'transparent', color: 'var(--pkc-hi-vis)', border: '2px solid var(--pkc-hi-vis)',
              padding: '12px 22px', fontSize: 12, fontWeight: 700,
              fontFamily: '"JetBrains Mono", monospace',
              letterSpacing: '0.05em', textTransform: 'uppercase',
              cursor: 'pointer', borderRadius: 2,
              clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)',
            }}>
            RELOAD →
          </button>
        </div>
      </div>
    );
  }
}
