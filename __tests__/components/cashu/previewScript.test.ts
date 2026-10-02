import * as fs from 'fs';
import * as path from 'path';

import {
  INITIAL_STAGE,
  mapPhase,
  type StageState,
} from '../../../src/components/cashu/charge/phaseToStation';
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  TAG_LOST,
  type Scenario,
} from '../../../src/components/cashu/charge/previewScript';
import {DUR} from '../../../src/components/cashu/charge/tokens';
import {describeCardFailure} from '../../../src/services/cashuCardNfc';

const phases = (scenario: Scenario) =>
  scenario.steps.flatMap(step =>
    step.kind === 'phase' ? [{t: step.t, text: step.text}] : [],
  );

/** Applies a scenario the way the preview does: a new session per 'running'. */
function reduce(scenario: Scenario): {
  stage: StageState;
  ended: 'complete' | 'error' | null;
  error: string | null;
} {
  let stage = INITIAL_STAGE;
  let seq = 0;
  let ended: 'complete' | 'error' | null = null;
  let error: string | null = null;
  for (const step of scenario.steps) {
    if (step.kind === 'mode' && step.mode === 'running') {
      stage = INITIAL_STAGE;
    } else if (step.kind === 'phase') {
      seq += 1;
      stage = mapPhase(stage, {text: step.text, seq});
    } else if (step.kind === 'complete' || step.kind === 'error') {
      ended = step.kind;
      error = step.kind === 'error' ? step.message : null;
      break;
    }
  }
  return {stage, ended, error};
}

describe('the default preview scenario', () => {
  it('is the PIN card, 12 sats, 16 → 12 + 4', () => {
    expect(DEFAULT_SCENARIO.label).toBe('PIN card · 12 sats · 16 → 12 + 4');
    expect(DEFAULT_SCENARIO.amountSat).toBe(12);
    expect(DEFAULT_SCENARIO.plan).toEqual({
      notes: [16, 8, 2],
      burnSlots: [16],
      changeSat: 4,
      last4: '7F3A',
      pinRequired: true,
    });
  });

  it('emits exactly the six phase strings on the real timings, then completes', () => {
    expect(phases(DEFAULT_SCENARIO)).toEqual([
      {t: 1700, text: 'reading card'},
      {t: 2000, text: 'verifying PIN'},
      {t: 2400, text: 'burning 16 sat (proof 1/1)'},
      {t: 3600, text: 'settling payment and minting change'},
      {t: 6100, text: 'writing change to card'},
      {t: 6900, text: 'reading card'},
    ]);
    const after = DEFAULT_SCENARIO.steps
      .filter(step => step.t > 6900)
      .map(step => [step.t, step.kind]);
    expect(after).toEqual([
      [7200, 'complete'],
      [8400, 'hold'],
      [9400, 'reset'],
      [9700, 'end'],
    ]);
    expect(
      DEFAULT_SCENARIO.steps.slice(0, 2).map(step => [step.t, step.kind]),
    ).toEqual([
      [0, 'mode'],
      [1000, 'mode'],
    ]);
  });

  it('holds each phase for 0.3 / 0.4 / 1.2 / 2.5 / 0.8 / 0.3 s', () => {
    const times = [...phases(DEFAULT_SCENARIO).map(p => p.t), 7200];
    const holds = times.slice(1).map((t, i) => t - times[i]);
    expect(holds).toEqual([300, 400, 1200, 2500, 800, 300]);
  });
});

