/* eslint-disable no-bitwise -- byte-level protocol assertions. */
import {schnorrSignDigest} from '@cashu/cashu-ts';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';

import {
  APPLET_AID,
  AUTH_TAG,
  CARD_NEEDS_UPDATE,
  CardAuthError,
  CardError,
  CardNeedsUpdateError,
  CardProtocolError,
  LEGACY_AIDS,
  PACKAGE_AID,
  PROOF_SIZE,
  auth,
  authMessage,
  buildApdu,
  cardKeysetBytes,
  describeStatusWord,
  getBalance,
  getCard,
  getChange,
  getDleq,
  getDleqs,
  getInfo,
  getPieces,
  getPiecesNamed,
  getPiecesPage,
  getPiecesShort,
  getPiecesShortPage,
  getProof,
  getPubkey,
  getSlotStatuses,
  isAlreadyOnCard,
  isAppletNotFound,
  isCardNeedsUpdate,
  isPinNeededForPayment,
  loadProof,
  parseCardRecord,
  parseChangePage,
  parseInfo,
  parsePiecesPage,
  parseShortListing,
  parseResponse,
  readCard,
  selectApplet,
  setHeader,
  spendAllAgain,
  spendAllBegin,
  spendAllChange,
  spendAllOutputs,
  spendAllSign,
  tellTime,
  toHex,
  type Transceiver,
} from '../../src/services/cashuCard';
import * as cardModule from '../../src/services/cashuCard';
import {getApduTimings, resetApduTimings} from '../../src/services/apduTiming';

const vectors = require('../fixtures/card-protocol-2.0/secret.json') as {
  cardKey: string;
  auth: {
    tag: string;
    readerNonce: string;
    cardNonce: string;
    message: string;
    signature: string;
  };
};
const transcript = (
  require('../fixtures/card-protocol-2.0/transcript-excerpt.json') as {
    steps: {
      index: number;
      name: string;
      kind: string;
      apdu: string;
      sw: string;
      data: string;
      nonce?: string;
      r?: string;
    }[];
  }
).steps;
/** One step of the applet's own transcript, by its index there. */
const step = (index: number) => {
  const found = transcript.find(s => s.index === index);
  if (!found) {
    throw new Error(`no transcript step ${index}`);
  }
  return found;
};
const hexBytes = (h: string) => Array.from(hexToBytes(h));

const OK = [0x90, 0x00];
const ok = (data: number[] = []) => [...data, ...OK];
const sw = (code: number) => [(code >> 8) & 0xff, code & 0xff];

/**
 * GET_INFO body (P1 = 1): v2.0, 128 slots, 3 unspent / 1 spent / 124 empty,
 * every capability, PIN set, format 4, 3 tries, a record and an owner, a
 * daily limit of 5000, the clock, the window, 300 spent today, the change
 * grant; then no payment limit, an allowance of 250 and 40 counted against it.
 */
const INFO_BODY = [
  2, 0, 128, 3, 1, 124, 0xff, 0x01, 0x04, 0x03, 0x00, 0x01, 0x00, 0x00, 0x13,
  0x88, 0x01, 0x6a, 0xc8, 0x73, 0x72, 0x6a, 0xc8, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x2c, 0x01, 0, 0, 0, 0, 0x00, 0x00, 0x00, 0xfa, 0x00, 0x00, 0x00, 0x28,
];
const CARD_PRIVATE = '11'.repeat(32);
const PUBKEY_BODY = hexBytes(
  // the public key of CARD_PRIVATE: AUTH answers verify under it
  bytesToHex(
    (
      jest.requireActual('@cashu/cashu-ts') as typeof import('@cashu/cashu-ts')
    ).getPubKeyFromPrivKey(hexToBytes(CARD_PRIVATE)),
  ),
);

// Distinct byte ranges per field, so a one-byte slice error cannot pass by
// landing on a neighbour that happens to hold the same value.
const KEYSET_BYTES = [0x00, 0x59, 0x53, 0x4c, 0xe0, 0xbf, 0xa1, 0x9a];
const NONCE_BYTES = Array.from({length: 32}, (_, i) => 0x40 + i);
const C_BYTES = [0x02, ...Array.from({length: 32}, (_, i) => 0x80 + i)];
/** 500, big-endian uint32. */
const AMOUNT_BYTES = [0x00, 0x00, 0x01, 0xf4];
/** 1,700,000,000: a date. */
const DATE_BYTES = [0x65, 0x53, 0xf1, 0x00];

/** status[1] + keyset_id[8] + amount[4] + nonce[32] + C[33] + date[4] = 82 bytes. */
const proofBody = ({
  status = 0x01,
  amount = AMOUNT_BYTES,
}: {status?: number; amount?: number[]} = {}) => [
  status,
  ...KEYSET_BYTES,
  ...amount,
  ...NONCE_BYTES,
  ...C_BYTES,
  ...DATE_BYTES,
];

const SIGNATURE = Array.from({length: 64}, (_, i) => (i * 3 + 1) & 0xff);

/**
 * A fake card that answers the read commands. Records every APDU it is sent so
 * tests can assert on the wire format, not just the parsed result. AUTH is
 * answered with a real BIP-340 signature by CARD_PRIVATE (or another key).
 */
function fakeCard(
  overrides: {
    selectFails?: number[];
    selectThrows?: unknown;
    selectVersion?: number[];
    /** The 2.0 AIDs' SELECT answers this status word. */
    selectSw?: number;
    legacyAnswers?: boolean;
    /** Only this old AID answers (9000). */
    legacyAid?: number[];
    infoBody?: number[];
    pubkeyBody?: number[];
    balanceBody?: number[];
    proofBody?: number[];
    proofStatusWord?: number;
    slotStatuses?: number[];
    authKey?: string;
    authBody?: number[];
  } = {},
) {
  const sent: number[][] = [];
  const transceive: Transceiver = async apdu => {
    sent.push(apdu);
    const [cla, ins] = apdu;

    if (cla === 0x00 && ins === 0xa4) {
      // A transport failure — the card left the field mid-SELECT.
      if (overrides.selectThrows !== undefined) {
        throw overrides.selectThrows;
      }
      const aidLength = apdu[4];
      const aid = apdu.slice(5, 5 + aidLength);
      const legacy = LEGACY_AIDS.some(
        l => l.length === aid.length && l.every((b, i) => aid[i] === b),
      );
      if (legacy) {
        const answers = overrides.legacyAid
          ? toHex(overrides.legacyAid) === toHex(aid)
          : overrides.legacyAnswers;
        return answers ? ok([0, 2]) : sw(0x6a82);
      }
      if (overrides.selectSw !== undefined) {
        return sw(overrides.selectSw);
      }
      if (overrides.selectFails?.includes(aidLength)) {
        return sw(0x6a82);
      }
      // Real cards obey Le. A Case-3 SELECT (header + Lc + AID, no Le) asks
      // for no response body, so the card answers with a status word only —
      // which is exactly what iOS produces when the Le byte is omitted.
      const hasLe = apdu.length > 5 + aidLength;
      return hasLe ? ok(overrides.selectVersion ?? [2, 0]) : ok([]);
    }
    if (cla === 0xb0 && ins === 0x01) {
      const body = overrides.infoBody ?? INFO_BODY;
      return ok(apdu[2] === 0 ? body.slice(0, 30) : body);
    }
    if (cla === 0xb0 && ins === 0x10) {
      return ok(overrides.pubkeyBody ?? PUBKEY_BODY);
    }
    if (cla === 0xb0 && ins === 0x11) {
      return ok(overrides.balanceBody ?? [0, 0, 0x01, 0xf4]);
    }
    if (cla === 0xb0 && ins === 0x14) {
      if (overrides.slotStatuses) {
        return ok(overrides.slotStatuses);
      }
      return ok([0x00, 0x01, 0x02]);
    }
    if (cla === 0xb0 && ins === 0x13) {
      if (overrides.proofStatusWord) {
        return sw(overrides.proofStatusWord);
      }
      return ok(overrides.proofBody ?? proofBody());
    }
    if (cla === 0xb0 && ins === 0x15) {
      if (overrides.authBody) {
        return ok(overrides.authBody);
      }
      const reader = apdu.slice(5, 5 + apdu[4]);
      const card = Array.from({length: 16}, (_, i) => 0x30 + i);
      const message = authMessage(reader, card, PUBKEY_BODY);
      const signature = schnorrSignDigest(
        message,
        overrides.authKey ?? CARD_PRIVATE,
      );
      return ok([...card, ...hexBytes(signature)]);
    }
    return sw(0x6d00);
  };
  return {transceive, sent};
}

