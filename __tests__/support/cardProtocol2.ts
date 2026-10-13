/* eslint-disable no-bitwise -- an APDU-level card model: bytes are the work. */
/**
 * Test models of the two things a 2.0 charge talks to, with real crypto:
 *
 *  - `FakeCard2`: the cashu-javacard 2.0 applet at the APDU level
 *    (spec/APDU.md) — SELECT by the 2.0 AID (and a 0.x card that answers only
 *    the old one), GET_INFO, GET_CARD, GET_PIECES, GET_DLEQ, AUTH, the
 *    SPEND_ALL_* payment with a real BIP-340 signature over the NUT-11
 *    SIG_ALL message it builds ITSELF (its own secret text, independent of
 *    the terminal's), its own change (real blinded outputs, openings kept,
 *    GET_CHANGE), LOAD_PROOF with the change grant and `6A94` for a piece it
 *    holds, VERIFY_PIN, the no-PIN allowance and the daily limit. Faults are
 *    injected per instruction.
 *  - `TestMint`: a mint with deterministic keys that signs blinded messages
 *    with NUT-12 DLEQ proofs, mints format-4 pieces to a card, and checks a
 *    swap the way a mint does — every input's C against its secret, the one
 *    SIG_ALL witness on the first input, unspent inputs, balanced amounts.
 *
 * Everything here uses the REAL cashu-ts (`jest.requireActual`), so a test
 * that mocks cashu-ts's Wallet can still build on this module.
 */
import type * as CashuTs from '@cashu/cashu-ts';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils';

const cashu = jest.requireActual<typeof CashuTs>('@cashu/cashu-ts');

export const MINT_URL = 'https://forge.flashapp.me';
/** Forge's shape: an 8-byte (pre-v2) keyset id, no input fee. */
export const KEYSET_ID = '0059534ce0bfa19a';
export const REFUND_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

