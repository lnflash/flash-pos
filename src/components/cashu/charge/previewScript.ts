/**
 * DEV-only choreography scripts: the exact phase strings executeCharge emits,
 * on the timings of a real charge, so the production ChargeView can be
 * rendered, recorded and judged with no card, NFC or mint. Pure data — no
 * Math.random, no clock reads.
 */
import type {PlanSummary} from './ChargeView';

export type ScriptStep =
  | {t: number; kind: 'mode'; mode: 'idle' | 'running'}
  | {t: number; kind: 'phase'; text: string}
  | {t: number; kind: 'plan'; plan: PlanSummary}
  | {t: number; kind: 'flow'; flow: 'tap' | 'pin' | 'done'}
  | {t: number; kind: 'pin'; digit: string}
  | {t: number; kind: 'complete'}
  | {t: number; kind: 'error'; message: string}
  | {t: number; kind: 'hold'}
  | {t: number; kind: 'reset'}
  | {t: number; kind: 'end'};

export interface Scenario {
  id: string;
  label: string;
  amountSat: number;
  /** The plan at t=0 (null: the tap flow reads it mid-script). */
  plan: PlanSummary | null;
  flow: 'tap' | 'pin' | 'done';
  steps: ScriptStep[];
  durationMs: number;
}

export const PLAN_A: PlanSummary = {
  notes: [16, 8, 2],
  burnSlots: [16],
  changeSat: 4,
  last4: '7F3A',
  pinRequired: true,
};

export const PLAN_B: PlanSummary = {
  notes: [8, 4],
  burnSlots: [8, 4],
  changeSat: 0,
  last4: '2C91',
  pinRequired: false,
};

export const PLAN_C: PlanSummary = {
  notes: [16, 8, 2],
  burnSlots: [16, 8],
  changeSat: 4,
  last4: '9B04',
  pinRequired: false,
};

const READ = 'reading card';
const PIN = 'verifying PIN';
const SETTLE = 'settling payment and minting change';
const CHANGE = 'writing change to card';
export const TAG_LOST = '[writing change to card] Tag was lost.';

const phase = (t: number, text: string): ScriptStep => ({
  t,
  kind: 'phase',
  text,
});

/** The session-2 run shared by the PIN scenarios, from its first read. */
function pinRun(t0: number, settleMs = 2500): ScriptStep[] {
  const settleEnd = t0 + 1900 + settleMs;
  return [
    phase(t0, READ),
    phase(t0 + 300, PIN),
    phase(t0 + 700, 'burning 16 sat (proof 1/1)'),
    phase(t0 + 1900, SETTLE),
    phase(settleEnd, CHANGE),
    phase(settleEnd + 800, READ),
    {t: settleEnd + 1100, kind: 'complete'},
    {t: settleEnd + 2300, kind: 'hold'},
    {t: settleEnd + 3300, kind: 'reset'},
    {t: settleEnd + 3600, kind: 'end'},
  ];
}

export const DEFAULT_SCENARIO: Scenario = {
  id: 'pin',
  label: 'PIN card · 12 sats · 16 → 12 + 4',
  amountSat: 12,
  plan: PLAN_A,
  flow: 'done',
  steps: [
    {t: 0, kind: 'mode', mode: 'idle'},
    {t: 1000, kind: 'mode', mode: 'running'},
    ...pinRun(1700),
  ],
  durationMs: 9700,
};

