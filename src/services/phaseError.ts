/**
 * A failure inside one phase of a charge. The message carries the phase for
 * the merchant-facing log ("[reading card] SELECT failed: ..."); `cause` keeps
 * the original error — a `CardError` with its status word, for one — so
 * callers branch on the class, not on the wording.
 *
 * Declared as a field rather than passed as `new Error(message, {cause})`:
 * Hermes supports `cause`, but the React Native tsconfig's `lib` stops short
 * of `es2022.error`, which is where that overload and `Error.cause` are typed.
 *
 * Its own leaf module (re-exported by `cashuCharge`): the charge screen reads
 * `paid` off the error it catches, and must not pull the mint, the keychain
 * and the settlement queue into its graph to do so.
 */
export class PhaseError extends Error {
  readonly cause: unknown;
  /**
   * The bill is PAID: the failure came after the burns, once the mint swap
   * had settled them (or, for an exact bill, deferred them to the drain).
   * Set by `executeCharge` — the only code that knows where the swap stands
   * — on whatever the post-swap tail throws. A paid failure must never run
   * the charge again for the same bill: no PIN re-entry, no "Tap card
   * again", or the card is burned twice (ENG-642).
   */
  paid: boolean;
  /**
   * The card signed and burned for the bill, and the mint then refused the
   * swap for good (a mint error, any HTTP 4xx). The bill is NOT paid, but
   * the card has spent: like a paid failure, it must never run the charge
   * again (a retry burns the card a second time for the same bill), and it
   * is never recorded as a paid sale. Set only by `executeCharge`.
   */
  refused: boolean;

  constructor(
    phase: string,
    cause: unknown,
    {paid = false, refused = false} = {},
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`[${phase}] ${message}`);
    this.name = 'PhaseError';
    this.cause = cause;
    this.paid = paid;
    this.refused = refused;
  }
}

/** The charge failed after the swap: the bill is paid (see `PhaseError.paid`). */
export function isPaidFailure(error: unknown): boolean {
  return error instanceof PhaseError && error.paid;
}

/**
 * The card burned for the bill and the mint refused the swap (see
 * `PhaseError.refused`): not paid, and never charged again.
 */
export function isRefusedAfterBurn(error: unknown): boolean {
  return error instanceof PhaseError && error.refused && !error.paid;
}
