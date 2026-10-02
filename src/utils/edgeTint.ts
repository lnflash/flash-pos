import {Animated} from 'react-native';

import {play, snapTo, toward} from '../components/cashu/charge/motion';

/**
 * The status- and navigation-bar insets are outside every screen: on Android
 * 15+ (edge-to-edge, targetSdk 35) StatusBar.setBackgroundColor is ignored,
 * so the green that floods the card charge would stop at the insets. Two
 * strips at the root (see <EdgeTint/> in App.tsx) sit under the navigator
 * and show only through the insets. Each strip has its own clock: the top
 * one turns green as the flood crosses the frame's top edge, the bottom one
 * as it crosses the bottom edge — they are reached at different times.
 */
export const edgeTintTop = new Animated.Value(0);
export const edgeTintBottom = new Animated.Value(0);

let held = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function clearWatchdog(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

export interface StripTiming {
  /** ms from now until the strip starts to turn green (native, no timer). */
  leadMs: number;
  /** ms the strip takes to reach full green. */
  durationMs: number;
}

/** Tint the insets green, each strip on its own native timing. */
export function showEdgeTint({
  top,
  bottom,
  timeScale = 1,
}: {
  top: StripTiming;
  bottom: StripTiming;
  timeScale?: number;
}): void {
  held = false;
  play(edgeTintTop, top.durationMs, {lead: top.leadMs, timeScale});
  play(edgeTintBottom, bottom.durationMs, {lead: bottom.leadMs, timeScale});
  clearWatchdog();
  // Success claims the tint when it mounts; if it never does, let go.
  const end = Math.max(
    top.leadMs + top.durationMs,
    bottom.leadMs + bottom.durationMs,
  );
  watchdog = setTimeout(() => {
    watchdog = null;
    if (!held) {
      hideEdgeTint();
    }
  }, (end + 1300) / timeScale);
}

/** Success keeps the green while it is on screen. */
export function holdEdgeTint(): void {
  held = true;
  clearWatchdog();
}

export function hideEdgeTint(ms = 200): void {
  held = false;
  clearWatchdog();
  for (const strip of [edgeTintTop, edgeTintBottom]) {
    if (ms <= 0) {
      // snapTo, not setValue: the strips may be mid-fade, and a stale JS
      // copy would put them back on the next render of the root.
      snapTo(strip, 0);
    } else {
      toward(strip, 0, ms, 'STD');
    }
  }
}
