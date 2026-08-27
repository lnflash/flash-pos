/* eslint-disable no-bitwise -- byte-level protocol assertions. */
import {
  APPLET_AID,
  CardError,
  PACKAGE_AID,
  buildApdu,
  describeStatusWord,
  getBalance,
  getInfo,
  getPubkey,
  parseResponse,
  readCard,
  selectApplet,
  toHex,
  type Transceiver,
} from '../../src/services/cashuCard';

const OK = [0x90, 0x00];
const ok = (data: number[] = []) => [...data, ...OK];
const sw = (code: number) => [(code >> 8) & 0xff, code & 0xff];

/** GET_INFO body: v1.0, 32 slots, 3 unspent / 1 spent / 28 empty, native+schnorr, PIN set. */
const INFO_BODY = [1, 0, 32, 3, 1, 28, 0x03, 0x01];
const PUBKEY_BODY = [0x02, ...Array.from({length: 32}, (_, i) => i + 1)];

/**
 * A fake card that answers the read commands. Records every APDU it is sent so
 * tests can assert on the wire format, not just the parsed result.
 */
function fakeCard(
  overrides: {
    selectFails?: number[];
    infoBody?: number[];
    pubkeyBody?: number[];
    balanceBody?: number[];
  } = {},
) {
  const sent: number[][] = [];
  const transceive: Transceiver = async apdu => {
    sent.push(apdu);
    const [cla, ins] = apdu;

    if (cla === 0x00 && ins === 0xa4) {
      const aidLength = apdu[4];
      if (overrides.selectFails?.includes(aidLength)) {
        return sw(0x6a82);
      }
      return ok([1, 0]);
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
});

describe('describeStatusWord', () => {
  it.each([
    [0x9000, 'OK'],
    [0x6982, 'PIN required'],
    [0x6983, 'card locked'],
    [0x6a82, 'applet not found'],
    [0x6e00, 'wrong CLA'],
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
      0x00, 0xa4, 0x04, 0x00, PACKAGE_AID.length, ...PACKAGE_AID,
    ]);
  });

  it('falls back to the full applet AID when prefix select is unsupported', async () => {
    const card = fakeCard({selectFails: [PACKAGE_AID.length]});
    await selectApplet(card.transceive);
    expect(card.sent).toHaveLength(2);
    expect(card.sent[1]).toEqual([
      0x00, 0xa4, 0x04, 0x00, APPLET_AID.length, ...APPLET_AID,
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
    const card = fakeCard({infoBody: [1, 0, 32, 0, 0, 32, 0x03, byte as number]});
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
    const mutating = card.sent.filter(a => [0x20, 0x30, 0x31, 0x50].includes(a[1]));
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

describe('toHex', () => {
  it('zero-pads single-digit bytes', () => {
    expect(toHex([0x00, 0x0f, 0xff])).toBe('000fff');
  });
});
