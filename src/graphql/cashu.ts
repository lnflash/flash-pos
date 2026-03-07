import {gql} from '@apollo/client';

/**
 * cashuCardProvision mutation
 *
 * Issues Cashu proofs onto a Flash card via the card's secp256k1 pubkey.
 * Proofs are P2PK-locked to the card — only the card can authorise spending.
 *
 * The `availableSlots` param controls how many denominations to split into
 * (omit for full 32-slot provisioning; pass free count for top-up).
 *
 * @see ENG-174 / ENG-175 — Flash backend implementation
 */
export const CASHU_CARD_PROVISION = gql`
  mutation cashuCardProvision($input: CashuCardProvisionInput!) {
    cashuCardProvision(input: $input) {
      errors {
        __typename
        message
      }
      proofs {
        id
        amount
        secret
        C
      }
      cardPubkey
      totalAmountCents
    }
  }
`;

/** Shape of a single proof returned by the mutation */
export interface CashuProofGql {
  /** Keyset ID (hex string) */
  id: string;
  /** Denomination in keyset's base unit (cents for USD keyset) */
  amount: number;
  /**
   * Full P2PK secret JSON string:
   *   ["P2PK", {"nonce": "<hex>", "data": "<card_pubkey_hex>", "tags": [["sigflag","SIG_INPUTS"]]}]
   */
  secret: string;
  /** Unblinded mint signature — compressed secp256k1 point (hex) */
  C: string;
}

export interface CashuCardProvisionPayload {
  errors: {__typename: string; message: string}[];
  proofs: CashuProofGql[];
  cardPubkey: string;
  totalAmountCents: number;
}

/**
 * Extract the 32-byte nonce (hex) from a P2PK secret JSON string.
 * The nonce is what we store on-card (field 2 of the 77-byte proof payload).
 *
 * @throws if the secret is not valid P2PK format
 */
export function extractNonceFromSecret(secret: string): string {
  try {
    const parsed = JSON.parse(secret) as [string, {nonce: string}];
    if (parsed[0] !== 'P2PK' || !parsed[1]?.nonce) {
      throw new Error('Not a P2PK secret');
    }
    return parsed[1].nonce;
  } catch {
    throw new Error(`Invalid P2PK secret format: ${secret}`);
  }
}

/**
 * Convert a CashuProofGql into the flat card-write format.
 * Extracts nonce from the P2PK secret JSON.
 */
export function toCardWriteProof(proof: CashuProofGql): {
  keysetId: string;
  amount: number;
  nonce: string;
  C: string;
} {
  return {
    keysetId: proof.id,
    amount: proof.amount,
    nonce: extractNonceFromSecret(proof.secret),
    C: proof.C,
  };
}
