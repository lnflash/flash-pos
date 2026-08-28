/* eslint-disable no-bitwise -- this module is a byte-level APDU codec; masking
   and shifting is the work, not an accident. */
/**
 * Cashu NFC card — APDU protocol layer.
 *
 * Talks to the cashu-javacard applet (https://github.com/lnflash/cashu-javacard),
 * NUT-XX Profile B: an offline bearer card that holds ecash proofs and signs
 * BIP-340 Schnorr witnesses to unlock them.
 *
 * This module is deliberately transport-agnostic. It knows how to build and
 * parse APDUs and nothing about NFC, so the whole protocol is unit-testable
 * without a card or a reader. The React Native IsoDep transport lives in
 * `cashuCardNfc.ts`.
 *
 * Command reference: cashu-javacard `spec/APDU.md`. Kept byte-for-byte in step
 * with the reference host driver `tools/cardctl/cardctl.py`.
 */

/** 7-byte package AID. SELECT does prefix matching, so this also finds the applet. */
export const PACKAGE_AID = [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02];
/** 8-byte applet AID, used as the fallback when prefix selection is unsupported. */
export const APPLET_AID = [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02, 0x01];

const CLA = 0xb0;

/**
 * One proof slot, in bytes: status[1] + keyset_id[8] + amount[4] + nonce[32]
 * + C[33]. See spec/APDU.md in lnflash/cashu-javacard.
 */
export const PROOF_SIZE = 78;
const SW_OK = 0x9000;

export const INS = {
  GET_INFO: 0x01,
  GET_PUBKEY: 0x10,
  GET_BALANCE: 0x11,
  GET_PROOF_COUNT: 0x12,
  GET_PROOF: 0x13,
  GET_SLOT_STATUS: 0x14,
  SPEND_PROOF: 0x20,
  SIGN_ARBITRARY: 0x21,
} as const;

/** Sends a raw APDU and resolves to the full response: data bytes + SW1 + SW2. */
export type Transceiver = (apdu: number[]) => Promise<number[]>;

/** A command reached the card and the card refused it. `sw` is the status word. */
export class CardError extends Error {
  constructor(readonly sw: number, readonly context: string) {
    super(`${context} failed: ${describeStatusWord(sw)} (0x${hex16(sw)})`);
    this.name = 'CardError';
  }
}

/**
 * The card accepted the command (0x9000) but the framing was wrong — a short
 * response, a wrong-length body.
 *
 * Deliberately *not* a `CardError`: there is no status word to report, and
 * pretending `sw === 0` would let retry logic misread a framing bug as a card
 * refusal. `describeCardFailure` renders these through its plain-`Error` branch.
 */
export class CardProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardProtocolError';
  }
}

const hex16 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * Known status words. The applet reuses the ISO 7816 space, so a bare hex code
 * is close to useless in a merchant-facing log — name the ones we can.
 */
export function describeStatusWord(sw: number): string {
  switch (sw) {
    case 0x9000:
      return 'OK';
    case 0x6982:
      return 'PIN required';
    case 0x6983:
      return 'card locked';
    case 0x6a82:
      return 'applet not found';
    case 0x6985:
      return 'proof already spent';
    case 0x6a83:
      return 'slot index out of range';
    case 0x6a88:
      return 'slot is empty';
    case 0x6a86:
      return 'invalid P1/P2';
    case 0x6f00:
      return 'the card failed to sign';
    case 0x6700:
      return 'wrong length';
    case 0x6d00:
      return 'unsupported command';
    case 0x6e00:
      return 'wrong CLA — is this a Cashu card?';
    default:
      return 'unexpected status word';
  }
}

export function buildApdu(
  ins: number,
  {
    cla = CLA,
    p1 = 0x00,
    p2 = 0x00,
    data,
    le,
  }: {
    cla?: number;
    p1?: number;
    p2?: number;
    data?: number[];
    le?: number;
  } = {},
): number[] {
  const apdu = [cla, ins, p1, p2];
  if (data && data.length > 0) {
    // Short-form Lc is a single byte. Without this guard a 300-byte payload
    // pushes `300`, which the native bridge truncates to 0x2c — a silently
    // corrupt length on the wire. The commands that will carry payloads
    // (LOAD_PROOF, VERIFY_PIN, SPEND_PROOF) are the ones that move money.
    if (data.length > 255) {
      throw new CardProtocolError(
        `APDU data too long for short Lc: ${data.length} bytes (max 255)`,
      );
    }
    apdu.push(data.length, ...data);
  }
  if (le !== undefined) {
    apdu.push(le);
  }
  return apdu;
}

/**
 * Splits a card response into body and status word, throwing on anything but
 * 0x9000. Both platforms hand back `[...data, sw1, sw2]`.
 */