/** A transceiver that answers each APDU from a list, recording what was sent. */
function scripted(answers: number[][]) {
  const sent: number[][] = [];
  const transceive: Transceiver = async apdu => {
    sent.push(apdu);
    const answer = answers.shift();
    if (!answer) {
      throw new Error(`no scripted answer for ${toHex(apdu)}`);
    }
    return answer;
  };
  return {transceive, sent};
}

/** A transcript step's answer as a transceiver response: data then SW. */
const answerOf = (index: number) => {
  const s = step(index);
  return [...hexBytes(s.data), ...hexBytes(s.sw)];
};

describe('buildApdu', () => {
  it('builds a bare command with no data and no Le', () => {
    expect(buildApdu(0x01)).toEqual([0xb0, 0x01, 0x00, 0x00]);
  });

  it('appends Le when given', () => {
    expect(buildApdu(0x10, {le: 0x21})).toEqual([0xb0, 0x10, 0x00, 0x00, 0x21]);
  });

  it('prefixes data with its length', () => {
    expect(buildApdu(0x20, {p1: 0x02, data: [0xaa, 0xbb]})).toEqual([
      0xb0, 0x20, 0x02, 0x00, 0x02, 0xaa, 0xbb,
    ]);
  });

  it('omits the length byte for empty data rather than sending Lc=0', () => {
    expect(buildApdu(0x01, {data: []})).toEqual([0xb0, 0x01, 0x00, 0x00]);
  });

  it('accepts the largest payload short-form Lc can express', () => {
    const data = Array.from({length: 255}, () => 0xaa);
    expect(buildApdu(0x20, {data})[4]).toBe(255);
  });

  // Regression: an unchecked push writes `300` as an "Lc byte"; the native
  // bridge truncates it to 0x2c and the card reads a silently corrupt length.
  // The commands that will carry payloads are the ones that move money.
  it('refuses a payload too long for short-form Lc instead of truncating it', () => {
    const data = Array.from({length: 300}, () => 0xaa);

    expect(() => buildApdu(0x20, {data})).toThrow(CardProtocolError);
    expect(() => buildApdu(0x20, {data})).toThrow(/300 bytes/);
  });
});

describe('parseResponse', () => {
  it('strips the status word from the body', () => {
    expect(parseResponse(ok([0xde, 0xad]), 'TEST')).toEqual([0xde, 0xad]);
  });

  it('accepts an empty body with a success status word', () => {
    expect(parseResponse(OK, 'TEST')).toEqual([]);
  });

  it('throws CardError carrying the status word', () => {
    expect(() => parseResponse(sw(0x6982), 'TEST')).toThrow(CardError);
    try {
      parseResponse(sw(0x6982), 'TEST');
    } catch (error) {
      expect((error as CardError).sw).toBe(0x6982);
      expect((error as CardError).message).toContain('PIN required');
    }
  });

  it('rejects a response too short to contain a status word', () => {
    expect(() => parseResponse([0x90], 'TEST')).toThrow(/truncated/);
  });

  // A framing failure is not a card refusal. Reporting it as CardError with
  // sw = 0 would both read as "unexpected status word (0x0000)" to a merchant
  // and let retry logic branching on `sw` misclassify it.
  it('reports a framing failure as CardProtocolError, not a status word', () => {
    expect(() => parseResponse([0x90], 'TEST')).toThrow(CardProtocolError);
    expect(() => parseResponse([0x90], 'TEST')).not.toThrow(CardError);
    try {
      parseResponse([0x90], 'TEST');
    } catch (error) {
      expect((error as Error).message).toBe(
        'TEST: truncated response (1 bytes)',
      );
      expect((error as Error).message).not.toMatch(/status word/);
    }
  });
});

describe('describeStatusWord', () => {
  it.each([
    [0x9000, 'OK'],
    [0x6982, 'PIN required'],
    [0x6983, 'PIN blocked'],
    [0x6984, 'no PIN set'],
    // VERIFY's 63Cx: the low nibble is the tries left (field-found 2026-10-02
    // as a bare "unexpected status word (0x63C2)" on the PIN sheet).
    [0x63c2, 'wrong PIN — 2 tries left'],
    [0x63c1, 'wrong PIN — 1 try left'],
    [0x63c0, 'wrong PIN — no tries left'],
    [0x6a82, 'applet not found'],
    [0x6e00, 'wrong CLA'],
    // The status words the money-moving commands actually return.
    [0x6985, 'proof already spent'],
    [0x6a83, 'slot index out of range'],
    [0x6a88, 'slot is empty'],
    [0x6a86, 'invalid P1/P2'],
    [0x6f00, 'the card failed to sign'],
    [0x6700, 'wrong length'],
    [0x6d00, 'unsupported command'],
  ])('names 0x%s', (code, expected) => {
    expect(describeStatusWord(code as number)).toContain(expected as string);
  });

  it('falls back for unknown codes instead of throwing', () => {
    expect(describeStatusWord(0x1234)).toBe('unexpected status word');
  });

  it.each([
    [0x6a8f, '', "over the card's daily limit"],
    [0x6a96, '', 'too many places'],
    [0x6a93, '', 'too little work'],
    [0x6986, '', 'card locked'],
    [0x6a90, '', 'no owner'],
    [0x6a8c, '', 'no record'],
    // 6A94 means two things, and the command picks which.
    [0x6a94, 'LOAD_PROOF', 'already on the card'],
    [0x6a94, 'SPEND_ALL_SIGN', 'PIN needed for this payment'],
    [0x6985, 'SPEND_ALL_SIGN', 'no payment begun'],
    [0x6985, 'SPEND_ALL_BEGIN', 'proof already spent'],
    [0x6a84, 'LOAD_PROOF', 'card is full'],
    [0x6a84, 'SPEND_ALL_CHANGE', 'no change opening free'],
    [0x6a88, 'SPEND_ALL_AGAIN', 'no signature to give again'],
  ])('names 0x%s for %s as %s', (code, context, expected) => {
    expect(describeStatusWord(code as number, context as string)).toContain(
      expected as string,
    );
  });

  it('a CardError words the status for its own command', () => {
    expect(new CardError(0x6a94, 'LOAD_PROOF').message).toBe(
      'LOAD_PROOF failed: already on the card (0x6A94)',
    );
    expect(new CardError(0x6a94, 'SPEND_ALL_SIGN').message).toBe(
      'SPEND_ALL_SIGN failed: PIN needed for this payment (0x6A94)',
    );
  });
});

describe('the 6A94 classifiers', () => {
  it("isAlreadyOnCard is LOAD_PROOF's 6A94 only", () => {
    expect(isAlreadyOnCard(new CardError(0x6a94, 'LOAD_PROOF'))).toBe(true);
    expect(isAlreadyOnCard(new CardError(0x6a94, 'SPEND_ALL_SIGN'))).toBe(
      false,
    );
    expect(isAlreadyOnCard(new CardError(0x6a84, 'LOAD_PROOF'))).toBe(false);
  });

  it("isPinNeededForPayment is SPEND_ALL_SIGN's 6A94, raw or as a cause", () => {
    const sign = new CardError(0x6a94, 'SPEND_ALL_SIGN');
    expect(isPinNeededForPayment(sign)).toBe(true);
    expect(
      isPinNeededForPayment(Object.assign(new Error('wrapped'), {cause: sign})),
    ).toBe(true);
    expect(isPinNeededForPayment(new CardError(0x6a94, 'LOAD_PROOF'))).toBe(
      false,
    );
    expect(isPinNeededForPayment(new CardError(0x6982, 'SPEND_ALL_SIGN'))).toBe(
      false,
    );
  });
});

