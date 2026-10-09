import {
  changePieces,
  failureBody,
  last4FromPubkey,
  parseFailure,
  pinFailureText,
  runningTotals,
} from '../../../src/components/cashu/charge/money';
import {splitPow2} from '../../../src/utils/denominations';

/**
 * The implementation cashuMint.ts carried before splitPow2 moved to
 * src/utils/denominations.ts, verbatim: the mint mints change in exactly
 * these pieces and the stage animates one slip per piece, so the move must
 * not change a single decomposition.
 */
function legacySplitPow2(amountSat: number): number[] {
  const pieces: number[] = [];
  let remaining = amountSat;
  let denom = 1;
  while (denom * 2 <= remaining) {
    denom *= 2;
  }
  while (remaining > 0) {
    if (denom <= remaining) {
      pieces.push(denom);
      remaining -= denom;
    } else {
      denom = Math.floor(denom / 2);
    }
  }
  return pieces;
}

describe('splitPow2 (shared by the mint and the stage)', () => {
  it('decomposes exactly as the mint always has', () => {
    for (let sat = 0; sat <= 4096; sat++) {
      expect(splitPow2(sat)).toEqual(legacySplitPow2(sat));
    }
    expect(splitPow2(100000)).toEqual(legacySplitPow2(100000));
  });

  it('is largest first and sums back to the amount', () => {
    expect(splitPow2(6)).toEqual([4, 2]);
    expect(splitPow2(7)).toEqual([4, 2, 1]);
    const pieces = splitPow2(1023);
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(1023);
    expect([...pieces].sort((a, b) => b - a)).toEqual(pieces);
  });
});

describe('changePieces', () => {
  it('returns one slip per change proof, largest first', () => {
    expect(changePieces(4)).toEqual([4]);
    expect(changePieces(5)).toEqual([4, 1]);
    expect(changePieces(7)).toEqual([4, 2, 1]);
    expect(changePieces(0)).toEqual([]);
    expect(changePieces(-3)).toEqual([]);
  });
});

describe('runningTotals', () => {
  it('runs the FROM CARD total burn by burn', () => {
    expect(runningTotals([16, 8])).toEqual([16, 24]);
    expect(runningTotals([16])).toEqual([16]);
    expect(runningTotals([])).toEqual([]);
  });
});

describe('last4FromPubkey', () => {
  it('takes the last four hex digits, uppercased', () => {
    expect(last4FromPubkey('02abcdef0123456789abcdef7f3a')).toBe('7F3A');
    expect(last4FromPubkey('02:ab:cd:7f:3a')).toBe('7F3A');
  });

  it('shows nothing until the pubkey is known', () => {
    expect(last4FromPubkey(null)).toBeNull();
    expect(last4FromPubkey(undefined)).toBeNull();
    expect(last4FromPubkey('7f')).toBeNull();
  });
});