export function parseResponse(response: number[], context: string): number[] {
  if (response.length < 2) {
    throw new CardProtocolError(
      `${context}: truncated response (${response.length} bytes)`,
    );
  }
  const sw =
    (response[response.length - 2] << 8) | response[response.length - 1];
  if (sw !== SW_OK) {
    throw new CardError(sw, context);
  }
  return response.slice(0, -2);
}

async function send(
  transceive: Transceiver,
  ins: number,
  opts: Parameters<typeof buildApdu>[1] & {context: string},
): Promise<number[]> {
  const {context, ...apduOpts} = opts;
  return parseResponse(await transceive(buildApdu(ins, apduOpts)), context);
}

export interface CardInfo {
  version: string;
  maxSlots: number;
  unspent: number;
  spent: number;
  empty: number;
  secp256k1Native: boolean;
  schnorr: boolean;
  pinState: 'unset' | 'set' | 'locked' | 'unknown';
}

/**
 * SELECT the applet. Tries the 7-byte package AID first (prefix match, what the
 * reference driver does) and falls back to the full applet AID for cards that
 * do not support partial selection.
 *
 * Resolves to the 2-byte applet version the applet returns on SELECT.
 *
 * The trailing 0x00 is Le, making this a Case-4 GlobalPlatform SELECT. It is
 * load-bearing on iOS: `NFCISO7816APDU initWithData:` parses a Case-3 command
 * (no Le) as expectedResponseLength -1, CoreNFC then sends no Le, and the card
 * answers with a status word only — so the applet version would come back empty
 * and `readCard` would silently fall back to the GET_INFO version.
 */