const OK = [0x90, 0x00];
const ok = (data: number[] = []) => [...data, ...OK];
const sw = (code: number) => [(code >> 8) & 0xff, code & 0xff];
const u32 = (v: number) => [
  (v >>> 24) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 8) & 0xff,
  v & 0xff,
];
const readU32 = (b: number[], at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
export const hex = (b: number[] | Uint8Array) => bytesToHex(Uint8Array.from(b));
const bytes = (h: string) => Array.from(hexToBytes(h));
const N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

/** A deterministic 32-byte scalar from a label, under n. */
export function scalar(label: string): Uint8Array {
  let k = BigInt(`0x${bytesToHex(sha256(utf8ToBytes(label)))}`) % N;
  if (k === 0n) {
    k = 1n;
  }
  return hexToBytes(k.toString(16).padStart(64, '0'));
}

/** The 2.0 card secret, built HERE (independently of cashuMint's builder). */
export function cardSecretText(
  nonce: string,
  cardKey: string,
  date = 0,
  refund: string | null = null,
): string {
  const head = `["P2PK",{"nonce":"${nonce}","data":"${cardKey}","tags":[`;
  if (!date) {
    return `${head}["sigflag","SIG_ALL"]]}]`;
  }
  return `${head}["locktime","${date}"],["refund","${refund}"],["sigflag","SIG_ALL"]]}]`;
}

/** A piece as the card stores it, and as a test hands it to the card. */
export interface PieceSpec {
  keysetId?: string;
  amount: number;
  nonce: string;
  C: string;
  date?: number;
  dleq?: {e: string; s: string; r: string} | null;
}

// ── the mint ─────────────────────────────────────────────────────────────────

export interface SwapRequestLike {
  inputs: {
    id: string;
    amount: number;
    secret: string;
    C: string;
    witness?: string;
  }[];
  outputs: {amount: number; id: string; B_: string}[];
}

export class TestMint {
  readonly keysetId: string;
  readonly inputFeePpk: number;
  readonly active: boolean;
  private privs = new Map<number, Uint8Array>();
  readonly keys: Record<string, string> = {};
  /** Secrets the mint holds as spent. */
  readonly spent = new Set<string>();
  readonly swaps: SwapRequestLike[] = [];
  /** The next swap throws this instead (then clears), for offline/429/… */
  failNext: unknown = null;
  /** Every swap throws this while set. */
  failAll: unknown = null;

  constructor({
    keysetId = KEYSET_ID,
    inputFeePpk = 0,
    active = true,
    label = 'test-mint',
  }: {
    keysetId?: string;
    inputFeePpk?: number;
    active?: boolean;
    label?: string;
  } = {}) {
    this.keysetId = keysetId;
    this.inputFeePpk = inputFeePpk;
    this.active = active;
    for (let i = 0; i < 21; i++) {
      const amount = 2 ** i;
      const priv = scalar(`${label}:${keysetId}:${amount}`);
      this.privs.set(amount, priv);
      this.keys[String(amount)] = bytesToHex(cashu.getPubKeyFromPrivKey(priv));
    }
  }

  /** The keyset as cashuMint keeps it (`saveKeysets`). */
  cachedKeyset() {
    return {
      id: this.keysetId,
      unit: 'sat',
      active: this.active,
      inputFeePpk: this.inputFeePpk,
      keys: {...this.keys},
    };
  }

  /** The keyset as cashu-ts's KeyChain lists it. */
  keyChainKeyset() {
    return {
      id: this.keysetId,
      unit: 'sat',
      isActive: this.active,
      fee: this.inputFeePpk,
      hasKeys: true,
      keys: Object.fromEntries(
        Object.entries(this.keys).map(([a, k]) => [Number(a), k]),
      ),
    };
  }

  private priv(amount: number): Uint8Array {
    const priv = this.privs.get(amount);
    if (!priv) {
      throw new Error(`the test mint has no key for ${amount}`);
    }
    return priv;
  }

  /** The mint's blind signature on `B_` (hex), with its NUT-12 proof. */
  sign(B_: string, amount: number) {
    const point = cashu.pointFromHex(B_);
    const priv = this.priv(amount);
    const {C_} = cashu.createBlindSignature(point, priv, this.keysetId);
    const dleq = cashu.createDLEQProof(point, priv);
    return {
      id: this.keysetId,
      amount,
      C_: C_.toHex(true),
      dleq: {e: bytesToHex(dleq.e), s: bytesToHex(dleq.s)},
    };
  }

  /**
   * A format-4 piece minted to `cardKey`, as flash-mobile's top-up makes one:
   * the card's own secret, unblinded, with the mint's DLEQ (e, s, r).
   */
  mintPiece(
    cardKey: string,
    amount: number,
    {
      nonce,
      date = 0,
      refundKey = null,
      withDleq = true,
    }: {
      nonce: string;
      date?: number;
      refundKey?: string | null;
      withDleq?: boolean;
    },
  ): PieceSpec & {secret: string} {
    const secret = cardSecretText(nonce, cardKey, date, refundKey);
    const {B_, r} = cashu.blindMessage(utf8ToBytes(secret));
    const sig = this.sign(B_.toHex(true), amount);
    const C = cashu
      .unblindSignature(
        cashu.pointFromHex(sig.C_),
        r,
        cashu.pointFromHex(this.keys[String(amount)]),
      )
      .toHex(true);
    return {
      keysetId: this.keysetId.slice(0, 16),
      amount,
      nonce,
      C,
      date,
      secret,
      dleq: withDleq
        ? {e: sig.dleq.e, s: sig.dleq.s, r: r.toString(16).padStart(64, '0')}
        : null,
    };
  }

  /** Whether `C` is this mint's signature on `secret` (C == k·Y). */
  verifyProof(secret: string, C: string, amount: number): boolean {
    const Y = cashu.hashToCurve(utf8ToBytes(secret));
    const k = BigInt(`0x${bytesToHex(this.priv(amount))}`);
    return Y.multiply(k).toHex(true) === C.toLowerCase();
  }

  /**
   * A swap as a SIG_ALL-capable mint checks it: every input a proof of this
   * mint and unspent, every input's secret SIG_ALL with one key, the first
   * input's witness a signature by that key over the SIG_ALL message, and the
   * outputs worth the inputs less the fee. Marks the inputs spent; answers
   * the outputs' signatures in order.
   */
  swap(req: SwapRequestLike) {
    this.swaps.push(JSON.parse(JSON.stringify(req)));
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.failAll !== null) {
      throw this.failAll;
    }
    const reject = (code: number, detail: string) => {
      const error = new cashu.MintOperationError(code, detail);
      throw error;
    };
    let key: string | null = null;
    for (const input of req.inputs) {
      if (!this.verifyProof(input.secret, input.C, Number(input.amount))) {
        reject(10003, 'proofs could not be verified');
      }
      if (this.spent.has(input.secret)) {
        reject(11001, 'Token already spent.');
      }
      const [kind, data] = JSON.parse(input.secret) as [
        string,
        {data: string; tags: string[][]},
      ];
      const flag = data.tags.find(t => t[0] === 'sigflag')?.[1];
      if (kind !== 'P2PK' || flag !== 'SIG_ALL') {
        reject(10003, 'not a SIG_ALL input');
      }
      if (key !== null && key !== data.data) {
        reject(10003, 'SIG_ALL inputs name different keys');
      }
      key = data.data;
    }
    const witness = req.inputs[0]?.witness;
    if (!witness || key === null) {
      reject(20008, 'no witness');
    }
    const signature = (JSON.parse(witness!) as {signatures: string[]})
      .signatures[0];
    let text = '';
    for (const i of req.inputs) {
      text += i.secret + i.C;
    }
    for (const o of req.outputs) {
      text += String(o.amount) + o.B_;
    }
    if (
      !cashu.schnorrVerifyDigest(signature, sha256(utf8ToBytes(text)), key!)
    ) {
      reject(20008, 'witness signatures not provided or invalid');
    }
    const fee = Math.ceil((this.inputFeePpk * req.inputs.length) / 1000);
    const inSum = req.inputs.reduce((t, i) => t + Number(i.amount), 0);
    const outSum = req.outputs.reduce((t, o) => t + Number(o.amount), 0);
    if (inSum !== outSum + fee) {
      reject(11002, `inputs ${inSum} != outputs ${outSum} + fee ${fee}`);
    }
    for (const input of req.inputs) {
      this.spent.add(input.secret);
    }
    return {
      signatures: req.outputs.map(o => this.sign(o.B_, Number(o.amount))),
    };
  }
}

