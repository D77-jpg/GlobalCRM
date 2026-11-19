import * as React from 'react';

/**
 * Visibility-aware, non-overlapping polling hook.
 * Pauses automatically when the browser tab is hidden and catches up once visible again.
 */
export function useVisibilityPolling(
  callback: () => void | Promise<unknown>,
  intervalMs: number,
  enabled = true,
): void {
  const cbRef = React.useRef(callback);
  cbRef.current = callback;

  React.useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    let inFlight = false;
    let disposed = false;

    const tick = async () => {
      if (disposed || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        await cbRef.current();
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => { void tick(); }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled]);
}
