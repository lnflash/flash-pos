/**
 * The phase strings `executeCharge` emits are an informal API: this mapper
 * turns each one into a station on the Spark Run track so the bolt hops on
 * REAL events (never a fake progress bar that could finish before the card
 * write does and tempt the customer to lift the card). Unknown strings map
 * to "no hop, show verbatim" — the animation decorates the phase text, it
 * never replaces it.
 */

/** 1 card · 2 PIN · 3 pay · 4 mint · 5 change. 0 = nothing sighted yet. */
export type Station = 0 | 1 | 2 | 3 | 4 | 5;

export const STATION_COUNT = 5;

export type StageEvent =
  | 'none'
  | 'hello'
  | 'thump'
  | 'hop'
  | 'burn'
  | 'orbit'
  | 'change'
  | 'scan'
  | 'spin';

export interface PhaseEvent {
  text: string;
  /**
   * Monotonic per screen. 'writing change to card' fires once per change
   * proof and 'reading card' fires 5+ times per read, so keying on the
   * string alone would collapse repeats; the seq keeps every one distinct.
   */
  seq: number;
}

export interface StageState {
  seq: number;
  phase: string | null;
  station: Station;
  event: StageEvent;
  /** The card had no PIN: station 2 is flown over and struck through. */
  pinSkipped: boolean;
  burn: {amount: number; index: number; total: number} | null;
  burnsDone: number;
  changeWritten: number;
  /** The trailing balance read — the bolt is already home. */
  finishing: boolean;
  /** Exact bill: no change is written, station 5 shows a stamp, not rain. */
  exact: boolean;
  /** Witness recovery after the customer's critical path — never an error. */
  tidying: boolean;
}

export const INITIAL_STAGE: StageState = {
  seq: 0,
  phase: null,
  station: 0,
  event: 'none',
  pinSkipped: false,
  burn: null,
  burnsDone: 0,
  changeWritten: 0,
  finishing: false,
  exact: false,
  tidying: false,
};

export const PHASE_READING = 'reading card';
export const PHASE_PIN = 'verifying PIN';
export const PHASE_SETTLING = 'settling payment and minting change';
export const PHASE_CHANGE = 'writing change to card';
const BURN_RE = /^burning (\d+) sat \(proof (\d+)\/(\d+)\)$/;
const RESIGN_RE = /^re-signing recovered (\d+) sat$/;

const max = (a: Station, b: Station): Station => (a > b ? a : b);

/** Monotonic: the station index never decreases within a session. */
export function mapPhase(prev: StageState, ev: PhaseEvent): StageState {
  const base: StageState = {
    ...prev,
    seq: ev.seq,
    phase: ev.text,
    tidying: false,
    finishing: false,
  };

  if (ev.text === PHASE_READING) {
    if (prev.station === 0) {
      return {...base, station: 1, event: 'hello'};
    }
    if (prev.station >= 4) {
      // The balance read after the money moved. Reaching it from the mint
      // with nothing written means the bill was exact (or the swap was
      // deferred offline with nothing owed to the card) — resolve station 5
      // so the run never looks four-fifths finished.
      const exact = prev.changeWritten === 0;
      return {...base, station: 5, event: 'scan', finishing: true, exact};
    }
    return {...base, event: 'thump'};
  }

  if (ev.text === PHASE_PIN) {
    return {...base, station: max(prev.station, 2), event: 'hop'};
  }

  const burn = BURN_RE.exec(ev.text);
  if (burn) {
    const [, amount, index, total] = burn;
    return {
      ...base,
      station: max(prev.station, 3),
      event: 'burn',
      pinSkipped: prev.pinSkipped || prev.station < 2,
      burn: {amount: Number(amount), index: Number(index), total: Number(total)},
      burnsDone: prev.burnsDone + 1,
    };
  }

  if (ev.text === PHASE_SETTLING) {
    return {...base, station: max(prev.station, 4), event: 'orbit'};
  }

  if (ev.text === PHASE_CHANGE) {
    return {
      ...base,
      station: 5,
      event: 'change',
      changeWritten: prev.changeWritten + 1,
    };
  }

  if (RESIGN_RE.test(ev.text)) {
    return {...base, event: 'spin', tidying: true};
  }

  return {...base, event: 'thump'};
}

export interface FriendlyLabel {
  /** 18 px, the child's line: what is happening in plain words. */
  title: string;
  /** 13 px: "step 3 of 5 · 16 sat · 1 of 2" or the tidying/finishing note. */
  detail: string;
}

/**
 * The plain-words layer above the verbatim phase. The raw string stays on
 * screen underneath: it is the trust surface and the number of record.
 */
export function friendlyLabel(state: StageState): FriendlyLabel {
  const step = state.station > 0 ? `step ${state.station} of ${STATION_COUNT}` : '';
  const phase = state.phase ?? '';
  if (state.tidying) {
    return {title: 'Tidying up', detail: 'tidying up'};
  }
  if (phase === PHASE_READING) {
    return state.finishing
      ? {title: 'Checking the card', detail: step}
      : {title: 'Reading the card', detail: step};
  }
  if (phase === PHASE_PIN) {
    return {title: 'Checking the PIN', detail: step};
  }
  if (state.event === 'burn' && state.burn) {
    const {amount, index, total} = state.burn;
    return {
      title: `Paying ${amount} sat`,
      detail: `${step} · ${amount} sat · ${index} of ${total}`,
    };
  }
  if (phase === PHASE_SETTLING) {
    return {title: 'Making your change', detail: step};
  }
  if (phase === PHASE_CHANGE) {
    return {
      title: 'Putting change on the card',
      detail: `${step} · ${state.changeWritten} back`,
    };
  }
  return {title: phase, detail: step};
}
