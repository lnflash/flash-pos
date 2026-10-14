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
 * Over the card's daily limit: the pre-flight refusal in `readAndPlan`
 * (`DAILY_LIMIT_REACHED`) and the card's own 6A8F at SIGN
 * (`describeStatusWord`: "over the card's daily limit"). Nothing is burned
 * either way.
 */
const DAILY_LIMIT =
  /over the card's daily limit|reached today's spending limit/i;

/**
 * The card's owner has locked it (`CARD_LOCKED` in `cashuCharge.ts`): the
 * till refuses it before anything is planned or burned.
 */
const CARD_LOCKED = /card is locked and can't be used to pay/i;

/** The copy for a locked card: nothing was taken, and nothing will be. */
export const CARD_LOCKED_BODY =
  "Nothing was taken from the card. This card is locked and can't be used to pay.";

/** The copy for a bill over the card's daily limit (decision 2, Flash voice). */
export const DAILY_LIMIT_BODY = "This card has reached today's spending limit.";

/**
 * A bill with change while the mint is out of reach (`CHANGE_NEEDS_MINT` in
 * `cashuCharge.ts`): refused in the preparing step, before anything burns.
 */
const CHANGE_NEEDS_MINT_RE =
  /this bill needs change, and this terminal needs to reach the mint/i;

export function changeNeedsMint(failure: Failure): boolean {
  return CHANGE_NEEDS_MINT_RE.test(failure.detail);
}

/**
 * A card whose pieces cannot be checked offline, with the mint out of reach
 * (`ONLINE_ONLY` in `cashuCharge.ts`): refused before anything burns.
 */
const ONLINE_ONLY_RE = /can only be charged while this terminal is online/i;

export function onlineOnly(failure: Failure): boolean {
  return ONLINE_ONLY_RE.test(failure.detail);
}

/** The copy for a bill whose change needs the mint (ENG-696). */
export const CHANGE_NEEDS_MINT_BODY =
  'Nothing was taken from the card. Try again once this terminal is online.';

/** The copy for an online-only card on an offline terminal (ENG-696). */
export const ONLINE_ONLY_BODY =
  'Nothing was taken from the card. Charge it once this terminal is online.';

/**
 * The card would not sign without its PIN (6A94 at SPEND_ALL_SIGN): the bill
 * is over its no-PIN allowance. The screen moves to the PIN pad.
 */
const PIN_NEEDED = /PIN needed for this payment/i;

/** The PIN pad's line for a bill over the card's no-PIN allowance. */
export const PIN_NEEDED_TEXT = "This payment needs the card's PIN.";

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
const CHANGE_UNRECORDED =
  /^writing change to card \(unrecorded(?:, \d+ sat on card)?\)$/i;

/**
 * Pieces of the change the card took before the write failed, as
 * `executeCharge` names them in the phase (`changeWriteFailurePhase`:
 * "writing change to card (4 sat on card)", or "(unrecorded, 4 sat on
 * card)"). Absent when nothing landed.
 */
const CHANGE_LANDED =
  /^writing change to card \((?:unrecorded, )?(\d+) sat on card\)$/i;

/**
 * Sats of change already on the card when the change write failed (ENG-645),
 * from the phase. 0 when nothing landed or the phase is not a change write.
 */
export function changeLandedSat(failure: Failure): number {
  const match = CHANGE_LANDED.exec(failure.phase ?? '');
  return match ? Number(match[1]) : 0;
}

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
 * ENG-674: `executeCharge`'s swap failed ambiguously (a transport failure,
 * a 5xx, a timeout) for a payment whose change was due and whose pieces all
 * verified offline — `PHASE_SETTLING_CHANGE_OWED` in `cashuCharge.ts`. The
 * card burned for the bill and its own change together; the change was
 * never loaded (the swap itself is what failed), so it is owed exactly as
 * an unwritten change piece is, and gets the same "next tap" promise.
 */
const SETTLING_CHANGE_OWED = /\(change owed, next tap\)$/i;

