/* eslint-disable no-bitwise -- this module is a byte-level APDU codec; masking
   and shifting is the work, not an accident. */
/**
 * Cashu NFC card — APDU protocol layer, shared card protocol 2.0.
 *
 * Talks to the cashu-javacard applet (https://github.com/lnflash/cashu-javacard),
 * protocol 2.0: an offline bearer card that holds format-4 SIG_ALL pieces
 * locked to its own key and pays with ONE BIP-340 signature over a whole
 * NUT-11 SIG_ALL swap (the pieces it burns, the till's outputs and its own
 * change), burning every piece in the commit that releases the signature.
 *
 * This module is deliberately transport-agnostic. It knows how to build and
 * parse APDUs and nothing about NFC, so the whole protocol is unit-testable
 * without a card or a reader. The React Native IsoDep transport lives in
 * `cashuCardNfc.ts`.
 *
 * Command reference: cashu-javacard `spec/APDU.md` (2.0). Kept byte-for-byte
 * in step with the reference host driver `tools/cardctl/cardctl.py` and the
 * cardsim client `tools/cardsim/client.cjs`; the framing tests replay the
 * applet's own transcript (`__tests__/fixtures/card-protocol-2.0`).
 *
 * A 0.x card (AID `D2 76 00 00 85 01 02`) does not speak this protocol. It is
 * recognised only so it can be refused as "This card needs an update" before
 * anything is written to it or spent from it (`CardNeedsUpdateError`).
 */
import {schnorrVerifyDigest} from '@cashu/cashu-ts';
import {sha256} from '@noble/hashes/sha256';
import {hexToBytes, randomBytes, utf8ToBytes} from '@noble/hashes/utils';

import {nowMs, recordApdu} from './apduTiming';

/**
 * The 2.0 package AID: "CASHUCARD" after the proprietary RID byte F0. SELECT
 * does prefix matching, so this also finds the applet.
 */
export const PACKAGE_AID = [
  0xf0, 0x43, 0x41, 0x53, 0x48, 0x55, 0x43, 0x41, 0x52, 0x44,
];
/** The applet's instance AID, for a reader that declines a partial name. */
export const APPLET_AID = [...PACKAGE_AID, 0x01];

/**
 * The AIDs of the applets 2.0 replaces: the 0.x applet's two, and Foxy's 1.x
 * (`F0 46 4F 58 59 43 41 52 44`, "FOXYCARD" after F0). spec/APDU.md
 * "SELECT APPLICATION" names both as "this card needs an update". Selected
 * only after both 2.0 AIDs answer `6A82`, and only to tell a card that needs
 * an update from a card that is not an eCash card at all: nothing but the
 * SELECT is ever sent to one.
 */
export const LEGACY_AIDS = [
  [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02],
  [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02, 0x01],
  [0xf0, 0x46, 0x4f, 0x58, 0x59, 0x43, 0x41, 0x52, 0x44],
];

/** The protocol major this layer speaks. */
export const PROTOCOL_MAJOR = 2;

const CLA = 0xb0;

/** Slots on a 2.0 card. */
export const MAX_SLOTS = 128;

/**
 * One proof slot, in bytes: status[1] + keyset_id[8] + amount[4] + nonce[32]
 * + C[33] + date[4]. See spec/APDU.md, "Proof Slot Layout".
 */
export const PROOF_SIZE = 82;
/** A slot without its status byte: what GET_PIECES and LOAD_PROOF carry. */
export const PIECE_SIZE = 81;
/** The mint's NUT-12 proof as the card keeps it: e ‖ s ‖ r. */
export const DLEQ_SIZE = 96;
/** A Bitcoin block header. */
export const HEADER_SIZE = 80;
/** One swap output in SPEND_ALL_OUTPUTS: amount[4] + B_[33]. */
const OUTPUT_SIZE = 37;
/** Outputs to one SPEND_ALL_OUTPUTS: 6 × 37 = 222, under the short Lc. */
const OUTPUTS_PER_APDU = 6;
/** One change opening in GET_CHANGE: amount, keyset, date, nonce, r. */
const OPENING_SIZE = 80;
/** Openings to one GET_CHANGE page. */
const OPENINGS_PER_PAGE = 3;
/** Pages GET_CHANGE can have: the card keeps at most 8 openings. */
const MAX_CHANGE_PAGES = 3;
/** "Not yet": SPEND_ALL_SIGN's answer while a payment waits out its limit. */
const NOT_YET = [0x00, 0x01];
/**
 * How many "not yet"s a payment may take before the terminal gives up. The
 * card's wait is its own work (a signature each), so this is a bound on a
 * misbehaving card, not on a real limit: cardsim's client allows 1,100.
 */
const MAX_SIGN_WAITS = 1100;

const SW_OK = 0x9000;

export const INS = {
  GET_INFO: 0x01,
  GET_PUBKEY: 0x10,
  GET_BALANCE: 0x11,
  GET_PROOF_COUNT: 0x12,
  GET_PROOF: 0x13,
  GET_SLOT_STATUS: 0x14,
  AUTH: 0x15,
  GET_CARD: 0x16,
  GET_PIECES: 0x17,
  GET_CHANGE: 0x19,
  GET_DLEQ: 0x1a,
  SPEND_ALL_BEGIN: 0x22,
  SPEND_ALL_OUTPUTS: 0x23,
  SPEND_ALL_SIGN: 0x24,
  SPEND_ALL_AGAIN: 0x25,
  SPEND_ALL_CHANGE: 0x26,
  LOAD_PROOF: 0x30,
  SET_HEADER: 0x36,
  TELL_TIME: 0x37,
  VERIFY_PIN: 0x40,
} as const;

/** Instruction byte → name, for the timing log. */
const INS_NAME = new Map<number, string>(
  Object.entries(INS).map(([name, ins]) => [ins, name]),
);

/** Sends a raw APDU and resolves to the full response: data bytes + SW1 + SW2. */
export type Transceiver = (apdu: number[]) => Promise<number[]>;

/**
 * Every APDU goes through here so each one lands in `apduTiming` under its
 * command name. The sample is taken around the transceive call itself — the
 * round trip the phone sees — and is recorded even when the card answers with
 * an error status, since a 6982 that took 700 ms is exactly the kind of number
 * a timing run exists to show.
 */
async function timedTransceive(
  transceive: Transceiver,
  apdu: number[],
  context: string,
): Promise<number[]> {
  const startedAt = nowMs();
  try {
    return await transceive(apdu);
  } finally {
    recordApdu(context, nowMs() - startedAt);
  }
}

/** A command reached the card and the card refused it. `sw` is the status word. */
export class CardError extends Error {
  constructor(readonly sw: number, readonly context: string) {
    super(
      `${context} failed: ${describeStatusWord(sw, context)} (0x${hex16(sw)})`,
    );
    this.name = 'CardError';
  }
}

/** The copy a card that does not speak protocol 2.0 is refused with (decision 8). */
export const CARD_NEEDS_UPDATE = 'This card needs an update';

