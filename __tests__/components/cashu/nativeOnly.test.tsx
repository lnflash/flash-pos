import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import {Animated} from 'react-native';
import {act, fireEvent, render} from '@testing-library/react-native';

jest.mock('react-native-svg', () => require('../../../__mocks__/svgStub'));

import ChargeAnimationPreview from '../../../src/screens/ChargeAnimationPreview';
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
} from '../../../src/components/cashu/charge/previewScript';

/**
 * The engine's contract: every animated property on the charge stage runs on
 * the native driver from ONE start() per gesture, so APDUs, secp256k1 and
 * redux on the JS thread can never stall a frame. This suite runs the real
 * preview scripts through the production ChargeView / ChargeStage and spies
 * on every Animated entry point.
 */

type Config = Record<string, unknown>;

interface Spies {
  timings: Array<{config: Config; animation: Animated.CompositeAnimation}>;
  loops: Array<{arg: unknown; config: unknown}>;
  startArgs: unknown[][];
  banned: Record<string, jest.SpyInstance>;
  addListener: jest.SpyInstance[];
  interpolations: Config[];
  restore: () => void;
}

function spyOnAnimated(): Spies {
  const timings: Spies['timings'] = [];
  const loops: Spies['loops'] = [];
  const startArgs: unknown[][] = [];
  const interpolations: Config[] = [];
  const realTiming = Animated.timing;
  const realLoop = Animated.loop;
  const wrapStart = (animation: Animated.CompositeAnimation) => {
    const start = animation.start.bind(animation);
    animation.start = ((...args: unknown[]) => {
      startArgs.push(args);
      return start(...(args as []));
    }) as typeof animation.start;
    return animation;
  };
  const timing = jest
    .spyOn(Animated, 'timing')
    .mockImplementation((value, config) => {
      const animation = wrapStart(realTiming(value, config));
      timings.push({config: config as unknown as Config, animation});
      return animation;
    });
  const loop = jest
    .spyOn(Animated, 'loop')
    .mockImplementation((arg, config) => {
      const animation = wrapStart(realLoop(arg, config));
      loops.push({arg, config});
      return animation;
    });
  const banned = {
    sequence: jest.spyOn(Animated, 'sequence'),
    parallel: jest.spyOn(Animated, 'parallel'),
    stagger: jest.spyOn(Animated, 'stagger'),
    delay: jest.spyOn(Animated, 'delay'),
    spring: jest.spyOn(Animated, 'spring'),
    decay: jest.spyOn(Animated, 'decay'),
    event: jest.spyOn(Animated, 'event'),
  };
  // Every node class the graph is built from.
  const value = new Animated.Value(0);
  const protos = new Set<object>([
    Object.getPrototypeOf(value),
    Object.getPrototypeOf(
      value.interpolate({inputRange: [0, 1], outputRange: [0, 1]}),
    ),
    Object.getPrototypeOf(Animated.multiply(value, value)),
    Object.getPrototypeOf(Animated.add(value, value)),
  ]);
  const addListener: jest.SpyInstance[] = [];
  const interpolate: jest.SpyInstance[] = [];
  protos.forEach(proto => {
    const target = proto as {
      addListener?: unknown;
      interpolate?: (c: Config) => unknown;
    };
    if (Object.prototype.hasOwnProperty.call(target, 'addListener')) {
      addListener.push(jest.spyOn(target as never, 'addListener' as never));
    }
    if (Object.prototype.hasOwnProperty.call(target, 'interpolate')) {
      const real = target.interpolate!;
      interpolate.push(
        jest
          .spyOn(target as never, 'interpolate' as never)
          .mockImplementation(function (this: unknown, config: Config) {
            interpolations.push(config);
            return real.call(this, config);
          } as never),
      );
    }
  });
  // AnimatedWithChildren / AnimatedNode carry the shared addListener.
  let proto = Object.getPrototypeOf(Object.getPrototypeOf(value));
  while (proto && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, 'addListener')) {
      addListener.push(jest.spyOn(proto, 'addListener'));
    }
    proto = Object.getPrototypeOf(proto);
  }
  return {
    timings,
    loops,
    startArgs,
    banned,
    addListener,
    interpolations,
    restore: () => {
      timing.mockRestore();
      loop.mockRestore();
      Object.values(banned).forEach(spy => spy.mockRestore());
      addListener.forEach(spy => spy.mockRestore());
      interpolate.forEach(spy => spy.mockRestore());
    },
  };
}

