import React from 'react';
import {act, render} from '@testing-library/react-native';

import SparkStage, {
  ProgressRail,
  stationPoints,
} from '../../../src/components/cashu/charge/SparkStage';
import {
  INITIAL_STAGE,
  mapPhase,
  type StageState,
} from '../../../src/components/cashu/charge/phaseToStation';

// react-native-svg ships untransformed ESM plus native views; the stage only
// needs shapes to exist, so View/Text stubs are the cheap, honest stand-in.
jest.mock('react-native-svg', () => {
  const MockReact = require('react');
  const {View} = require('react-native');
  const stub = (name: string) => {
    const C = (props: {children?: React.ReactNode}) =>
      MockReact.createElement(View, {testID: `svg-${name}`}, props.children);
    C.displayName = name;
    return C;
  };
  return {
    __esModule: true,
    default: stub('Svg'),
    Circle: stub('Circle'),
    Ellipse: stub('Ellipse'),
    Path: stub('Path'),
    Rect: stub('Rect'),
  };
});

function after(phases: string[]): StageState {
  return phases.reduce(
    (state, text, i) => mapPhase(state, {text, seq: i + 1}),
    INITIAL_STAGE,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('stationPoints', () => {
  it('spaces five stations evenly on a track that dips in the middle', () => {
    const pts = stationPoints(300, 100, 24);
    expect(pts.slice(1).map(p => Math.round(p.x))).toEqual([24, 87, 150, 213, 276]);
    expect(pts.slice(1).map(p => Math.round(p.y))).toEqual([100, 118, 124, 118, 100]);
  });
});

describe('SparkStage', () => {
  it('renders the idle scene: dim track, ripples, parked bolt', () => {
    const {getByTestId, queryByTestId, unmount} = render(
      <SparkStage state={INITIAL_STAGE} mode="idle" width={320} reduceMotion={false} />,
    );
    expect(getByTestId('idle-ripples')).toBeTruthy();
    expect(getByTestId('coin-pool')).toBeTruthy();
    expect(getByTestId('spark-bolt').props.accessibilityLabel).toBe('waiting for card');
    expect(queryByTestId('hold-still-pill')).toBeNull();
    act(() => jest.advanceTimersByTime(3000));
    unmount();
  });

  it('names the step and phase on the bolt while running', () => {
    const state = after(['reading card', 'verifying PIN', 'burning 16 sat (proof 1/2)']);
    const {getByTestId, queryByTestId, unmount} = render(
      <SparkStage
        state={state}
        mode="running"
        stalled
        burnCoins={[16, 8]}
        changeSat={8}
        width={320}
        reduceMotion={false}
      />,
    );
    expect(getByTestId('spark-bolt').props.accessibilityLabel).toBe(
      'step 3 of 5, burning 16 sat (proof 1/2)',
    );
    for (let n = 1; n <= 5; n += 1) {
      expect(getByTestId(`station-${n}-lit`)).toBeTruthy();
    }
    expect(getByTestId('hold-still-pill')).toBeTruthy();
    expect(getByTestId('burn-pips').children).toHaveLength(2);
    expect(getByTestId('change-note').props.children).toBe('+8 sat');
    expect(queryByTestId('idle-ripples')).toBeNull();
    act(() => jest.advanceTimersByTime(2000));
    unmount();
  });

  it('drives every phase event through the running scene without leaking timers', () => {
    const phases = [
      'reading card',
      'verifying PIN',
      'burning 16 sat (proof 1/2)',
      'burning 8 sat (proof 2/2)',
      'settling payment and minting change',
      'writing change to card',
      'writing change to card',
      're-signing recovered 8 sat',
      'reading card',
    ];
    let state: StageState = INITIAL_STAGE;
    const {rerender, getByTestId, unmount} = render(
      <SparkStage state={state} mode="running" burnCoins={[16, 8]} width={320} reduceMotion={false} />,
    );
    phases.forEach((text, i) => {
      state = mapPhase(state, {text, seq: i + 1});
      rerender(
        <SparkStage state={state} mode="running" burnCoins={[16, 8]} width={320} reduceMotion={false} />,
      );
      act(() => jest.advanceTimersByTime(700));
    });
    expect(getByTestId('spark-bolt').props.accessibilityLabel).toBe('step 5 of 5, reading card');
    rerender(
      <SparkStage state={state} mode="complete" burnCoins={[16, 8]} width={320} reduceMotion={false} />,
    );
    expect(getByTestId('spark-bolt').props.accessibilityLabel).toBe('paid, you can lift the card');
    act(() => jest.advanceTimersByTime(3000));
    unmount();
    // RN's jest mock ends every native-driver animation with a one-shot
    // 16 ms timer that its no-op stopAnimation never clears, so the count is
    // read after a short drain. What this guards is JS timers: the
    // reduce-motion crossfade and anything a callback re-armed after cleanup.
    act(() => jest.advanceTimersByTime(50));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stamps an exact bill on station 5 instead of raining change', () => {
    const state = after([
      'reading card',
      'burning 8 sat (proof 1/1)',
      'settling payment and minting change',
      'reading card',
    ]);
    const {getByTestId, unmount} = render(
      <SparkStage state={state} mode="running" burnCoins={[8]} changeSat={0} width={320} reduceMotion />,
    );
    expect(getByTestId('change-note').props.children).toBe('exact');
    expect(getByTestId('station-2-skipped')).toBeTruthy();
    // The reduce-motion crossfade parks the bolt on a 100 ms timer: unmount
    // clears it (the 50 ms drain only absorbs the mock's 16 ms end callbacks).
    unmount();
    act(() => jest.advanceTimersByTime(50));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the failed station lit red and the bolt parked in error mode', () => {
    const state = after(['reading card', 'verifying PIN', 'burning 16 sat (proof 1/1)', 'settling payment and minting change']);
    const {getByTestId, rerender, unmount} = render(
      <SparkStage state={state} mode="running" width={320} reduceMotion={false} />,
    );
    rerender(<SparkStage state={state} mode="error" width={320} reduceMotion={false} />);
    act(() => jest.advanceTimersByTime(2000));
    expect(getByTestId('station-4-red')).toBeTruthy();
    expect(getByTestId('spark-bolt').props.accessibilityLabel).toBe(
      'step 4 of 5, settling payment and minting change',
    );
    unmount();
    act(() => jest.advanceTimersByTime(50));
    expect(jest.getTimerCount()).toBe(0);
  });

  // Rendered transforms are the JS-side Animated values at render time. The
  // RN jest mock ends native-driver timings without writing values back, so
  // these read what park()/landing snapped, after a same-props rerender.
  const boltAt = (bolt: {props: {style?: {transform?: Record<string, number>[]}}}) => {
    const t = bolt.props.style?.transform ?? [];
    return {x: t[0]?.translateX, y: t[1]?.translateY};
  };
  const BOLT_HALF = 28;
  const parked = (p: {x: number; y: number}) => ({x: p.x - BOLT_HALF, y: p.y - BOLT_HALF - 6});
  const FULL = stationPoints(320, 112, 24);

  it('lands on the change station before bouncing on an exact bill', () => {
    const state = after([
      'reading card',
      'burning 8 sat (proof 1/1)',
      'settling payment and minting change',
      'reading card',
    ]);
    const props = {state, mode: 'running' as const, burnCoins: [8], changeSat: 0, width: 320, reduceMotion: false};
    const {getByTestId, rerender, unmount} = render(<SparkStage {...props} />);
    // The hop is genuinely in flight on the first tick: a same-tick bounce()
    // would have cut it short (before the fix: bobbing at the mint with the
    // label already on "step 5 of 5"; with park-first bounce: a teleport).
    rerender(<SparkStage {...props} />);
    expect(boltAt(getByTestId('spark-bolt'))).toEqual(parked(FULL[1]));
    act(() => jest.advanceTimersByTime(1500));
    rerender(<SparkStage {...props} />);
    expect(boltAt(getByTestId('spark-bolt'))).toEqual(parked(FULL[5]));
    expect(getByTestId('station-5-lit').props.style.opacity).toBe(1);
    expect(getByTestId('change-note').props.children).toBe('exact');
    unmount();
  });

  it('freezes the bolt ON the failed station when the error lands mid-hop', () => {
    const state = after(['reading card', 'verifying PIN', 'burning 16 sat (proof 1/1)', 'settling payment and minting change']);
    const {getByTestId, rerender, unmount} = render(
      <SparkStage state={state} mode="running" width={320} reduceMotion={false} />,
    );
    // No timer advance: the hop towards the mint is still in flight.
    rerender(<SparkStage state={state} mode="error" width={320} reduceMotion={false} />);
    rerender(<SparkStage state={state} mode="error" width={320} reduceMotion={false} />);
    expect(boltAt(getByTestId('spark-bolt'))).toEqual(parked(FULL[4]));
    for (let n = 1; n <= 4; n += 1) {
      expect(getByTestId(`station-${n}-lit`).props.style.opacity).toBe(1);
    }
    act(() => jest.advanceTimersByTime(2000));
    unmount();
    act(() => jest.advanceTimersByTime(50));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('re-seats the bolt and keeps the lights when the PIN pad undocks mid-run', () => {
    const state = after(['reading card']);
    const {getByTestId, rerender, unmount} = render(
      <SparkStage state={state} mode="running" docked width={320} reduceMotion={false} />,
    );
    // The card is still on the phone: 'reading card' landed while docked.
    rerender(<SparkStage state={state} mode="running" width={320} reduceMotion={false} />);
    rerender(<SparkStage state={state} mode="running" width={320} reduceMotion={false} />);
    expect(boltAt(getByTestId('spark-bolt'))).toEqual(parked(FULL[1]));
    expect(getByTestId('station-1-lit').props.style.opacity).toBe(1);
    act(() => jest.advanceTimersByTime(1000));
    unmount();
  });

  it('honours reduce motion: no ripples, no swinging pill, no breathing loop', () => {
    const {queryByTestId, getByTestId, rerender, unmount} = render(
      <SparkStage state={INITIAL_STAGE} mode="idle" width={320} reduceMotion />,
    );
    expect(queryByTestId('idle-ripples')).toBeNull();
    const running = after(['reading card', 'verifying PIN']);
    rerender(<SparkStage state={running} mode="running" stalled width={320} reduceMotion />);
    expect(getByTestId('hold-still-pill')).toBeTruthy();
    rerender(<SparkStage state={running} mode="complete" width={320} reduceMotion />);
    // The grow spring finishes, and with reduce motion nothing re-arms after
    // it: an infinite loop would keep the timer count above zero forever.
    act(() => jest.advanceTimersByTime(3000));
    act(() => jest.advanceTimersByTime(50));
    expect(jest.getTimerCount()).toBe(0);
    unmount();
  });

  it('docks to the PIN strip and back', () => {
    const {getByTestId, rerender, queryByTestId} = render(
      <SparkStage state={INITIAL_STAGE} mode="idle" docked width={320} reduceMotion={false} />,
    );
    expect(getByTestId('spark-stage').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({height: 90})]),
    );
    expect(queryByTestId('idle-ripples')).toBeNull();
    rerender(<SparkStage state={INITIAL_STAGE} mode="idle" width={320} reduceMotion={false} />);
    expect(getByTestId('spark-stage').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({height: 230})]),
    );
  });
});

describe('ProgressRail', () => {
  it('renders and animates towards the new progress', () => {
    const {getByTestId, rerender, unmount} = render(<ProgressRail progress={0.2} width={320} />);
    expect(getByTestId('progress-rail')).toBeTruthy();
    rerender(<ProgressRail progress={1} width={320} />);
    act(() => jest.advanceTimersByTime(500));
    unmount();
  });
});