/**
 * The card runs the 0.x applet (it answers a legacy AID), or a 2.0 AID with a
 * major version below 2. Nothing is written to it and nothing is spent from
 * it: a 0.x card's pieces are SIG_INPUTS pieces this terminal no longer signs
 * for, and an operator sweeps them.
 */
export class CardNeedsUpdateError extends Error {
  constructor(readonly detail = '') {
    super(CARD_NEEDS_UPDATE);
    this.name = 'CardNeedsUpdateError';
  }
}

/** True for a `CardNeedsUpdateError`, raw or as another error's `cause`. */
export function isCardNeedsUpdate(error: unknown): boolean {
  const cause =
    error instanceof Error ? (error as {cause?: unknown}).cause : undefined;
  return (
    error instanceof CardNeedsUpdateError ||
    cause instanceof CardNeedsUpdateError
  );
}

/**
 * The card answered AUTH with a signature that does not verify under the key
 * it reported: whatever is on the antenna is not the card that holds that
 * key (a relay, a clone of its public data, a broken card).
 */
export class CardAuthError extends Error {
  constructor(message = 'This card could not prove it holds its key') {
    super(message);
    this.name = 'CardAuthError';
  }
}

/** ISO 7816 "file or application not found": the SELECT hit a card without our applet. */
export const SW_APPLET_NOT_FOUND = 0x6a82;
/** LOAD_PROOF: the piece is already on the card. SPEND_ALL_SIGN: the PIN is needed. */
export const SW_ALREADY_OR_PIN = 0x6a94;
/** Over the card's daily limit (BEGIN on a wrapped sum, or SIGN). */
export const SW_OVER_DAILY_LIMIT = 0x6a8f;
/** Security status not satisfied: the PIN (or a grant) not given in this tap. */
export const SW_SECURITY_NOT_SATISFIED = 0x6982;

/**
 * True when the failure is the card saying it does not run the Cashu applet.
 *
 * Matches the raw `CardError` from `selectApplet`, and one wrapped as the
 * `cause` of another error (the per-phase `PhaseError` that `readAndPlan`
 * throws). The decision rests on the class and the status word, never on
 * the message text. This is the signature of a non-Cashu ISO-DEP card — a
 * BoltCard on an NTAG 424 DNA, for one — not of a card that failed.
 */
export function isAppletNotFound(error: unknown): boolean {
  const cause =
    error instanceof Error ? (error as {cause?: unknown}).cause : undefined;
  const cardError = cause instanceof CardError ? cause : error;
  return cardError instanceof CardError && cardError.sw === SW_APPLET_NOT_FOUND;
}

/**
 * True when the card refused to sign a payment because it needs the PIN
 * (`6A94` from SPEND_ALL_SIGN: a PIN is set, it was not given in this tap,
 * and the no-PIN allowance does not cover the payment). Nothing was burned.
 */
export function isPinNeededForPayment(error: unknown): boolean {
  const cause =
    error instanceof Error ? (error as {cause?: unknown}).cause : undefined;
  const cardError = cause instanceof CardError ? cause : error;
  return (
    cardError instanceof CardError &&
    cardError.sw === SW_ALREADY_OR_PIN &&
    cardError.context.startsWith('SPEND_ALL_SIGN')
  );
}

/**
 * The card answered (0x9000) but the framing was wrong — a short response, a
 * wrong-length body.
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
 *
 * Some words mean different things to different commands (`6A94` is "already
 * on the card" to LOAD_PROOF and "the PIN is needed" to SPEND_ALL_SIGN), so
 * the command's context, as `CardError` carries it, picks the meaning.
 */
export function describeStatusWord(sw: number, context = ''): string {
  // ISO 7816 VERIFY: 63Cx carries the tries remaining in the low nibble.
  // A merchant reading "unexpected status word (0x63C2)" over the customer's
  // shoulder learned nothing (field-found 2026-10-02); the count is the one
  // thing worth saying.
  if ((sw & 0xfff0) === 0x63c0) {
    const tries = sw & 0x000f;
    if (tries === 0) {
      return 'wrong PIN — no tries left';
    }
    return `wrong PIN — ${tries} ${tries === 1 ? 'try' : 'tries'} left`;
  }
  const command = context.split(' ')[0];
  switch (sw) {
    case 0x9000:
      return 'OK';
    case 0x6982:
      return 'PIN required';
    case 0x6983:
      return 'PIN blocked';
    case 0x6984:
      return 'no PIN set';
    case 0x6a82:
      return 'applet not found';
    case 0x6985:
      return command === 'SPEND_ALL_OUTPUTS' ||
        command === 'SPEND_ALL_CHANGE' ||
        command === 'SPEND_ALL_SIGN'
        ? 'no payment begun'
        : 'proof already spent';
    case 0x6986:
      return 'card locked';
    case 0x6a80:
      return 'wrong data';
    case 0x6a83:
      return 'slot index out of range';
    case 0x6a84:
      // ISO 7816 "not enough memory space": LOAD_PROOF found no free slot.
      // The charge UI classes a full card by this wording (and the
      // pre-flight's "this card is full") — `money.ts`, CARD_FULL.
      return command === 'SPEND_ALL_CHANGE'
        ? 'no change opening free'
        : 'card is full — no free slot';
    case 0x6a88:
      return command === 'SPEND_ALL_AGAIN'
        ? 'the card has no signature to give again'
        : 'slot is empty';
    case 0x6a86:
      return 'invalid P1/P2';
    case 0x6a8c:
      return 'the card has no record';
    case 0x6a8d:
      return 'the card is in use';
    case 0x6a8e:
      return 'a dated piece on a card with no refund key';
    case 0x6a8f:
      return "over the card's daily limit";
    case 0x6a90:
      return 'the card has no owner';
    case 0x6a91:
      return "the owner's proof is missing or wrong";
    case 0x6a93:
      return 'too little work in the block header';
    case 0x6a94:
      return command === 'SPEND_ALL_SIGN'
        ? 'PIN needed for this payment'
        : 'already on the card';
    case 0x6a96:
      return 'too many places for one signature';
    case 0x6f00:
      return 'the card failed to sign';
    case 0x6700:
      return 'wrong length';
    case 0x6d00:
      return 'unsupported command';
    case 0x6e00:
      return 'wrong CLA — is this an eCash card?';
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
    // corrupt length on the wire. The commands that carry payloads
    // (LOAD_PROOF, VERIFY_PIN, SPEND_ALL_OUTPUTS) are the ones that move money.
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
  // Timing buckets by command, not by the caller's label: "GET_PROOF slot 3"
  // and "GET_PROOF slot 4" are the same figure.
  return parseResponse(
    await timedTransceive(
      transceive,
      buildApdu(ins, apduOpts),
      INS_NAME.get(ins) ?? context,
    ),
    context,
  );
}

// ── bytes ───────────────────────────────────────────────────────────────────

export const toHex = (bytes: number[] | Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** Bytes from hex; throws on odd length or a non-hex digit. */
export function fromHex(hex: string, what = 'value'): number[] {
  const clean = hex.replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new CardProtocolError(`${what} is not valid hex`);
  }
  return Array.from(hexToBytes(clean.toLowerCase()));
}

const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

// uint32 big-endian. >>> 0 keeps it unsigned; a value with bit 31 set would
// otherwise read negative.
const readU32 = (b: number[], at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function checkU32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new CardProtocolError(
      `${what} must be a whole number below 2^32, got ${value}`,
    );
  }
}

