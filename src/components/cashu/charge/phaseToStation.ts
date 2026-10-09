import {formatSatAmount} from '../../../utils/satCurrency';

/**
 * The phase strings `executeCharge` emits are an informal API: this mapper
 * turns each one into a station of the charge so the stage moves on REAL
 * events (never a fake progress bar that could finish before the card write
 * does and tempt the customer to lift the card). Unknown strings map to "no
 * gesture, show verbatim" — the animation decorates the phase text, it never
 * replaces it.
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
  /** The card had no PIN: the PIN station never lights. */
  pinSkipped: boolean;
  burn: {amount: number; index: number; total: number} | null;
  burnsDone: number;
  changeWritten: number;
  /** The trailing balance read — the money has already moved. */
  finishing: boolean;
  /** Exact bill: no change is written onto the card. */
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
/** `writeOwedChange`: change from an earlier charge, written before the burn. */
const OWED_RE = /^adding (\d+) sat of change owed from an earlier charge$/;

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

  if (OWED_RE.test(ev.text)) {
    // Before the burn, so never station 5 — that would break the monotonic
    // stepper. The station holds; the stage spins while the slot is written.
    return {...base, event: 'spin'};
  }

  return {...base, event: 'thump'};
}

export interface FriendlyLabel {
  /** The status title: what is happening, in plain words. */
  title: string;
}

export interface LabelContext {
  /** From the plan: the change the card is about to receive. */
  changeSat?: number;
}

/**
 * The plain-words layer above the verbatim phase. The raw string stays on
 * screen underneath: it is the trust surface and the number of record.
 * Sat amounts go through formatSatAmount so friendly copy never mixes
 * "sat" and "sats".
 */
export function friendlyLabel(
  state: StageState,
  ctx: LabelContext = {},
): FriendlyLabel {
  const phase = state.phase;
  if (phase === null) {
    return {title: 'Waiting for the card'};
  }
  if (state.tidying) {
    return {title: 'Tidying up'};
  }
  if (phase === PHASE_READING) {
    return {title: state.finishing ? 'Checking the card' : 'Reading the card'};
  }
  if (phase === PHASE_PIN) {
    return {title: 'Checking the PIN'};
  }
  if (state.event === 'burn' && state.burn) {
    const {amount, index} = state.burn;
    return {
      title:
        index > 1
          ? `Taking ${formatSatAmount(amount)} more off the card`
          : `Taking ${formatSatAmount(amount)} off the card`,
    };
  }
  if (phase === PHASE_SETTLING) {
    return {title: 'Settling with the mint'};
  }
  if (phase === PHASE_CHANGE) {
    return {
      title:
        ctx.changeSat && ctx.changeSat > 0
          ? `Putting ${formatSatAmount(ctx.changeSat)} on the card`
          : 'Putting your change on the card',
    };
  }
  const owed = OWED_RE.exec(phase);
  if (owed) {
    return {
      title: `Adding ${formatSatAmount(
        Number(owed[1]),
      )} of change from an earlier charge`,
    };
  }
  return {title: phase};
}
