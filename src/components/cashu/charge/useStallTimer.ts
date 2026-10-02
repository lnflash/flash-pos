import {useEffect, useState} from 'react';

export const STALL_MS = 2500;

/**
 * True when no phase has arrived for `ms`. The on-card Schnorr sign can take
 * ~1 s during PIN verify and each burn, so the hold pill says "Keep holding —
 * almost done" rather than letting a still hand wonder. Disabled where the
 * stage already says "working" (the mint settle) and outside the running
 * phase; cleared on every phase and on unmount.
 */
export function useStallTimer(
  seq: number,
  enabled: boolean,
  ms: number = STALL_MS,
): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!enabled) {
      return;
    }
    const timer = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(timer);
  }, [seq, enabled, ms]);
  return stalled && enabled;
}