export const SCENARIOS: Scenario[] = [
  DEFAULT_SCENARIO,
  {
    id: 'exact',
    label: 'No PIN · exact 12',
    amountSat: 12,
    plan: PLAN_B,
    flow: 'done',
    steps: [
      {t: 0, kind: 'mode', mode: 'idle'},
      {t: 1000, kind: 'mode', mode: 'running'},
      phase(1700, READ),
      phase(2000, 'burning 8 sat (proof 1/2)'),
      phase(3200, 'burning 4 sat (proof 2/2)'),
      phase(4400, SETTLE),
      phase(5900, READ),
      {t: 6200, kind: 'complete'},
      {t: 7400, kind: 'hold'},
      {t: 8400, kind: 'reset'},
      {t: 8700, kind: 'end'},
    ],
    durationMs: 8700,
  },
  {
    id: 'two',
    label: 'Two notes · 16+8 → 20 + 4',
    amountSat: 20,
    plan: PLAN_C,
    flow: 'done',
    steps: [
      {t: 0, kind: 'mode', mode: 'idle'},
      {t: 1000, kind: 'mode', mode: 'running'},
      phase(1700, READ),
      phase(2000, 'burning 16 sat (proof 1/2)'),
      phase(3200, 'burning 8 sat (proof 2/2)'),
      phase(4400, SETTLE),
      phase(6900, CHANGE),
      phase(7700, READ),
      {t: 8000, kind: 'complete'},
      {t: 9200, kind: 'hold'},
      {t: 10200, kind: 'reset'},
      {t: 10500, kind: 'end'},
    ],
    durationMs: 10500,
  },
  {
    id: 'error',
    label: 'Error at change write',
    amountSat: 12,
    plan: PLAN_A,
    flow: 'done',
    steps: [
      {t: 0, kind: 'mode', mode: 'idle'},
      {t: 1000, kind: 'mode', mode: 'running'},
      phase(1700, READ),
      phase(2000, PIN),
      phase(2400, 'burning 16 sat (proof 1/1)'),
      phase(3600, SETTLE),
      phase(6100, CHANGE),
      {t: 6500, kind: 'error', message: TAG_LOST},
      {t: 9000, kind: 'reset'},
      {t: 9300, kind: 'end'},
    ],
    durationMs: 9300,
  },
  {
    // The slip has long gone into the card when the write fails: the CHANGE
    // chip must NOT say "4 ✓" — nothing after the write confirmed it.
    id: 'error-late',
    label: 'Error 1 s into change write',
    amountSat: 12,
    plan: PLAN_A,
    flow: 'done',
    steps: [
      {t: 0, kind: 'mode', mode: 'idle'},
      {t: 1000, kind: 'mode', mode: 'running'},
      phase(1700, READ),
      phase(2000, PIN),
      phase(2400, 'burning 16 sat (proof 1/1)'),
      phase(3600, SETTLE),
      phase(6100, CHANGE),
      {t: 7100, kind: 'error', message: TAG_LOST},
      {t: 9600, kind: 'reset'},
      {t: 9900, kind: 'end'},
    ],
    durationMs: 9900,
  },
  {
    id: 'slow',
    label: 'Slow settle 8 s',
    amountSat: 12,
    plan: PLAN_A,
    flow: 'done',
    steps: [
      {t: 0, kind: 'mode', mode: 'idle'},
      {t: 1000, kind: 'mode', mode: 'running'},
      ...pinRun(1700, 8000),
    ],
    durationMs: 15200,
  },
  {
    id: 'full',
    label: 'Full flow',
    amountSat: 12,
    plan: null,
    flow: 'tap',
    steps: [
      {t: 0, kind: 'mode', mode: 'idle'},
      {t: 1000, kind: 'mode', mode: 'running'},
      phase(1700, READ),
      phase(1820, READ),
      phase(1940, READ),
      phase(2060, READ),
      phase(2180, READ),
      {t: 2400, kind: 'plan', plan: PLAN_A},
      {t: 2400, kind: 'flow', flow: 'pin'},
      {t: 2400, kind: 'mode', mode: 'idle'},
      {t: 3400, kind: 'pin', digit: '1'},
      {t: 3620, kind: 'pin', digit: '9'},
      {t: 3840, kind: 'pin', digit: '8'},
      {t: 4060, kind: 'pin', digit: '4'},
      {t: 4760, kind: 'mode', mode: 'running'},
      ...pinRun(5700),
    ],
    durationMs: 13700,
  },
];
