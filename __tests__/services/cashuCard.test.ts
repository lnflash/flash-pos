/* eslint-disable no-bitwise -- byte-level protocol assertions. */
import {
  APPLET_AID,
  CardError,
  CardProtocolError,
  PACKAGE_AID,
  PROOF_SIZE,
  buildApdu,
  describeStatusWord,
  getBalance,
  getInfo,
  getProof,
  getPubkey,
  parseResponse,
  readCard,
  selectApplet,
  signArbitrary,
  spendProof,
  toHex,
  type Transceiver,
} from '../../src/services/cashuCard';

const OK = [0x90, 0x00];
const ok = (data: number[] = []) => [...data, ...OK];
const sw = (code: number) => [(code >> 8) & 0xff, code & 0xff];

/** GET_INFO body: v1.0, 32 slots, 3 unspent / 1 spent / 28 empty, native+schnorr, PIN set. */
const INFO_BODY = [1, 0, 32, 3, 1, 28, 0x03, 0x01];
const PUBKEY_BODY = [0x02, ...Array.from({length: 32}, (_, i) => i + 1)];

// Distinct byte ranges per field, so a one-byte slice error cannot pass by
// landing on a neighbour that happens to hold the same value.
const KEYSET_BYTES = [0x00, 0x59, 0x53, 0x4c, 0xe0, 0xbf, 0xa1, 0x9a];
const NONCE_BYTES = Array.from({length: 32}, (_, i) => 0x40 + i);
const C_BYTES = [0x02, ...Array.from({length: 32}, (_, i) => 0x80 + i)];
/** 500, big-endian uint32. */
const AMOUNT_BYTES = [0x00, 0x00, 0x01, 0xf4];

/** status[1] + keyset_id[8] + amount[4] + nonce[32] + C[33] = 78 bytes. */
const proofBody = ({
  status = 0x01,
  amount = AMOUNT_BYTES,
}: {status?: number; amount?: number[]} = {}) => [
  status,
  ...KEYSET_BYTES,
  ...amount,
  ...NONCE_BYTES,
  ...C_BYTES,
];

const SIGNATURE = Array.from({length: 64}, (_, i) => (i * 3 + 1) & 0xff);
const MESSAGE = Array.from({length: 32}, (_, i) => 0xa0 + i).map(b => b & 0xff);

/**
 * A fake card that answers the read commands. Records every APDU it is sent so
 * tests can assert on the wire format, not just the parsed result.
 */
function fakeCard(
  overrides: {
    selectFails?: number[];
    selectThrows?: unknown;
    infoBody?: number[];
    pubkeyBody?: number[];
    balanceBody?: number[];
    proofBody?: number[];
    proofStatusWord?: number;
    signature?: number[];
    signStatusWord?: number;
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
      if (overrides.selectFails?.includes(aidLength)) {
        return sw(0x6a82);
      }
      // Real cards obey Le. A Case-3 SELECT (header + Lc + AID, no Le) asks
      // for no response body, so the card answers with a status word only —
      // which is exactly what iOS produces when the Le byte is omitted.
      const hasLe = apdu.length > 5 + aidLength;
      return hasLe ? ok([1, 0]) : ok([]);
    }
    if (cla === 0xb0 && ins === 0x01) {
      return ok(overrides.infoBody ?? INFO_BODY);
    }
    if (cla === 0xb0 && ins === 0x10) {
      return ok(overrides.pubkeyBody ?? PUBKEY_BODY);
    }
    if (cla === 0xb0 && ins === 0x11) {
      return ok(overrides.balanceBody ?? [0, 0, 0x01, 0xf4]);
    }
    if (cla === 0xb0 && ins === 0x13) {
      if (overrides.proofStatusWord) {
        return sw(overrides.proofStatusWord);
      }
      return ok(overrides.proofBody ?? proofBody());
    }
    if (cla === 0xb0 && (ins === 0x20 || ins === 0x21)) {
      if (overrides.signStatusWord) {
        return sw(overrides.signStatusWord);
      }
      return ok(overrides.signature ?? SIGNATURE);
    }
    return sw(0x6d00);
  };
  return {transceive, sent};
}

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
    [0x6983, 'card locked'],
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
});

describe('selectApplet', () => {
  it('selects with the 7-byte package AID first', async () => {
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
    await expect(selectApplet(card.transceive)).rejects.toThrow(
      /applet not found/,
    );
  });

  it('returns the applet version reported by SELECT', async () => {
    const card = fakeCard();
    expect(await selectApplet(card.transceive)).toEqual([1, 0]);
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
    expect(version).toEqual([1, 0]);
  });

  // A card that moved out of the field is not a card with the wrong software.
  it('rethrows a transport failure instead of retrying on a dead handle', async () => {
    const card = fakeCard({selectThrows: new Error('tag was lost')});

    await expect(selectApplet(card.transceive)).rejects.toThrow('tag was lost');
    // Exactly one attempt: no fallback SELECT on a handle that is already gone.
    expect(card.sent).toHaveLength(1);
  });

  it('rethrows a non-6A82 status word without trying the fallback AID', async () => {
    const card = fakeCard({selectThrows: new CardError(0x6e00, 'SELECT')});

    await expect(selectApplet(card.transceive)).rejects.toThrow(/wrong CLA/);
    expect(card.sent).toHaveLength(1);
  });
});