describe('isAppletNotFound', () => {
  it('matches the raw SELECT CardError', () => {
    expect(isAppletNotFound(new CardError(0x6a82, 'SELECT'))).toBe(true);
    expect(isAppletNotFound(new CardError(0x6983, 'VERIFY'))).toBe(false);
  });

  it('matches the per-phase wrapper readAndPlan rethrows through its cause', () => {
    const wrapped = (cause: unknown) =>
      Object.assign(new Error('[reading card] wrapped'), {cause});
    expect(isAppletNotFound(wrapped(new CardError(0x6a82, 'SELECT')))).toBe(
      true,
    );
    expect(isAppletNotFound(wrapped(new CardError(0x6983, 'VERIFY')))).toBe(
      false,
    );
    expect(isAppletNotFound(wrapped(new Error('card left the field')))).toBe(
      false,
    );
  });

  it('decides on the class and status word, never on the message text', () => {
    // A rewording of describeStatusWord or the phase prefix must not change
    // the routing decision, and a message alone is not evidence of a card.
    expect(
      isAppletNotFound(
        new Error('[reading card] SELECT failed: applet not found (0x6A82)'),
      ),
    ).toBe(false);
    expect(
      isAppletNotFound(new Error('[reading card] card left the field')),
    ).toBe(false);
  });

  it('ignores non-errors', () => {
    expect(isAppletNotFound('applet not found')).toBe(false);
    expect(isAppletNotFound(undefined)).toBe(false);
  });
});

describe('selectApplet', () => {
  it('selects with the 2.0 package AID first ("CASHUCARD" after F0)', async () => {
    const card = fakeCard();
    await selectApplet(card.transceive);
    expect(card.sent).toHaveLength(1);
    expect(card.sent[0]).toEqual([
      0x00,
      0xa4,
      0x04,
      0x00,
      PACKAGE_AID.length,
      ...PACKAGE_AID,
      0x00,
    ]);
    // Byte for byte the applet transcript's own SELECT, plus the Le.
    expect(toHex(card.sent[0])).toBe(`${step(0).apdu}00`);
  });

  it('falls back to the full applet AID when prefix select is unsupported', async () => {
    const card = fakeCard({selectFails: [PACKAGE_AID.length]});
    await selectApplet(card.transceive);
    expect(card.sent).toHaveLength(2);
    expect(card.sent[1]).toEqual([
      0x00,
      0xa4,
      0x04,
      0x00,
      APPLET_AID.length,
      ...APPLET_AID,
      0x00,
    ]);
  });

  it('surfaces the card error when no AID selects', async () => {
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
    });
    const failure = await selectApplet(card.transceive).catch(e => e);
    expect(failure).toBeInstanceOf(CardError);
    expect(failure.message).toMatch(/applet not found/);
    // Not an eCash card at all (a BoltCard): the router's NDEF path keys on this.
    expect(isAppletNotFound(failure)).toBe(true);
    expect(isCardNeedsUpdate(failure)).toBe(false);
  });

  it('returns the applet version reported by SELECT', async () => {
    const card = fakeCard();
    expect(await selectApplet(card.transceive)).toEqual([2, 0]);
  });

  it('a 0.x card (the old AID answers) needs an update, and is sent nothing but SELECT commands', async () => {
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
      legacyAnswers: true,
    });
    const failure = await selectApplet(card.transceive).catch(e => e);

    expect(failure).toBeInstanceOf(CardNeedsUpdateError);
    expect(failure.message).toBe(CARD_NEEDS_UPDATE);
    expect(failure.message).toBe('This card needs an update');
    expect(isCardNeedsUpdate(failure)).toBe(true);
    expect(isAppletNotFound(failure)).toBe(false);
    expect(card.sent.every(a => a[0] === 0x00 && a[1] === 0xa4)).toBe(true);
    // The 2.0 AIDs first, then the 0.x package AID, which answered.
    expect(card.sent.map(a => toHex(a.slice(5, 5 + a[4])))).toEqual([
      toHex(PACKAGE_AID),
      toHex(APPLET_AID),
      toHex(LEGACY_AIDS[0]),
    ]);
  });

  it('a 2.0 AID that answers with a major below 2 needs an update', async () => {
    const card = fakeCard({selectVersion: [1, 20]});
    await expect(selectApplet(card.transceive)).rejects.toBeInstanceOf(
      CardNeedsUpdateError,
    );
    expect(card.sent).toHaveLength(1);
  });

  it('the needs-update check survives the per-phase wrapper', () => {
    const wrapped = Object.assign(new Error('[reading card] wrapped'), {
      cause: new CardNeedsUpdateError(),
    });
    expect(isCardNeedsUpdate(wrapped)).toBe(true);
    expect(isCardNeedsUpdate(new CardError(0x6a82, 'SELECT'))).toBe(false);
  });

  // Regression: without the trailing Le byte this is an ISO 7816 Case-3
  // command. iOS parses it as expectedResponseLength -1, CoreNFC sends no Le,
  // and the card returns a status word only — so the version silently
  // disappears. The fake card only yields a body when Le is present, so
  // dropping the byte fails this test.
  it('sends a Case-4 SELECT with Le so the card returns the version body', async () => {
    const card = fakeCard();
    const version = await selectApplet(card.transceive);

    expect(card.sent[0][card.sent[0].length - 1]).toBe(0x00);
    expect(card.sent[0]).toHaveLength(5 + PACKAGE_AID.length + 1);
    expect(version).toEqual([2, 0]);
  });

  // A card that moved out of the field is not a card with the wrong software.
  it('rethrows a transport failure instead of retrying on a dead handle', async () => {
    const card = fakeCard({selectThrows: new Error('tag was lost')});

    await expect(selectApplet(card.transceive)).rejects.toThrow('tag was lost');
    // Exactly one attempt: no fallback SELECT on a handle that is already gone.
    expect(card.sent).toHaveLength(1);
  });

  // tools/cardsim/README.md, "Old cards": an old AID through jCardSim
  // answers 6E00 or 6999 where a real card's runtime answers 6A82 — "treat
  // any SELECT answer that is not 02xx 9000 as 'This card needs an update'".
  it.each([0x6e00, 0x6999, 0x6d00, 0x6f00])(
    'a 2.0 AID answered %s needs an update, with no fallback AID tried',
    async code => {
      const card = fakeCard({selectSw: code});
      const failure = await selectApplet(card.transceive).catch(e => e);

      expect(failure).toBeInstanceOf(CardNeedsUpdateError);
      expect(failure.message).toBe(CARD_NEEDS_UPDATE);
      expect(isAppletNotFound(failure)).toBe(false);
      expect(card.sent).toHaveLength(1);
    },
  );

  it('a status word thrown as a CardError is classed the same way', async () => {
    const card = fakeCard({selectThrows: new CardError(0x6e00, 'SELECT')});

    await expect(selectApplet(card.transceive)).rejects.toBeInstanceOf(
      CardNeedsUpdateError,
    );
    expect(card.sent).toHaveLength(1);
  });

  it.each([
    ['an empty version', []],
    ['a one-byte version', [2]],
    ['version 3.0', [3, 0]],
    ['version 1.20', [1, 20]],
    ['three bytes', [2, 0, 0]],
  ])('a 9000 with %s needs an update', async (_, version) => {
    const card = fakeCard({selectVersion: version});

    await expect(selectApplet(card.transceive)).rejects.toBeInstanceOf(
      CardNeedsUpdateError,
    );
    expect(card.sent).toHaveLength(1);
  });

  it('accepts any 2.0 minor', async () => {
    const card = fakeCard({selectVersion: [2, 7]});
    await expect(selectApplet(card.transceive)).resolves.toEqual([2, 7]);
  });

  it("a Foxy 1.x card (F0 46 4F 58 59 43 41 52 44 answers) needs an update, not 'not a Flash card'", async () => {
    const FOXY = [0xf0, 0x46, 0x4f, 0x58, 0x59, 0x43, 0x41, 0x52, 0x44];
    expect(LEGACY_AIDS.map(toHex)).toContain(toHex(FOXY));
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
      legacyAid: FOXY,
    });
    const failure = await selectApplet(card.transceive).catch(e => e);

    expect(failure).toBeInstanceOf(CardNeedsUpdateError);
    expect(isAppletNotFound(failure)).toBe(false);
    expect(card.sent.every(a => a[0] === 0x00 && a[1] === 0xa4)).toBe(true);
    expect(toHex(card.sent[card.sent.length - 1].slice(5, 14))).toBe(
      toHex(FOXY),
    );
  });

  it('a card that answers 6A82 to every AID, old ones too, is not an eCash card', async () => {
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
    });
    const failure = await selectApplet(card.transceive).catch(e => e);
    expect(isAppletNotFound(failure)).toBe(true);
    expect(card.sent).toHaveLength(2 + LEGACY_AIDS.length);
  });
});

