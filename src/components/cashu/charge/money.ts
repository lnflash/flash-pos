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

export interface Failure {
  /** The phase the charge died on, from executeCharge's "[phase] …" prefix. */
  phase: string | null;
  /** The reason after the prefix. */
  detail: string;
  /** The card left the antenna (vs a card or mint refusal). */
  tagLost: boolean;
}

export function parseFailure(message: string | null | undefined): Failure {
  const text = (message ?? '').trim();
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(text);
  const phase = match ? match[1] : null;
  const detail = (match ? match[2] : text).trim();
  return {phase, detail, tagLost: detail === '' || TAG_LOST.test(detail)};
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
  if (!failure.tagLost) {
    return failure.detail || 'The card stopped responding.';
  }
  const phase = failure.phase ?? '';
  if (/^writing change/i.test(phase) && ctx.changeSat > 0) {
    // The mint has settled before the change is written: the bill is paid,
    // only the change is not on the card yet.
    const verb = ctx.paidSat === 1 ? 'is' : 'are';
    return `${ctx.fmt(ctx.paidSat)} ${verb} paid. Hold the card to the phone again to add your ${ctx.fmt(ctx.changeSat)} change.`;
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
