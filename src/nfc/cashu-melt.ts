/**
 * cashu-melt.ts
 *
 * Nutshell mint HTTP client for the melt (proof redemption) flow.
 * Used by CashuPayment screen to redeem P2PK proofs via Lightning.
 *
 * Flow:
 *   1. createMeltQuote(mintUrl, unit, bolt11Invoice)
 *      → POST /v1/melt/quote/bolt11  → {quote, amount, fee_reserve}
 *   2. meltProofs(mintUrl, quote, proofs)
 *      → POST /v1/melt/bolt11        → {paid: true, payment_preimage}
 *
 * The `proof.witness` field must already be set to the Schnorr signature
 * obtained from the card's SPEND_PROOF APDU before calling meltProofs().
 *
 * @see https://github.com/cashubtc/nuts/blob/main/05.md  NUT-05 melt
 * @see https://github.com/cashubtc/nuts/blob/main/11.md  NUT-11 P2PK
 */

export interface MeltQuote {
  quote: string;
  amount: number;
  fee_reserve: number;
  paid: boolean;
  expiry: number;
}

export interface MeltProofInput {
  id: string;      // keyset ID hex
  amount: number;
  secret: string;  // full P2PK JSON secret string
  C: string;       // compressed point hex (66 chars)
  /** Stringified JSON: '{"signatures":["<64-byte-sig-hex>"]}' */
  witness: string;
}

export interface MeltResult {
  paid: boolean;
  payment_preimage: string | null;
}

export class MeltError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'MeltError';
  }
}

/**
 * Create a melt quote — locks in the fee and returns a quote ID.
 *
 * @param mintUrl       e.g. "https://forge.flashapp.me"
 * @param unit          "usd" or "sat"
 * @param bolt11        Lightning invoice to pay
 */
export async function createMeltQuote(
  mintUrl: string,
  unit: string,
  bolt11: string,
): Promise<MeltQuote> {
  const url = mintUrl.replace(/\/$/, '') + '/v1/melt/quote/bolt11';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({unit, request: bolt11}),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      detail = body.detail || body.error || '';
    } catch {}
    throw new MeltError(
      `createMeltQuote failed (${resp.status}): ${detail}`,
      resp.status,
      detail,
    );
  }

  return resp.json();
}

/**
 * Melt proofs — redeems P2PK proofs to pay the Lightning invoice
 * associated with the given quote.
 *
 * Each proof must have a `witness` containing the Schnorr signature
 * from the card's SPEND_PROOF APDU.
 *
 * @param mintUrl   e.g. "https://forge.flashapp.me"
 * @param quoteId   from createMeltQuote().quote
 * @param proofs    P2PK proofs with witness signatures
 */
export async function meltProofs(
  mintUrl: string,
  quoteId: string,
  proofs: MeltProofInput[],
): Promise<MeltResult> {
  const url = mintUrl.replace(/\/$/, '') + '/v1/melt/bolt11';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({quote: quoteId, inputs: proofs}),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      detail = body.detail || body.error || '';
    } catch {}
    throw new MeltError(
      `meltProofs failed (${resp.status}): ${detail}`,
      resp.status,
      detail,
    );
  }

  return resp.json();
}

/**
 * Select the minimum set of proofs covering amountCents.
 * Greedy: sorts ascending, picks until sum >= target.
 *
 * @returns {selected, total, overpaymentCents}
 */
export function selectProofsForAmount(
  proofs: {slotIndex: number; amount: number; keysetId: string; nonce: string; C: string}[],
  amountCents: number,
): {
  selected: typeof proofs;
  total: number;
  overpaymentCents: number;
} {
  const sorted = proofs.slice().sort((a, b) => a.amount - b.amount);
  const selected: typeof proofs = [];
  let total = 0;

  for (const p of sorted) {
    if (total >= amountCents) break;
    selected.push(p);
    total += p.amount;
  }

  if (total < amountCents) {
    return {selected: [], total: 0, overpaymentCents: 0};
  }

  return {selected, total, overpaymentCents: total - amountCents};
}
