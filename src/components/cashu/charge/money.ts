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

/**
 * `executeCharge` reports a failed post-swap bookkeeping write under this
 * phase when every piece of change was then written onto the card anyway
 * (`cashuCharge.ts`, `PHASE_RECORDING_PAYMENT_CHANGE_ON_CARD`): the loads
 * run whether or not the bookkeeping landed. The change is on the card;
 * the title and body must not say otherwise.
 */
const CHANGE_ON_CARD = /^recording the payment \(change on card\)$/i;

/**
 * The charge failed after the swap, but its change is on the card: only
 * the payment bookkeeping did not land. BODY AND TITLE COPY ONLY, like
 * `failedAfterSwap`; `PhaseError.paid` says whether the bill is paid.
 */
export function changeOnCard(failure: Failure): boolean {
  return CHANGE_ON_CARD.test(failure.phase ?? '');
}

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

/**
 * Both change-write phases `executeCharge` reports a failure under
 * (`PHASE_WRITING_CHANGE` and its "(unrecorded)" variant). Nothing else
 * starts this way: owed change from an earlier charge is written under its
 * own phase, before the PIN-gated burn. `cashuCharge.test` pins this against
 * the messages the service really throws.
 */
const CHANGE_WRITE = /^writing change to card/i;

/**
 * The charge died writing the change onto the card, after the mint swap
 * settled the bill: the change is recorded owed on the terminal, unless the
 * phase says otherwise. BODY COPY ONLY — whether the bill is paid is
 * `executeCharge`'s word (`PhaseError.paid`, `isPaidFailure`), never this
 * wording match: a paid charge can fail on a phase that is not a change
 * write (the payment bookkeeping, say), and the screen must end it as paid
 * all the same (ENG-642).
 */
export function failedAfterSwap(failure: Failure): boolean {
  return CHANGE_WRITE.test(failure.phase ?? '');
}

export interface FailureContext {
  /** Burns the charge had started when it failed (stage.burnsDone). */
  burnsDone: number;
  paidSat: number;
  changeSat: number;
  /**
   * `executeCharge` reported the bill paid (`PhaseError.paid`): the failure
   * came after the swap, whatever its phase.
   */
  paid?: boolean;
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
  if (failure.cardFull && ctx.burnsDone === 0 && !ctx.paid) {
    // The pre-flight (or a LOAD of earlier change) refused before any burn.
    // No instruction: a spend leaves its slot 'spent', not free, and nothing
    // in the app clears spent slots yet (ENG-631 adds the top-up that does).
    return 'Nothing was taken from the card. It has no free slot for the change.';
  }
  const verb = ctx.paidSat === 1 ? 'is' : 'are';
  if (CHANGE_UNRECORDED.test(phase)) {
    // The bill is paid but the change was never recorded and did not land:
    // it is not saved anywhere. Say the one thing the customer needs to
    // hear — the bill is paid — and that the change did not reach the card;
    // not "saved", not "next time". The card's own words stay on the pill.
    return `${ctx.fmt(ctx.paidSat)} ${verb} paid. Your ${ctx.fmt(
      ctx.changeSat,
    )} change could not be put on the card.`;
  }
  if (failedAfterSwap(failure) && ctx.changeSat > 0) {
    // The mint has settled before the change is written: the bill is paid,
    // and the change is recorded on the terminal — WHATEVER the card said
    // to the LOAD (the unrecorded case has its own phase above). A 6982
    // security-status refusal, a 6A80 wrong-data, a protocol error: all of
    // them leave the money exactly where a lost tag does, and a body that
    // showed the raw APDU text instead would send the merchant to Retry,
    // which burns the card for the same bill a second time. A tag that
    // moved goes onto the card at its next tap. A card that ran out of
    // slots does not: the next tap gives the owed piece no slot either (a
    // spend leaves its slot 'spent', not free, and nothing in the app
    // clears spent slots until ENG-631) — so promise only what is true: it
    // is saved here and goes on once the card has room.
    const saved = `${ctx.fmt(ctx.paidSat)} ${verb} paid. Your ${ctx.fmt(
      ctx.changeSat,
    )} change is saved on this terminal`;
    return failure.cardFull
      ? `${saved} and will be added once the card has a free slot.`
      : `${saved} and will be added the next time this card is charged.`;
  }
  if (ctx.paid) {
    // Paid, but not on a change write: the payment bookkeeping or a later
    // step failed. The bill must read as paid — never "hold the card again",
    // which would charge it twice. The change loads run even when the
    // bookkeeping fails, and a failed load is reported under its own phase
    // above; a bookkeeping failure whose change all landed says so in its
    // phase. Anything else promises nothing about the change.
    const paid = `${ctx.fmt(ctx.paidSat)} ${verb} paid.`;
    if (ctx.changeSat > 0 && changeOnCard(failure)) {
      return `${paid} Your ${ctx.fmt(ctx.changeSat)} change is on the card.`;
    }
    return ctx.changeSat > 0
      ? `${paid} Your ${ctx.fmt(ctx.changeSat)} change did not reach the card.`
      : `${paid} There is nothing more to do.`;
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
