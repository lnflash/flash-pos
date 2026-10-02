import {useEffect, useState} from 'react';
import {AccessibilityInfo} from 'react-native';

/**
 * The system "reduce motion" setting, read once at app start and kept
 * current, so a screen's FIRST render already knows it — learning it a few
 * ms after mount would rebuild an animated graph mid-push (the card charge)
 * or start a rise that should have been a fade (Success's hand-off).
 */
let systemReduceMotion = false;
try {
  AccessibilityInfo.isReduceMotionEnabled?.()
    ?.then(enabled => {
      systemReduceMotion = !!enabled;
    })
    .catch(() => {});
  AccessibilityInfo.addEventListener?.('reduceMotionChanged', enabled => {
    systemReduceMotion = !!enabled;
  });
} catch {
  // No accessibility module (tests, previews): motion stays on.
}

/** The system setting (live), unless `override` pins it (the preview's toggle). */
export function useReduceMotion(override?: boolean): boolean {
  const [system, setSystem] = useState(() => systemReduceMotion);
  useEffect(() => {
    if (override !== undefined) {
      return;
    }
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      ?.then(enabled => live && setSystem(!!enabled))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.(
      'reduceMotionChanged',
      enabled => setSystem(!!enabled),
    );
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, [override]);
  return override ?? system;
}