/**
 * The shared mint every test in a file talks to (a mocked cashu-ts Wallet
 * reaches it through `globalThis`, since a jest.mock factory may not close
 * over module state).
 */
export function testMint(): TestMint {
  const g = globalThis as {__testMint?: TestMint};
  if (!g.__testMint) {
    g.__testMint = new TestMint();
  }
  return g.__testMint;
}

/** Replace the shared mint (a fresh one per test). */
export function resetTestMint(
  options?: ConstructorParameters<typeof TestMint>[0],
) {
  (globalThis as {__testMint?: TestMint}).__testMint = new TestMint(options);
  return testMint();
}

/** A cashu-ts Wallet double backed by the shared mint, for `jest.mock`. */
export class MockWallet {
  constructor(readonly mintUrl: string) {}
  loadMint = async () => {
    const g = globalThis as {__mintOffline?: unknown};
    if (g.__mintOffline) {
      throw g.__mintOffline;
    }
  };
  mint = {
    swap: async (req: SwapRequestLike) => testMint().swap(req),
  };
  keyChain = {
    getKeysets: () => [testMint().keyChainKeyset()],
    ensureKeysetKeys: async () => testMint().keyChainKeyset(),
  };
}

/** Make the mock wallet's `loadMint` fail (offline), or clear it with null. */
export function setMintOffline(error: unknown) {
  (globalThis as {__mintOffline?: unknown}).__mintOffline = error;
}

// ── the card ─────────────────────────────────────────────────────────────────

const PACKAGE_AID = [
  0xf0, 0x43, 0x41, 0x53, 0x48, 0x55, 0x43, 0x41, 0x52, 0x44,
];
const LEGACY_AID = [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02];
const FOXY_AID = [0xf0, 0x46, 0x4f, 0x58, 0x59, 0x43, 0x41, 0x52, 0x44];

interface Slot extends Required<Omit<PieceSpec, 'dleq'>> {
  status: 1 | 2;
  dleq: {e: string; s: string; r: string} | null;
}

interface Opening {
  amount: number;
  keysetId: string;
  date: number;
  nonce: string;
  r: string;
  state: 'draft' | 'pending';
}

export interface FakeCardOptions {
  /** Pieces in slots 0…n-1. */
  pieces?: PieceSpec[];
  /** Indexes into `pieces` that are spent on the card. */
  spentSlots?: number[];
  /** The slots the card reports (128 on a real card; fewer makes a full card cheap). */
  slotCount?: number;
  pin?: string;
  pinBlocked?: boolean;
  /** The no-PIN allowance, and what it has counted. */
  allowance?: number;
  noPinSpent?: number;
  dailyLimit?: number;
  spentToday?: number;
  now?: number;
  windowStart?: number;
  rolls?: number;
  rollBudget?: number;
  refundKey?: string | null;
  mint?: string;
  /** The card's private key; the default is the deterministic test key. */
  privateKey?: string;
  /** A 0.x card: refuses the 2.0 AID, answers the 0.x one. */
  legacy?: boolean;
  /** A Foxy 1.x card: refuses the 2.0 AID, answers F0 46 4F 58 59 43 41 52 44. */
  foxy?: boolean;
  /** The 2.0 AID's SELECT answers this status word (jCardSim's 6E00 / 6999 for an old card). */
  selectSw?: number;
  /** The 2.0 AID's SELECT answers 9000 with this body instead of the version. */
  selectBody?: number[];
  /** The owner has locked the card (LOCK_CARD): GET_INFO byte 10. */
  locked?: boolean;
  /** The piece format GET_INFO (byte 8) and GET_CARD (byte 0) report; 4 by default. */
  format?: number;
  /** GET_CARD's unit byte; 0 (sat) by default. */
  unit?: number;
  /** GET_PIECES P2 = 2 answers this slot as something else (a card whose listing lies). */
  namedOverride?: (slot: number) => number[] | undefined;
  /** Not an eCash card: refuses every AID. */
  notCashu?: boolean;
  /** The SELECT version (default 2.0). */
  version?: [number, number];
  /** GET_INFO's major (default the SELECT one). */
  infoMajor?: number;
  /** "Not yet" answers SPEND_ALL_SIGN gives before signing. */
  signWaits?: number;
  /** AUTH answers with a signature by another key. */
  forgeAuth?: boolean;
  /** SPEND_ALL_SIGN signs something else (a broken card). */
  badSignature?: boolean;
  /** Free change openings (8 on a real card). */
  openings?: number;
  /** Every LOAD_PROOF refuses with this SW (e.g. 0x6a84) for the n-th load. */
  refuseLoad?: (n: number) => number | undefined;
  /** The n-th LOAD lands, and its answer is lost. */
  loseLoadAnswer?: (n: number) => boolean;
  /** The n-th SIGN commits, and its answer is lost. */
  loseSignAnswer?: (n: number) => boolean;
  /** The n-th SIGN fails on the air BEFORE the card commits (nothing burned). */
  dropBeforeSign?: (n: number) => boolean;
  /** Any APDU whose instruction this answers true fails on the air, unsent. */
  failBefore?: (ins: number, n: number) => boolean;
  /** A balance read (GET_BALANCE) fails on the air once a payment is signed. */
  loseTagOnBalanceAfterSign?: boolean;
  /** The n-th AGAIN fails on the air. */
  loseAgain?: (n: number) => boolean;
}