describe('getInfo', () => {
  it('decodes the 42-byte info block (P1 = 1)', async () => {
    const card = fakeCard();
    expect(await getInfo(card.transceive)).toEqual({
      version: '2.0',
      major: 2,
      minor: 0,
      maxSlots: 128,
      unspent: 3,
      spent: 1,
      empty: 124,
      capabilities: 0xff,
      secp256k1Native: true,
      schnorr: true,
      pinState: 'set',
      format: 4,
      triesLeft: 3,
      locked: false,
      recordSet: true,
      dailyLimit: 5000,
      hasOwner: true,
      now: 0x6ac87372,
      windowStart: 0x6ac80000,
      spentToday: 300,
      changeGrant: true,
      paymentLimit: 0,
      allowance: 250,
      noPinSpent: 40,
    });
  });

  it('asks with P1 = 1 by default, and P1 = 0 for the 30-byte block', async () => {
    const card = fakeCard();
    await getInfo(card.transceive);
    await getInfo(card.transceive, {p1: 0});
    expect(card.sent[0]).toEqual([0xb0, 0x01, 0x01, 0x00, 0x00]);
    expect(card.sent[1]).toEqual([0xb0, 0x01, 0x00, 0x00, 0x00]);
  });

  it('P1 = 0 has no allowance fields', async () => {
    const card = fakeCard();
    const info = await getInfo(card.transceive, {p1: 0});
    expect(info.allowance).toBeUndefined();
    expect(info.changeGrant).toBe(true);
  });

  it("decodes the applet transcript's own answers", () => {
    // A new card (step 1): no PIN, nothing on it, format 4, three tries.
    expect(parseInfo(hexBytes(step(1).data))).toMatchObject({
      major: 2,
      maxSlots: 128,
      unspent: 0,
      empty: 128,
      pinState: 'unset',
      format: 4,
      triesLeft: 3,
      hasOwner: false,
      now: 0,
    });
    // P1 = 1 after a payment of 90 with a 40 of its own change (step 484).
    const after = parseInfo(hexBytes(step(484).data));
    expect(after.allowance).toBe(0);
    expect(after.hasOwner).toBe(true);
    expect(after.recordSet).toBe(true);
  });

  it('decodes capability flags independently', async () => {
    const body = [...INFO_BODY];
    body[6] = 0x02;
    body[7] = 0x00;
    const info = await getInfo(fakeCard({infoBody: body}).transceive);
    expect(info.secp256k1Native).toBe(false);
    expect(info.schnorr).toBe(true);
    expect(info.pinState).toBe('unset');
  });

  it.each([
    [0, 'unset'],
    [1, 'set'],
    [2, 'blocked'],
    [9, 'unknown'],
  ])('maps PIN state byte %i to %s', async (byte, expected) => {
    const body = [...INFO_BODY];
    body[7] = byte as number;
    const card = fakeCard({infoBody: body});
    expect((await getInfo(card.transceive)).pinState).toBe(expected);
  });

  it('rejects a short info block rather than reading undefined bytes', async () => {
    const card = fakeCard({infoBody: [2, 0, 128, 0, 0, 0, 0, 0]});
    await expect(getInfo(card.transceive)).rejects.toThrow(
      /expected at least 30 bytes/,
    );
  });

  it('a card that reports a major below 2 needs an update', async () => {
    const body = [...INFO_BODY];
    body[0] = 1;
    await expect(
      getInfo(fakeCard({infoBody: body}).transceive),
    ).rejects.toBeInstanceOf(CardNeedsUpdateError);
  });
});

describe('getPubkey', () => {
  it('returns the 33-byte compressed key', async () => {
    const card = fakeCard();
    const key = await getPubkey(card.transceive);
    expect(key).toHaveLength(33);
    expect([0x02, 0x03]).toContain(key[0]);
  });

  it('sends Le=0x21', async () => {
    const card = fakeCard();
    await getPubkey(card.transceive);
    expect(card.sent[0]).toEqual([0xb0, 0x10, 0x00, 0x00, 0x21]);
  });

  it('rejects a short key — a truncated pubkey would poison a P2PK lock', async () => {
    const card = fakeCard({pubkeyBody: [0x02, 0x03]});
    await expect(getPubkey(card.transceive)).rejects.toThrow(
      /expected 33 bytes/,
    );
  });

  // The card answered 0x9000. Dressing a length mismatch up as a status-word
  // failure produces "…got 2 failed: unexpected status word (0x0000)" in front
  // of a merchant, and lies to anything branching on `sw`.
  it('reports a wrong-length body as CardProtocolError with a clean message', async () => {
    const card = fakeCard({pubkeyBody: [0x02, 0x03]});

    await expect(getPubkey(card.transceive)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    await expect(getPubkey(card.transceive)).rejects.not.toBeInstanceOf(
      CardError,
    );
    await expect(getPubkey(card.transceive)).rejects.toThrow(
      'GET_PUBKEY: expected 33 bytes, got 2',
    );
  });
});

describe('getBalance', () => {
  it('decodes a big-endian uint32', async () => {
    const card = fakeCard();
    expect(await getBalance(card.transceive)).toBe(500);
  });

  it('stays unsigned above 2^31 — a large balance must not read negative', async () => {
    const card = fakeCard({balanceBody: [0xff, 0xff, 0xff, 0xff]});
    expect(await getBalance(card.transceive)).toBe(4294967295);
  });

  it('reads zero on an empty card', async () => {
    const card = fakeCard({balanceBody: [0, 0, 0, 0]});
    expect(await getBalance(card.transceive)).toBe(0);
  });

  it('rejects a wrong-length balance', async () => {
    const card = fakeCard({balanceBody: [0, 1]});
    await expect(getBalance(card.transceive)).rejects.toThrow(
      /expected 4 bytes/,
    );
  });
});

describe('readCard', () => {
  it('performs SELECT then the read commands and AUTH, in order', async () => {
    const card = fakeCard();
    const summary = await readCard(card.transceive);

    expect(card.sent.map(a => [a[0], a[1]])).toEqual([
      [0x00, 0xa4],
      [0xb0, 0x01],
      [0xb0, 0x10],
      [0xb0, 0x15],
      [0xb0, 0x11],
    ]);
    expect(summary.appletVersion).toBe('2.0');
    expect(summary.balance).toBe(500);
    expect(summary.info.maxSlots).toBe(128);
    expect(summary.pubkey).toHaveLength(66);
    expect(summary.pubkey).toBe(toHex(PUBKEY_BODY));
  });

  it('spends nothing — no payment command or LOAD_PROOF is ever sent', async () => {
    const card = fakeCard();
    await readCard(card.transceive);
    const mutating = card.sent.filter(a =>
      [0x22, 0x23, 0x24, 0x25, 0x26, 0x30, 0x31, 0x50].includes(a[1]),
    );
    expect(mutating).toEqual([]);
  });

  it('fails the read when the card cannot prove its key (AUTH by another key)', async () => {
    const card = fakeCard({authKey: '22'.repeat(32)});
    await expect(readCard(card.transceive)).rejects.toBeInstanceOf(
      CardAuthError,
    );
    // No balance is reported for a card that did not prove its key.
    expect(card.sent.map(a => a[1])).not.toContain(0x11);
  });

  it('fails fast when the applet is absent', async () => {
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
    });
    await expect(readCard(card.transceive)).rejects.toThrow(/applet not found/);
    // Nothing beyond the SELECT attempts (2.0, then 0.x) was tried.
    expect(card.sent.every(a => a[1] === 0xa4)).toBe(true);
    expect(card.sent).toHaveLength(2 + LEGACY_AIDS.length);
  });

  it('a 0.x card is refused as needing an update, with nothing read from it', async () => {
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
      legacyAnswers: true,
    });
    await expect(readCard(card.transceive)).rejects.toBeInstanceOf(
      CardNeedsUpdateError,
    );
    expect(card.sent.every(a => a[1] === 0xa4)).toBe(true);
  });
});