function expectNativeOnly(spies: Spies) {
  expect(spies.timings.length).toBeGreaterThan(50);
  spies.timings.forEach(({config}) => {
    expect(config.useNativeDriver).toBe(true);
    expect(config).not.toHaveProperty('delay');
  });
  // A loop only ever wraps a single timing (the one shape RN runs natively).
  const timingResults = new Set(spies.timings.map(t => t.animation));
  spies.loops.forEach(({arg, config}) => {
    expect(timingResults.has(arg as Animated.CompositeAnimation)).toBe(true);
    expect(config).toBeUndefined();
  });
  Object.entries(spies.banned).forEach(([name, spy]) => {
    expect([name, spy.mock.calls.length]).toEqual([name, 0]);
  });
  expect(spies.addListener.length).toBeGreaterThan(0);
  spies.addListener.forEach(spy => expect(spy).not.toHaveBeenCalled());
  // No start callback ever does work: every start() is bare.
  spies.startArgs.forEach(args =>
    expect(args.filter(a => a !== undefined)).toEqual([]),
  );
  // The native driver drops `easing` on interpolate: curves live in tables.
  expect(spies.interpolations.length).toBeGreaterThan(100);
  spies.interpolations.forEach(config => {
    expect(config).not.toHaveProperty('easing');
    expect(config.extrapolate).toBe('clamp');
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the charge stage runs on the native driver only', () => {
  it('for the whole default script, finale and loop restart included', () => {
    const spies = spyOnAnimated();
    try {
      const {unmount} = render(<ChargeAnimationPreview />);
      act(() => {
        jest.advanceTimersByTime(DEFAULT_SCENARIO.durationMs + 1800);
      });
      expect(spies.loops.length).toBeGreaterThanOrEqual(2);
      unmount();
      expectNativeOnly(spies);
    } finally {
      spies.restore();
    }
  });

  it('for every other scenario, reduce motion included', () => {
    const spies = spyOnAnimated();
    try {
      for (const scenario of SCENARIOS) {
        for (const reduce of [false, true]) {
          const {getByTestId, getByText, unmount} = render(
            <ChargeAnimationPreview />,
          );
          if (reduce) {
            fireEvent.press(getByText('Reduce'));
          }
          fireEvent.press(getByTestId(`scenario-${scenario.id}`));
          act(() => {
            jest.advanceTimersByTime(scenario.durationMs + 100);
          });
          unmount();
          jest.clearAllTimers();
        }
      }
      expectNativeOnly(spies);
    } finally {
      spies.restore();
    }
  });
});

describe('the running and finale path never imports the JS-driven toolkits', () => {
  const root = path.join(__dirname, '../../../src');
  const files = [
    ...fs
      .readdirSync(path.join(root, 'components/cashu/charge'))
      .map(f => path.join(root, 'components/cashu/charge', f)),
    path.join(root, 'screens/CashuCardCharge.tsx'),
    path.join(root, 'screens/ChargeAnimationPreview.tsx'),
    path.join(root, 'screens/Success.tsx'),
    path.join(root, 'components/EdgeTint.tsx'),
    path.join(root, 'utils/edgeTint.ts'),
  ];

  it.each(files.map(f => [path.relative(root, f), f]))('%s', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8');
    expect(source).not.toMatch(/react-native-animatable/);
    expect(source).not.toMatch(
      /from '(react-native-reanimated|lottie-react-native|@shopify\/react-native-skia|moti)'/,
    );
    expect(source).not.toMatch(/useNativeDriver:\s*false/);
    expect(source).not.toMatch(
      /Animated\.(sequence|parallel|stagger|delay|spring|decay)\(/,
    );
    expect(source).not.toMatch(/\bdelay:\s*\d/);
  });
});