export async function selectApplet(transceive: Transceiver): Promise<number[]> {
  let lastError: unknown;
  for (const aid of [PACKAGE_AID, APPLET_AID]) {
    try {
      return parseResponse(
        await transceive([0x00, 0xa4, 0x04, 0x00, aid.length, ...aid, 0x00]),
        'SELECT',
      );
    } catch (error) {
      // Only "applet not found" earns a second attempt. A transport failure —
      // the card left the field mid-SELECT — must surface as itself; retrying
      // on a dead handle would report a card that moved as a card running the
      // wrong software.
      if (!(error instanceof CardError) || error.sw !== 0x6a82) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new CardError(0x6a82, 'SELECT');
}

export async function getInfo(transceive: Transceiver): Promise<CardInfo> {
  const body = await send(transceive, INS.GET_INFO, {
    le: 0x00,
    context: 'GET_INFO',
  });
  if (body.length < 8) {
    throw new CardProtocolError(
      `GET_INFO: expected 8 bytes, got ${body.length}`,
    );
  }
  const caps = body[6];
  const pinStates: Record<number, CardInfo['pinState']> = {
    0: 'unset',
    1: 'set',
    2: 'locked',
  };
  return {
    version: `${body[0]}.${body[1]}`,
    maxSlots: body[2],
    unspent: body[3],
    spent: body[4],
    empty: body[5],
    secp256k1Native: (caps & 0x01) !== 0,
    schnorr: (caps & 0x02) !== 0,
    pinState: pinStates[body[7]] ?? 'unknown',
  };
}

/** The card's compressed secp256k1 public key (33 bytes) — its P2PK identity. */
export async function getPubkey(transceive: Transceiver): Promise<number[]> {
  const body = await send(transceive, INS.GET_PUBKEY, {
    le: 0x21,
    context: 'GET_PUBKEY',
  });
  if (body.length !== 33) {
    throw new CardProtocolError(
      `GET_PUBKEY: expected 33 bytes, got ${body.length}`,
    );
  }
  return body;
}

/** Sum of unspent proof amounts held on the card, in the mint's base unit. */
export async function getBalance(transceive: Transceiver): Promise<number> {
  const body = await send(transceive, INS.GET_BALANCE, {
    le: 0x04,
    context: 'GET_BALANCE',
  });
  if (body.length !== 4) {
    throw new CardProtocolError(
      `GET_BALANCE: expected 4 bytes, got ${body.length}`,
    );
  }
  // uint32 big-endian. >>> 0 keeps it unsigned; a full card would otherwise
  // read negative once bit 31 is set.
  return ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) >>> 0;
}

export const toHex = (bytes: number[]): string =>
  bytes.map(b => b.toString(16).padStart(2, '0')).join('');

export interface CardSummary {
  appletVersion: string;
  info: CardInfo;
  pubkey: string;
  balance: number;
}

/**
 * The read-only round-trip: SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE.
 *
 * Touches nothing on the card. This is the hardware bring-up check — the
 * terminal-side equivalent of `cardctl selftest`.
 */
export async function readCard(transceive: Transceiver): Promise<CardSummary> {
  const version = await selectApplet(transceive);
  const info = await getInfo(transceive);
  const pubkey = await getPubkey(transceive);
  const balance = await getBalance(transceive);
  return {
    appletVersion:
      version.length >= 2 ? `${version[0]}.${version[1]}` : info.version,
    info,
    pubkey: toHex(pubkey),
    balance,
  };
}

/** One proof slot as the card returns it, hex-encoded. */
export interface CardProofSlot {
  slot: number;
  status: 'unspent' | 'spent';
  /** NUT-02 keyset id — 16 hex chars, decoded from 8 RAW bytes, never ASCII. */
  keysetId: string;
  amount: number;
  /**
   * The 32-byte P2PK nonce. NOT the secret — the secret is ~150 bytes of JSON.
   *
   * The card never returns the secret, so a settlement cannot be reconstructed
   * from a slot read alone: whatever loaded the proof must keep the secret and
   * hand it to `recordSpend`. See `SettlementEntry.secret` in
   * `cashuSettlement.ts`.
   */
  nonce: string;
  /** The mint's unblinded signature, 33 bytes compressed. */
  C: string;
}

/**
 * Read one proof slot.
 *
 * Spent slots are still readable — only an empty slot is refused. That is what
 * makes a failed settlement recoverable: the proof data survives the burn.
 */
export async function getProof(
  transceive: Transceiver,
  slot: number,
): Promise<CardProofSlot> {
  const body = await send(transceive, INS.GET_PROOF, {
    p1: slot,
    le: PROOF_SIZE,
    context: `GET_PROOF slot ${slot}`,
  });
  if (body.length !== PROOF_SIZE) {
    throw new CardProtocolError(
      `GET_PROOF slot ${slot}: expected ${PROOF_SIZE} bytes, got ${body.length}`,
    );
  }
  const status = body[0];
  if (status !== 0x01 && status !== 0x02) {
    throw new CardProtocolError(
      `GET_PROOF slot ${slot}: unknown status byte 0x${status.toString(16)}`,
    );
  }
  return {
    slot,
    status: status === 0x01 ? 'unspent' : 'spent',
    // Raw bytes to hex gives the full 16-char id. Decoding as ASCII would give
    // 8 chars — half an id, matching no keyset at the mint.
    keysetId: toHex(body.slice(1, 9)),
    amount:
      ((body[9] << 24) | (body[10] << 16) | (body[11] << 8) | body[12]) >>> 0,
    nonce: toHex(body.slice(13, 45)),
    C: toHex(body.slice(45, 78)),
  };
}

const assertMessage = (message: number[], command: string): void => {
  if (message.length !== 32) {
    throw new CardProtocolError(
      `${command}: message must be 32 bytes, got ${message.length}`,
    );
  }
};

const assertSignature = (sig: number[], command: string): number[] => {
  if (sig.length !== 64) {
    throw new CardProtocolError(
      `${command}: expected a 64-byte signature, got ${sig.length}`,
    );
  }
  return sig;
};

/**
 * Mark a slot spent and return the BIP-340 witness over `message`.
 *
 * ⚠️ **Irreversible, and it burns the slot BEFORE it signs.** If this call
 * throws, assume the proof may already be spent — the card commits the flag
 * first on purpose, so that yanking the card mid-response cannot reset it and
 * hand out a free witness.
 *
 * The caller must therefore durably record the intent *before* telling anyone
 * the payment succeeded. See `cashuSettlement.ts`.
 *
 * A failure here is usually recoverable: the slot data survives, so
 * `signArbitrary` can re-derive an equally valid witness from the same card.
 */
export async function spendProof(
  transceive: Transceiver,
  slot: number,
  message: number[],
): Promise<number[]> {
  assertMessage(message, 'SPEND_PROOF');
  return assertSignature(
    await send(transceive, INS.SPEND_PROOF, {
      p1: slot,
      data: message,
      le: 0x40,
      context: `SPEND_PROOF slot ${slot}`,
    }),
    'SPEND_PROOF',
  );
}

/**
 * Sign 32 bytes without consuming a proof.
 *
 * This is the recovery path. The witness message is `sha256(utf8(secret))`,
 * derived entirely from data that survives on the card, so a settlement that
 * failed after the burn can be retried by re-signing here — no second proof is
 * spent and no PIN is required.
 */
export async function signArbitrary(
  transceive: Transceiver,
  message: number[],
): Promise<number[]> {
  assertMessage(message, 'SIGN_ARBITRARY');
  return assertSignature(
    await send(transceive, INS.SIGN_ARBITRARY, {
      data: message,
      le: 0x40,
      context: 'SIGN_ARBITRARY',
    }),
    'SIGN_ARBITRARY',
  );
}
