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
const SW_OK = 0x9000;

export const INS = {
  GET_INFO: 0x01,
  GET_PUBKEY: 0x10,
  GET_BALANCE: 0x11,
  GET_PROOF_COUNT: 0x12,
  GET_SLOT_STATUS: 0x14,
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
    case 0x6a86:
      return 'invalid P1/P2';
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
  }: {cla?: number; p1?: number; p2?: number; data?: number[]; le?: number} = {},
): number[] {
  const apdu = [cla, ins, p1, p2];
  if (data && data.length > 0) {
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
    throw new CardError(
      0,
      `${context}: truncated response (${response.length} bytes)`,
    );
  }
  const sw = (response[response.length - 2] << 8) | response[response.length - 1];
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
 */
export async function selectApplet(transceive: Transceiver): Promise<number[]> {
  let lastError: unknown;
  for (const aid of [PACKAGE_AID, APPLET_AID]) {
    try {
      return parseResponse(
        await transceive([0x00, 0xa4, 0x04, 0x00, aid.length, ...aid]),
        'SELECT',
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new CardError(0, 'SELECT: no applet found');
}

export async function getInfo(transceive: Transceiver): Promise<CardInfo> {
  const body = await send(transceive, INS.GET_INFO, {
    le: 0x00,
    context: 'GET_INFO',
  });
  if (body.length < 8) {
    throw new CardError(
      0,
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
    throw new CardError(
      0,
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
    throw new CardError(
      0,
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