/**
 * The charge died writing the change onto the card, or settling a payment
 * whose change never got that far (ENG-674), after the mint swap settled
 * the bill: the change is recorded owed on the terminal, unless the phase
 * says otherwise. BODY COPY ONLY — whether the bill is paid is
 * `executeCharge`'s word (`PhaseError.paid`, `isPaidFailure`), never this
 * wording match: a paid charge can fail on a phase that is not a change
 * write (the payment bookkeeping, say), and the screen must end it as paid
 * all the same (ENG-642).
 */
/**
 * ENG-674: the card signed and burned, but the bill's pieces could not all
 * be checked offline (`requiresOnline`) and the swap, their only check,
 * failed in a way that may not have reached the mint —
 * `PHASE_SETTLING_UNCONFIRMED` in `cashuCharge.ts`. `PhaseError.paid` is set
 * so the screen never offers a re-charge, but the payment is NOT confirmed:
 * the pieces may be forged. The screen must not say "Paid".
 */
const SETTLING_UNCONFIRMED = /mint has not confirmed it/i;

export function settleUnconfirmed(failure: Failure): boolean {
  return SETTLING_UNCONFIRMED.test(failure.phase ?? '');
}

/**
 * ENG-674: the card signed and burned, and the mint then refused the swap
 * for good — `PHASE_SETTLING_REFUSED` in `cashuCharge.ts`, thrown with
 * `PhaseError.refused`. Not paid; the payment is kept on the terminal for a
 * human; the card must not be charged again for it (it would burn again).
 */
const SETTLING_REFUSED = /mint refused it/i;

export function settleRefused(failure: Failure): boolean {
  return SETTLING_REFUSED.test(failure.phase ?? '');
}

/**
 * ENG-674: the card answered with a signature that does not verify against
 * the payment — `PHASE_CARD_SIGNATURE_INVALID` in `cashuCharge.ts`, thrown
 * with `PhaseError.refused`. Not paid, nothing reached the mint, nothing
 * will retry it; the card must not be charged again (it has burned).
 */
const SIGNATURE_INVALID = /card's signature is not valid/i;

export function signatureInvalid(failure: Failure): boolean {
  return SIGNATURE_INVALID.test(failure.phase ?? '');
}

/**
 * ENG-674: the card burned and its answer was lost —
 * `PHASE_SETTLING_NEEDS_CARD` in `cashuCharge.ts`. Unconfirmed (it also
 * matches `settleUnconfirmed`, for the title), but only the card's next
 * payment on this terminal can recover it: SPEND_ALL_AGAIN gives the card's
 * LAST signature, and a payment made anywhere else first replaces it. The
 * body must not promise the terminal is retrying on its own, nor that the
 * payment will be recovered.
 */
const SETTLING_NEEDS_CARD = /\(signature lost, next tap\)$/i;

export function settleNeedsCard(failure: Failure): boolean {
  return SETTLING_NEEDS_CARD.test(failure.phase ?? '');
}

export const SIGNATURE_INVALID_BODY =
  "The card's signature for this payment is not valid, so this bill is not paid and nothing reached the mint. Don't charge the card again. The payment is saved on this terminal for review.";

export const NEEDS_CARD_BODY =
  "The card has paid, but its answer was lost, so this payment is not confirmed. It can be recovered only if the card's next payment is made on this terminal. Hold the goods, and don't charge the card again for this bill.";

export const REFUSED_BODY =
  "The mint refused this payment after the card paid it, so this bill is not paid. Don't charge the card again. The payment is saved on this terminal for review.";

export const UNCONFIRMED_BODY =
  "The card has paid, but the mint hasn't confirmed this payment yet. Hold the goods until it settles: the terminal keeps trying while it is online. Don't charge the card again.";