export const TEST_CARD_PRIVATE =
  '1111111111111111111111111111111111111111111111111111111111111111';

export class FakeCard2 {
  readonly sent: number[][] = [];
  readonly loads: {
    keysetId: string;
    amount: number;
    nonce: string;
    C: string;
    date: number;
    dleq: boolean;
  }[] = [];
  readonly priv: string;
  readonly pubkey: string;
  slots: (Slot | null)[];
  openings: Opening[] = [];
  pin: string | undefined;
  pinState: 0 | 1 | 2;
  tries = 3;
  pinVerified = false;
  changeDue = false;
  changeGrant = false;
  lastSig: {sig: string; noPin: boolean} | null = null;
  payment: {
    slots: number[];
    sum: number;
    change: number;
    text: string;
    outputs: number;
    changeOutputs: number;
    waits: number | null;
  } | null = null;
  signCount = 0;
  loadCount = 0;
  againCount = 0;
  tapTime = 0;
  now: number;
  spentToday: number;
  noPinSpent: number;
  headers: number[][] = [];
  private changeCounter = 0;
  private counts = new Map<number, number>();

  constructor(readonly opts: FakeCardOptions = {}) {
    this.priv = opts.privateKey ?? TEST_CARD_PRIVATE;
    this.pubkey = bytesToHex(cashu.getPubKeyFromPrivKey(hexToBytes(this.priv)));
    const count = opts.slotCount ?? 128;
    this.slots = Array.from({length: count}, (_, i) => {
      const p = opts.pieces?.[i];
      if (!p) {
        return null;
      }
      return {
        keysetId: (p.keysetId ?? KEYSET_ID).slice(0, 16),
        amount: p.amount,
        nonce: p.nonce,
        C: p.C,
        date: p.date ?? 0,
        dleq: p.dleq ?? null,
        status: opts.spentSlots?.includes(i) ? 2 : 1,
      };
    });
    this.pin = opts.pin;
    this.pinState = opts.pin === undefined ? 0 : opts.pinBlocked ? 2 : 1;
    this.now = opts.now ?? 0;
    this.spentToday = opts.spentToday ?? 0;
    this.noPinSpent = opts.noPinSpent ?? 0;
  }

  /**
   * Put an opening on the card as a signed-for payment's change leaves it
   * (pending): the change of an EARLIER charge, still owed. Answers the
   * blinded message the card made for it.
   */
  addPendingChange({
    amount,
    nonce,
    r,
    keysetId = KEYSET_ID,
    date = 0,
  }: {
    amount: number;
    nonce: string;
    r: string;
    keysetId?: string;
    date?: number;
  }): string {
    const secret = cardSecretText(
      nonce,
      this.pubkey,
      date,
      this.opts.refundKey ?? null,
    );
    this.openings.push({
      amount,
      keysetId: keysetId.slice(0, 16),
      date,
      nonce,
      r,
      state: 'pending',
    });
    this.changeDue = true;
    return cashu
      .blindMessage(utf8ToBytes(secret), BigInt(`0x${r}`))
      .B_.toHex(true);
  }

  /** What the card holds, unspent, in sats. */
  get balance(): number {
    return this.slots.reduce(
      (t, s) => t + (s && s.status === 1 ? s.amount : 0),
      0,
    );
  }

  get burnCount(): number {
    return this.slots.filter(s => s?.status === 2).length;
  }

  /** The instruction bytes sent, in order. */
  get insSent(): number[] {
    return this.sent.map(a => a[1]);
  }

