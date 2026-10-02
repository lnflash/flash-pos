import {act, renderHook} from '@testing-library/react-native';

import type {
  Scenario,
  ScriptStep,
} from '../../../src/components/cashu/charge/previewScript';
import {DEFAULT_SCENARIO} from '../../../src/components/cashu/charge/previewScript';
import {usePhaseScript} from '../../../src/components/cashu/charge/usePhaseScript';

const SCRIPT: Scenario = {
  id: 'test',
  label: 'test',
  amountSat: 12,
  plan: null,
  flow: 'done',
  steps: [
    {t: 0, kind: 'mode', mode: 'idle'},
    {t: 100, kind: 'phase', text: 'reading card'},
    {t: 250, kind: 'phase', text: 'verifying PIN'},
    {t: 250, kind: 'complete'},
    {t: 400, kind: 'end'},
  ],
  durationMs: 400,
};

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** Records [ms since start, step] for every step the hook plays. */
type HookProps = {
  speed?: number;
  loop?: boolean;
  active?: boolean;
  runKey?: number;
};

function record(scenario: Scenario, options: HookProps = {}) {
  const start = Date.now();
  const played: Array<[number, ScriptStep]> = [];
  const onStep = (step: ScriptStep) => played.push([Date.now() - start, step]);
  const hook = renderHook(
    (props: HookProps) => usePhaseScript(scenario, {...props, onStep}),
    {initialProps: options},
  );
  return {played, ...hook};
}

describe('usePhaseScript', () => {
  it('restarts from t = 0 when the run key changes (re-picking the playing scenario)', () => {
    const {played, rerender} = record(SCRIPT, {loop: false, runKey: 0});
    act(() => jest.advanceTimersByTime(200));
    expect(played.map(([, s]) => s.kind)).toEqual(['mode', 'phase']);
    played.length = 0;
    rerender({loop: false, runKey: 1});
    // The first step plays again at once; the old schedule is gone.
    expect(played.map(([, s]) => s.kind)).toEqual(['mode']);
    act(() => jest.advanceTimersByTime(60));
    // 260 ms since the first start: the old run would have completed by now.
    expect(played.map(([, s]) => s.kind)).toEqual(['mode']);
    act(() => jest.advanceTimersByTime(40));
    expect(played.map(([, s]) => s.kind)).toEqual(['mode', 'phase']);
  });

  it('plays every step in order, on time, from one start timestamp', () => {
    const {played} = record(SCRIPT, {loop: false});
    expect(played.map(([, s]) => s.kind)).toEqual(['mode']);
    act(() => jest.advanceTimersByTime(99));
    expect(played).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(played[1]).toEqual([100, SCRIPT.steps[1]]);
    act(() => jest.advanceTimersByTime(150));
    // Two steps share t=250: both fire on the same tick, in script order.
    expect(played.slice(2).map(([t, s]) => [t, s.kind])).toEqual([
      [250, 'phase'],
      [250, 'complete'],
    ]);
    act(() => jest.advanceTimersByTime(1000));
    expect(played.map(([, s]) => s.kind)).toEqual([
      'mode',
      'phase',
      'phase',
      'complete',
      'end',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('plays the default scenario on its exact timings', () => {
    const {played} = record(DEFAULT_SCENARIO, {loop: false});
    act(() => jest.advanceTimersByTime(DEFAULT_SCENARIO.durationMs));
    expect(played.map(([t]) => t)).toEqual(
      DEFAULT_SCENARIO.steps.map(step => step.t),
    );
  });

  it('stretches time by the speed factor (0.5 doubles every gap)', () => {
    const {played} = record(SCRIPT, {loop: false, speed: 0.5});
    act(() => jest.advanceTimersByTime(199));
    expect(played).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(played[1][0]).toBe(200);
    act(() => jest.advanceTimersByTime(1000));
    expect(played.map(([t]) => t)).toEqual([0, 200, 500, 500, 800]);
  });

  it('loops without drift: lap n starts at n x duration', () => {
    const {played} = record(SCRIPT, {loop: true});
    act(() => jest.advanceTimersByTime(400 * 3 + 100));
    const laps = played.filter(([, s]) => s.kind === 'mode').map(([t]) => t);
    expect(laps).toEqual([0, 400, 800, 1200]);
    const reads = played
      .filter(([, s]) => s.kind === 'phase' && s.text === 'reading card')
      .map(([t]) => t);
    expect(reads).toEqual([100, 500, 900, 1300]);
  });

  it('catches up overdue steps in order after a late timer', () => {
    const {played} = record(SCRIPT, {loop: false});
    // A JS stall: by the time the first timer fires, the wall clock is
    // already past three steps.
    act(() => {
      jest.setSystemTime(Date.now() + 200);
      jest.advanceTimersByTime(100);
    });
    expect(played.map(([, s]) => s.kind)).toEqual([
      'mode',
      'phase',
      'phase',
      'complete',
    ]);
  });

  it('pauses while inactive and leaves no timer behind on unmount', () => {
    const {played, rerender, unmount} = record(SCRIPT, {
      loop: true,
      active: false,
    });
    act(() => jest.advanceTimersByTime(1000));
    expect(played).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    rerender({loop: true, active: true});
    expect(played).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
