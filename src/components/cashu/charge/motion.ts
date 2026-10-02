import {Animated, Easing} from 'react-native';

import {BEZIER} from './tokens';

/**
 * The motion engine's only primitives. Every animated property on the charge
 * stage is an interpolation of a handful of native Animated values:
 *
 *  - a GESTURE is one linear native timing on its own clock (`play`); holds,
 *    sub-steps and per-element easing are baked into keyframes (`kf`), and a
 *    wait for an earlier gesture is baked in by starting the clock below 0;
 *  - a PRESENCE value is retargeted by one eased native timing (`toward`),
 *    which continues from the native current value — no snap;
 *  - an AMBIENT clock is a native loop around a single timing (`loop`), the
 *    only loop shape React Native runs without a JS round-trip per cycle.
 *
 * Nothing here uses Animated.sequence/parallel/stagger/delay, the `delay:`
 * option, start callbacks, listeners or the JS driver — so APDUs, secp256k1
 * and redux on the JS thread can never stall a frame.
 */

export type EaseName = 'OUT' | 'INOUT' | 'IN' | 'STD' | 'LIN';

export const EASE: Record<EaseName, (t: number) => number> = {
  OUT: Easing.bezier(
    BEZIER.OUT[0],
    BEZIER.OUT[1],
    BEZIER.OUT[2],
    BEZIER.OUT[3],
  ),
  INOUT: Easing.bezier(
    BEZIER.INOUT[0],
    BEZIER.INOUT[1],
    BEZIER.INOUT[2],
    BEZIER.INOUT[3],
  ),
  IN: Easing.bezier(BEZIER.IN[0], BEZIER.IN[1], BEZIER.IN[2], BEZIER.IN[3]),
  STD: Easing.bezier(
    BEZIER.STD[0],
    BEZIER.STD[1],
    BEZIER.STD[2],
    BEZIER.STD[3],
  ),
  LIN: Easing.linear,
};

export interface Key {
  /** ms from the gesture start. */
  t: number;
  v: number;
  /** The curve ARRIVING at this key. Omitted = linear. */
  ease?: EaseName;
}

export interface Keyframes {
  inputRange: number[];
  outputRange: number[];
}

/** Minimum bezier samples per eased segment. */
export const MIN_SAMPLES = 10;
const JUMP = 1e-6;

/**
 * Bakes keys into an interpolation table on a 0..1 clock of `duration` ms.
 * A flat segment (a hold) or a linear one emits only its endpoint; an eased
 * segment is sampled at max(10, ceil(Δt/16)) points of its bezier — the
 * native driver drops `easing` on interpolate (RN 0.77's
 * AnimatedInterpolation.__getNativeConfig carries none), so the curve has to
 * live in the table itself.
 */
export function keyframes(keys: readonly Key[], duration: number): Keyframes {
  if (keys.length === 0) {
    throw new Error('keyframes: at least one key');
  }
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  const push = (t: number, v: number) => {
    let x = t / duration;
    const last = inputRange[inputRange.length - 1];
    if (last !== undefined && x <= last) {
      x = last + JUMP;
    }
    inputRange.push(x);
    outputRange.push(v);
  };
  const first = keys[0];
  push(0, first.v);
  if (first.t > 0) {
    push(first.t, first.v);
  }
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (b.t < a.t) {
      throw new Error(`keyframes: keys out of order at ${b.t}`);
    }
    const dt = b.t - a.t;
    const dv = b.v - a.v;
    const ease = b.ease ?? 'LIN';
    if (dt === 0 || dv === 0 || ease === 'LIN') {
      push(b.t, b.v);
      continue;
    }
    const n = Math.max(MIN_SAMPLES, Math.ceil(dt / 16));
    const f = EASE[ease];
    for (let s = 1; s <= n; s++) {
      const u = s / n;
      push(a.t + dt * u, s === n ? b.v : a.v + dv * f(u));
    }
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey.t < duration) {
    push(duration, lastKey.v);
  }
  return {inputRange, outputRange};
}

/** A clamped keyframe node on a gesture clock. Never passes `easing`. */
/**
 * The progress u in [0, 1] at which a (monotone) bezier token reaches y —
 * e.g. the frame on which a flood eased by INOUT reaches a given radius.
 */