  private nth(ins: number): number {
    const n = this.counts.get(ins) ?? 0;
    this.counts.set(ins, n + 1);
    return n;
  }

  private dropPayment() {
    this.payment = null;
    this.openings = this.openings.filter(o => o.state !== 'draft');
  }

  private secretOf(slot: Slot): string {
    return cardSecretText(
      slot.nonce,
      this.pubkey,
      slot.date,
      this.opts.refundKey ?? null,
    );
  }

  transceive = async (apdu: number[]): Promise<number[]> => {
    this.sent.push(apdu);
    const [cla, ins, p1, p2] = apdu;
    const n = this.nth(ins);
    if (this.opts.failBefore?.(ins, n)) {
      throw new Error('Tag was lost.');
    }
    if (cla === 0x00 && ins === 0xa4) {
      return this.select(apdu.slice(5, 5 + apdu[4]));
    }
    // Any command but the payment's own gives a begun payment up.
    if (this.payment && ![0x23, 0x24, 0x26].includes(ins)) {
      this.dropPayment();
    }
    const data = apdu.length > 5 ? apdu.slice(5, 5 + apdu[4]) : [];
    switch (ins) {
      case 0x01:
        return this.getInfo(p1);
      case 0x10:
        return ok(bytes(this.pubkey));
      case 0x11:
        if (this.opts.loseTagOnBalanceAfterSign && this.signCount > 0) {
          throw new Error('Tag was lost.');
        }
        return ok(u32(this.balance));
      case 0x13: {
        const s = this.slots[p1];
        if (p1 >= 128) {
          return sw(0x6a83);
        }
        if (!s) {
          return sw(0x6a88);
        }
        return ok([s.status, ...this.pieceBytes(s)]);
      }
      case 0x14:
        return ok(
          Array.from({length: 128}, (_, i) => this.slots[i]?.status ?? 0),
        );
      case 0x15:
        return this.auth(data);
      case 0x16:
        return this.getCard();
      case 0x17:
        return this.getPieces(p1, p2, data);
      case 0x19:
        return this.getChange(p1);
      case 0x1a:
        return this.getDleq(p1, p2);
      case 0x22:
        return this.begin(data);
      case 0x23:
        return this.outputs(data);
      case 0x24:
        return this.sign();
      case 0x25:
        return this.again();
      case 0x26:
        return this.change(data);
      case 0x30:
        return this.load(p1, data);
      case 0x36:
        if (data.length !== 80) {
          return sw(0x6700);
        }
        this.headers.push(data);
        {
          const t =
            (data[68] |
              (data[69] << 8) |
              (data[70] << 16) |
              (data[71] << 24)) >>>
            0;
          if (t > this.now) {
            this.now = t;
          }
        }
        return ok(u32(this.now));
      case 0x37:
        if (data.length !== 4) {
          return sw(0x6700);
        }
        this.tapTime = readU32(data, 0);
        return ok();
      case 0x40:
        return this.verifyPin(data);
      default:
        return sw(0x6d00);
    }
  };

  private select(aid: number[]): number[] {
    const is = (a: number[]) =>
      aid.length >= a.length && a.every((b, i) => aid[i] === b);
    if (is(PACKAGE_AID)) {
      if (this.opts.legacy || this.opts.foxy || this.opts.notCashu) {
        return sw(0x6a82);
      }
      if (this.opts.selectSw !== undefined) {
        return sw(this.opts.selectSw);
      }
      this.pinVerified = false;
      this.dropPayment();
      this.changeGrant = this.changeDue;
      return ok(this.opts.selectBody ?? this.opts.version ?? [2, 0]);
    }
    if (is(LEGACY_AID)) {
      return this.opts.legacy ? ok([0, 2]) : sw(0x6a82);
    }
    if (is(FOXY_AID)) {
      return this.opts.foxy ? ok([1, 20]) : sw(0x6a82);
    }
    return sw(0x6a82);
  }

  private pieceBytes(s: Slot): number[] {
    return [
      ...bytes(s.keysetId),
      ...u32(s.amount),
      ...bytes(s.nonce),
      ...bytes(s.C),
      ...u32(s.date),
    ];
  }

  private getInfo(p1: number): number[] {
    const unspent = this.slots.filter(s => s?.status === 1).length;
    const spent = this.slots.filter(s => s?.status === 2).length;
    const empty = this.slots.length - unspent - spent;
    const body = [
      this.opts.infoMajor ?? (this.opts.version ?? [2, 0])[0],
      (this.opts.version ?? [2, 0])[1],
      this.slots.length,
      unspent,
      spent,
      empty,
      0xff,
      this.pinState,
      this.opts.format ?? 0x04,
      this.tries,
      this.opts.locked ? 1 : 0,
      1,
      ...u32(this.opts.dailyLimit ?? 0),
      1,
      ...u32(this.now),
      ...u32(this.opts.windowStart ?? 0),
      ...u32(this.spentToday),
      this.changeGrant ? 1 : 0,
    ];
    if (p1 >= 1) {
      body.push(
        ...u32(0),
        ...u32(this.opts.allowance ?? 0),
        ...u32(this.noPinSpent),
      );
    }
    return ok(body);
  }