function checkSlot(slot: number, what = 'slot'): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) {
    throw new CardProtocolError(
      `${what} must be 0..${MAX_SLOTS - 1}, got ${slot}`,
    );
  }
}

/**
 * The 8 bytes of a keyset id the card stores: an 8-byte (pre-v2) id whole,
 * or the first 8 bytes of a 33-byte NUT-02 v2 id (a reader expands it back
 * against the mint's keysets; `expandKeysetId` in cashuMint.ts).
 */
export function cardKeysetBytes(keysetId: string): number[] {
  if (keysetId.length !== 16 && keysetId.length !== 66) {
    throw new CardProtocolError(
      `keyset id must be 16 or 66 hex chars, got ${keysetId.length}`,
    );
  }
  return fromHex(keysetId.slice(0, 16), 'keyset id');
}

// ── SELECT ──────────────────────────────────────────────────────────────────

async function selectAid(
  transceive: Transceiver,
  aid: number[],
): Promise<number[]> {
  return parseResponse(
    await timedTransceive(
      transceive,
      [0x00, 0xa4, 0x04, 0x00, aid.length, ...aid, 0x00],
      'SELECT',
    ),
    'SELECT',
  );
}

const isNotFound = (error: unknown): boolean =>
  error instanceof CardError && error.sw === SW_APPLET_NOT_FOUND;

/**
 * SELECT the 2.0 applet. Tries the package AID first (prefix match, what the
 * reference driver does) and falls back to the full applet AID for cards that
 * do not support partial selection.
 *
 * Resolves to the 2-byte applet version, `02 xx`.
 *
 * The contract is cashu-javacard's (`tools/cardsim/README.md`, "Old cards"):
 * any SELECT answer that is not `02xx 9000` is "This card needs an update".
 * So, on a 2.0 AID:
 *
 *   - `9000` with a body that is not exactly `02 xx` (empty, one byte, a
 *     major of 1 or 3) throws `CardNeedsUpdateError`;
 *   - any status word but `9000` or `6A82` (jCardSim answers an old card
 *     `6E00` or `6999`) throws `CardNeedsUpdateError`;
 *   - `6A82` tries the next AID.
 *
 * Only `6A82` on both 2.0 AIDs goes on to the old AIDs (0.x and Foxy 1.x,
 * spec/APDU.md "SELECT APPLICATION"): if one answers, the card needs an
 * update and nothing more is sent. If none does, the original `6A82` stands
 * — not an eCash card (a BoltCard, a bank card), which `isAppletNotFound`
 * recognises and the LNURLw fallback reads.
 *
 * A transport failure (the card left the field mid-SELECT) surfaces as
 * itself: a card that moved is not a card running the wrong software.
 *
 * The trailing 0x00 is Le, making this a Case-4 GlobalPlatform SELECT. It is
 * load-bearing on iOS: `NFCISO7816APDU initWithData:` parses a Case-3 command
 * (no Le) as expectedResponseLength -1, CoreNFC then sends no Le, and the card
 * answers with a status word only — so the applet version would come back empty.
 */
export async function selectApplet(transceive: Transceiver): Promise<number[]> {
  let notFound: unknown;
  for (const aid of [PACKAGE_AID, APPLET_AID]) {
    let version: number[];
    try {
      version = await selectAid(transceive, aid);
    } catch (error) {
      if (isNotFound(error)) {
        notFound = error;
        continue;
      }
      if (error instanceof CardError) {
        throw new CardNeedsUpdateError(`SELECT answered 0x${hex16(error.sw)}`);
      }
      throw error;
    }
    if (version.length !== 2 || version[0] !== PROTOCOL_MAJOR) {
      throw new CardNeedsUpdateError(
        `SELECT answered version ${toHex(version) || '(none)'}`,
      );
    }
    return version;
  }
  for (const aid of LEGACY_AIDS) {
    let answered = false;
    try {
      await selectAid(transceive, aid);
      answered = true;
    } catch (error) {
      if (!(error instanceof CardError)) {
        throw error;
      }
    }
    if (answered) {
      throw new CardNeedsUpdateError(`old applet ${toHex(aid)}`);
    }
  }
  throw notFound instanceof Error
    ? notFound
    : new CardError(SW_APPLET_NOT_FOUND, 'SELECT');
}

// ── reads ───────────────────────────────────────────────────────────────────

export interface CardInfo {
  version: string;
  major: number;
  minor: number;
  maxSlots: number;
  unspent: number;
  spent: number;
  empty: number;
  /** Capability byte, raw (all bits set on 2.0). */
  capabilities: number;
  secp256k1Native: boolean;
  schnorr: boolean;
  /**
   * The PIN (GET_INFO byte 7): none, set, or blocked after too many wrong
   * tries. Not the card's lock (`locked`, byte 10, set by LOCK_CARD).
   */
  pinState: 'unset' | 'set' | 'blocked' | 'unknown';
  /** Piece format: 4 = SIG_ALL pieces. */
  format: number;
  /** PIN tries left, 0 to 3. */
  triesLeft: number;
  /**
   * The owner has locked the card (`LOCK_CARD`, GET_INFO byte 10): it pays
   * nothing and loads nothing more (spec/APDU.md LOAD_PROOF `6986`).
   */
  locked: boolean;
  recordSet: boolean;
  /** The owner's daily limit in sats; 0 is none. */
  dailyLimit: number;
  hasOwner: boolean;
  /** The card's clock: the newest block header's time, seconds; 0 before any. */
  now: number;
  /** When the day's window began, seconds. */
  windowStart: number;
  /** Sats signed for in the window. */
  spentToday: number;
  /** This tap may load the last payment's change with no PIN. */
  changeGrant: boolean;
  /**
   * The limit on one payment (P1 = 1). The card reports it only under the
   * owner's grant, so a till reads 0 here: over it, the card makes the
   * payment wait, it does not refuse.
   */
  paymentLimit?: number;
  /** Sats a day the card signs for without its PIN (P1 = 1); 0 is none. */
  allowance?: number;
  /** What has been signed for without the PIN in the window (P1 = 1). */
  noPinSpent?: number;
}

const PIN_STATES: Record<number, CardInfo['pinState']> = {
  0: 'unset',
  1: 'set',
  2: 'blocked',
};

