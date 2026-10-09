import {splitPow2} from '../../../utils/denominations';

/**
 * The money story the stage animates, derived from the plan: which notes
 * leave the card, how the FROM total runs, which change slips go back.
 */

/** Change pieces in the order the card receives them (largest first). */
export function changePieces(changeSat: number): number[] {
  return changeSat > 0 ? splitPow2(changeSat) : [];
}

/** The FROM CARD total after each burn: [16, 8] → [16, 24]. */
export function runningTotals(burnSlots: readonly number[]): number[] {
  let total = 0;
  return burnSlots.map(amount => (total += amount));
}

/** "•••• 7F3A": the last four hex digits of the card's pubkey. */
export function last4FromPubkey(hex: string | null | undefined): string | null {
  if (!hex) {
    return null;
  }
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  return clean.length >= 4 ? clean.slice(-4).toUpperCase() : null;
}

const TAG_LOST =
  /tag (was )?lost|left the field|not connected|stopped responding/i;

/**
 * The card has no free slot for the change: the pre-flight refusal in
 * `readAndPlan` ("this card is full: …") and the card's own 6A84 on a LOAD
 * (`describeStatusWord`: "card is full — no free slot") both say so.
 */
const CARD_FULL = /card is full/i;

/**
 * `executeCharge` reports a change write that failed AFTER the owed-change
 * record itself failed to land under this phase (`cashuCharge.ts`,
 * `PHASE_WRITING_CHANGE_UNRECORDED`). The change is then nowhere but the
 * dead process; the body must not say it is saved.
 */
const CHANGE_UNRECORDED = /^writing change to card \(unrecorded\)$/i;

export interface Failure {
  /** The phase the charge died on, from executeCharge's "[phase] …" prefix. */
  phase: string | null;
  /** The reason after the prefix. */
  detail: string;
  /** The card left the antenna (vs a card or mint refusal). */
  tagLost: boolean;
  /** The card has no free slot for the change (vs any other refusal). */
  cardFull: boolean;
}

export function parseFailure(message: string | null | undefined): Failure {
  const text = (message ?? '').trim();
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(text);
  const phase = match ? match[1] : null;
  const detail = (match ? match[2] : text).trim();
  return {
    phase,
    detail,
    tagLost: detail === '' || TAG_LOST.test(detail),
    cardFull: CARD_FULL.test(detail),
  };
}

export interface FailureContext {
  /** Burns the charge had started when it failed (stage.burnsDone). */
  burnsDone: number;
  paidSat: number;
  changeSat: number;
  /** formatSatAmount: "4 sats", "1 sat". */
  fmt: (sat: number) => string;
}

/**
 * The error body, in plain words: where the money is and what to do. The
 * raw failure ("[writing change to card] Tag was lost.") stays verbatim on
 * the pill — the trust surface — never as the body: it is NFC jargon and it
 * repeats the title. A card or mint refusal keeps its own reason.
 */
export function failureBody(failure: Failure, ctx: FailureContext): string {
  const phase = failure.phase ?? '';
  if (failure.cardFull && ctx.burnsDone === 0) {
    // The pre-flight (or a LOAD of earlier change) refused before any burn.
    // No instruction: a spend leaves its slot 'spent', not free, and nothing
    // in the app clears spent slots yet (ENG-631 adds the top-up that does).
    return 'Nothing was taken from the card. It has no free slot for the change.';
  }
  if (CHANGE_UNRECORDED.test(phase)) {
    // The bill is paid but the change was never recorded and did not land:
    // it is not saved anywhere, so say only what the card said.
    return failure.detail || 'The card stopped responding.';
  }
  if (
    /^writing change/i.test(phase) &&
    ctx.changeSat > 0 &&
    (failure.tagLost || failure.cardFull)
  ) {
    // The mint has settled before the change is written: the bill is paid,
    // and the change is recorded on the terminal — it goes onto the card at
    // its next tap, whether the tag moved or the card ran out of slots.
    const verb = ctx.paidSat === 1 ? 'is' : 'are';
    return `${ctx.fmt(ctx.paidSat)} ${verb} paid. Your ${ctx.fmt(ctx.changeSat)} change is saved and will be added the next time this card is charged.`;
  }
  if (!failure.tagLost) {
    return failure.detail || 'The card stopped responding.';
  }
  // "Nothing was taken" only when no money phase was ever reached — not
  // even the one it died on.
  if (ctx.burnsDone === 0 && !MONEY_PHASE.test(phase)) {
    return 'Nothing was taken from the card. Hold it to the phone again.';
  }
  return 'Hold the card to the phone again to finish.';
}

/** Phases from which money may have left the card. */
const MONEY_PHASE = /^(burning|settling|writing|re-signing)/i;

/**
 * The PIN sheet's error line. The raw failure is
 * "VERIFY_PIN failed: wrong PIN — 2 tries left": the APDU name is noise to
 * the customer and the line has room for one sentence, so keep the part
 * that tells them what to do. Anything that is not a PIN verdict passes
 * through unchanged.
 */
export function pinFailureText(detail: string): string {
  const tries = /wrong PIN — (\d+) (try|tries) left/i.exec(detail);
  if (tries) {
    return `Wrong PIN — ${tries[1]} ${tries[2]} left. Try again.`;
  }
  if (/wrong PIN — no tries left|PIN blocked/i.test(detail)) {
    return 'PIN blocked — this card can no longer be charged.';
  }
  if (/no PIN set/i.test(detail)) {
    return 'This card has no PIN. Tap again without one.';
  }
  return detail.replace(/^VERIFY_PIN failed: /, '');
}