describe('every preview scenario', () => {
  it.each(SCENARIOS.map(s => [s.label, s] as const))(
    '%s is well formed',
    (_label, scenario) => {
      const ts = scenario.steps.map(step => step.t);
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
      const last = scenario.steps[scenario.steps.length - 1];
      expect(last).toEqual({t: scenario.durationMs, kind: 'end'});
      expect(scenario.steps[0]).toEqual({t: 0, kind: 'mode', mode: 'idle'});
    },
  );

  it.each(SCENARIOS.map(s => [s.label, s] as const))(
    '%s drives mapPhase to the closing read, or to its error',
    (_label, scenario) => {
      const {stage, ended, error} = reduce(scenario);
      if (scenario.id === 'error' || scenario.id === 'error-late') {
        expect(ended).toBe('error');
        expect(error).toBe(TAG_LOST);
        expect(stage.station).toBe(5);
        expect(stage.phase).toBe('writing change to card');
      } else {
        expect(ended).toBe('complete');
        expect(stage.finishing).toBe(true);
        expect(stage.station).toBe(5);
        expect(stage.exact).toBe(
          (scenario.plan ?? DEFAULT_SCENARIO.plan)!.changeSat === 0,
        );
      }
    },
  );

  it('uses the plan that matches its burns', () => {
    for (const scenario of SCENARIOS) {
      const plan =
        scenario.plan ??
        scenario.steps.flatMap(s => (s.kind === 'plan' ? [s.plan] : []))[0];
      const burns = phases(scenario)
        .map(p => /^burning (\d+) sat/.exec(p.text))
        .flatMap(m => (m ? [Number(m[1])] : []));
      expect(burns).toEqual(plan.burnSlots);
      const burned = plan.burnSlots.reduce((a, b) => a + b, 0);
      expect(burned - plan.changeSat).toBe(scenario.amountSat);
    }
  });

  it('is deterministic data: no Math.random, no clock reads', () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        '../../../src/components/cashu/charge/previewScript.ts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(/);
  });
});

describe('the other scenarios', () => {
  const byId = (id: string) => SCENARIOS.find(s => s.id === id)!;

  it('error at change write: the canned message is exactly what the screen shows', () => {
    expect(TAG_LOST).toBe('[writing change to card] Tag was lost.');
    expect(describeCardFailure(new Error(TAG_LOST))).toBe(TAG_LOST);
    const error = byId('error');
    const fail = error.steps.find(step => step.kind === 'error')!;
    const reset = error.steps.find(step => step.kind === 'reset')!;
    expect(reset.t - fail.t).toBe(2500);
  });

  it('slow settle: the helper is due 4 s into an 8 s settle', () => {
    const slow = byId('slow');
    const settle = phases(slow).find(p => p.text.startsWith('settling'))!;
    const change = phases(slow).find(p => p.text.startsWith('writing'))!;
    expect(change.t - settle.t).toBe(8000);
    expect(settle.t + DUR.settleHelpLead).toBe(7600);
  });

  it('full flow: five reads, the plan, four digits 220 ms apart and a 700 ms auto-commit', () => {
    const full = byId('full');
    expect(full.plan).toBeNull();
    expect(full.flow).toBe('tap');
    expect(phases(full).slice(0, 5)).toEqual(
      [1700, 1820, 1940, 2060, 2180].map(t => ({t, text: 'reading card'})),
    );
    const digits = full.steps.flatMap(step =>
      step.kind === 'pin' ? [step.t] : [],
    );
    expect(digits).toEqual([3400, 3620, 3840, 4060]);
    const commit = full.steps.find(
      step => step.kind === 'mode' && step.mode === 'running' && step.t > 4060,
    )!;
    expect(commit.t - digits[3]).toBe(700);
    const atPlan = full.steps
      .filter(step => step.t === 2400)
      .map(step => step.kind);
    expect(atPlan).toEqual(['plan', 'flow', 'mode']);
  });

  it('two notes: the FROM total rolls 16 → 24 before the split', () => {
    const two = byId('two');
    expect(two.plan!.burnSlots).toEqual([16, 8]);
    expect(two.plan!.changeSat).toBe(4);
    expect(two.amountSat).toBe(20);
  });

  it('exact bill: no change, so no change write', () => {
    const exact = byId('exact');
    expect(exact.plan!.changeSat).toBe(0);
    expect(phases(exact).some(p => p.text === 'writing change to card')).toBe(
      false,
    );
  });
});