/** GET_INFO's body: 30 bytes with P1 = 0, 42 with P1 = 1. */
export function parseInfo(body: number[]): CardInfo {
  if (body.length < 30) {
    throw new CardProtocolError(
      `GET_INFO: expected at least 30 bytes, got ${body.length}`,
    );
  }
  const caps = body[6];
  const info: CardInfo = {
    version: `${body[0]}.${body[1]}`,
    major: body[0],
    minor: body[1],
    maxSlots: body[2],
    unspent: body[3],
    spent: body[4],
    empty: body[5],
    capabilities: caps,
    secp256k1Native: (caps & 0x01) !== 0,
    schnorr: (caps & 0x02) !== 0,
    pinState: PIN_STATES[body[7]] ?? 'unknown',
    format: body[8],
    triesLeft: body[9],
    locked: body[10] === 1,
    recordSet: body[11] === 1,
    dailyLimit: readU32(body, 12),
    hasOwner: body[16] === 1,
    now: readU32(body, 17),
    windowStart: readU32(body, 21),
    spentToday: readU32(body, 25),
    changeGrant: body[29] === 1,
  };
  if (body.length >= 42) {
    info.paymentLimit = readU32(body, 30);
    info.allowance = readU32(body, 34);
    info.noPinSpent = readU32(body, 38);
  }
  return info;
}

/**
 * GET_INFO. P1 = 1 (the default) adds the no-PIN allowance and what it has
 * counted, which the charge needs to decide whether to ask for the PIN.
 * Throws `CardNeedsUpdateError` for a major below 2.
 */
export async function getInfo(
  transceive: Transceiver,
  {p1 = 1}: {p1?: 0 | 1} = {},
): Promise<CardInfo> {
  const body = await send(transceive, INS.GET_INFO, {
    p1,
    le: 0x00,
    context: 'GET_INFO',
  });
  const info = parseInfo(body);
  if (info.major < PROTOCOL_MAJOR) {
    throw new CardNeedsUpdateError(`GET_INFO version ${info.version}`);
  }
  return info;
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
  return readU32(body, 0);
}

/**
 * VERIFY_PIN within the current session. Resolves on success; a wrong PIN
 * rejects with the card's `63CX` (tries remaining), a blocked PIN with
 * `6983`, an unset PIN with `6984`. The session flag clears on deselect —
 * every purchase re-verifies.
 */
export async function verifyCardPin(
  transceive: Transceiver,
  pin: string,
): Promise<void> {
  const data = Array.from(pin).map(c => c.charCodeAt(0));
  await send(transceive, INS.VERIFY_PIN, {
    data,
    context: 'VERIFY_PIN',
  });
}

export type SlotStatus = 'empty' | 'unspent' | 'spent';

/**
 * Bulk status read: one byte per slot (0=empty, 1=unspent, 2=spent), so the
 * reader can tell what a payment burned without pulling every slot.
 *
 * `count` is also the Le — the card returns exactly one byte per slot, and
 * iOS's Case-2 handling needs the length stated up front (see the comment on
 * `selectApplet` for what a missing Le does to CoreNFC).
 */
export async function getSlotStatuses(
  transceive: Transceiver,
  count: number = MAX_SLOTS,
): Promise<SlotStatus[]> {
  if (count <= 0 || count > 0xff) {
    throw new CardProtocolError(`GET_SLOT_STATUS: invalid count ${count}`);
  }
  const body = await send(transceive, INS.GET_SLOT_STATUS, {
    le: count,
    context: `GET_SLOT_STATUS (${count} slots)`,
  });
  if (body.length !== count) {
    throw new CardProtocolError(
      `GET_SLOT_STATUS: expected ${count} bytes, got ${body.length}`,
    );
  }
  return body.map(b => {
    if (b === 0x00) {
      return 'empty';
    }
    if (b === 0x01) {
      return 'unspent';
    }
    if (b === 0x02) {
      return 'spent';
    }
    throw new CardProtocolError(
      `GET_SLOT_STATUS: unknown status byte 0x${b.toString(16)}`,
    );
  });
}

/** One proof slot as the card returns it, hex-encoded. */
export interface CardProofSlot {
  slot: number;
  status: 'unspent' | 'spent';
  /**
   * The keyset id as the card stores it: 16 hex chars, decoded from 8 RAW
   * bytes, never ASCII. For a NUT-02 v2 keyset these are the first 8 bytes
   * of its id (`expandKeysetId` gives the full id back).
   */
  keysetId: string;
  amount: number;
  /**
   * The 32-byte P2PK nonce. NOT the secret — the secret is ~200 bytes of JSON
   * the terminal rebuilds from this nonce, the card's key and the date
   * (`buildCardSigAllSecret` in cashuMint.ts).
   */
  nonce: string;
  /** The mint's unblinded signature, 33 bytes compressed. */
  C: string;
  /** The piece's locktime, seconds; 0 for none. */
  date: number;
}

/** 81 bytes after a slot's status: keyset, amount, nonce, C, date. */
function parsePiece(
  slot: number,
  status: CardProofSlot['status'],
  b: number[],
  at: number,
): CardProofSlot {
  return {
    slot,
    status,
    // Raw bytes to hex gives the full 16-char id. Decoding as ASCII would give
    // 8 chars — half an id, matching no keyset at the mint.
    keysetId: toHex(b.slice(at, at + 8)),
    amount: readU32(b, at + 8),
    nonce: toHex(b.slice(at + 12, at + 44)),
    C: toHex(b.slice(at + 44, at + 77)),
    date: readU32(b, at + 77),
  };
}

/**
 * Read one proof slot.
 *
 * Spent slots are still readable — only an empty slot is refused. A spent
 * slot whose CLEAR_SPENT was cut short answers with some fields zeroed: its
 * bytes are not a proof.
 */
export async function getProof(
  transceive: Transceiver,
  slot: number,
): Promise<CardProofSlot> {
  checkSlot(slot);
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
  return parsePiece(slot, status === 0x01 ? 'unspent' : 'spent', body, 1);
}

/** One GET_PIECES page: what it covered, and every non-empty slot in it. */
export interface PiecesPage {
  /** The first slot this page does not cover; 128 at the end. */
  next: number;
  /** Unspent slots, in full. */
  unspent: CardProofSlot[];
  /** Spent slots: number only. */
  spent: number[];
}

/** GET_PIECES P2 = 0's body: `next`, then a tag per slot and 81 bytes per unspent one. */
export function parsePiecesPage(body: number[], from: number): PiecesPage {
  if (body.length < 1) {
    throw new CardProtocolError('GET_PIECES: empty page');
  }
  const next = body[0];
  if (next <= from || next > MAX_SLOTS) {
    throw new CardProtocolError(
      `GET_PIECES: page from ${from} says it ends at ${next}`,
    );
  }
  const page: PiecesPage = {next, unspent: [], spent: []};
  let at = 1;
  while (at < body.length) {
    const tag = body[at++];
    const slot = tag & 0x7f;
    if (slot < from || slot >= next) {
      throw new CardProtocolError(
        `GET_PIECES: slot ${slot} outside the page ${from}..${next - 1}`,
      );
    }
    if ((tag & 0x80) !== 0) {
      page.spent.push(slot);
      continue;
    }
    if (at + PIECE_SIZE > body.length) {
      throw new CardProtocolError(
        `GET_PIECES: slot ${slot} is cut short (${body.length - at} bytes)`,
      );
    }
    page.unspent.push(parsePiece(slot, 'unspent', body, at));
    at += PIECE_SIZE;
  }
  return page;
}

