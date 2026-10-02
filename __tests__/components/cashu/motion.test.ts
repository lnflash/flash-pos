import {Animated, Easing} from 'react-native';

import {
  EASE,
  MIN_SAMPLES,
  keyframes,
  kf,
  loop,
  play,
  snapTo,
  toward,
  warmUp,
  type Key,
} from '../../../src/components/cashu/charge/motion';

/** Inputs strictly between two keys' clock positions (exclusive, inclusive]. */
const inside = (input: number[], from: number, to: number) =>
  input.filter(x => x > from + 1e-9 && x <= to + 1e-9);

describe('keyframes', () => {
  const D = 620;
  const keys: Key[] = [
    {t: 0, v: 0},
    {t: 80, v: 0},
    {t: 560, v: 70, ease: 'INOUT'},
    {t: 600, v: 70},
  ];

  it('is strictly increasing and spans the whole clock', () => {
    const {inputRange, outputRange} = keyframes(keys, D);
    expect(inputRange.length).toBe(outputRange.length);
    for (let i = 1; i < inputRange.length; i++) {
      expect(inputRange[i]).toBeGreaterThan(inputRange[i - 1]);
    }
    expect(inputRange[0]).toBe(0);
    expect(inputRange[inputRange.length - 1]).toBe(1);
  });

  it('hits every key exactly, endpoints included', () => {
    const {inputRange, outputRange} = keyframes(keys, D);
    expect(outputRange[0]).toBe(0);
    expect(outputRange[outputRange.length - 1]).toBe(70);
    for (const key of keys) {
      const i = inputRange.findIndex(x => Math.abs(x - key.t / D) < 1e-9);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(outputRange[i]).toBe(key.v);
    }
  });

  it('keeps holds flat: a hold emits only its endpoint', () => {
    const {inputRange, outputRange} = keyframes(keys, D);
    expect(inside(inputRange, 0, 80 / D)).toEqual([80 / D]);
    const holdStart = inputRange.indexOf(80 / D);
    expect(outputRange[holdStart]).toBe(0);
    // ...and the tail hold after the last key is a single flat point at 1.
    expect(inside(inputRange, 560 / D, 1).length).toBe(2);
    expect(outputRange.slice(-2)).toEqual([70, 70]);
  });

  it('samples each eased segment at max(10, ceil(dt/16)) points of its bezier', () => {
    const {inputRange, outputRange} = keyframes(keys, D);
    const samples = inside(inputRange, 80 / D, 560 / D);
    expect(samples.length).toBe(Math.max(MIN_SAMPLES, Math.ceil(480 / 16)));
    // Every sample lies on the INOUT curve.
    samples.forEach(x => {
      const i = inputRange.indexOf(x);
      const u = (x * D - 80) / 480;
      expect(outputRange[i]).toBeCloseTo(70 * EASE.INOUT(u), 6);
    });
    // A short eased segment still gets at least ten samples.
    const short = keyframes(
      [
        {t: 0, v: 0},
        {t: 40, v: 1, ease: 'OUT'},
      ],
      400,
    );
    expect(inside(short.inputRange, 0, 40 / 400).length).toBe(MIN_SAMPLES);
  });

  it('bakes a linear segment as a single endpoint', () => {
    const {inputRange} = keyframes(
      [
        {t: 0, v: 0},
        {t: 100, v: 1},
      ],
      100,
    );
    expect(inputRange).toEqual([0, 1]);
  });

  it('keeps a same-time jump strictly increasing', () => {
    const {inputRange, outputRange} = keyframes(
      [
        {t: 0, v: 0.44},
        {t: 310, v: 0.44},
        {t: 310, v: 1},
      ],
      620,
    );
    for (let i = 1; i < inputRange.length; i++) {
      expect(inputRange[i]).toBeGreaterThan(inputRange[i - 1]);
    }
    expect(outputRange).toEqual([0.44, 0.44, 1, 1]);
  });

  it('rejects keys out of order', () => {
    expect(() =>
      keyframes(
        [
          {t: 100, v: 0},
          {t: 50, v: 1},
        ],
        200,
      ),
    ).toThrow(/out of order/);
  });

  it('bakes the badge overshoot within 4 %', () => {
    const {outputRange} = keyframes(
      [
        {t: 60, v: 0.56},
        {t: 300, v: 0.83, ease: 'OUT'},
        {t: 420, v: 0.8, ease: 'INOUT'},
      ],
      1200,
    );
    expect(Math.max(...outputRange)).toBeLessThanOrEqual(0.8 * 1.04 + 1e-9);
  });
});