describe('getProof', () => {
  // Every field gets its own byte range, so an off-by-one in any slice moves
  // values between fields and fails here rather than at the mint, after the
  // money is already gone.
  it('decodes all six fields of the 82-byte slot', async () => {
    const card = fakeCard();
    expect(await getProof(card.transceive, 3)).toEqual({
      slot: 3,
      status: 'unspent',
      // Raw bytes to hex — 16 chars. Decoding as ASCII gives 8, matching no
      // keyset at the mint.
      keysetId: '0059534ce0bfa19a',
      amount: 500,
      nonce: toHex(NONCE_BYTES),
      C: toHex(C_BYTES),
      date: 1700000000,
    });
  });

  it("decodes the applet transcript's slot 0", async () => {
    const {transceive, sent} = scripted([answerOf(151)]);
    const proof = await getProof(transceive, 0);
    // The transcript's reader asks with Le 00 (any length); the spec's Le is
    // the slot's 82 bytes, which iOS needs stated.
    expect(toHex(sent[0].slice(0, 4))).toBe(step(151).apdu.slice(0, 8));
    expect(sent[0][4]).toBe(PROOF_SIZE);
    expect(proof).toMatchObject({
      slot: 0,
      status: 'unspent',
      keysetId: '0059534ce0bfa19a',
      amount: 600,
    });
  });

  it('produces field lengths the mint will accept', async () => {
    const card = fakeCard();
    const proof = await getProof(card.transceive, 0);
    expect(proof.keysetId).toHaveLength(16);
    expect(proof.nonce).toHaveLength(64);
    expect(proof.C).toHaveLength(66);
    expect(proof.C.startsWith('02')).toBe(true);
  });

  it('reports a spent slot as spent — spent slots stay readable', async () => {
    const card = fakeCard({proofBody: proofBody({status: 0x02})});
    expect((await getProof(card.transceive, 0)).status).toBe('spent');
  });

  it('stays unsigned above 2^31 — a large amount must not read negative', async () => {
    const card = fakeCard({
      proofBody: proofBody({amount: [0xff, 0xff, 0xff, 0xff]}),
    });
    expect((await getProof(card.transceive, 0)).amount).toBe(4294967295);
  });

  it('decodes a zero amount', async () => {
    const card = fakeCard({proofBody: proofBody({amount: [0, 0, 0, 0]})});
    expect((await getProof(card.transceive, 0)).amount).toBe(0);
  });

  it('sends the documented APDU with the slot in P1 and Le = 82', async () => {
    const card = fakeCard();
    await getProof(card.transceive, 7);
    expect(card.sent[0]).toEqual([0xb0, 0x13, 0x07, 0x00, PROOF_SIZE]);
  });

  it('rejects a short slot rather than reading undefined bytes', async () => {
    const card = fakeCard({proofBody: proofBody().slice(0, 81)});
    await expect(getProof(card.transceive, 2)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    await expect(getProof(card.transceive, 2)).rejects.toThrow(
      'GET_PROOF slot 2: expected 82 bytes, got 81',
    );
  });

  it('rejects a long slot too', async () => {
    const card = fakeCard({proofBody: [...proofBody(), 0x00]});
    await expect(getProof(card.transceive, 0)).rejects.toThrow(
      /expected 82 bytes, got 83/,
    );
  });

  // 0x00 is an empty slot the card should have refused; anything else is a
  // protocol the driver does not understand. Guessing 'unspent' would hand a
  // garbage proof to the mint.
  it('rejects an unknown status byte instead of guessing', async () => {
    const card = fakeCard({proofBody: proofBody({status: 0x03})});
    await expect(getProof(card.transceive, 1)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    await expect(getProof(card.transceive, 1)).rejects.toThrow(
      'GET_PROOF slot 1: unknown status byte 0x3',
    );
  });

  it('rejects an empty status byte', async () => {
    const card = fakeCard({proofBody: proofBody({status: 0x00})});
    await expect(getProof(card.transceive, 0)).rejects.toThrow(
      /unknown status byte 0x0/,
    );
  });

  it('surfaces a card refusal as a CardError naming the slot', async () => {
    const card = fakeCard({proofStatusWord: 0x6a88});
    await expect(getProof(card.transceive, 9)).rejects.toBeInstanceOf(
      CardError,
    );
    await expect(getProof(card.transceive, 9)).rejects.toThrow(
      /GET_PROOF slot 9 failed: slot is empty/,
    );
  });
});

// 0.x's SPEND_PROOF burned a slot for a message the reader chose, and
// SIGN_ARBITRARY signed any 32 bytes and burned nothing: both are gone from
// 2.0 cards (the applet answers 6D00) and from this module. The card signs
// only payments it builds the message for itself, and AUTH's tagged hash.
describe('the 0.x signers are gone', () => {
  it('exports no spendProof, signArbitrary or resignWitness', () => {
    const mod = cardModule as Record<string, unknown>;
    expect(mod.spendProof).toBeUndefined();
    expect(mod.signArbitrary).toBeUndefined();
    expect(mod.__signArbitraryForTests).toBeUndefined();
    expect(mod.resignWitness).toBeUndefined();
  });

  it('names no 0x20 or 0x21 instruction', () => {
    const ins = Object.values(cardModule.INS) as number[];
    expect(ins).not.toContain(0x20);
    expect(ins).not.toContain(0x21);
  });
});

describe('SPEND_ALL_BEGIN', () => {
  it('names the places, Le 04, and reads what they are worth (transcript 96)', async () => {
    const {transceive, sent} = scripted([answerOf(96)]);
    await expect(spendAllBegin(transceive, [0])).resolves.toBe(16);
    expect(toHex(sent[0])).toBe(step(96).apdu);
  });

  it("a spent place is the card's 6985 (transcript 186)", async () => {
    const {transceive} = scripted([answerOf(186)]);
    const failure = await spendAllBegin(transceive, [0]).catch(e => e);
    expect(failure).toBeInstanceOf(CardError);
    expect(failure.sw).toBe(0x6985);
    expect(failure.message).toMatch(/proof already spent/);
  });

  it('frames several places in the order given (transcript 567)', async () => {
    const {transceive, sent} = scripted([answerOf(567)]);
    await expect(spendAllBegin(transceive, [3, 3])).rejects.toThrow(
      /wrong data/,
    );
    expect(toHex(sent[0])).toBe(step(567).apdu);
  });

  it('refuses no places, or a slot past 127, before any APDU', async () => {
    const {transceive, sent} = scripted([]);
    await expect(spendAllBegin(transceive, [])).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    await expect(spendAllBegin(transceive, [128])).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    expect(sent).toEqual([]);
  });
});

describe('SPEND_ALL_OUTPUTS', () => {
  const apdu = hexBytes(step(474).apdu);
  const B_ = toHex(apdu.slice(9, 42));

  it('frames an output as amount (4) ‖ B_ (33), no Le (transcript 474)', async () => {
    const {transceive, sent} = scripted([answerOf(474)]);
    await spendAllOutputs(transceive, [{amount: 90, B_}]);
    expect(toHex(sent[0])).toBe(step(474).apdu);
  });

  it('sends six outputs to an APDU, in order', async () => {
    const outputs = Array.from({length: 7}, (_, i) => ({amount: 2 ** i, B_}));
    const {transceive, sent} = scripted([
      [0x90, 0],
      [0x90, 0],
    ]);
    await spendAllOutputs(transceive, outputs);
    expect(sent).toHaveLength(2);
    expect(sent[0][4]).toBe(6 * 37);
    expect(sent[1][4]).toBe(37);
    expect(sent[1].slice(5, 9)).toEqual([0, 0, 0, 64]);
  });

  it('refuses a B_ that is not 33 bytes before any APDU', async () => {
    const {transceive, sent} = scripted([]);
    await expect(
      spendAllOutputs(transceive, [{amount: 1, B_: '02aa'}]),
    ).rejects.toBeInstanceOf(CardProtocolError);
    expect(sent).toEqual([]);
  });

  it("a payment not begun is the card's 6985, named for the command", async () => {
    const {transceive} = scripted([[0x69, 0x85]]);
    await expect(
      spendAllOutputs(transceive, [{amount: 90, B_}]),
    ).rejects.toThrow('SPEND_ALL_OUTPUTS failed: no payment begun (0x6985)');
  });
});

describe('SPEND_ALL_CHANGE', () => {
  it("asks for an amount, Le 21, and reads the card's blinded message (transcript 475)", async () => {
    const {transceive, sent} = scripted([answerOf(475)]);
    await expect(spendAllChange(transceive, 40)).resolves.toBe(step(475).data);
    expect(toHex(sent[0])).toBe(step(475).apdu);
  });

  it('refuses a change of 0 before any APDU', async () => {
    const {transceive, sent} = scripted([]);
    await expect(spendAllChange(transceive, 0)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    expect(sent).toEqual([]);
  });

  it('no opening free is 6A84, named as such', async () => {
    const {transceive} = scripted([[0x6a, 0x84]]);
    await expect(spendAllChange(transceive, 4)).rejects.toThrow(
      /no change opening free/,
    );
  });
});

describe('SPEND_ALL_SIGN', () => {
  it('Le 40, and the 64-byte signature verbatim (transcript 97)', async () => {
    const {transceive, sent} = scripted([answerOf(97)]);
    const signature = await spendAllSign(transceive);
    expect(toHex(signature)).toBe(step(97).data);
    expect(toHex(sent[0])).toBe(step(97).apdu);
  });

  it('asks again for as long as the card answers "not yet" (transcript 110)', async () => {
    const {transceive, sent} = scripted([
      answerOf(110),
      answerOf(110),
      answerOf(110),
      [...SIGNATURE, 0x90, 0x00],
    ]);
    await expect(spendAllSign(transceive)).resolves.toEqual(SIGNATURE);
    expect(sent).toHaveLength(4);
  });

  it('the PIN needed (6A94) is classified, and nothing is retried', async () => {
    const {transceive, sent} = scripted([answerOf(251)]);
    const failure = await spendAllSign(transceive).catch(e => e);
    expect(isPinNeededForPayment(failure)).toBe(true);
    expect(failure.message).toMatch(/PIN needed for this payment/);
    expect(sent).toHaveLength(1);
  });

  it('over the daily limit is 6A8F (transcript 101)', async () => {
    const {transceive} = scripted([answerOf(101)]);
    await expect(spendAllSign(transceive)).rejects.toThrow(
      "SPEND_ALL_SIGN failed: over the card's daily limit (0x6A8F)",
    );
  });

  it('rejects a signature that is not 64 bytes', async () => {
    const {transceive} = scripted([[...SIGNATURE.slice(0, 63), 0x90, 0x00]]);
    await expect(spendAllSign(transceive)).rejects.toThrow(
      'SPEND_ALL_SIGN: expected a 64-byte signature, got 63',
    );
  });
});

describe('SPEND_ALL_AGAIN', () => {
  it('Le 40, and the last signature again (transcript 557)', async () => {
    const {transceive, sent} = scripted([answerOf(557)]);
    expect(toHex(await spendAllAgain(transceive))).toBe(step(557).data);
    expect(toHex(sent[0])).toBe(step(557).apdu);
  });

  it('a PIN-signed payment asked for again with no PIN is 6982 (transcript 770)', async () => {
    const {transceive} = scripted([answerOf(770)]);
    await expect(spendAllAgain(transceive)).rejects.toMatchObject({
      sw: 0x6982,
    });
  });
});

describe('GET_PIECES', () => {
  it("reads every page: the applet transcript's two (148, 149)", async () => {
    const {transceive, sent} = scripted([answerOf(148), answerOf(149)]);
    const {unspent, spent} = await getPieces(transceive);

    expect(sent.map(toHex)).toEqual([step(148).apdu, step(149).apdu]);
    expect(spent).toEqual([]);
    expect(unspent.map(p => [p.slot, p.amount])).toEqual([
      [0, 600],
      [1, 400],
      [2, 1],
      [3, 2000],
    ]);
    expect(unspent.every(p => p.keysetId === '0059534ce0bfa19a')).toBe(true);
    expect(unspent.every(p => p.nonce.length === 64 && p.C.length === 66)).toBe(
      true,
    );
  });

  it('lists spent places by their tags alone (transcript 234)', () => {
    const page = parsePiecesPage(hexBytes(step(234).data), 0);
    expect(page).toEqual({next: 128, unspent: [], spent: [0, 1, 2, 3]});
  });

  it('an empty card is one byte, 128 (transcript 237)', async () => {
    const {transceive} = scripted([answerOf(237)]);
    await expect(getPieces(transceive)).resolves.toEqual({
      unspent: [],
      spent: [],
    });
  });

  it('refuses a page that does not move forward, rather than looping', () => {
    expect(() => parsePiecesPage([0x05], 5)).toThrow(CardProtocolError);
    expect(() => parsePiecesPage([0x81], 0)).toThrow(CardProtocolError);
  });

  it('refuses a piece cut short', () => {
    const page = hexBytes(step(148).data).slice(0, 50);
    expect(() => parsePiecesPage(page, 0)).toThrow(/cut short/);
  });

  it('frames P1 as the first slot, P2 = 0, Le 00', async () => {
    const {transceive, sent} = scripted([[0x80, 0x90, 0x00]]);
    await getPiecesPage(transceive, 3);
    expect(sent[0]).toEqual([0xb0, 0x17, 0x03, 0x00, 0x00]);
  });
});

describe('GET_PIECES, the short listing (P2 = 3)', () => {
  it('frames P1 as the first slot, P2 = 3, Le 00 (transcript 588)', async () => {
    const {transceive, sent} = scripted([answerOf(588)]);
    await getPiecesShortPage(transceive, 0);
    expect(toHex(sent[0])).toBe(step(588).apdu);
  });

  it("reads the transcript's listing: named keysets and dates, then a place and a size (588)", async () => {
    const {transceive} = scripted([answerOf(588)]);
    await expect(getPiecesShort(transceive)).resolves.toEqual([
      {slot: 0, keysetId: '0059534ce0bfa19a', amount: 1, date: 0},
      {slot: 1, keysetId: '0059534ce0bfa19a', amount: 8, date: 0x713fb300},
      {slot: 2, keysetId: '0059534ce0bfa19a', amount: 32, date: 0},
      {slot: 3, keysetId: '0059534ce0bfa19a', amount: 16, date: 0},
    ]);
  });

  it('an answer from a later place begins with the twelve bytes again (589)', () => {
    expect(parseShortListing(hexBytes(step(589).data), 1)).toEqual({
      next: 128,
      pieces: [
        {slot: 1, keysetId: '0059534ce0bfa19a', amount: 8, date: 0x713fb300},
        {slot: 2, keysetId: '0059534ce0bfa19a', amount: 32, date: 0},
        {slot: 3, keysetId: '0059534ce0bfa19a', amount: 16, date: 0},
      ],
    });
  });

  it('a card past 63 places: FF and an amount, sizes up the powers, spent places left out (657)', () => {
    const {next, pieces} = parseShortListing(hexBytes(step(657).data), 0);
    expect(next).toBe(128);
    const bySlot = new Map(pieces.map(p => [p.slot, p]));
    expect(bySlot.get(20)?.amount).toBe(1000);
    expect(bySlot.get(10)?.keysetId).toBe('00ab12cd34ef5678');
    expect(bySlot.has(65)).toBe(false);
    // Every slot in order, none twice.
    const slots = pieces.map(p => p.slot);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('reads answer after answer until 128, each from where the last ended', async () => {
    const {transceive, sent} = scripted([
      // slots 0 (8) and 1 (16); the next answer starts at 2
      [0x02, 0x80, ...KEYSET_BYTES, 0, 0, 0, 0, 0x03, 0x01, 0x04, 0x90, 0x00],
      // slot 5: 1,000 sat, no power of two
      [
        0x80,
        0x85,
        ...KEYSET_BYTES,
        0,
        0,
        0,
        0,
        0xff,
        0,
        0,
        0x03,
        0xe8,
        0x90,
        0x00,
      ],
    ]);
    const pieces = await getPiecesShort(transceive);
    expect(sent.map(a => toHex(a))).toEqual(['b017000300', 'b017020300']);
    expect(pieces.map(p => [p.slot, p.amount])).toEqual([
      [0, 8],
      [1, 16],
      [5, 1000],
    ]);
  });

  it('an empty card is one byte, 128 (619); past the pieces too (659)', async () => {
    expect(parseShortListing(hexBytes(step(619).data), 0)).toEqual({
      next: 128,
      pieces: [],
    });
    expect(parseShortListing(hexBytes(step(659).data), 0x42)).toEqual({
      next: 128,
      pieces: [],
    });
  });

  it("a first slot past 127 is refused before any APDU; the card's own answer is 6A83 (590)", async () => {
    const {transceive, sent} = scripted([]);
    await expect(getPiecesShortPage(transceive, 128)).rejects.toThrow(
      CardProtocolError,
    );
    expect(sent).toEqual([]);
    expect(() => parseResponse(answerOf(590), 'GET_PIECES')).toThrow(CardError);
  });

  it('refuses an answer that does not move on, a first entry with no keyset, or one cut short', () => {
    expect(() => parseShortListing([0x05], 5)).toThrow(CardProtocolError);
    expect(() => parseShortListing([0x80, 0x00, 0x03], 0)).toThrow(
      /names no keyset/,
    );
    expect(() => parseShortListing([0x80, 0x80, 0, 0x59, 0x53], 0)).toThrow(
      /cut short/,
    );
    expect(() =>
      parseShortListing(
        [0x80, 0x81, ...new Array(12).fill(0), 0, 0x00, 0x01],
        0,
      ),
    ).toThrow(/out of order/);
  });
});

describe('GET_PIECES by name (P2 = 2)', () => {
  it('frames the slots as data, Le 00, and reads each whole in the order asked (591)', async () => {
    const {transceive, sent} = scripted([answerOf(591)]);
    const named = await getPiecesNamed(transceive, [1, 0]);
    expect(toHex(sent[0])).toBe(step(591).apdu);
    expect(named.map(n => [n.slot, n.status, n.piece?.amount])).toEqual([
      [1, 'unspent', 8],
      [0, 'unspent', 1],
    ]);
    expect(named[0].piece?.date).toBe(0x713fb300);
    expect(named[0].piece?.keysetId).toBe('0059534ce0bfa19a');
  });

  it('an empty slot is answered as it is: status 00 (662)', async () => {
    const {transceive, sent} = scripted([answerOf(662)]);
    const named = await getPiecesNamed(transceive, [127, 64]);
    expect(toHex(sent[0])).toBe(step(662).apdu);
    expect(named[0]).toEqual({slot: 127, status: 'empty', piece: null});
    expect(named[1].status).toBe('unspent');
  });

  it('asks three slots to an APDU', async () => {
    const {transceive, sent} = scripted([
      [...proofBody(), ...proofBody(), ...proofBody(), 0x90, 0x00],
      [...proofBody(), 0x90, 0x00],
    ]);
    const named = await getPiecesNamed(transceive, [5, 6, 7, 8]);
    expect(sent.map(a => a.slice(0, 5))).toEqual([
      [0xb0, 0x17, 0x00, 0x02, 0x03],
      [0xb0, 0x17, 0x00, 0x02, 0x01],
    ]);
    expect(named.map(n => n.slot)).toEqual([5, 6, 7, 8]);
  });

  it('refuses an answer of the wrong length', async () => {
    const {transceive} = scripted([[...proofBody(), 0x90, 0x00]]);
    await expect(getPiecesNamed(transceive, [1, 2])).rejects.toThrow(
      CardProtocolError,
    );
  });
});

describe('GET_CARD', () => {
  it('a new card: format 4, no record, no refund key, no mint (transcript 3)', async () => {
    const {transceive, sent} = scripted([answerOf(3)]);
    const record = await getCard(transceive);
    expect(toHex(sent[0])).toBe(step(3).apdu);
    expect(record).toMatchObject({
      format: 4,
      recordSet: false,
      refundKey: null,
      mint: '',
      rollBudget: 7,
      design: '',
    });
  });

  it('reads the refund key, the mint, the rolls and the budget', () => {
    const mint = Array.from(Buffer.from('https://forge.flashapp.me'));
    const refund = hexBytes(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    );
    const body = [
      4,
      1,
      0,
      0,
      0,
      0x13,
      0x88,
      ...refund,
      0x17,
      0x08,
      0x7b,
      0xc0,
      ...new Array(32).fill(0xab),
      3,
      10,
      1,
      ...new Array(26).fill(0),
      mint.length,
      ...mint,
      0x46,
      0x4c,
      0x53,
    ];
    expect(parseCardRecord(body)).toEqual({
      format: 4,
      recordSet: true,
      unit: 0,
      dailyLimit: 5000,
      refundKey: toHex(refund),
      hardestBits: '17087bc0',
      lastHeader: 'ab'.repeat(32),
      rolls: 3,
      rollBudget: 10,
      allowanceArmed: true,
      mint: 'https://forge.flashapp.me',
      design: 'FLS',
    });
  });

  it('refuses a record shorter than its mint says', () => {
    expect(() => parseCardRecord([...new Array(105).fill(0), 10])).toThrow(
      CardProtocolError,
    );
  });
});

describe('GET_CHANGE', () => {
  it('reads the openings, stopping at a page that is not full (transcript 485)', async () => {
    const {transceive, sent} = scripted([answerOf(485)]);
    const openings = await getChange(transceive);
    expect(sent.map(toHex)).toEqual([step(485).apdu]);
    expect(openings).toHaveLength(2);
    // The first is the change the transcript's step 481 made, with the
    // nonce and r it reports for it.
    expect(openings[0]).toEqual({
      amount: 40,
      keysetId: '0059534ce0bfa19a',
      date: 0,
      nonce: step(481).nonce,
      r: step(481).r,
    });
    expect(openings[1]).toMatchObject({amount: 20, date: 0});
  });

  it('a page with none is a count of 0 (transcript 486)', () => {
    expect(parseChangePage(hexBytes(step(486).data))).toEqual([]);
  });

  it('asks the next page while a page is full', async () => {
    const full = [3, ...new Array(240).fill(0x01)];
    const {transceive, sent} = scripted([
      [...full, 0x90, 0x00],
      [0x00, 0x90, 0x00],
    ]);
    await expect(getChange(transceive)).resolves.toHaveLength(3);
    expect(sent.map(a => a[2])).toEqual([0, 1]);
  });

  it('refuses an answer whose length is not its count', () => {
    expect(() => parseChangePage([2, ...new Array(80).fill(0)])).toThrow(
      CardProtocolError,
    );
  });
});

describe('GET_DLEQ', () => {
  it('a place with nothing kept is 00 (transcript 814)', async () => {
    const {transceive, sent} = scripted([answerOf(814)]);
    await expect(getDleq(transceive, 0)).resolves.toEqual([null]);
    expect(toHex(sent[0])).toBe(step(814).apdu);
  });

  it('a kept proof is 01 and e ‖ s ‖ r (transcript 816)', async () => {
    const {transceive} = scripted([answerOf(816)]);
    const [proof] = await getDleq(transceive, 0);
    const data = step(816).data;
    expect(proof).toEqual({
      e: data.slice(2, 66),
      s: data.slice(66, 130),
      r: data.slice(130, 194),
    });
  });

  it('two places in one APDU, in the order asked (transcript 818, 819)', async () => {
    const two = scripted([answerOf(818)]);
    const answers = await getDleq(two.transceive, 0, 1);
    expect(toHex(two.sent[0])).toBe(step(818).apdu);
    expect(answers[0]).not.toBeNull();
    expect(answers[1]).toBeNull();

    const twice = scripted([answerOf(819)]);
    const same = await getDleq(twice.transceive, 0, 0);
    expect(same[0]).toEqual(same[1]);
  });

  it('getDleqs asks two places to an APDU', async () => {
    const {transceive, sent} = scripted([answerOf(818), answerOf(814)]);
    const map = await getDleqs(transceive, [0, 1, 4]);
    expect(sent.map(a => [a[2], a[3]])).toEqual([
      [0, 1],
      [4, 0xff],
    ]);
    expect(map.get(0)).not.toBeNull();
    expect(map.get(1)).toBeNull();
    expect(map.get(4)).toBeNull();
  });
});

describe('LOAD_PROOF', () => {
  const plain = hexBytes(step(90).apdu);
  const withProof = hexBytes(step(815).apdu);
  const piece = (apdu: number[]) => {
    const b = apdu.slice(5);
    return {
      keysetId: toHex(b.slice(0, 8)),
      amount: (b[8] << 24) | (b[9] << 16) | (b[10] << 8) | b[11],
      nonce: toHex(b.slice(12, 44)),
      C: toHex(b.slice(44, 77)),
      date: ((b[77] << 24) | (b[78] << 16) | (b[79] << 8) | b[80]) >>> 0,
    };
  };

  it('frames a piece as keyset ‖ amount ‖ nonce ‖ C ‖ date, Le 01 (transcript 90)', async () => {
    const {transceive, sent} = scripted([answerOf(90)]);
    await expect(loadProof(transceive, piece(plain))).resolves.toBe(0);
    expect(toHex(sent[0])).toBe(step(90).apdu);
  });

  it("with the mint's proof: P1 = 1, e ‖ s ‖ r after the piece, Le 02 (transcript 815)", async () => {
    const {transceive, sent} = scripted([answerOf(815)]);
    const b = withProof.slice(5);
    const dleq = {
      e: toHex(b.slice(81, 113)),
      s: toHex(b.slice(113, 145)),
      r: toHex(b.slice(145, 177)),
    };
    await expect(loadProof(transceive, piece(withProof), dleq)).resolves.toBe(
      0,
    );
    // Byte for byte the transcript's command but its Le: the transcript's
    // reader asks Le 00 (any length), the spec's is the answer's 02.
    expect(toHex(sent[0].slice(0, -1))).toBe(step(815).apdu.slice(0, -2));
    expect(sent[0][sent[0].length - 1]).toBe(0x02);
  });

  it('a piece already on the card is 6A94, read as landed (transcript 828)', async () => {
    const {transceive} = scripted([answerOf(828)]);
    const failure = await loadProof(transceive, piece(plain)).catch(e => e);
    expect(isAlreadyOnCard(failure)).toBe(true);
    expect(failure.message).toMatch(/already on the card/);
  });

  it('stores a v2 keyset id by its first 8 bytes', async () => {
    const {transceive, sent} = scripted([[0x00, 0x90, 0x00]]);
    await loadProof(transceive, {
      ...piece(plain),
      keysetId: `01${'ab'.repeat(32)}`,
    });
    expect(sent[0].slice(5, 13)).toEqual(
      cardKeysetBytes(`01${'ab'.repeat(32)}`),
    );
    expect(sent[0].slice(5, 13)).toEqual([0x01, ...new Array(7).fill(0xab)]);
  });

  it('refuses a keyset id that is neither 8 nor 33 bytes, before any APDU', async () => {
    const {transceive, sent} = scripted([]);
    await expect(
      loadProof(transceive, {...piece(plain), keysetId: 'abcd'}),
    ).rejects.toBeInstanceOf(CardProtocolError);
    expect(sent).toEqual([]);
  });

  it('refuses a proof that is not 96 bytes', async () => {
    const {transceive, sent} = scripted([]);
    await expect(
      loadProof(transceive, piece(plain), {e: 'aa', s: 'bb', r: 'cc'}),
    ).rejects.toBeInstanceOf(CardProtocolError);
    expect(sent).toEqual([]);
  });
});

describe('AUTH', () => {
  it("the message is the applet's tagged hash (spec/vectors/secret.json)", () => {
    const a = vectors.auth;
    expect(AUTH_TAG).toBe(a.tag);
    expect(
      bytesToHex(
        authMessage(
          hexBytes(a.readerNonce),
          hexBytes(a.cardNonce),
          hexBytes(vectors.cardKey),
        ),
      ),
    ).toBe(a.message);
  });

  it("verifies the card's own answer from the applet transcript (294)", async () => {
    const reader = hexBytes(step(294).apdu).slice(5, 21);
    const {transceive, sent} = scripted([answerOf(294)]);
    await expect(
      auth(transceive, hexBytes(vectors.cardKey), reader),
    ).resolves.toBeUndefined();
    expect(toHex(sent[0])).toBe(step(294).apdu);
  });

  it("a signature that does not verify under the card's key is CardAuthError", async () => {
    const reader = hexBytes(step(294).apdu).slice(5, 21);
    const answer = answerOf(294);
    answer[20] ^= 0x01;
    const {transceive} = scripted([answer]);
    await expect(
      auth(transceive, hexBytes(vectors.cardKey), reader),
    ).rejects.toBeInstanceOf(CardAuthError);
  });

  it('the same answer under another key is CardAuthError', async () => {
    const reader = hexBytes(step(294).apdu).slice(5, 21);
    const {transceive} = scripted([answerOf(294)]);
    await expect(auth(transceive, PUBKEY_BODY, reader)).rejects.toBeInstanceOf(
      CardAuthError,
    );
  });

  it('sends 16 fresh bytes when none are given', async () => {
    const card = fakeCard();
    await auth(card.transceive, PUBKEY_BODY);
    await auth(card.transceive, PUBKEY_BODY);
    expect(card.sent[0][4]).toBe(16);
    expect(card.sent[0].slice(5, 21)).not.toEqual(card.sent[1].slice(5, 21));
  });

  it('refuses a reader nonce of another length before any APDU', async () => {
    const {transceive, sent} = scripted([]);
    await expect(
      auth(transceive, PUBKEY_BODY, [1, 2, 3]),
    ).rejects.toBeInstanceOf(CardProtocolError);
    expect(sent).toEqual([]);
  });
});

describe('the clock', () => {
  it("SET_HEADER sends the 80-byte header, Le 04, and reads the card's now", async () => {
    const header = Array.from({length: 80}, (_, i) => i);
    const {transceive, sent} = scripted([[0x6a, 0xc8, 0x73, 0x72, 0x90, 0x00]]);
    await expect(setHeader(transceive, header)).resolves.toBe(0x6ac87372);
    expect(sent[0]).toEqual([0xb0, 0x36, 0, 0, 0x50, ...header, 0x04]);
  });

  it('SET_HEADER refuses a header that is not 80 bytes before any APDU', async () => {
    const {transceive, sent} = scripted([]);
    await expect(setHeader(transceive, [1, 2, 3])).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    expect(sent).toEqual([]);
  });

  it('TELL_TIME sends the clock as 4 bytes, no Le', async () => {
    const {transceive, sent} = scripted([[0x90, 0x00]]);
    await tellTime(transceive, 0x6ac8717e);
    expect(sent[0]).toEqual([0xb0, 0x37, 0, 0, 0x04, 0x6a, 0xc8, 0x71, 0x7e]);
  });
});

describe('toHex', () => {
  it('zero-pads single-digit bytes', () => {
    expect(toHex([0x00, 0x0f, 0xff])).toBe('000fff');
  });
});

describe('getSlotStatuses', () => {
  it('decodes one status byte per slot', async () => {
    const card = fakeCard({slotStatuses: [0x00, 0x01, 0x02, 0x01]});
    await expect(getSlotStatuses(card.transceive, 4)).resolves.toEqual([
      'empty',
      'unspent',
      'spent',
      'unspent',
    ]);
  });

  it('asks for exactly count bytes (Le is the slot count)', async () => {
    const card = fakeCard({slotStatuses: [0x01]});
    await getSlotStatuses(card.transceive, 1);
    const apdu = card.sent.find(([, ins]) => ins === 0x14);
    expect(apdu?.[apdu.length - 1]).toBe(0x01);
  });

  it('rejects a short body rather than mapping missing slots to empty', async () => {
    const card = fakeCard({slotStatuses: [0x01, 0x02]});
    await expect(getSlotStatuses(card.transceive, 3)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
  });

  it('rejects an unknown status byte', async () => {
    const card = fakeCard({slotStatuses: [0x07]});
    await expect(getSlotStatuses(card.transceive, 1)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
  });

  it('refuses a nonsensical count before any APDU is sent', async () => {
    const card = fakeCard();
    await expect(getSlotStatuses(card.transceive, 0)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    expect(card.sent).toHaveLength(0);
  });
});

describe('APDU timing', () => {
  beforeEach(() => resetApduTimings());

  it('readCard records one sample per command, named as the protocol does', async () => {
    const card = fakeCard();
    await readCard(card.transceive);
    expect(getApduTimings().map(s => s.context)).toEqual([
      'SELECT',
      'GET_INFO',
      'GET_PUBKEY',
      'AUTH',
      'GET_BALANCE',
    ]);
    expect(getApduTimings().every(s => s.ms >= 0)).toBe(true);
  });

  it('a command the card refuses is still timed', async () => {
    const {transceive} = scripted([[0x69, 0x82]]);
    await expect(spendAllSign(transceive)).rejects.toBeInstanceOf(CardError);
    expect(getApduTimings().map(s => s.context)).toEqual(['SPEND_ALL_SIGN']);
  });

  it('a SELECT that falls back to the applet AID is timed twice', async () => {
    const card = fakeCard({selectFails: [PACKAGE_AID.length]});
    await selectApplet(card.transceive);
    expect(getApduTimings().map(s => s.context)).toEqual(['SELECT', 'SELECT']);
  });
});