/** One GET_PIECES page from `from` (P2 = 0, the whole form). */
export async function getPiecesPage(
  transceive: Transceiver,
  from = 0,
): Promise<PiecesPage> {
  checkSlot(from, 'GET_PIECES first slot');
  const body = await send(transceive, INS.GET_PIECES, {
    p1: from,
    p2: 0x00,
    le: 0x00,
    context: `GET_PIECES from ${from}`,
  });
  return parsePiecesPage(body, from);
}

/**
 * Every piece on the card, page by page: the unspent ones in full and the
 * spent slots by number. The empty slots are what is left of 128.
 */
export async function getPieces(
  transceive: Transceiver,
): Promise<{unspent: CardProofSlot[]; spent: number[]}> {
  const unspent: CardProofSlot[] = [];
  const spent: number[] = [];
  let from = 0;
  while (from < MAX_SLOTS) {
    const page = await getPiecesPage(transceive, from);
    unspent.push(...page.unspent);
    spent.push(...page.spent);
    from = page.next;
  }
  return {unspent, spent};
}

/**
 * One unspent piece as the short listing (GET_PIECES, P2 = 3) names it: what
 * choosing pieces needs, and no more. Its nonce and C are read afterwards by
 * slot (`getPiecesNamed`), for the chosen pieces only.
 */
export interface ListedPiece {
  slot: number;
  /** The keyset as the card stores it: 16 hex chars (8 raw bytes). */
  keysetId: string;
  amount: number;
  /** The piece's locktime, seconds; 0 for none. */
  date: number;
}

/** One short-listing answer: where the next one starts, and its pieces. */
export interface ShortListingPage {
  /** The first slot this answer does not cover; 128 at the end. */
  next: number;
  pieces: ListedPiece[];
}

/** Bytes a short-listing entry's keyset and date take, after its slot. */
const SHORT_NAMED_SIZE = 12;
/** The size byte that says an amount (4 bytes) follows, not a power of two. */
const SHORT_OTHER_AMOUNT = 0xff;

/**
 * GET_PIECES P2 = 3's body (spec/APDU.md GET_PIECES; the applet's
 * `processGetShort`): `next` (1), then for each unspent slot from P1 up to
 * `next`, in order: its number (1, with `0x80` where its keyset (8) and date
 * (4) follow — always in an answer's first entry, and wherever they differ
 * from the entry before), then the power of two it is worth (1), or `FF` and
 * its amount (4). Spent and empty slots are not listed.
 */
export function parseShortListing(
  body: number[],
  from: number,
): ShortListingPage {
  if (body.length < 1) {
    throw new CardProtocolError('GET_PIECES (short): empty answer');
  }
  const next = body[0];
  if (next <= from || next > MAX_SLOTS) {
    throw new CardProtocolError(
      `GET_PIECES (short): an answer from ${from} says it ends at ${next}`,
    );
  }
  const pieces: ListedPiece[] = [];
  let keysetId: string | null = null;
  let date = 0;
  let last = from - 1;
  let at = 1;
  const need = (n: number, what: string) => {
    if (at + n > body.length) {
      throw new CardProtocolError(
        `GET_PIECES (short): ${what} is cut short at byte ${at}`,
      );
    }
  };
  while (at < body.length) {
    const tag = body[at++];
    const slot = tag & 0x7f;
    if (slot <= last || slot >= next) {
      throw new CardProtocolError(
        `GET_PIECES (short): slot ${slot} out of order in ${from}..${next - 1}`,
      );
    }
    last = slot;
    if ((tag & 0x80) !== 0) {
      need(SHORT_NAMED_SIZE, `slot ${slot}'s keyset and date`);
      keysetId = toHex(body.slice(at, at + 8));
      date = readU32(body, at + 8);
      at += SHORT_NAMED_SIZE;
    } else if (keysetId === null) {
      throw new CardProtocolError(
        `GET_PIECES (short): slot ${slot} names no keyset and none came before it`,
      );
    }
    need(1, `slot ${slot}'s size`);
    const size = body[at++];
    let amount: number;
    if (size === SHORT_OTHER_AMOUNT) {
      need(4, `slot ${slot}'s amount`);
      amount = readU32(body, at);
      at += 4;
    } else if (size <= 31) {
      amount = 2 ** size;
    } else {
      throw new CardProtocolError(
        `GET_PIECES (short): slot ${slot}'s size byte 0x${size.toString(16)}`,
      );
    }
    pieces.push({slot, keysetId, amount, date});
  }
  return {next, pieces};
}

/** One short-listing answer from slot `from` (GET_PIECES, P2 = 3). */
export async function getPiecesShortPage(
  transceive: Transceiver,
  from = 0,
): Promise<ShortListingPage> {
  checkSlot(from, 'GET_PIECES first slot');
  const body = await send(transceive, INS.GET_PIECES, {
    p1: from,
    p2: 0x03,
    le: 0x00,
    context: `GET_PIECES short from ${from}`,
  });
  return parseShortListing(body, from);
}

/**
 * Every unspent piece's slot, keyset, date and amount: the short listing,
 * answer by answer until `next` is 128. A card whose pieces share a keyset
 * and a date and are powers of two is all 128 slots in two answers, where
 * the whole form (`getPieces`) takes forty-three — the till reads this at
 * every payment (spec/APDU.md "Payment Flow").
 */
export async function getPiecesShort(
  transceive: Transceiver,
): Promise<ListedPiece[]> {
  const pieces: ListedPiece[] = [];
  let from = 0;
  while (from < MAX_SLOTS) {
    const page = await getPiecesShortPage(transceive, from);
    pieces.push(...page.pieces);
    from = page.next;
  }
  return pieces;
}

/** A slot read by name (GET_PIECES P2 = 2): its state, and its piece if it holds one. */
export interface NamedSlot {
  slot: number;
  status: SlotStatus;
  /** The piece, for an unspent or spent slot; null for an empty one. */
  piece: CardProofSlot | null;
}

/** Slots one GET_PIECES P2 = 2 names (the applet's BATCH_MOST). */
const NAMED_PER_APDU = 3;

/**
 * GET_PIECES P2 = 2: the named slots whole, as GET_PROOF gives them (status,
 * then its 81 bytes), in the order asked, three to an APDU. An empty or spent
 * slot is answered as it is, so the caller sees for itself that it is not
 * what the listing said.
 */