describe('getInfo', () => {
  it('decodes the 8-byte info block', async () => {
    const card = fakeCard();
    expect(await getInfo(card.transceive)).toEqual({
      version: '1.0',
      maxSlots: 32,
      unspent: 3,
      spent: 1,
      empty: 28,
      secp256k1Native: true,
      schnorr: true,
      pinState: 'set',
    });
  });

  it('decodes capability flags independently', async () => {
    const card = fakeCard({infoBody: [1, 0, 32, 0, 0, 32, 0x02, 0x00]});
    const info = await getInfo(card.transceive);
    expect(info.secp256k1Native).toBe(false);
    expect(info.schnorr).toBe(true);
    expect(info.pinState).toBe('unset');
  });

  it.each([
    [0, 'unset'],
    [1, 'set'],
    [2, 'locked'],
    [9, 'unknown'],
  ])('maps PIN state byte %i to %s', async (byte, expected) => {
    const card = fakeCard({
      infoBody: [1, 0, 32, 0, 0, 32, 0x03, byte as number],
    });
    expect((await getInfo(card.transceive)).pinState).toBe(expected);
  });

  it('rejects a short info block rather than reading undefined bytes', async () => {
    const card = fakeCard({infoBody: [1, 0, 32]});
    await expect(getInfo(card.transceive)).rejects.toThrow(/expected 8 bytes/);
  });

  it('sends the documented APDU', async () => {
    const card = fakeCard();
    await getInfo(card.transceive);
    expect(card.sent[0]).toEqual([0xb0, 0x01, 0x00, 0x00, 0x00]);
  });
});