export function easeInverse(name: EaseName, y: number): number {
  if (y <= 0) {
    return 0;
  }
  if (y >= 1) {
    return 1;
  }
  const f = EASE[name];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < y) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export function kf(
  clock: Animated.Value | Animated.AnimatedInterpolation<number>,
  keys: readonly Key[],
  duration: number,
): Animated.AnimatedInterpolation<number> {
  return clock.interpolate({
    ...keyframes(keys, duration),
    extrapolate: 'clamp',
  });
}

/** A straight clamped mapping, for presence values and ambient clocks. */
export function map(
  value: Animated.Value | Animated.AnimatedInterpolation<number>,
  inputRange: number[],
  outputRange: number[],
): Animated.AnimatedInterpolation<number> {
  return value.interpolate({inputRange, outputRange, extrapolate: 'clamp'});
}

export interface PlayOptions {
  /** ms the rest pose holds natively before the gesture begins. */
  lead?: number;
  /** 0.5 plays at half speed (the preview's slow-motion). */
  timeScale?: number;
}

/**
 * One gesture: ONE native linear timing from -lead/D to 1. The lead is a
 * clamped flat stretch of every interpolation on this clock — no `delay:`
 * option (a JS setTimeout) and no JS timer.
 */
export function play(
  clock: Animated.Value,
  duration: number,
  {lead = 0, timeScale = 1}: PlayOptions = {},
): Animated.CompositeAnimation {
  const from = lead > 0 ? -lead / duration : 0;
  clock.setValue(from);
  const animation = Animated.timing(clock, {
    toValue: 1,
    duration: (duration + lead) / timeScale,
    easing: Easing.linear,
    useNativeDriver: true,
    isInteraction: false,
  });
  animation.start();
  return animation;
}

/**
 * A presence change: one eased native timing from wherever the native value
 * is now. A phase that lands mid-flight just retargets — nothing jumps.
 */
export function toward(
  value: Animated.Value,
  to: number,
  ms: number,
  ease: EaseName = 'STD',
  timeScale = 1,
): Animated.CompositeAnimation {
  const animation = Animated.timing(value, {
    toValue: to,
    duration: Math.max(0, ms / timeScale),
    easing: EASE[ease],
    useNativeDriver: true,
    isInteraction: false,
  });
  animation.start();
  return animation;
}

/**
 * An ambient clock: 0→1 over `period`, forever, on the native driver. A loop
 * around a single timing is the only loop RN hands to native in one call
 * (`_startNativeLoop`); ping-pong comes from interpolating [0,.5,1].
 */
export function loop(
  value: Animated.Value,
  period: number,
  timeScale = 1,
): Animated.CompositeAnimation {
  value.setValue(0);
  const animation = Animated.loop(
    Animated.timing(value, {
      toValue: 1,
      duration: period / timeScale,
      easing: Easing.linear,
      useNativeDriver: true,
      isInteraction: false,
    }),
  );
  animation.start();
  return animation;
}

/**
 * Puts a value at `to` NOW — natively AND in JS. A bare setValue() on a value
 * whose native animation is still running stops it, and React Native then
 * reports the value it was stopped at back to JS (Animation.js
 * __onAnimatedValueUpdateReceived) — AFTER the setValue. The JS copy goes
 * stale, and the next React render pushes props computed from it onto every
 * view the native driver is not updating at that moment, where they stay.
 * Seen on the device: the finale's badge and paid title sitting on a fresh
 * charge, and a phase pill from the last attempt at W0. A 0 ms native timing
 * to the same value reports AFTER that stale value, so JS settles on `to`.
 */
export function snapTo(value: Animated.Value, to: number): void {
  value.setValue(to);
  Animated.timing(value, {
    toValue: to,
    duration: 0,
    useNativeDriver: true,
    isInteraction: false,
  }).start();
}

/**
 * Moves every value to the native side at mount (a 0 ms timing to its own
 * value), so the first phase of a charge sends only `start` — no burst of
 * node creation next to the first burn's APDUs.
 */
export function warmUp(
  values: ReadonlyArray<readonly [Animated.Value, number]>,
): void {
  for (const [value, at] of values) {
    Animated.timing(value, {
      toValue: at,
      duration: 0,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }
}

/** performance.now where it exists (RN, jest), Date.now otherwise. */
export function now(): number {
  const p = (globalThis as {performance?: {now?: () => number}}).performance;
  return p?.now ? p.now() : Date.now();
}