describe('parseFailure', () => {
  it('splits executeCharge\'s "[phase] detail" and spots a lost tag', () => {
    expect(parseFailure('[writing change to card] Tag was lost.')).toEqual({
      phase: 'writing change to card',
      detail: 'Tag was lost.',
      tagLost: true,
      cardFull: false,
    });
    expect(parseFailure('[burning 16 sat (proof 1/2)] tag lost').tagLost).toBe(
      true,
    );
    expect(parseFailure('[reading card] The card left the field').tagLost).toBe(
      true,
    );
  });

  it('treats a refusal as "didn\'t finish", not as the card moving', () => {
    expect(parseFailure('[verifying PIN] wrong PIN — 2 tries left')).toEqual({
      phase: 'verifying PIN',
      detail: 'wrong PIN — 2 tries left',
      tagLost: false,
      cardFull: false,
    });
    expect(parseFailure('card PIN is blocked')).toEqual({
      phase: null,
      detail: 'card PIN is blocked',
      tagLost: false,
      cardFull: false,
    });
  });

  it('reads an empty reason as the card going quiet', () => {
    expect(parseFailure('[settling payment and minting change]')).toEqual({
      phase: 'settling payment and minting change',
      detail: '',
      tagLost: true,
      cardFull: false,
    });
    expect(parseFailure(null).tagLost).toBe(true);
  });

  it("spots a full card, from the pre-flight and from the card's own 6A84", () => {
    expect(
      parseFailure(
        '[reading card] this card is full: 6 sat of change needs 2 free slots and the card has 0',
      ),
    ).toMatchObject({cardFull: true, tagLost: false});
    expect(
      parseFailure(
        'this card is full: 6 sat of change needs 2 free slots and the card has 0',
      ),
    ).toMatchObject({phase: null, cardFull: true, tagLost: false});
    expect(
      parseFailure(
        '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      ),
    ).toMatchObject({
      phase: 'writing change to card',
      cardFull: true,
      tagLost: false,
    });
    expect(parseFailure('[verifying PIN] wrong PIN').cardFull).toBe(false);
  });
});

describe('failureBody', () => {
  const fmt = (sat: number) => `${sat} ${sat === 1 ? 'sat' : 'sats'}`;
  const ctx = (over: Partial<{burnsDone: number; changeSat: number}> = {}) => ({
    burnsDone: 1,
    paidSat: 12,
    changeSat: 4,
    fmt,
    ...over,
  });

  it('a full card before any burn: nothing taken, and no instruction that would not free a slot', () => {
    const body = failureBody(
      parseFailure(
        'this card is full: 6 sat of change needs 2 free slots and the card has 0',
      ),
      ctx({burnsDone: 0}),
    );
    expect(body).toBe(
      'Nothing was taken from the card. It has no free slot for the change.',
    );
    // A spend leaves its slot 'spent', not free: telling the customer to
    // spend first would send them in a loop (until ENG-631's top-up clears).
    expect(body).not.toMatch(/spend/i);
    // The same when a LOAD of earlier change was refused before the burn.
    expect(
      failureBody(
        parseFailure(
          '[adding 2 sat of change owed from an earlier charge] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
        ),
        ctx({burnsDone: 0}),
      ),
    ).toMatch(/^Nothing was taken from the card\./);
  });

  it('a change write that died — tag lost or card full — says the change is saved for the next charge', () => {
    const saved =
      '12 sats are paid. Your 4 sats change is saved and will be added the next time this card is charged.';
    expect(
      failureBody(
        parseFailure('[writing change to card] Tag was lost.'),
        ctx(),
      ),
    ).toBe(saved);
    expect(
      failureBody(
        parseFailure(
          '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
        ),
        ctx(),
      ),
    ).toBe(saved);
    expect(
      failureBody(parseFailure('[writing change to card] Tag was lost.'), {
        ...ctx(),
        paidSat: 1,
        changeSat: 1,
      }),
    ).toBe(
      '1 sat is paid. Your 1 sat change is saved and will be added the next time this card is charged.',
    );
  });

  it('a change write that died with NO record landed says the bill is paid and the change did not reach the card — never that it is saved', () => {
    const FULL = 'LOAD_PROOF failed: card is full — no free slot (0x6A84)';
    const unrecorded = (reason: string) =>
      failureBody(
        parseFailure(`[writing change to card (unrecorded)] ${reason}`),
        ctx(),
      );
    const body =
      '12 sats are paid. Your 4 sats change could not be put on the card.';
    expect(unrecorded('Tag was lost.')).toBe(body);
    expect(unrecorded(FULL)).toBe(body);
    expect(unrecorded('')).toBe(body);
    for (const reason of ['Tag was lost.', FULL, '']) {
      expect(unrecorded(reason)).not.toMatch(/saved|next time/i);
      // The raw failure is NFC jargon for the pill, never the body.
      expect(unrecorded(reason)).not.toMatch(/LOAD_PROOF|0x6A84|Tag was lost/);
    }
    expect(
      failureBody(
        parseFailure('[writing change to card (unrecorded)] Tag was lost.'),
        {...ctx(), paidSat: 1, changeSat: 1},
      ),
    ).toBe('1 sat is paid. Your 1 sat change could not be put on the card.');
    // The title still names the card as full / moved, from the same parse.
    expect(
      parseFailure(`[writing change to card (unrecorded)] ${FULL}`),
    ).toMatchObject({
      phase: 'writing change to card (unrecorded)',
      cardFull: true,
    });
  });

  it('keeps the other bodies: a refusal verbatim, a lost tag by where it was', () => {
    expect(
      failureBody(
        parseFailure('[verifying PIN] wrong PIN — 2 tries left'),
        ctx(),
      ),
    ).toBe('wrong PIN — 2 tries left');
    expect(
      failureBody(
        parseFailure('[reading card] Tag was lost.'),
        ctx({burnsDone: 0}),
      ),
    ).toBe('Nothing was taken from the card. Hold it to the phone again.');
    expect(
      failureBody(
        parseFailure('[burning 16 sat (proof 1/1)] Tag was lost.'),
        ctx(),
      ),
    ).toBe('Hold the card to the phone again to finish.');
    expect(failureBody(parseFailure(''), ctx())).toBe(
      'Hold the card to the phone again to finish.',
    );
  });
});

describe('pinFailureText', () => {
  it("turns the card's tries-left verdict into one instruction", () => {
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — 2 tries left')).toBe(
      'Wrong PIN — 2 tries left. Try again.',
    );
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — 1 try left')).toBe(
      'Wrong PIN — 1 try left. Try again.',
    );
  });

  it('says plainly when the PIN is blocked', () => {
    expect(
      pinFailureText('VERIFY_PIN failed: wrong PIN — no tries left'),
    ).toMatch(/PIN blocked/);
    expect(pinFailureText('VERIFY_PIN failed: PIN blocked')).toMatch(
      /PIN blocked/,
    );
  });

  it('drops the APDU name and leaves anything else alone', () => {
    expect(pinFailureText('VERIFY_PIN failed: wrong length')).toBe(
      'wrong length',
    );
    expect(pinFailureText('Tag was lost.')).toBe('Tag was lost.');
  });
});
