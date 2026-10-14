import {
  changeLandedSat,
  changeOnCard,
  changePieces,
  failedAfterSwap,
  failureBody,
  last4FromPubkey,
  parseFailure,
  pinFailureText,
  runningTotals,
  settleRefused,
  settleUnconfirmed,
  changeNeedsMint,
  onlineOnly,
  CARD_LOCKED_BODY,
  CHANGE_NEEDS_MINT_BODY,
  DAILY_LIMIT_BODY,
  ONLINE_ONLY_BODY,
  REFUSED_BODY,
  PIN_CHANGE_NEEDS_CONNECTION_TEXT,
  PIN_NEEDED_TEXT,
  PIN_ONLINE_ONLY_TEXT,
  UNCONFIRMED_BODY,
} from '../../../src/components/cashu/charge/money';
import {
  CARD_LOCKED,
  CHANGE_NEEDS_MINT,
  ONLINE_ONLY,
} from '../../../src/services/cashuCharge';
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

describe('changePieces: the plan’s own split (ENG-701)', () => {
  it('animates the pieces the card is told to make', () => {
    expect(changePieces(5, [2, 1, 1, 1])).toEqual([2, 1, 1, 1]);
    expect(changePieces(6, [2, 2, 1, 1])).toEqual([2, 2, 1, 1]);
  });

  it('falls back to the fewest when the plan names none', () => {
    expect(changePieces(5, undefined)).toEqual(splitPow2(5));
    expect(changePieces(5, [])).toEqual(splitPow2(5));
    expect(changePieces(0, [1])).toEqual([]);
  });

  it("the stage's plan shape carries the same slips the card writes", () => {
    const {
      planShape,
    } = require('../../../src/components/cashu/charge/ChargeView');
    const plan = {
      notes: [8],
      burnSlots: [8],
      changeSat: 5,
      changePieces: [2, 1, 1, 1],
      last4: null,
      pinRequired: true,
    };
    expect(planShape(plan, 3).pieces).toEqual([2, 1, 1, 1]);
    expect(planShape({...plan, changePieces: undefined}, 3).pieces).toEqual([
      4, 1,
    ]);
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

describe('failedAfterSwap (ENG-642)', () => {
  it('is true only for the change write, recorded or not: the swap has settled the bill', () => {
    for (const message of [
      '[writing change to card] Tag was lost.',
      '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      '[writing change to card] ',
      '[writing change to card (unrecorded)] Tag was lost.',
    ]) {
      expect(failedAfterSwap(parseFailure(message))).toBe(true);
    }
  });

  it('is false for every phase before the swap, owed change from an earlier charge included', () => {
    for (const message of [
      '[reading card] Tag was lost.',
      '[verifying PIN] wrong PIN — 2 tries left',
      '[adding 4 sat of change owed from an earlier charge] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      '[burning 16 sat (proof 1/2)] tag lost',
      '[settling payment and minting change] mint unreachable',
      'this card is full: 6 sat of change needs 2 free slots and the card has 0',
      'writing change to card',
      '',
      null,
    ]) {
      expect(failedAfterSwap(parseFailure(message))).toBe(false);
    }
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

  it('a change write that died with the tag lost says the change is saved for the next charge', () => {
    expect(
      failureBody(
        parseFailure('[writing change to card] Tag was lost.'),
        ctx(),
      ),
    ).toBe(
      '12 sats are paid. Your 4 sats change is saved on this terminal and will be added the next time this card is charged.',
    );
    expect(
      failureBody(parseFailure('[writing change to card] Tag was lost.'), {
        ...ctx(),
        paidSat: 1,
        changeSat: 1,
      }),
    ).toBe(
      '1 sat is paid. Your 1 sat change is saved on this terminal and will be added the next time this card is charged.',
    );
  });

  it('a change write the card refused as full says the change is saved and goes on once the card has a free slot — never "next time"', () => {
    // A full card stays full: the next tap gives the owed piece no slot
    // either (nothing frees a spent slot until ENG-631), so "the next time
    // this card is charged" would be false for exactly the case that
    // triggers it.
    const body = failureBody(
      parseFailure(
        '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      ),
      ctx(),
    );
    expect(body).toBe(
      '12 sats are paid. Your 4 sats change is saved on this terminal and will be added once the card has a free slot.',
    );
    expect(body).not.toMatch(/next time/i);
  });

  it('a change write the card refused for ANY other reason still says paid + saved — never the raw APDU text', () => {
    // Under "writing change to card" the swap has settled and the owed
    // record landed (the unrecorded case has its own phase). A 6982, a
    // 6A80 or a protocol error on the LOAD is still "paid, change saved":
    // a body showing the raw refusal under "Charge didn't finish" reads as
    // "nothing happened", and the merchant's Retry burns the card for the
    // same bill again.
    const refusals = [
      'LOAD_PROOF failed: security status not satisfied (0x6982)',
      'LOAD_PROOF failed: wrong data (0x6A80)',
      'LOAD_PROOF: expected 1-byte slot, got 0',
    ];
    for (const reason of refusals) {
      const failure = parseFailure(`[writing change to card] ${reason}`);
      expect(failure).toMatchObject({tagLost: false, cardFull: false});
      const body = failureBody(failure, ctx());
      expect(body).toBe(
        '12 sats are paid. Your 4 sats change is saved on this terminal and will be added the next time this card is charged.',
      );
      expect(body).not.toMatch(/LOAD_PROOF|0x69|0x6A|1-byte/);
    }
    // The raw reason stays on the pill, from the same parse.
    expect(parseFailure(`[writing change to card] ${refusals[0]}`).detail).toBe(
      refusals[0],
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

  describe('part of the change landed before the write failed (ENG-645)', () => {
    const FULL = 'LOAD_PROOF failed: card is full — no free slot (0x6A84)';
    const body = (phase: string, reason: string, changeSat = 6) =>
      failureBody(parseFailure(`[${phase}] ${reason}`), {
        ...ctx({changeSat}),
        paidSat: 10,
        paid: true,
      });

    it('reads how much landed from the phase, and nothing from any other phase', () => {
      const landed = (message: string) =>
        changeLandedSat(parseFailure(message));
      expect(
        landed('[writing change to card (4 sat on card)] Tag was lost.'),
      ).toBe(4);
      expect(
        landed('[writing change to card (unrecorded, 12 sat on card)] x'),
      ).toBe(12);
      expect(landed('[writing change to card] Tag was lost.')).toBe(0);
      expect(
        landed('[writing change to card (unrecorded)] Tag was lost.'),
      ).toBe(0);
      expect(landed('[recording the payment] keychain write denied')).toBe(0);
      expect(landed('[burning 4 sat on card (proof 1/1)] x')).toBe(0);
      expect(landed('Tag was lost.')).toBe(0);
    });

    it('both variants are still change writes after the swap', () => {
      for (const phase of [
        'writing change to card (4 sat on card)',
        'writing change to card (unrecorded, 4 sat on card)',
      ]) {
        expect(failedAfterSwap(parseFailure(`[${phase}] Tag was lost.`))).toBe(
          true,
        );
      }
    });

    it('unrecorded: says how much is on the card and how much could not be put on it', () => {
      const expected =
        '10 sats are paid. 4 sats of your 6 sats change are on the card. The other 2 sats could not be put on the card.';
      for (const reason of ['Tag was lost.', FULL, '']) {
        const text = body(
          'writing change to card (unrecorded, 4 sat on card)',
          reason,
        );
        expect(text).toBe(expected);
        expect(text).not.toMatch(/saved|next time/i);
        expect(text).not.toMatch(/Your 6 sats change/);
        expect(text).not.toMatch(/LOAD_PROOF|0x6A84|Tag was lost/);
      }
    });

    it('recorded: says how much is on the card and that only the rest is saved', () => {
      expect(
        body('writing change to card (4 sat on card)', 'Tag was lost.'),
      ).toBe(
        '10 sats are paid. 4 sats of your 6 sats change are on the card. The other 2 sats are saved on this terminal and will be added the next time this card is charged.',
      );
      expect(body('writing change to card (4 sat on card)', FULL)).toBe(
        '10 sats are paid. 4 sats of your 6 sats change are on the card. The other 2 sats are saved on this terminal and will be added once the card has a free slot.',
      );
    });

    it('singular: 1 sat landed, 1 sat left', () => {
      expect(
        body('writing change to card (unrecorded, 1 sat on card)', 'x', 2),
      ).toBe(
        '10 sats are paid. 1 sat of your 2 sats change is on the card. The other 1 sat could not be put on the card.',
      );
      expect(body('writing change to card (1 sat on card)', 'x', 2)).toBe(
        '10 sats are paid. 1 sat of your 2 sats change is on the card. The other 1 sat is saved on this terminal and will be added the next time this card is charged.',
      );
    });

    it('a landed count that does not fit the change falls back to the whole-change copy', () => {
      expect(
        body('writing change to card (unrecorded, 6 sat on card)', 'x'),
      ).toBe(
        '10 sats are paid. Your 6 sats change could not be put on the card.',
      );
      expect(body('writing change to card (9 sat on card)', 'x')).toBe(
        '10 sats are paid. Your 6 sats change is saved on this terminal and will be added the next time this card is charged.',
      );
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

describe('failureBody for a charge executeCharge flagged paid (ENG-642)', () => {
  const fmt = (sat: number) => `${sat} ${sat === 1 ? 'sat' : 'sats'}`;
  const paid = (changeSat: number) => ({
    burnsDone: 1,
    paidSat: 16,
    changeSat,
    paid: true,
    fmt,
  });

  it('an exact bill lost on the final read: paid, never "hold the card again"', () => {
    const body = failureBody(
      parseFailure('[reading card] Tag was lost.'),
      paid(0),
    );
    expect(body).toBe('16 sats are paid. There is nothing more to do.');
    expect(body).not.toMatch(/again/i);
  });

  it('the payment bookkeeping refused with change due: paid, the change not promised', () => {
    expect(
      failureBody(
        parseFailure('[recording the payment] keychain write denied'),
        paid(4),
      ),
    ).toBe('16 sats are paid. Your 4 sats change did not reach the card.');
  });

  it('the payment bookkeeping refused but the change landed: paid, the change on the card', () => {
    const failure = parseFailure(
      '[recording the payment (change on card)] keychain write denied',
    );
    expect(changeOnCard(failure)).toBe(true);
    expect(failedAfterSwap(failure)).toBe(false);
    const body = failureBody(failure, paid(4));
    expect(body).toBe('16 sats are paid. Your 4 sats change is on the card.');
    expect(body).not.toMatch(/did not reach|saved/i);
  });

  it('changeOnCard keys on the change-on-card phase only', () => {
    for (const message of [
      '[recording the payment] keychain write denied',
      '[writing change to card] Tag was lost.',
      '[writing change to card (unrecorded)] Tag was lost.',
      'keychain write denied',
    ]) {
      expect(changeOnCard(parseFailure(message))).toBe(false);
    }
  });

  it('a change write keeps its own copy: saved on the terminal', () => {
    expect(
      failureBody(
        parseFailure('[writing change to card] Tag was lost.'),
        paid(4),
      ),
    ).toBe(
      '16 sats are paid. Your 4 sats change is saved on this terminal and will be added the next time this card is charged.',
    );
  });

  it('one sat paid reads "is paid"', () => {
    expect(
      failureBody(parseFailure('[reading card] Tag was lost.'), {
        ...paid(0),
        paidSat: 1,
      }),
    ).toBe('1 sat is paid. There is nothing more to do.');
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

  // ENG-698: the offline refusals arrive while a PIN card's sheet is up, and
  // the raw sentence was cut to "This bill needs change, and this termin…".
  // The details exactly as `makeStep` wraps them, through `parseFailure`.
  const PREPARING = '[preparing the payment] ';

  it('names a bill whose change needs the mint in one short sentence', () => {
    expect(PIN_CHANGE_NEEDS_CONNECTION_TEXT).toBe(
      'Change needs a connection. Nothing was taken.',
    );
    expect(
      pinFailureText(parseFailure(PREPARING + CHANGE_NEEDS_MINT).detail),
    ).toBe(PIN_CHANGE_NEEDS_CONNECTION_TEXT);
  });

  it('names an online-only card on an offline terminal in one short sentence', () => {
    expect(PIN_ONLINE_ONLY_TEXT).toBe(
      'This card needs a connection. Nothing was taken.',
    );
    expect(pinFailureText(parseFailure(PREPARING + ONLINE_ONLY).detail)).toBe(
      PIN_ONLINE_ONLY_TEXT,
    );
  });

  it('keeps both offline lines no longer than the longest PIN verdict', () => {
    const longest = pinFailureText('VERIFY_PIN failed: PIN blocked');
    expect(longest).toBe('PIN blocked — this card can no longer be charged.');
    expect(longest.length).toBe(49);
    expect(PIN_CHANGE_NEEDS_CONNECTION_TEXT.length).toBeLessThanOrEqual(
      longest.length,
    );
    expect(PIN_ONLINE_ONLY_TEXT.length).toBeLessThanOrEqual(longest.length);
  });

  it('leaves every PIN verdict exactly as it was', () => {
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — 2 tries left')).toBe(
      'Wrong PIN — 2 tries left. Try again.',
    );
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — no tries left')).toBe(
      'PIN blocked — this card can no longer be charged.',
    );
    expect(pinFailureText('VERIFY_PIN failed: no PIN set')).toBe(
      'This card has no PIN. Tap again without one.',
    );
    expect(
      pinFailureText(
        'SPEND_ALL_SIGN failed: PIN needed for this payment (0x6A94)',
      ),
    ).toBe(PIN_NEEDED_TEXT);
  });
});

describe('protocol 2.0 copy (decision 2, Flash voice)', () => {
  const ctx = {
    burnsDone: 0,
    paidSat: 16,
    changeSat: 0,
    fmt: (sat: number) => `${sat} sats`,
  };

  it("a bill over the daily limit, from the pre-flight or the card's 6A8F, reads as the limit", () => {
    expect(DAILY_LIMIT_BODY).toBe(
      "This card has reached today's spending limit.",
    );
    expect(
      failureBody(
        parseFailure("This card has reached today's spending limit."),
        ctx,
      ),
    ).toBe(DAILY_LIMIT_BODY);
    expect(
      failureBody(
        parseFailure(
          "[burning 16 sat (proof 1/1)] SPEND_ALL_SIGN failed: over the card's daily limit (0x6A8F)",
        ),
        {...ctx, burnsDone: 1},
      ),
    ).toBe(DAILY_LIMIT_BODY);
  });

  it('a paid failure is never re-worded as the limit', () => {
    expect(
      failureBody(
        parseFailure("[recording the payment] over the card's daily limit"),
        {...ctx, paid: true},
      ),
    ).toBe('16 sats are paid. There is nothing more to do.');
  });

  it("the PIN pad's line for a bill over the no-PIN allowance (6A94 at SIGN)", () => {
    expect(PIN_NEEDED_TEXT).toBe("This payment needs the card's PIN.");
    expect(
      pinFailureText(
        'SPEND_ALL_SIGN failed: PIN needed for this payment (0x6A94)',
      ),
    ).toBe(PIN_NEEDED_TEXT);
  });

  it('an old card is told it needs an update, verbatim (decision 8)', () => {
    expect(failureBody(parseFailure('This card needs an update'), ctx)).toBe(
      'This card needs an update',
    );
  });
});

describe('settleUnconfirmed (ENG-674)', () => {
  const unconfirmed = parseFailure(
    '[settling payment — the mint has not confirmed it] the request never reached the network',
  );

  it('matches only the unconfirmed settling phase', () => {
    expect(settleUnconfirmed(unconfirmed)).toBe(true);
    expect(
      settleUnconfirmed(parseFailure('[settling payment] mint unreachable')),
    ).toBe(false);
    expect(
      settleUnconfirmed(
        parseFailure(
          '[settling payment and minting change (change owed, next tap)] x',
        ),
      ),
    ).toBe(false);
  });

  it('never says paid, even when the charge is flagged paid to block a re-charge', () => {
    const body = failureBody(unconfirmed, {
      burnsDone: 1,
      paidSat: 16,
      changeSat: 0,
      paid: true,
      fmt: (n: number) => `${n} sats`,
    });
    expect(body).toBe(UNCONFIRMED_BODY);
    expect(body).not.toMatch(/\bis paid\b|\bare paid\b|nothing more to do/);
  });
});

describe('settleRefused (ENG-674)', () => {
  const refused = parseFailure(
    '[settling payment — the mint refused it] proofs could not be verified',
  );
  const ctx = {
    burnsDone: 1,
    paidSat: 16,
    changeSat: 0,
    paid: true,
    fmt: (n: number) => `${n} sats`,
  };

  it('matches only the refused settling phase', () => {
    expect(settleRefused(refused)).toBe(true);
    expect(
      settleRefused(
        parseFailure(
          '[settling payment — the mint has not confirmed it] offline',
        ),
      ),
    ).toBe(false);
    expect(
      settleRefused(parseFailure('[settling payment and minting change] x')),
    ).toBe(false);
  });

  it('says the bill is not paid and not to charge the card again', () => {
    const body = failureBody(refused, ctx);
    expect(body).toBe(REFUSED_BODY);
    expect(body).toMatch(/not paid/);
    expect(body).toMatch(/Don't charge the card again/);
    expect(body).not.toMatch(/\bis paid\b|\bare paid\b|nothing more to do/);
  });
});

describe('a locked card (ENG-674)', () => {
  it('nothing was taken, and it says why', () => {
    const body = failureBody(
      parseFailure("This card is locked and can't be used to pay."),
      {burnsDone: 0, paidSat: 16, changeSat: 0, fmt: n => `${n} sats`},
    );
    expect(body).toBe(CARD_LOCKED_BODY);
  });
});

// ENG-696: both refusals are thrown inside the preparing step, before
// anything burns, so `makeStep` reports them as `[preparing the payment]
// <constant>`. The detectors read the constants exported by cashuCharge, so
// a wording change there cannot silently drop them back to the raw text.
describe('the change-needs-mint and online-only refusals (ENG-696)', () => {
  const changeNeedsMintFailure = parseFailure(
    `[preparing the payment] ${CHANGE_NEEDS_MINT}`,
  );
  const onlineOnlyFailure = parseFailure(
    `[preparing the payment] ${ONLINE_ONLY}`,
  );
  const lockedFailure = parseFailure(`[reading card] ${CARD_LOCKED}`);
  const unpaid = {burnsDone: 0, paidSat: 7, changeSat: 1, paid: false};
  const fmt = (n: number) => `${n} sats`;

  it('changeNeedsMint recognises its own refusal and nothing else', () => {
    expect(changeNeedsMint(changeNeedsMintFailure)).toBe(true);
    expect(changeNeedsMint(onlineOnlyFailure)).toBe(false);
    expect(changeNeedsMint(lockedFailure)).toBe(false);
  });

  it('onlineOnly recognises its own refusal and nothing else', () => {
    expect(onlineOnly(onlineOnlyFailure)).toBe(true);
    expect(onlineOnly(changeNeedsMintFailure)).toBe(false);
    expect(onlineOnly(lockedFailure)).toBe(false);
  });

  it('the body says nothing was taken, instead of repeating the pill', () => {
    const changeBody = failureBody(changeNeedsMintFailure, {...unpaid, fmt});
    expect(changeBody).toBe(CHANGE_NEEDS_MINT_BODY);
    expect(changeBody).toMatch(/^Nothing was taken/);

    const onlineBody = failureBody(onlineOnlyFailure, {...unpaid, fmt});
    expect(onlineBody).toBe(ONLINE_ONLY_BODY);
    expect(onlineBody).toMatch(/^Nothing was taken/);
  });

  it('each body fits where the locked-card body already renders', () => {
    // The body is numberOfLines={2}; CARD_LOCKED_BODY already ships there.
    expect(CHANGE_NEEDS_MINT_BODY.length).toBeLessThanOrEqual(
      CARD_LOCKED_BODY.length,
    );
    expect(ONLINE_ONLY_BODY.length).toBeLessThanOrEqual(
      CARD_LOCKED_BODY.length,
    );
  });
});