  private getCard(): number[] {
    const mint = Array.from(utf8ToBytes(this.opts.mint ?? MINT_URL));
    const refund = this.opts.refundKey
      ? bytes(this.opts.refundKey)
      : new Array(33).fill(0);
    return ok([
      this.opts.format ?? 0x04,
      1,
      this.opts.unit ?? 0,
      ...u32(this.opts.dailyLimit ?? 0),
      ...refund,
      0,
      0,
      0,
      0,
      ...new Array(32).fill(0),
      this.opts.rolls ?? 0,
      this.opts.rollBudget ?? 0,
      0,
      ...new Array(26).fill(0),
      mint.length,
      ...mint,
      0,
      0,
      0,
    ]);
  }

  private getPieces(from: number, form: number, data: number[]): number[] {
    if (form === 2) {
      return this.getNamed(data);
    }
    if (from >= 128) {
      return sw(0x6a83);
    }
    if (form === 3) {
      return this.getShort(from);
    }
    if (form !== 0) {
      return sw(0x6a86);
    }
    const out: number[] = [];
    let length = 1;
    let next = from;
    while (next < 128) {
      const s = next < this.slots.length ? this.slots[next] : null;
      const cost = !s ? 0 : s.status === 1 ? 82 : 1;
      if (length + cost > 255) {
        break;
      }
      length += cost;
      if (s) {
        out.push(s.status === 2 ? next | 0x80 : next);
        if (s.status === 1) {
          out.push(...this.pieceBytes(s));
        }
      }
      next++;
    }
    return ok([next, ...out]);
  }

  /**
   * GET_PIECES P2 = 3, as the applet's `processGetShort` gives it: `next`,
   * then each unspent place's number (0x80 where its keyset and date
   * follow), then its power of two, or FF and its amount.
   */
  private getShort(from: number): number[] {
    const out: number[] = [];
    let at = 1;
    let next = from;
    let prev: Slot | null = null;
    while (next < 128) {
      const s = next < this.slots.length ? this.slots[next] : null;
      if (s && s.status === 1) {
        const named =
          !prev || prev.keysetId !== s.keysetId || prev.date !== s.date;
        const power =
          s.amount > 0 && (s.amount & (s.amount - 1)) === 0
            ? Math.log2(s.amount)
            : -1;
        const cost = 2 + (named ? 12 : 0) + (power < 0 ? 4 : 0);
        if (at + cost > 255) {
          break;
        }
        out.push(named ? next | 0x80 : next);
        if (named) {
          out.push(...bytes(s.keysetId), ...u32(s.date));
        }
        out.push(...(power < 0 ? [0xff, ...u32(s.amount)] : [power]));
        at += cost;
        prev = s;
      }
      next++;
    }
    return ok([next, ...out]);
  }

  /** GET_PIECES P2 = 2: one to three places whole, in the order asked. */
  private getNamed(data: number[]): number[] {
    if (data.length < 1 || data.length > 3) {
      return sw(0x6700);
    }
    if (data.some(x => x >= 128)) {
      return sw(0x6a83);
    }
    return ok(
      data.flatMap(x => {
        const override = this.opts.namedOverride?.(x);
        if (override) {
          return override;
        }
        const s = x < this.slots.length ? this.slots[x] : null;
        return s ? [s.status, ...this.pieceBytes(s)] : new Array(82).fill(0);
      }),
    );
  }

  private onCard(nonce: string): boolean {
    return this.slots.some(s => s && s.nonce === nonce);
  }

  private getChange(page: number): number[] {
    this.openings = this.openings.filter(
      o => o.state !== 'pending' || !this.onCard(o.nonce),
    );
    const pending = this.openings
      .filter(o => o.state === 'pending')
      .slice(page * 3, page * 3 + 3);
    return ok([
      pending.length,
      ...pending.flatMap(o => [
        ...u32(o.amount),
        ...bytes(o.keysetId),
        ...u32(o.date),
        ...bytes(o.nonce),
        ...bytes(o.r),
      ]),
    ]);
  }

  private getDleq(a: number, b: number): number[] {
    const asked = b === 0xff ? [a] : [a, b];
    if (asked.some(x => x >= 128)) {
      return sw(0x6a83);
    }
    return ok(
      asked.flatMap(x => {
        const s = this.slots[x];
        if (!s || s.status !== 1 || !s.dleq) {
          return [0];
        }
        return [1, ...bytes(s.dleq.e), ...bytes(s.dleq.s), ...bytes(s.dleq.r)];
      }),
    );
  }

