import React from 'react';

// One subscription instead of six — every component that branched on
// window.innerWidth < 768 now reads from this single matchMedia listener.
// `addEventListener('change', …)` is event-driven, not polled — it only
// fires when the breakpoint is actually crossed, which kills the resize-
// thrash that Safari was paying for on every pixel of a window drag.
export function useIsMobile(maxWidth = 767) {
  const query = `(max-width: ${maxWidth}px)`;
  const get = () =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false;
  const [isMobile, setIsMobile] = React.useState(get);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}

export function usePrefersReducedMotion() {
  const get = () =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  const [reduced, setReduced] = React.useState(get);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
