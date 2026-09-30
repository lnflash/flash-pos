import {useEffect, useState} from 'react';

export const STALL_MS = 2500;

/**
 * True when no phase has arrived for STALL_MS. The on-card Schnorr sign can
 * take ~1 s during PIN verify and each burn with nothing visibly moving, so
 * the stage shows "Hold still" rather than letting a still hand see a still
 * screen. Disabled where a loop already says "working" (the mint orbit) and
 * outside the running phase; cleared on every phase and on unmount.
 */
export function useStallTimer(seq: number, enabled: boolean): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!enabled) {
      return;
    }
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [seq, enabled]);
  return stalled && enabled;
}
