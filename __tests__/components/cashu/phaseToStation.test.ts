import {
  INITIAL_STAGE,
  PHASE_CHANGE,
  PHASE_PIN,
  PHASE_READING,
  PHASE_SETTLING,
  friendlyLabel,
  mapPhase,
  type StageState,
} from '../../../src/components/cashu/charge/phaseToStation';

/** Feeds the strings in order, stamping each with a fresh seq like the screen. */
function run(phases: string[], from: StageState = INITIAL_STAGE): StageState[] {
  const out: StageState[] = [];
  let state = from;
  phases.forEach((text, i) => {
    state = mapPhase(state, {text, seq: i + 1});
    out.push(state);
  });
  return out;
}

// These are the exact strings src/services/cashuCharge.ts emits. A wording
// change there must fail HERE, loudly, rather than silently freezing the bolt.
const SESSION = [
  'reading card',
  'verifying PIN',
  'burning 16 sat (proof 1/2)',
  'burning 8 sat (proof 2/2)',
  'settling payment and minting change',
  'writing change to card',
  'writing change to card',
  'reading card',
];

describe('mapPhase', () => {
  it('pins the phase strings the service emits', () => {
    expect(PHASE_READING).toBe('reading card');
    expect(PHASE_PIN).toBe('verifying PIN');
    expect(PHASE_SETTLING).toBe('settling payment and minting change');
    expect(PHASE_CHANGE).toBe('writing change to card');
  });

  it('walks a full PIN session across the five stations', () => {
    const states = run(SESSION);
    expect(states.map(s => s.station)).toEqual([1, 2, 3, 3, 4, 5, 5, 5]);
    expect(states.map(s => s.event)).toEqual([
      'hello',
      'hop',
      'burn',
      'burn',
      'orbit',
      'change',
      'change',
      'scan',
    ]);
    expect(states[2].burn).toEqual({amount: 16, index: 1, total: 2});
    expect(states[3].burnsDone).toBe(2);
    expect(states[6].changeWritten).toBe(2);
    expect(states[7].finishing).toBe(true);
    expect(states[7].exact).toBe(false);
    expect(states[7].seq).toBe(8);
    expect(states.every(s => !s.pinSkipped)).toBe(true);
  });

  it('is monotonic: repeated "reading card" never sends the bolt backwards', () => {
    const states = run(['reading card', 'reading card', 'reading card', 'verifying PIN', 'reading card']);
    expect(states.map(s => s.station)).toEqual([1, 1, 1, 2, 2]);
    expect(states[1].event).toBe('thump');
    expect(states[4].event).toBe('thump');
  });

  it('marks the PIN station skipped when burns arrive without a verify', () => {
    const [, burn] = run(['reading card', 'burning 4 sat (proof 1/1)']);
    expect(burn.station).toBe(3);
    expect(burn.pinSkipped).toBe(true);
  });

  it('resolves an exact bill to station 5 on the trailing read', () => {
    const states = run([
      'reading card',
      'burning 8 sat (proof 1/1)',
      'settling payment and minting change',
      'reading card',
    ]);
    const last = states[states.length - 1];
    expect(last.station).toBe(5);
    expect(last.exact).toBe(true);
    expect(last.finishing).toBe(true);
    expect(last.event).toBe('scan');
  });

  it('treats witness recovery as tidying, never a station', () => {
    const states = run([...SESSION.slice(0, 7), 're-signing recovered 8 sat', 'reading card']);
    const spin = states[7];
    expect(spin.station).toBe(5);
    expect(spin.event).toBe('spin');
    expect(spin.tidying).toBe(true);
    expect(friendlyLabel(spin).title).toBe('Tidying up');
    expect(states[8].tidying).toBe(false);
  });

  it('shows an unknown phase verbatim without a hop', () => {
    const [, unknown] = run(['reading card', 'polishing the brass']);
    expect(unknown.station).toBe(1);
    expect(unknown.event).toBe('thump');
    expect(unknown.phase).toBe('polishing the brass');
    expect(friendlyLabel(unknown)).toEqual({title: 'polishing the brass', detail: 'step 1 of 5'});
  });

  it('keeps every seq even when the string repeats', () => {
    const states = run(['writing change to card', 'writing change to card']);
    expect(states.map(s => s.seq)).toEqual([1, 2]);
    expect(states.map(s => s.changeWritten)).toEqual([1, 2]);
  });
});

describe('friendlyLabel', () => {
  it('puts plain words above the verbatim phase with a step counter', () => {
    const states = run(SESSION);
    expect(friendlyLabel(states[0])).toEqual({title: 'Reading the card', detail: 'step 1 of 5'});
    expect(friendlyLabel(states[1])).toEqual({title: 'Checking the PIN', detail: 'step 2 of 5'});
    expect(friendlyLabel(states[2])).toEqual({
      title: 'Paying 16 sat',
      detail: 'step 3 of 5 · 16 sat · 1 of 2',
    });
    expect(friendlyLabel(states[4])).toEqual({title: 'Making your change', detail: 'step 4 of 5'});
    expect(friendlyLabel(states[6])).toEqual({
      title: 'Putting change on the card',
      detail: 'step 5 of 5 · 2 back',
    });
    expect(friendlyLabel(states[7]).title).toBe('Checking the card');
  });
});