describe('getPubkey', () => {
  it('returns the 33-byte compressed key', async () => {
    const card = fakeCard();
    const key = await getPubkey(card.transceive);
    expect(key).toHaveLength(33);
    expect(key[0]).toBe(0x02);
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
  it('performs SELECT then the three read commands, in order', async () => {
    const card = fakeCard();
    const summary = await readCard(card.transceive);

    expect(card.sent.map(a => [a[0], a[1]])).toEqual([
      [0x00, 0xa4],
      [0xb0, 0x01],
      [0xb0, 0x10],
      [0xb0, 0x11],
    ]);
    expect(summary.appletVersion).toBe('1.0');
    expect(summary.balance).toBe(500);
    expect(summary.info.maxSlots).toBe(32);
    expect(summary.pubkey).toHaveLength(66);
    expect(summary.pubkey.startsWith('02')).toBe(true);
  });

  it('spends nothing — no SPEND_PROOF or LOAD_PROOF is ever sent', async () => {
    const card = fakeCard();
    await readCard(card.transceive);
    const mutating = card.sent.filter(a =>
      [0x20, 0x30, 0x31, 0x50].includes(a[1]),
    );
    expect(mutating).toEqual([]);
  });

  it('fails fast when the applet is absent', async () => {
    const card = fakeCard({
      selectFails: [PACKAGE_AID.length, APPLET_AID.length],
    });
    await expect(readCard(card.transceive)).rejects.toThrow(/applet not found/);
    // Nothing beyond the two SELECT attempts should have been tried.
    expect(card.sent).toHaveLength(2);
  });
});

describe('getProof', () => {
  // Every field gets its own byte range, so an off-by-one in any slice moves
  // values between fields and fails here rather than at the mint, after the
  // money is already gone.
  it('decodes all five fields of the 78-byte slot', async () => {
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

  it('sends the documented APDU with the slot in P1 and Le = 78', async () => {
    const card = fakeCard();
    await getProof(card.transceive, 7);
    expect(card.sent[0]).toEqual([0xb0, 0x13, 0x07, 0x00, PROOF_SIZE]);
  });

  it('rejects a short slot rather than reading undefined bytes', async () => {
    const card = fakeCard({proofBody: proofBody().slice(0, 77)});
    await expect(getProof(card.transceive, 2)).rejects.toBeInstanceOf(
      CardProtocolError,
    );
    await expect(getProof(card.transceive, 2)).rejects.toThrow(
      'GET_PROOF slot 2: expected 78 bytes, got 77',
    );
  });

  it('rejects a long slot too', async () => {
    const card = fakeCard({proofBody: [...proofBody(), 0x00]});
    await expect(getProof(card.transceive, 0)).rejects.toThrow(
      /expected 78 bytes, got 79/,
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

describe('spendProof', () => {
  it('sends the exact APDU: CLA b0, INS 20, slot in P1, Lc 32, Le 40', async () => {
    const card = fakeCard();
    await spendProof(card.transceive, 5, MESSAGE);

    expect(card.sent).toHaveLength(1);
    expect(card.sent[0]).toEqual([
      0xb0,
      0x20,
      0x05,
      0x00,
      0x20,
      ...MESSAGE,
      0x40,
    ]);
  });

  it('returns the 64-byte BIP-340 witness verbatim', async () => {
    const card = fakeCard();
    expect(await spendProof(card.transceive, 0, MESSAGE)).toEqual(SIGNATURE);
  });

  // The card burns the slot before it signs, so a malformed command must be
  // stopped on this side of the wire — never sent and then regretted.
  it.each([[0], [31], [33], [64]])(
    'refuses a %i-byte message without touching the card',
    async length => {
      const card = fakeCard();
      const message = Array.from({length}, () => 0x01);

      await expect(
        spendProof(card.transceive, 0, message),
      ).rejects.toBeInstanceOf(CardProtocolError);
      await expect(spendProof(card.transceive, 0, message)).rejects.toThrow(
        `SPEND_PROOF: message must be 32 bytes, got ${length}`,
      );
      expect(card.sent).toEqual([]);
    },
  );

  it('rejects a short signature — the slot is burned but the witness is unusable', async () => {
    const card = fakeCard({signature: Array.from({length: 63}, () => 0x01)});
    await expect(
      spendProof(card.transceive, 0, MESSAGE),
    ).rejects.toBeInstanceOf(CardProtocolError);
    await expect(spendProof(card.transceive, 0, MESSAGE)).rejects.toThrow(
      'SPEND_PROOF: expected a 64-byte signature, got 63',
    );
  });

  it('rejects a long signature too', async () => {
    const card = fakeCard({signature: Array.from({length: 65}, () => 0x01)});
    await expect(spendProof(card.transceive, 0, MESSAGE)).rejects.toThrow(
      /expected a 64-byte signature, got 65/,
    );
  });

  it('surfaces a double-spend refusal as a CardError naming the slot', async () => {
    const card = fakeCard({signStatusWord: 0x6985});
    await expect(
      spendProof(card.transceive, 4, MESSAGE),
    ).rejects.toBeInstanceOf(CardError);
    await expect(spendProof(card.transceive, 4, MESSAGE)).rejects.toThrow(
      /SPEND_PROOF slot 4 failed: proof already spent/,
    );
  });
});

describe('signArbitrary', () => {
  // The recovery path: it consumes nothing, so P1 carries no slot.
  it('sends INS 21 with no slot in P1, Lc 32, Le 40', async () => {
    const card = fakeCard();
    await signArbitrary(card.transceive, MESSAGE);

    expect(card.sent).toHaveLength(1);
    expect(card.sent[0]).toEqual([
      0xb0,
      0x21,
      0x00,
      0x00,
      0x20,
      ...MESSAGE,
      0x40,
    ]);
  });

  it('never sends SPEND_PROOF — recovery must not burn a second slot', async () => {
    const card = fakeCard();
    await signArbitrary(card.transceive, MESSAGE);
    expect(card.sent.filter(a => a[1] === 0x20)).toEqual([]);
  });

  it('returns the 64-byte witness', async () => {
    const card = fakeCard();
    expect(await signArbitrary(card.transceive, MESSAGE)).toEqual(SIGNATURE);
  });

  it.each([[0], [31], [33]])(
    'refuses a %i-byte message without touching the card',
    async length => {
      const card = fakeCard();
      const message = Array.from({length}, () => 0x01);

      await expect(
        signArbitrary(card.transceive, message),
      ).rejects.toBeInstanceOf(CardProtocolError);
      await expect(signArbitrary(card.transceive, message)).rejects.toThrow(
        `SIGN_ARBITRARY: message must be 32 bytes, got ${length}`,
      );
      expect(card.sent).toEqual([]);
    },
  );

  it('rejects a wrong-length signature', async () => {
    const card = fakeCard({signature: Array.from({length: 32}, () => 0x01)});
    await expect(signArbitrary(card.transceive, MESSAGE)).rejects.toThrow(
      'SIGN_ARBITRARY: expected a 64-byte signature, got 32',
    );
  });

  it('surfaces a signing failure as a CardError', async () => {
    const card = fakeCard({signStatusWord: 0x6f00});
    await expect(
      signArbitrary(card.transceive, MESSAGE),
    ).rejects.toBeInstanceOf(CardError);
    await expect(signArbitrary(card.transceive, MESSAGE)).rejects.toThrow(
      /SIGN_ARBITRARY failed: the card failed to sign/,
    );
  });
});

describe('toHex', () => {
  it('zero-pads single-digit bytes', () => {
    expect(toHex([0x00, 0x0f, 0xff])).toBe('000fff');
  });
});