export async function getPiecesNamed(
  transceive: Transceiver,
  slots: number[],
): Promise<NamedSlot[]> {
  slots.forEach(slot => checkSlot(slot));
  const out: NamedSlot[] = [];
  for (let i = 0; i < slots.length; i += NAMED_PER_APDU) {
    const asked = slots.slice(i, i + NAMED_PER_APDU);
    const body = await send(transceive, INS.GET_PIECES, {
      p2: 0x02,
      data: asked,
      le: 0x00,
      context: `GET_PIECES slots ${asked.join(',')}`,
    });
    if (body.length !== asked.length * PROOF_SIZE) {
      throw new CardProtocolError(
        `GET_PIECES (named): expected ${asked.length * PROOF_SIZE} bytes, got ${
          body.length
        }`,
      );
    }
    asked.forEach((slot, k) => {
      const at = k * PROOF_SIZE;
      const status = body[at];
      if (status === 0x00) {
        out.push({slot, status: 'empty', piece: null});
        return;
      }
      if (status !== 0x01 && status !== 0x02) {
        throw new CardProtocolError(
          `GET_PIECES (named): slot ${slot} has status byte 0x${status.toString(
            16,
          )}`,
        );
      }
      const state = status === 0x01 ? 'unspent' : 'spent';
      out.push({
        slot,
        status: state,
        piece: parsePiece(slot, state, body, at + 1),
      });
    });
  }
  return out;
}

/** The card's record (GET_CARD): what the terminal needs to rebuild its secrets. */
export interface CardRecord {
  format: number;
  recordSet: boolean;
  /** 0 = sat. */
  unit: number;
  dailyLimit: number;
  /** The refund key every dated piece names, or null for none (zeros). */
  refundKey: string | null;
  /** The hardest header's bits, as a header carries them. */
  hardestBits: string;
  /** The hash of the last header taken, as Bitcoin shows a block hash. */
  lastHeader: string;
  /** How often the window has rolled since the owner's last REFRESH. */
  rolls: number;
  /** The rollover budget, 1 to 30 (7 when the card says 0). */
  rollBudget: number;
  allowanceArmed: boolean;
  /** The mint the card's pieces belong to. */
  mint: string;
  /** Three characters, or '' for none. */
  design: string;
}

const ROLL_BUDGET_DEFAULT = 7;

export function parseCardRecord(b: number[]): CardRecord {
  if (b.length < 106) {
    throw new CardProtocolError(
      `GET_CARD: expected at least 106 bytes, got ${b.length}`,
    );
  }
  const mintLength = b[105];
  if (106 + mintLength > b.length) {
    throw new CardProtocolError(
      `GET_CARD: the mint is ${mintLength} bytes and the record ${b.length}`,
    );
  }
  const refund = b.slice(7, 40);
  const design = b.slice(106 + mintLength, 109 + mintLength);
  return {
    format: b[0],
    recordSet: b[1] === 1,
    unit: b[2],
    dailyLimit: readU32(b, 3),
    refundKey: refund.every(x => x === 0) ? null : toHex(refund),
    hardestBits: toHex(b.slice(40, 44)),
    lastHeader: toHex(b.slice(44, 76)),
    rolls: b[76],
    rollBudget: b[77] || ROLL_BUDGET_DEFAULT,
    allowanceArmed: b[78] === 1,
    mint: String.fromCharCode(...b.slice(106, 106 + mintLength)),
    design:
      design.length === 3 && design.some(x => x !== 0)
        ? String.fromCharCode(...design)
        : '',
  };
}

/** GET_CARD: the unit, the refund key and the mint the card's secrets need. */
export async function getCard(transceive: Transceiver): Promise<CardRecord> {
  return parseCardRecord(
    await send(transceive, INS.GET_CARD, {le: 0x00, context: 'GET_CARD'}),
  );
}

/** A piece's NUT-12 proof as the card keeps it, hex. */
export interface CardDleq {
  e: string;
  s: string;
  r: string;
}

/**
 * GET_DLEQ for one slot or two: each answer is the mint's proof kept with an
 * unspent piece, or null (empty, spent, loaded without one). The card checks
 * nothing; `verifyPieceDleq` does, with the mint's key.
 */
export async function getDleq(
  transceive: Transceiver,
  slotA: number,
  slotB?: number,
): Promise<(CardDleq | null)[]> {
  checkSlot(slotA);
  if (slotB !== undefined) {
    checkSlot(slotB);
  }
  const body = await send(transceive, INS.GET_DLEQ, {
    p1: slotA,
    p2: slotB === undefined ? 0xff : slotB,
    le: 0x00,
    context: `GET_DLEQ slot ${slotA}`,
  });
  const asked = slotB === undefined ? 1 : 2;
  const out: (CardDleq | null)[] = [];
  let at = 0;
  for (let k = 0; k < asked; k++) {
    const flag = body[at++];
    if (flag === 0x00) {
      out.push(null);
      continue;
    }
    if (flag !== 0x01 || at + DLEQ_SIZE > body.length) {
      throw new CardProtocolError(`GET_DLEQ: malformed answer for proof ${k}`);
    }
    out.push({
      e: toHex(body.slice(at, at + 32)),
      s: toHex(body.slice(at + 32, at + 64)),
      r: toHex(body.slice(at + 64, at + 96)),
    });
    at += DLEQ_SIZE;
  }
  if (at !== body.length) {
    throw new CardProtocolError(
      `GET_DLEQ: ${body.length - at} bytes left over`,
    );
  }
  return out;
}

/**
 * GET_DLEQ for many slots, two to an APDU. Resolves to a map from slot to
 * its proof (or null).
 */
export async function getDleqs(
  transceive: Transceiver,
  slots: number[],
): Promise<Map<number, CardDleq | null>> {
  const out = new Map<number, CardDleq | null>();
  for (let i = 0; i < slots.length; i += 2) {
    const pair = slots.slice(i, i + 2);
    const answers = await getDleq(transceive, pair[0], pair[1]);
    pair.forEach((slot, k) => out.set(slot, answers[k]));
  }
  return out;
}

// ── AUTH ────────────────────────────────────────────────────────────────────

/** The tag AUTH's message is hashed under (the 2.0 neutral identity). */
export const AUTH_TAG = 'CashuCard/auth';

/**
 * AUTH's message: SHA-256(T ‖ T ‖ reader (16) ‖ card (16) ‖ card key (33)),
 * T = SHA-256("CashuCard/auth"). 129 bytes behind a tag, so no piece's secret
 * (text beginning `["P2PK"`) can hash to it.
 */
export function authMessage(
  readerNonce: number[] | Uint8Array,
  cardNonce: number[] | Uint8Array,
  cardPubkey: number[] | Uint8Array,
): Uint8Array {
  const tag = sha256(utf8ToBytes(AUTH_TAG));
  const body = new Uint8Array(32 + 32 + 16 + 16 + 33);
  body.set(tag, 0);
  body.set(tag, 32);
  body.set(Uint8Array.from(readerNonce), 64);
  body.set(Uint8Array.from(cardNonce), 80);
  body.set(Uint8Array.from(cardPubkey), 96);
  return sha256(body);
}

/**
 * AUTH: prove the card on the antenna holds the key it reports. Sends 16
 * fresh bytes, and verifies the card's BIP-340 signature over the tagged
 * message under `cardPubkey`. Throws `CardAuthError` on a signature that does
 * not verify. No PIN, nothing burned.
 */