export function failedAfterSwap(failure: Failure): boolean {
  const phase = failure.phase ?? '';
  return CHANGE_WRITE.test(phase) || SETTLING_CHANGE_OWED.test(phase);
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
  if (!ctx.paid && CARD_LOCKED.test(failure.detail)) {
    // Refused on GET_INFO's lock byte, before anything was planned.
    return CARD_LOCKED_BODY;
  }
  if (!ctx.paid && DAILY_LIMIT.test(failure.detail)) {
    // The card refuses before it burns (6A8F, or the pre-flight): nothing
    // was taken, and another tap today will be refused the same way.
    return DAILY_LIMIT_BODY;
  }
  if (!ctx.paid && changeNeedsMint(failure)) {
    // Refused in the preparing step, before the card signed or burned.
    return CHANGE_NEEDS_MINT_BODY;
  }
  if (!ctx.paid && onlineOnly(failure)) {
    return ONLINE_ONLY_BODY;
  }
  if (failure.cardFull && ctx.burnsDone === 0 && !ctx.paid) {
    // The pre-flight (or a LOAD of earlier change) refused before any burn.
    // No instruction: a spend leaves its slot 'spent', not free, and nothing
    // in the app clears spent slots yet (ENG-631 adds the top-up that does).
    return 'Nothing was taken from the card. It has no free slot for the change.';
  }
  const verb = ctx.paidSat === 1 ? 'is' : 'are';
  // Part of the change landed before the write failed (ENG-645): say how
  // much is on the card and how much is not, never the whole change missing.
  const landed = changeLandedSat(failure);
  const partial = landed > 0 && landed < ctx.changeSat;
  const rest = ctx.changeSat - landed;
  const landedLead = `${ctx.fmt(ctx.paidSat)} ${verb} paid. ${ctx.fmt(
    landed,
  )} of your ${ctx.fmt(ctx.changeSat)} change ${
    landed === 1 ? 'is' : 'are'
  } on the card. The other ${ctx.fmt(rest)}`;
  if (CHANGE_UNRECORDED.test(phase)) {
    if (partial) {
      return `${landedLead} could not be put on the card.`;
    }
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
    const saved = partial
      ? `${landedLead} ${rest === 1 ? 'is' : 'are'} saved on this terminal`
      : `${ctx.fmt(ctx.paidSat)} ${verb} paid. Your ${ctx.fmt(
          ctx.changeSat,
        )} change is saved on this terminal`;
    return failure.cardFull
      ? `${saved} and will be added once the card has a free slot.`
      : `${saved} and will be added the next time this card is charged.`;
  }
  if (settleNeedsCard(failure)) {
    // Never "paid", and no "the terminal keeps trying": only the card's
    // next payment here can give the lost signature back (ENG-674).
    return NEEDS_CARD_BODY;
  }
  if (settleUnconfirmed(failure)) {
    // Never "paid": the mint has not confirmed it (ENG-674).
    return UNCONFIRMED_BODY;
  }
  if (signatureInvalid(failure)) {
    // Never "paid", never "try again": the card's answer did not verify.
    return SIGNATURE_INVALID_BODY;
  }
  if (settleRefused(failure)) {
    // Never "paid", never "try again": the mint said no after the burn.
    return REFUSED_BODY;
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
 * The PIN sheet's line for a bill whose change needs the mint, with the mint
 * out of reach (ENG-698). The refusal arrives while a PIN card's sheet is up;
 * the raw `CHANGE_NEEDS_MINT` is three times what the line holds.
 */
export const PIN_CHANGE_NEEDS_CONNECTION_TEXT =
  'Change needs a connection. Nothing was taken.';

/** The PIN sheet's line for an online-only card, offline (ENG-698). */
export const PIN_ONLINE_ONLY_TEXT =
  'This card needs a connection. Nothing was taken.';

/**
 * The PIN sheet's error line. The raw failure is
 * "VERIFY_PIN failed: wrong PIN — 2 tries left": the APDU name is noise to
 * the customer and the line has room for one sentence, so keep the part
 * that tells them what to do. The two offline refusals (change that needs
 * the mint, an online-only card) get one short sentence each, like the PIN
 * verdicts. Anything else passes through unchanged.
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
  if (PIN_NEEDED.test(detail)) {
    return PIN_NEEDED_TEXT;
  }
  if (CHANGE_NEEDS_MINT_RE.test(detail)) {
    return PIN_CHANGE_NEEDS_CONNECTION_TEXT;
  }
  if (ONLINE_ONLY_RE.test(detail)) {
    return PIN_ONLINE_ONLY_TEXT;
  }
  return detail.replace(/^VERIFY_PIN failed: /, '');
}
