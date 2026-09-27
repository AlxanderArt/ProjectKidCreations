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
      <div className="pkc-error-boundary">
        <div className="pkc-error-boundary__content">
          <div className="pkc-error-boundary__eyebrow">// SYSTEM ERROR</div>

          <h1 className="pkc-error-boundary__title">
            SOMETHING<br/>
            <span className="pkc-accent-text">BROKE.</span>
          </h1>

          <p className="pkc-error-boundary__message">
            The page hit an unexpected error. Reloading usually fixes it.
            If this keeps happening, drop us a note.
          </p>

          <button
            className="pkc-button pkc-button--primary pkc-error-boundary__reload"
            onClick={() => window.location.reload()}
          >
            RELOAD →
          </button>
        </div>
      </div>
    );
  }
}