export async function auth(
  transceive: Transceiver,
  cardPubkey: number[],
  readerNonce: number[] = Array.from(randomBytes(16)),
): Promise<void> {
  if (readerNonce.length !== 16) {
    throw new CardProtocolError(
      `AUTH: the reader's nonce is 16 bytes, got ${readerNonce.length}`,
    );
  }
  const body = await send(transceive, INS.AUTH, {
    data: readerNonce,
    le: 0x50,
    context: 'AUTH',
  });
  if (body.length !== 80) {
    throw new CardProtocolError(`AUTH: expected 80 bytes, got ${body.length}`);
  }
  const message = authMessage(readerNonce, body.slice(0, 16), cardPubkey);
  const signature = toHex(body.slice(16));
  if (!schnorrVerifyDigest(signature, message, toHex(cardPubkey))) {
    throw new CardAuthError();
  }
}

// ── the clock ───────────────────────────────────────────────────────────────

/**
 * SET_HEADER: show the card a Bitcoin block header (80 bytes, as the network
 * carries it). Resolves to the card's `now`. An older header moves nothing;
 * one with too little work is `6A93`. No PIN, no owner, any state.
 */
export async function setHeader(
  transceive: Transceiver,
  header: number[],
): Promise<number> {
  if (header.length !== HEADER_SIZE) {
    throw new CardProtocolError(
      `SET_HEADER: a block header is ${HEADER_SIZE} bytes, got ${header.length}`,
    );
  }
  const body = await send(transceive, INS.SET_HEADER, {
    data: header,
    le: 0x04,
    context: 'SET_HEADER',
  });
  if (body.length !== 4) {
    throw new CardProtocolError(
      `SET_HEADER: expected 4 bytes, got ${body.length}`,
    );
  }
  return readU32(body, 0);
}

/**
 * TELL_TIME: the terminal's clock, seconds — a note for the card's receipts
 * and log, trusted for nothing. It gives up a payment already begun, so it
 * goes before SPEND_ALL_BEGIN.
 */
export async function tellTime(
  transceive: Transceiver,
  seconds: number,
): Promise<void> {
  checkU32(seconds, 'TELL_TIME');
  await send(transceive, INS.TELL_TIME, {
    data: u32(seconds),
    context: 'TELL_TIME',
  });
}

// ── paying: one SIG_ALL signature ───────────────────────────────────────────

/** A swap output as the card hashes it: the amount and the blinded message. */
export interface CardOutput {
  amount: number;
  /** The blinded message, 33 bytes compressed, hex. */
  B_: string;
}

/**
 * SPEND_ALL_BEGIN: name the payment's places, in the order their pieces go
 * into the message. Resolves to what they are worth together. `6985` names a
 * spent slot, `6A88` an empty one, `6A80` a slot twice or of another date.
 */
export async function spendAllBegin(
  transceive: Transceiver,
  slots: number[],
): Promise<number> {
  if (slots.length < 1 || slots.length > MAX_SLOTS) {
    throw new CardProtocolError(
      `SPEND_ALL_BEGIN: a payment names 1 to ${MAX_SLOTS} slots, got ${slots.length}`,
    );
  }
  slots.forEach(slot => checkSlot(slot));
  const body = await send(transceive, INS.SPEND_ALL_BEGIN, {
    data: slots,
    le: 0x04,
    context: 'SPEND_ALL_BEGIN',
  });
  if (body.length !== 4) {
    throw new CardProtocolError(
      `SPEND_ALL_BEGIN: expected 4 bytes, got ${body.length}`,
    );
  }
  return readU32(body, 0);
}

/** SPEND_ALL_OUTPUTS: the till's outputs, in order, six to an APDU. */
export async function spendAllOutputs(
  transceive: Transceiver,
  outputs: CardOutput[],
): Promise<void> {
  if (outputs.length === 0) {
    throw new CardProtocolError('SPEND_ALL_OUTPUTS: no outputs');
  }
  const encoded = outputs.map(o => {
    checkU32(o.amount, 'output amount');
    const B_ = fromHex(o.B_, 'B_');
    if (B_.length !== 33) {
      throw new CardProtocolError(
        `SPEND_ALL_OUTPUTS: B_ must be 33 bytes, got ${B_.length}`,
      );
    }
    return [...u32(o.amount), ...B_];
  });
  for (let i = 0; i < encoded.length; i += OUTPUTS_PER_APDU) {
    const data = encoded.slice(i, i + OUTPUTS_PER_APDU).flat();
    if (data.length % OUTPUT_SIZE !== 0) {
      throw new CardProtocolError('SPEND_ALL_OUTPUTS: misframed outputs');
    }
    await send(transceive, INS.SPEND_ALL_OUTPUTS, {
      data,
      context: 'SPEND_ALL_OUTPUTS',
    });
  }
}

/**
 * SPEND_ALL_CHANGE: one change output the card makes for itself — a fresh
 * nonce and r, its own key, the payment's date and refund key. Resolves to
 * the blinded message (hex). The card keeps the opening (GET_CHANGE).
 */
export async function spendAllChange(
  transceive: Transceiver,
  amount: number,
): Promise<string> {
  checkU32(amount, 'change amount');
  if (amount === 0) {
    throw new CardProtocolError('SPEND_ALL_CHANGE: change of 0');
  }
  const body = await send(transceive, INS.SPEND_ALL_CHANGE, {
    data: u32(amount),
    le: 0x21,
    context: 'SPEND_ALL_CHANGE',
  });
  if (body.length !== 33) {
    throw new CardProtocolError(
      `SPEND_ALL_CHANGE: expected 33 bytes, got ${body.length}`,
    );
  }
  return toHex(body);
}

const assertSignature = (sig: number[], command: string): number[] => {
  if (sig.length !== 64) {
    throw new CardProtocolError(
      `${command}: expected a 64-byte signature, got ${sig.length}`,
    );
  }
  return sig;
};

/**
 * SPEND_ALL_SIGN: the one signature over the whole payment.
 *
 * ⚠️ **Irreversible.** Every place named at BEGIN is burned in the commit
 * that releases the signature. A card lifted while it signs has burned
 * nothing; a card lifted after the commit and before the answer has burned
 * every place and the answer is lost — `spendAllAgain` gives it again. While
 * the payment is over the card's limit on one payment the card answers
 * "not yet" (`00 01`) and is asked again: its wait is its own work.
 */
export async function spendAllSign(transceive: Transceiver): Promise<number[]> {
  for (let waits = 0; waits <= MAX_SIGN_WAITS; waits++) {
    const body = await send(transceive, INS.SPEND_ALL_SIGN, {
      le: 0x40,
      context: 'SPEND_ALL_SIGN',
    });
    if (
      body.length === NOT_YET.length &&
      body[0] === NOT_YET[0] &&
      body[1] === NOT_YET[1]
    ) {
      continue;
    }
    return assertSignature(body, 'SPEND_ALL_SIGN');
  }
  throw new CardProtocolError(
    `SPEND_ALL_SIGN: the card made the payment wait more than ${MAX_SIGN_WAITS} times`,
  );
}