  private auth(reader: number[]): number[] {
    if (reader.length !== 16) {
      return sw(0x6700);
    }
    const card = Array.from({length: 16}, (_, i) => (0x30 + i) & 0xff);
    const tag = sha256(utf8ToBytes('CashuCard/auth'));
    const msg = sha256(
      Uint8Array.from([
        ...tag,
        ...tag,
        ...reader,
        ...card,
        ...bytes(this.pubkey),
      ]),
    );
    const key = this.opts.forgeAuth ? '22'.repeat(32) : this.priv;
    return ok([...card, ...bytes(cashu.schnorrSignDigest(msg, key))]);
  }

  private begin(data: number[]): number[] {
    if (data.length < 1) {
      return sw(0x6700);
    }
    const seen = new Set<number>();
    let sum = 0;
    let date: number | null = null;
    for (const slot of data) {
      if (slot >= 128) {
        return sw(0x6a83);
      }
      const s = this.slots[slot];
      if (!s) {
        return sw(0x6a88);
      }
      if (s.status === 2) {
        return sw(0x6985);
      }
      if (seen.has(slot)) {
        return sw(0x6a80);
      }
      if (date !== null && s.date !== date) {
        return sw(0x6a80);
      }
      date = s.date;
      seen.add(slot);
      sum += s.amount;
    }
    let text = '';
    for (const slot of data) {
      const s = this.slots[slot]!;
      text += this.secretOf(s) + s.C;
    }
    this.payment = {
      slots: [...data],
      sum,
      change: 0,
      text,
      outputs: 0,
      changeOutputs: 0,
      waits: null,
    };
    return ok(u32(sum));
  }

  private outputs(data: number[]): number[] {
    if (!this.payment) {
      return sw(0x6985);
    }
    if (this.payment.changeOutputs > 0) {
      this.dropPayment();
      return sw(0x6985);
    }
    if (data.length < 37 || data.length % 37 !== 0) {
      this.dropPayment();
      return sw(0x6700);
    }
    for (let at = 0; at < data.length; at += 37) {
      this.payment.text +=
        String(readU32(data, at)) + hex(data.slice(at + 4, at + 37));
      this.payment.outputs += 1;
    }
    return ok();
  }

  private change(data: number[]): number[] {
    if (!this.payment) {
      return sw(0x6985);
    }
    if (data.length !== 4) {
      this.dropPayment();
      return sw(0x6700);
    }
    const amount = readU32(data, 0);
    if (amount === 0 || this.payment.change + amount > this.payment.sum) {
      this.dropPayment();
      return sw(0x6a80);
    }
    if (this.openings.length >= (this.opts.openings ?? 8)) {
      this.dropPayment();
      return sw(0x6a84);
    }
    const first = this.slots[this.payment.slots[0]]!;
    const n = (this.changeCounter += 1);
    const nonce = bytesToHex(
      sha256(utf8ToBytes(`change-nonce:${this.pubkey}:${n}`)),
    );
    const r = bytesToHex(scalar(`change-r:${nonce}`));
    const secret = cardSecretText(
      nonce,
      this.pubkey,
      first.date,
      this.opts.refundKey ?? null,
    );
    const B_ = cashu
      .blindMessage(utf8ToBytes(secret), BigInt(`0x${r}`))
      .B_.toHex(true);
    this.openings.push({
      amount,
      keysetId: first.keysetId,
      date: first.date,
      nonce,
      r,
      state: 'draft',
    });
    this.payment.change += amount;
    this.payment.changeOutputs += 1;
    this.payment.text += String(amount) + B_;
    return ok(bytes(B_));
  }

  private needsPin(): boolean {
    return this.pinState !== 0 && !this.pinVerified;
  }

  private sign(): number[] {
    const payment = this.payment;
    if (!payment) {
      return sw(0x6985);
    }
    const net = payment.sum - payment.change;
    const noPin = this.needsPin();
    if (noPin) {
      const allowance = this.opts.allowance ?? 0;
      if (
        this.pinState !== 1 ||
        allowance === 0 ||
        this.noPinSpent + net > allowance
      ) {
        this.dropPayment();
        return sw(0x6a94);
      }
    }
    const limit = this.opts.dailyLimit ?? 0;
    if (limit > 0) {
      const windowStart = this.opts.windowStart ?? 0;
      const rolled = this.now >= windowStart + 86400;
      const counted = rolled ? 0 : this.spentToday;
      if (counted + net > limit) {
        this.dropPayment();
        return sw(0x6a8f);
      }
    }
    if (payment.waits === null) {
      payment.waits = this.opts.signWaits ?? 0;
    }
    if (payment.waits > 0) {
      payment.waits -= 1;
      return ok([0x00, 0x01]);
    }
    const n = this.signCount;
    if (this.opts.dropBeforeSign?.(n)) {
      this.signCount += 1;
      this.dropPayment();
      throw new Error('Tag was lost.');
    }
    const digest = sha256(
      utf8ToBytes(
        this.opts.badSignature ? `${payment.text}tampered` : payment.text,
      ),
    );
    const sig = cashu.schnorrSignDigest(digest, this.priv);
    // The commit: burned, counted, the openings signed for, the signature kept.
    for (const slot of payment.slots) {
      this.slots[slot]!.status = 2;
    }
    this.openings = this.openings.map(o =>
      o.state === 'draft' ? {...o, state: 'pending'} : o,
    );
    this.spentToday += net;
    if (noPin) {
      this.noPinSpent += net;
    }
    this.changeDue = true;
    this.lastSig = {sig, noPin};
    this.payment = null;
    this.signCount += 1;
    if (this.opts.loseSignAnswer?.(n)) {
      throw new Error('Tag was lost.');
    }
    return ok(bytes(sig));
  }

