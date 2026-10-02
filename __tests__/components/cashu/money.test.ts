import {
  changePieces,
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
    });
    expect(parseFailure('card PIN is blocked')).toEqual({
      phase: null,
      detail: 'card PIN is blocked',
      tagLost: false,
    });
  });

  it('reads an empty reason as the card going quiet', () => {
    expect(parseFailure('[settling payment and minting change]')).toEqual({
      phase: 'settling payment and minting change',
      detail: '',
      tagLost: true,
    });
    expect(parseFailure(null).tagLost).toBe(true);
  });
});

describe('pinFailureText', () => {
  it('turns the card\'s tries-left verdict into one instruction', () => {
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — 2 tries left')).toBe(
      'Wrong PIN — 2 tries left. Try again.',
    );
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — 1 try left')).toBe(
      'Wrong PIN — 1 try left. Try again.',
    );
  });

  it('says plainly when the PIN is blocked', () => {
    expect(pinFailureText('VERIFY_PIN failed: wrong PIN — no tries left')).toMatch(/PIN blocked/);
    expect(pinFailureText('VERIFY_PIN failed: PIN blocked')).toMatch(/PIN blocked/);
  });

  it('drops the APDU name and leaves anything else alone', () => {
    expect(pinFailureText('VERIFY_PIN failed: wrong length')).toBe('wrong length');
    expect(pinFailureText('Tag was lost.')).toBe('Tag was lost.');
  });
});