/**
 * SPEND_ALL_AGAIN: the LAST signature SPEND_ALL_SIGN gave, again — for an
 * answer lost on the air. It is good only for the payment it was made for:
 * the caller verifies it against that payment's message before using it.
 * Needs the PIN where one is set, unless that signature was given with none.
 */
export async function spendAllAgain(
  transceive: Transceiver,
): Promise<number[]> {
  return assertSignature(
    await send(transceive, INS.SPEND_ALL_AGAIN, {
      le: 0x40,
      context: 'SPEND_ALL_AGAIN',
    }),
    'SPEND_ALL_AGAIN',
  );
}

// ── the card's own change ───────────────────────────────────────────────────

/**
 * The opening of a change output the card made for itself and has not yet
 * been handed back: with the mint's blind signature, it is the piece.
 */
export interface ChangeOpening {
  amount: number;
  /** The card's 8 bytes of the payment's keyset, hex. */
  keysetId: string;
  /** The payment's date (locktime), seconds; 0 for none. */
  date: number;
  nonce: string;
  /** The blinding factor, 32 bytes hex. */
  r: string;
}

export function parseChangePage(body: number[]): ChangeOpening[] {
  if (body.length < 1) {
    throw new CardProtocolError('GET_CHANGE: empty answer');
  }
  const count = body[0];
  if (count > OPENINGS_PER_PAGE || body.length !== 1 + count * OPENING_SIZE) {
    throw new CardProtocolError(
      `GET_CHANGE: ${count} openings in ${body.length} bytes`,
    );
  }
  const out: ChangeOpening[] = [];
  for (let i = 0; i < count; i++) {
    const at = 1 + i * OPENING_SIZE;
    out.push({
      amount: readU32(body, at),
      keysetId: toHex(body.slice(at + 4, at + 12)),
      date: readU32(body, at + 12),
      nonce: toHex(body.slice(at + 16, at + 48)),
      r: toHex(body.slice(at + 48, at + 80)),
    });
  }
  return out;
}

/**
 * GET_CHANGE, every page: the openings of change the card has signed for
 * and that are not yet back on it. An opening whose piece is already on the
 * card is let go by the card before it answers. No PIN.
 */
export async function getChange(
  transceive: Transceiver,
): Promise<ChangeOpening[]> {
  const out: ChangeOpening[] = [];
  for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
    const openings = parseChangePage(
      await send(transceive, INS.GET_CHANGE, {
        p1: page,
        le: 0x00,
        context: `GET_CHANGE page ${page}`,
      }),
    );
    out.push(...openings);
    if (openings.length < OPENINGS_PER_PAGE) {
      break;
    }
  }
  return out;
}

// ── loading ─────────────────────────────────────────────────────────────────

/** A piece as LOAD_PROOF writes it. */
export interface LoadablePiece {
  /** 16 hex chars (8 bytes), or a 66-char v2 id the card stores the first 8 of. */
  keysetId: string;
  amount: number;
  nonce: string;
  C: string;
  /** Locktime, seconds; 0 (the default) for none. */
  date?: number;
}

/**
 * LOAD_PROOF: store a piece in the next free slot. With `dleq` (P1 = 1) the
 * mint's NUT-12 proof (e, s, r) goes on beside it, so any later reader can
 * check the piece offline (`GET_DLEQ`).
 *
 * Needs a PIN verified in this tap, the owner's grant, the tap after a
 * payment (the change grant), or a card with no PIN (`6982` otherwise).
 * `6A94` means the piece is already on the card: the caller treats that as
 * landed, never as a failure. `6A84`: no free slot.
 */
export async function loadProof(
  transceive: Transceiver,
  proof: LoadablePiece,
  dleq?: CardDleq,
): Promise<number> {
  const keysetBytes = cardKeysetBytes(proof.keysetId);
  checkU32(proof.amount, 'LOAD_PROOF amount');
  const date = proof.date ?? 0;
  checkU32(date, 'LOAD_PROOF date');
  const nonceBytes = fromHex(proof.nonce, 'nonce');
  const cBytes = fromHex(proof.C, 'C');
  if (nonceBytes.length !== 32 || cBytes.length !== 33) {
    throw new CardProtocolError(
      `LOAD_PROOF: expected 32-byte nonce and 33-byte C, got ${nonceBytes.length}/${cBytes.length}`,
    );
  }
  const data = [
    ...keysetBytes,
    ...u32(proof.amount),
    ...nonceBytes,
    ...cBytes,
    ...u32(date),
  ];
  if (dleq) {
    const proofBytes = [
      ...fromHex(dleq.e, 'dleq.e'),
      ...fromHex(dleq.s, 'dleq.s'),
      ...fromHex(dleq.r, 'dleq.r'),
    ];
    if (proofBytes.length !== DLEQ_SIZE) {
      throw new CardProtocolError(
        `LOAD_PROOF: the mint's proof is ${DLEQ_SIZE} bytes, got ${proofBytes.length}`,
      );
    }
    data.push(...proofBytes);
  }
  const body = await send(transceive, INS.LOAD_PROOF, {
    p1: dleq ? 0x01 : 0x00,
    data,
    le: dleq ? 0x02 : 0x01,
    context: 'LOAD_PROOF',
  });
  if (body.length !== (dleq ? 2 : 1)) {
    throw new CardProtocolError(
      `LOAD_PROOF: expected ${dleq ? 2 : 1} bytes, got ${body.length}`,
    );
  }
  return body[0];
}

/** True for LOAD_PROOF's `6A94`: the piece is already on the card. */
export function isAlreadyOnCard(error: unknown): boolean {
  return (
    error instanceof CardError &&
    error.sw === SW_ALREADY_OR_PIN &&
    error.context.startsWith('LOAD_PROOF')
  );
}

// ── the read-only summary ───────────────────────────────────────────────────

export interface CardSummary {
  appletVersion: string;
  info: CardInfo;
  pubkey: string;
  balance: number;
}

/**
 * The read-only round-trip: SELECT → GET_INFO → GET_PUBKEY → AUTH →
 * GET_BALANCE.
 *
 * Touches nothing on the card. AUTH makes the read honest: the balance shown
 * is the balance of the card that proved it holds the key, and a signature
 * that does not verify fails the read (`CardAuthError`). A charge runs AUTH
 * too, in its second tap before the PIN or anything else goes to the card
 * (`executeCharge` in `cashuCharge.ts`): the SIG_ALL signature proves the
 * key as well, but only after the card has burned.
 */
export async function readCard(transceive: Transceiver): Promise<CardSummary> {
  const version = await selectApplet(transceive);
  const info = await getInfo(transceive);
  const pubkey = await getPubkey(transceive);
  await auth(transceive, pubkey);
  const balance = await getBalance(transceive);
  return {
    appletVersion:
      version.length >= 2 ? `${version[0]}.${version[1]}` : info.version,
    info,
    pubkey: toHex(pubkey),
    balance,
  };
}
