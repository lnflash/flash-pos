'use strict';
/**
 * Pure helpers for the simulator e2e runner (scripts/e2e-flashcard.mjs):
 * the card's P2PK secret, hex, and the fixture each Maestro flow starts from.
 * No network, no dependencies — jest pins it (__tests__/scripts/e2eLib.test.ts).
 */

/** The PIN every PIN-card flow sets and types. */
const PIN = '1234';

/**
 * The bill every charge flow rings up, in sats. It must stay sub-cent so the
 * keypad's SAT entry goes straight to the card charge instead of a BTCPay
 * invoice (Keypad.tsx: 1-cent invoice minimum): 3 sats is sub-cent at any
 * BTC price under $333k.
 */
const BILL_SAT = 3;

/** The proof the card holds when a charge starts: change is 8 - 3 = 5 = 4 + 1. */
const CARD_SAT = 8;

/** The proof the owed-change flow's second charge pays with, exactly. */
const NEXT_SAT = 4;

/** A cashu-javacard holds 32 proof slots. */
const CARD_SLOTS = 32;

/**
 * The NUT-10 secret for a proof locked to the card, byte-identical to
 * `buildCardP2PKSecret` (src/services/cashuMint.ts). The app rebuilds this
 * string from the nonce and pubkey the card reports when it spends the slot;
 * a fixture minted with any other serialization is a proof the mint rejects
 * after the card has burned it.
 */
function cardSecret(nonce, cardPubkey) {
  return JSON.stringify([
    'P2PK',
    {
      nonce: nonce.toLowerCase(),
      data: cardPubkey.toLowerCase(),
      tags: [['sigflag', 'SIG_INPUTS']],
    },
  ]);
}

/** Lower-case hex of a byte array / Uint8Array. */
function toHex(bytes) {
  return Array.from(bytes, b => (b & 0xff).toString(16).padStart(2, '0')).join(
    '',
  );
}

/** Labels for the 1-sat proofs that fill a card: F1 … Fn. */
function fillerLabels(count) {
  return Array.from({length: count}, (_, i) => `F${i + 1}`);
}

const FULL_FILLERS = fillerLabels(CARD_SLOTS - 1);

/**
 * What each flow needs minted (label → sats) and the card states it posts to
 * cardsim, by stage name. Every stage is applied as `/reset` then
 * `/fixture`. `proofs` are labels into `mint`, loaded in order into slots
 * 0…n; `spentSlots` are indexes into `proofs`, spent on the card only.
 * `link` is extra query for the card-bridge deep link.
 *
 * The flow YAML posts each stage from the env var `FIXTURE_<STAGE>`.
 */
const FLOWS = {
  'balance-read': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
  },
  'charge-with-change': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
  },
  'charge-no-pin': {
    mint: {P8: CARD_SAT},
    stages: {INITIAL: {proofs: ['P8']}},
  },
  'full-card-refusal': {
    mint: {P8: CARD_SAT, ...Object.fromEntries(FULL_FILLERS.map(l => [l, 1]))},
    stages: {
      INITIAL: {
        pin: PIN,
        proofs: ['P8', ...FULL_FILLERS],
        spentSlots: FULL_FILLERS.map((_, i) => i + 1),
      },
    },
  },
  'owed-change-next-tap': {
    mint: {
      P8: CARD_SAT,
      P4: NEXT_SAT,
      ...Object.fromEntries(FULL_FILLERS.map(l => [l, 1])),
    },
    stages: {
      // The read plans against a card with room for the change …
      INITIAL: {pin: PIN, proofs: ['P8']},
      // … which is full by the time the PIN is entered: same P8 (live at
      // the mint), every other slot loaded and spent.
      FULL: {
        pin: PIN,
        proofs: ['P8', ...FULL_FILLERS],
        spentSlots: FULL_FILLERS.map((_, i) => i + 1),
      },
      // P8 is spent at the mint now and must not come back; P4 pays the
      // second bill exactly, after the owed 4 + 1 go on.
      AFTER: {pin: PIN, proofs: ['P4']},
    },
  },
  'lost-load-answer': {
    mint: {P8: CARD_SAT},
    // A PIN card: the keypad read only reconciles it, so the balance shows
    // what the card holds and what is still waiting, untouched.
    stages: {INITIAL: {pin: PIN, proofs: ['P8']}},
    link: {dropLoad: 1},
  },
};

const FLOW_NAMES = Object.keys(FLOWS);

/**
 * A cardsim `/fixture` body for one stage. `minted` maps each label to a
 * card proof `{keysetId, amount, nonce, C}`.
 */
function buildFixture(stage, minted) {
  const body = {};
  if (stage.pin) {
    body.pin = stage.pin;
  }
  body.proofs = stage.proofs.map(label => {
    const proof = minted[label];
    if (!proof) {
      throw new Error(`no minted proof for ${label}`);
    }
    return {
      keysetId: proof.keysetId,
      amount: proof.amount,
      nonce: proof.nonce,
      C: proof.C,
    };
  });
  if (stage.spentSlots && stage.spentSlots.length > 0) {
    body.spentSlots = [...stage.spentSlots];
  }
  return body;
}

/** Placeholder proofs for --dry-run: well-formed, never minted. */
function placeholderProofs(flow) {
  const out = {};
  Object.entries(FLOWS[flow].mint).forEach(([label, amount], i) => {
    out[label] = {
      keysetId: '00'.repeat(8),
      amount,
      nonce: (i + 1).toString(16).padStart(64, '0'),
      C: `02${'00'.repeat(32)}`,
    };
  });
  return out;
}

/** The card-bridge deep link a flow opens. */
function bridgeLink(bridgeUrl, flow) {
  const params = [`url=${encodeURIComponent(bridgeUrl)}`];
  const link = FLOWS[flow].link || {};
  if (link.dropLoad) {
    params.push(`dropLoad=${link.dropLoad}`);
  }
  return `flashpos://dev/card-bridge?${params.join('&')}`;
}

module.exports = {
  BILL_SAT,
  CARD_SAT,
  CARD_SLOTS,
  NEXT_SAT,
  FLOWS,
  FLOW_NAMES,
  PIN,
  bridgeLink,
  buildFixture,
  cardSecret,
  placeholderProofs,
  toHex,
};