describe('the native-only primitives', () => {
  let timing: jest.SpyInstance;
  beforeEach(() => {
    timing = jest.spyOn(Animated, 'timing');
  });
  afterEach(() => {
    timing.mockRestore();
  });

  it('kf clamps and never passes easing to interpolate', () => {
    const clock = new Animated.Value(0);
    const interpolate = jest.spyOn(clock, 'interpolate');
    kf(
      clock,
      [
        {t: 0, v: 0},
        {t: 100, v: 1, ease: 'OUT'},
      ],
      200,
    );
    const config = interpolate.mock.calls[0][0] as Record<string, unknown>;
    expect(config.extrapolate).toBe('clamp');
    expect(config).not.toHaveProperty('easing');
    expect(config).not.toHaveProperty('extrapolateLeft');
  });

  it('play runs ONE linear native timing, starting below 0 for a lead', () => {
    const clock = new Animated.Value(0.5);
    play(clock, 620, {lead: 310, timeScale: 0.5});
    expect(timing).toHaveBeenCalledTimes(1);
    const [value, config] = timing.mock.calls[0];
    expect(value).toBe(clock);
    expect(config).toMatchObject({
      toValue: 1,
      duration: (620 + 310) / 0.5,
      useNativeDriver: true,
    });
    expect(config.easing).toBe(Easing.linear);
    expect(config).not.toHaveProperty('delay');
    expect(
      (clock as unknown as {__getValue: () => number}).__getValue(),
    ).toBeCloseTo(-0.5, 9);
  });

  it('play with no lead starts the clock at exactly 0', () => {
    const clock = new Animated.Value(1);
    play(clock, 400);
    expect((clock as unknown as {__getValue: () => number}).__getValue()).toBe(
      0,
    );
  });

  it('toward is one eased native timing with no delay', () => {
    const value = new Animated.Value(0);
    toward(value, 1, 240, 'STD', 0.5);
    const [, config] = timing.mock.calls[0];
    expect(config).toMatchObject({
      toValue: 1,
      duration: 480,
      useNativeDriver: true,
    });
    expect(config.easing).toBe(EASE.STD);
    expect(config).not.toHaveProperty('delay');
  });

  it('loop wraps a single linear native timing', () => {
    const animatedLoop = jest.spyOn(Animated, 'loop');
    const value = new Animated.Value(0.3);
    const animation = loop(value, 2400);
    expect(animatedLoop).toHaveBeenCalledTimes(1);
    expect(animatedLoop.mock.calls[0][0]).toBe(timing.mock.results[0].value);
    const [, config] = timing.mock.calls[0];
    expect(config).toMatchObject({
      toValue: 1,
      duration: 2400,
      useNativeDriver: true,
    });
    expect(config.easing).toBe(Easing.linear);
    expect((value as unknown as {__getValue: () => number}).__getValue()).toBe(
      0,
    );
    animation.stop();
    animatedLoop.mockRestore();
  });

  it('snapTo sets the value now AND sends a 0 ms native timing to it, so JS cannot keep a stale stop value', () => {
    const value = new Animated.Value(0.45);
    const setValue = jest.spyOn(value, 'setValue');
    snapTo(value, 0);
    expect(setValue).toHaveBeenCalledWith(0);
    expect(timing).toHaveBeenCalledTimes(1);
    const [target, config] = timing.mock.calls[0];
    expect(target).toBe(value);
    expect(config).toMatchObject({
      toValue: 0,
      duration: 0,
      useNativeDriver: true,
    });
    expect(config).not.toHaveProperty('delay');
    // The native end report of that timing is what re-syncs JS; simulate a
    // stale stop report landing first, then the snap's own end report.
    (
      value as unknown as {__onAnimatedValueUpdateReceived: (v: number) => void}
    ).__onAnimatedValueUpdateReceived(0.45);
    (
      value as unknown as {__onAnimatedValueUpdateReceived: (v: number) => void}
    ).__onAnimatedValueUpdateReceived(0);
    expect((value as unknown as {__getValue: () => number}).__getValue()).toBe(
      0,
    );
  });

  it('warmUp sends a 0 ms native timing to every value, at its own value', () => {
    const a = new Animated.Value(0);
    const b = new Animated.Value(2);
    warmUp([
      [a, 0],
      [b, 2],
    ]);
    expect(
      timing.mock.calls.map(([value, config]) => [
        value,
        config.toValue,
        config.duration,
        config.useNativeDriver,
      ]),
    ).toEqual([
      [a, 0, 0, true],
      [b, 2, 0, true],
    ]);
  });
});