  private again(): number[] {
    const n = this.againCount++;
    if (this.opts.loseAgain?.(n)) {
      throw new Error('Tag was lost.');
    }
    if (!this.lastSig) {
      return sw(0x6a88);
    }
    if (!this.lastSig.noPin && this.needsPin()) {
      return sw(0x6982);
    }
    return ok(bytes(this.lastSig.sig));
  }

  private load(p1: number, data: number[]): number[] {
    if (
      this.pinState !== 0 &&
      (this.pinState !== 1 || (!this.pinVerified && !this.changeGrant))
    ) {
      return sw(0x6982);
    }
    const withProof = p1 === 1;
    if (
      withProof ? data.length !== 177 : data.length % 81 !== 0 || !data.length
    ) {
      return sw(0x6700);
    }
    const n = this.loadCount++;
    const refused = this.opts.refuseLoad?.(n);
    if (refused !== undefined) {
      return sw(refused);
    }
    const nonce = hex(data.slice(12, 44));
    if (this.onCard(nonce)) {
      return sw(0x6a94);
    }
    const free = this.slots.findIndex(s => s === null);
    if (free === -1) {
      return sw(0x6a84);
    }
    const piece: Slot = {
      keysetId: hex(data.slice(0, 8)),
      amount: readU32(data, 8),
      nonce,
      C: hex(data.slice(44, 77)),
      date: readU32(data, 77),
      dleq: withProof
        ? {
            e: hex(data.slice(81, 113)),
            s: hex(data.slice(113, 145)),
            r: hex(data.slice(145, 177)),
          }
        : null,
      status: 1,
    };
    this.slots[free] = piece;
    this.loads.push({
      keysetId: piece.keysetId,
      amount: piece.amount,
      nonce: piece.nonce,
      C: piece.C,
      date: piece.date,
      dleq: withProof,
    });
    this.openings = this.openings.filter(o => o.nonce !== nonce);
    if (!this.pinVerified) {
      this.changeDue = false;
    }
    if (this.opts.loseLoadAnswer?.(n)) {
      throw new Error('Tag was lost.');
    }
    return ok(withProof ? [free, 1] : [free]);
  }

  private verifyPin(data: number[]): number[] {
    if (this.pinState === 0) {
      return sw(0x6984);
    }
    if (this.pinState === 2) {
      return sw(0x6983);
    }
    const given = String.fromCharCode(...data);
    if (given === this.pin) {
      this.pinVerified = true;
      this.tries = 3;
      return ok();
    }
    this.tries -= 1;
    if (this.tries === 0) {
      this.pinState = 2;
      return sw(0x6983);
    }
    return sw(0x63c0 | this.tries);
  }
}

/** A deterministic 32-byte nonce for test piece `i`. */
export const pieceNonce = (i: number) =>
  bytesToHex(sha256(utf8ToBytes(`piece-nonce:${i}`)));

/**
 * A card holding real pieces of `amounts` minted by `mint` (the shared one by
 * default), with the mint's DLEQ kept beside each.
 */
export function cardWithPieces(
  amounts: number[],
  opts: Omit<FakeCardOptions, 'pieces'> & {
    mint_?: TestMint;
    withDleq?: boolean;
    date?: number;
  } = {},
): FakeCard2 {
  const probe = new FakeCard2(opts);
  const m = opts.mint_ ?? testMint();
  const pieces = amounts.map((amount, i) =>
    m.mintPiece(probe.pubkey, amount, {
      nonce: pieceNonce(i),
      date: opts.date ?? 0,
      refundKey: opts.refundKey ?? null,
      withDleq: opts.withDleq ?? true,
    }),
  );
  return new FakeCard2({...opts, pieces});
}

/** The 80-byte header vectors (cashu-javacard spec/vectors/headers.json). */
export function headerVectors(): {
  height: number;
  hash: string;
  time: number;
  header: string;
}[] {
  return (
    require('../fixtures/card-protocol-2.0/headers.json') as {
      headers: {height: number; hash: string; time: number; header: string}[];
    }
  ).headers;
}
