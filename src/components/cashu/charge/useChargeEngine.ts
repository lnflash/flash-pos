import {useEffect, useMemo, useRef} from 'react';
import {Animated} from 'react-native';

import {
  FINALE_BADGE,
  FINALE_REST_SCALE,
  NOTE_H,
  PIN_SCALE,
  type ChargeLayout,
} from './geometry';
import {
  EASE,
  easeInverse,
  kf,
  loop,
  map,
  now,
  play,
  snapTo,
  toward,
  warmUp,
  type EaseName,
  type Key,
} from './motion';
import {DUR} from './tokens';
import {hideEdgeTint, showEdgeTint} from '../../../utils/edgeTint';
import {markChargeComplete} from '../../../utils/chargeHandoff';
import type {StageState} from './phaseToStation';

/**
 * The charge stage's animation engine.
 *
 * VALUES are created once per mount. The NODE GRAPH (every interpolation,
 * multiply and add the views bind to) is built once per [layout,
 * reduceMotion] for the maximal plan shape — a tap-flow plan that lands
 * mid-charge changes only static styles and native distance values, never a
 * node, so nothing re-attaches (RN 0.77 restores default values natively on
 * re-attach). The CONDUCTOR turns real phase events into gestures: one
 * native timing per gesture clock, presence retargets, and two native loops.
 */

export const POOL = 8;
/** A burn's note: falls 80–520 (INOUT), rests, swapped for the number at 600. */
export const NOTE_FALL = 80;
export const NOTE_LAND = 520;
export const NOTE_CUT = 600;
/** The split: A rolls its label in place (0–120), then both notes travel. */
export const SPLIT_ROLL = 120;
export const GHOST_A = {land: 540, cut: 600};
/** B's cut (and its one-frame step) must fall inside the split's clock. */
export const GHOST_B = {land: 576, cut: 636};
/**
 * The card's contactless arcs rest at this opacity and pulse 0.35–1 while
 * the reader waits; the card art scales its arcs so the rest reads as the
 * printed card's.
 */
export const ARC_REST = 0.7;
/** Half the cap height of a 20 sp chip number: where a falling note touches it. */
const GLYPH_HALF = 7;
/** The flood starts as a 60 dp disc hidden under the 64 dp resting badge. */
const FLOOD_FROM = 0.75;
/** The flood runs over the DUR.flood ms that end on the hand-off frame. */
const FLOOD_AT = DUR.handoff - DUR.flood;

/**
 * When (finale-clock ms) the flood's edge reaches the inset strips: the
 * status-bar strip ramps while the circle grows from touching the frame's
 * top edge to covering its top corners; the gesture-bar strip the same at
 * the bottom. Each strip turns green exactly as the flood reaches it —
 * never before the content beside it, never after.
 */
export function floodReach(L: ChargeLayout): {
  top: [number, number];
  bottom: [number, number];
} {
  const r0 = (FINALE_BADGE / 2) * FLOOD_FROM;
  const r1 = (FINALE_BADGE / 2) * L.finale.floodEnd;
  const when = (r: number) =>
    FLOOD_AT + DUR.flood * easeInverse('INOUT', (r - r0) / (r1 - r0));
  const half = Math.max(L.finale.cx, L.W - L.finale.cx);
  const above = L.finale.cy;
  const below = L.H - L.finale.cy;
  return {
    top: [when(above), when(Math.hypot(half, above))],
    bottom: [when(below), when(Math.hypot(half, below))],
  };
}
export const SEGMENTS = 5;
export const SLOTS = 3;
/** A ghost's label rolls a full line (18) plus 4: out of its 28 dp note. */
const LABEL_ROLL = 22;
/** The FROM odometer rolls a full number window (24). */
const ODO = 24;
/** Hold-pill widths (dp) before the variants are measured: W0, keep, stall. */
const HOLD_WIDTHS = [277, 204, 209];
/** The hold pill's two half-surfaces span this much when fully apart. */
export const HOLD_MAX_W = 360;

export type Num = Animated.Value | Animated.AnimatedInterpolation<number>;
type V = Animated.Value;
type CA = Animated.CompositeAnimation;

export type Mode = 'idle' | 'running' | 'complete' | 'error';
export type Pose = 'pin' | 'run';
export type SegName = 'card' | 'pin' | 'pay' | 'settle' | 'change';

export interface PlanShape {
  /** A CHANGE chip exists (changeSat > 0). */
  three: boolean;
  pinRequired: boolean;
  segments: SegName[];
  /** Sat value of each note that leaves the card, in burn order. */
  burns: number[];
  /** FROM CARD running total after each burn. */
  totals: number[];
  changeSat: number;
  /** Change slips, largest first. */
  pieces: number[];
  paidSat: number;
}

// ---------------------------------------------------------------------------
// Values

export interface Values {
  all: Array<readonly [V, number]>;
  ambient: V;
  sheen: V;
  // gesture clocks
  ledgerIn: V;
  /**
   * A plan that lands WITH the PIN pose: the ledger fades in on the dock
   * (opacity only) instead of its own staggered rise. Rests at 1.
   */
  ledgerReveal: V;
  lockOut: V;
  fromIn: V;
  notes: V[];
  split: V;
  paid: V;
  slips: V[];
  changeHome: V;
  settleHelp: V;
  F: V;
  X: V;
  pinErrClock: V;
  // presence
  sheenOn: V;
  arcsLive: V;
  holdW0: V;
  holdKeep: V;
  holdStall: V;
  /** Each hold-pill variant's natural width (dp), measured once at mount. */
  holdWidths: V[];
  idleHelper: V;
  /**
   * The masked id belongs to the running card: cut to 0 the moment the pose
   * turns to PIN, back to 1 when it turns to running (where the dock then
   * fades it in over the last third of the move).
   */
  idOn: V;
  lockIn: V;
  claims: V;
  errOn: V;
  pinErrOn: V;
  title: V[];
  pill: V[];
  fill: V[];
  active: V[];
  failed: V[];
  actIdle: V;
  actRun: V;
  actErr: V;
  dotsGreen: V;
  toRun: V;
  iosPose: V;
  // error veto arms: one per gesture whose claim may still be in flight
  armNote: V[];
  armFrom: V;
  armSplit: V;
  armPaid: V;
  armSlip: V[];
  /** The change left the chip but no later phase has confirmed the write. */
  armChange: V;
  // native distances, set per plan
  dxA: V;
  dxB: V;
  segHalf: V;
}

export interface InitialState {
  mode: Mode;
  pose: Pose;
  planKnown: boolean;
}

export function createValues(init: InitialState): Values {
  const all: Array<readonly [V, number]> = [];
  const v = (x = 0) => {
    const value = new Animated.Value(x);
    all.push([value, x] as const);
    return value;
  };
  const many = (n: number, x = 0) => Array.from({length: n}, () => v(x));
  const idle = init.mode === 'idle' && init.pose === 'run';
  const running = init.mode === 'running';
  return {
    all,
    ambient: v(),
    sheen: v(),
    ledgerIn: v(init.planKnown ? 1 : 0),
    ledgerReveal: v(1),
    lockOut: v(),
    fromIn: v(),
    notes: many(POOL),
    split: v(),
    paid: v(),
    slips: many(POOL),
    changeHome: v(),
    settleHelp: v(),
    F: v(),
    X: v(),
    pinErrClock: v(),
    sheenOn: v(),
    arcsLive: v(1),
    holdW0: v(running ? 1 : 0),
    holdKeep: v(),
    holdStall: v(),
    holdWidths: HOLD_WIDTHS.map(w => v(w)),
    idleHelper: v(idle ? 1 : 0),
    idOn: v(init.pose === 'pin' ? 0 : 1),
    lockIn: v(),
    claims: v(1),
    errOn: v(),
    pinErrOn: v(),
    title: many(SLOTS, 2),
    pill: many(SLOTS, 2),
    fill: many(SEGMENTS),
    active: many(SEGMENTS),
    failed: many(SEGMENTS),
    actIdle: v(idle ? 1 : 0),
    actRun: v(running ? 1 : 0),
    actErr: v(),
    dotsGreen: v(),
    toRun: v(init.pose === 'pin' ? 0 : 1),
    iosPose: v(),
    armNote: many(POOL),
    armFrom: v(),
    armSplit: v(),
    armPaid: v(),
    armSlip: many(POOL),
    armChange: v(),
    dxA: v(),
    dxB: v(),
    segHalf: v(),
  };
}

// ---------------------------------------------------------------------------
// Node graph

const mul = (a: Num, ...rest: Num[]): Num =>
  rest.reduce<Num>((acc, b) => Animated.multiply(acc, b), a);
/** 1 − x, clamped. */
const inv = (x: Num): Num => map(x, [0, 1], [1, 0]);
/**
 * A chip's rest layer ends on an EXACT 1: a product of fades can settle a
 * hair under it, and Android then draws the layer at alpha 254 — the PAID
 * fill read #017957 on the device instead of #007856. The last 2 % of a fade
 * is invisible; an off-brand green at rest is not.
 */
const solid = (x: Num): Num => map(x, [0, 0.98], [0, 1]);
const add = (a: Num, b: Num | number): Num => Animated.add(a, b as Num);
/**
 * A presence slot in [0,2]: 0 hidden below, 1 shown, 2 hidden above. A swap
 * is a FADE-THROUGH: the outgoing text is gone by 1.5 before the incoming one
 * shows from 0.5, and both ride the same eased timing — so two different
 * strings never overprint (device frames showed "Putting 4 sats…" ghosting
 * behind "Checking the card"). Each still travels its full 4 dp — except
 * under reduce motion, where `still` pins every rise to 0.
 */
export const slot = (p: Num, still: Num | null = null) => ({
  opacity: map(p, [0, 0.5, 1, 1.5, 2], [0, 0, 1, 0, 0]),
  translateY: still ?? map(p, [0, 1, 2], [4, 0, -4]),
});
/**
 * A swap between pre-mounted variants that must never overprint (the hold
 * pill's copy, the bottom actions): each variant shows only above 0.5, so
 * with the outgoing and incoming values riding the same timing the outgoing
 * one is gone before the incoming one appears.
 */
const through = (p: Num): Num => map(p, [0.5, 1], [0, 1]);
/**
 * A fixed value that is still a NATIVE node: a flat interpolation of a clock
 * that warmUp already moved to the native side. A bare `new Animated.Value`
 * bound straight to a view prop stays JS-only, and when the graph is rebuilt
 * (reduce motion toggled, a late layout) the native side restores that prop
 * to its DEFAULT on detach — opacity 1 — so a hidden layer (the flood, the
 * reduce-motion overlay) would pop up and stay. Field-found on the emulator
 * 2026-09-30: a green 80 dp circle on the card after Reduce, and a full-green
 * screen after Reduce was switched back off.
 */
const fixed =
  (clock: V) =>
  (x: number): Num =>
    clock.interpolate({
      inputRange: [0, 1],
      outputRange: [x, x],
      extrapolate: 'clamp',
    });

/** A note in flight between two chips, with its rolling label. */
export interface Ghost {
  translateX: Num;
  opacity: Num;
  from: Num;
  fromY: Num;
  to: Num;
  toY: Num;
}

export interface Nodes {
  card: {
    translateX: Num;
    translateY: Num;
    scale: Num;
    opacity: Num;
    arcs: Num[];
    sheenX: Num;
    sheenOpacity: Num;
    dim: Num;
    glow: Num;
    last4: Num;
  };
  ornaments: {translateX: Num; translateY: Num; opacity: Num};
  hold: {
    w0: Num;
    keep: Num;
    stall: Num;
    /**
     * ONE pill surface for every variant: two half-stadiums that slide
     * apart or together, so the pill morphs to the new copy's width and
     * never fades (no muddy grey over the card, never two pills).
     */
    surface: Num;
    shiftL: Num;
    shiftR: Num;
    widths: V[];
    dot: Num;
    ringScale: Num;
    ringOpacity: Num;
  };
  lock: {opacity: Num; scale: Num; open: Num};
  errBadge: {opacity: Num; scale: Num};
  readBadge: {opacity: Num};
  pinErrBadge: {opacity: Num};
  pool: {
    translateY: Num;
    notes: Array<{translateY: Num; opacity: Num}>;
    slips: Array<{translateY: Num; scale: Num; opacity: Num}>;
  };
  ledger: {
    translateY: Num;
    opacity: Num;
    chipIn: Array<{opacity: Num; translateY: Num}>;
    opIn: Array<{opacity: Num; translateY: Num}>;
    fromPending: Num;
    fromFilled: Num;
    odo: Array<{p: Num; pY: Num; n: Num; nY: Num}>;
    fromSpent: Num;
    /** The spent (grey) number, back once ghost A has slid clear. */
    fromSpentNum: Num;
    paidPending3: Num;
    paidPending2: Num;
    paidSettling: Num;
    paidTint: Num;
    paidPaid: Num;
    changePending: Num;
    changeSettling: Num;
    /** CHANGE's settling number: lifted off as the first slip leaves. */
    changeNum: Num;
    changeTint: Num;
    changeHome: Num;
    opLit3: Num[];
    opLit2: Num;
    ghostA: Ghost;
    ghostB: Ghost;
  };
  stepper: {
    opacity: Num;
    single: Num;
    singleActive: Num;
    singleFailed: Num;
    segmented: Num;
    segs: Array<{
      active: Num;
      fillScale: Num;
      fillX: Num;
      /** Reduce motion: the fill fades in place instead of wiping. */
      fillOpacity: Num;
      failed: Num;
    }>;
  };
  status: {
    opacity: Num;
    translateY: Num;
    titles: Array<{opacity: Num; translateY: Num}>;
    paid: {opacity: Num; translateY: Num};
    err: {opacity: Num; translateY: Num};
    pills: Array<{opacity: Num; translateY: Num}>;
    errPill: {opacity: Num; translateY: Num};
    idleHelper: Num;
    errBody: {opacity: Num; translateY: Num};
  };
  actions: {opacity: Num; idle: Num; run: Num; err: Num};
  sheet: {translateY: Num; opacity: Num; helper: Num; errHelper: Num};
  amount: {translateY: Num};
  flood: {opacity: Num; scale: Num};
  badge: {opacity: Num; translateY: Num; scale: Num};
  rm: {overlay: Num; badge: Num};
  dots: {green: Num};
}

export function buildNodes(v: Values, L: ChargeLayout, rm: boolean): Nodes {
  const F = DUR.finale;
  const X = DUR.error;
  const D = DUR.dock;
  const A = DUR.ambient;
  const constant = fixed(v.F);

  // --- global faders -------------------------------------------------------
  const fOut = kf(
    v.F,
    [
      {t: 0, v: 1},
      {t: 160, v: 0, ease: 'STD'},
    ],
    F,
  );
  const fHold = kf(
    v.F,
    [
      {t: 0, v: 1},
      {t: 120, v: 0, ease: 'STD'},
    ],
    F,
  );
  // The last running title lifts away (60-160) just ahead of the paid title
  // rising in (120-240): the two never overprint at full strength.
  const fTitle = kf(
    v.F,
    [
      {t: 60, v: 1},
      {t: 160, v: 0, ease: 'STD'},
    ],
    F,
  );
  const fTitleRise = rm
    ? constant(0)
    : kf(
        v.F,
        [
          {t: 60, v: 0},
          {t: 160, v: -4, ease: 'STD'},
        ],
        F,
      );
  const xRamp = (ms: number) =>
    kf(
      v.X,
      [
        {t: 0, v: 0},
        {t: ms, v: 1, ease: 'STD'},
      ],
      X,
    );
  /** Fades to 0 over `ms` once an error is on (errOn gates the X clock). */
  const xOut = (ms: number) => inv(mul(v.errOn, xRamp(ms)));
  const xIn = (keys: Key[]) => mul(v.errOn, kf(v.X, keys, X));
  const xOut160 = xOut(160);
  const xOut120 = xOut(120);
  const veto160 = xRamp(160);
  const veto200 = xRamp(200);
  const keep = (arm: V, veto: Num) => inv(mul(arm, veto));

  // --- ambient -------------------------------------------------------------
  // The active segment breathes under reduce motion too: it is opacity
  // only, and without it a reduce-motion charge sits perfectly still between
  // phases (2.3 s frozen frames in a slow settle).
  const breathe = kf(
    v.ambient,
    [
      {t: 0, v: 0.35},
      {t: A / 2, v: 0.7, ease: 'INOUT'},
      {t: A, v: 0.35, ease: 'INOUT'},
    ],
    A,
  );
  const tintBreathe = rm
    ? constant(0.6)
    : kf(
        v.ambient,
        [
          {t: 0, v: 0.25},
          {t: A / 2, v: 0.9, ease: 'INOUT'},
          {t: A, v: 0.25, ease: 'INOUT'},
        ],
        A,
      );
  const arcs = [0, 1, 2].map(k => {
    if (rm) {
      return constant(ARC_REST);
    }
    const s = 0.12 * k * A;
    const keys: Key[] = [{t: 0, v: 0.35}];
    if (s > 0) {
      keys.push({t: s, v: 0.35});
    }
    keys.push({t: s + 0.12 * A, v: 1, ease: 'OUT'});
    keys.push({t: (0.36 + 0.12 * k) * A, v: 0.35, ease: 'STD'});
    const pulse = kf(v.ambient, keys, A);
    return add(mul(v.arcsLive, add(pulse, -ARC_REST)), ARC_REST);
  });

  // --- dock (PIN ↔ running) -----------------------------------------------
  // toRun is linear; keys are written in PIN→running time t = toRun × 360.
  // Everything overlaps, nothing queues (a queue opened a 37 % empty band on
  // the re-entry): the sheet fades where it is (0–160, a 24 dp settle), the
  // card and ledger grow back as ONE group over the whole move (0–360), and
  // the running copy is in by 160. Cancel is drawn above the sheet and is on
  // the first running frame (ChargeStage). The reverse plays it backwards.
  const dock = (keys: Key[]) => kf(v.toRun, keys, D);
  const runVis = dock([
    {t: 0, v: 0},
    {t: 160, v: 1, ease: 'STD'},
  ]);
  // The idle and error buttons sit under the sheet: they show once it is
  // gone. (The running Cancel is above the sheet and ignores this.)
  const actVis = runVis;
  // What rides the full card — the masked id on its face, the hold pill on
  // its top edge — comes back only at the end of the move, once the card is
  // nearly full size (≥ 0.97 at 280, ≥ 0.9 at 240): never printed across
  // the small card's chip. The id's own presence (idOn) is cut the moment
  // the pose turns to PIN, so the reverse never flashes it either.
  const lateKeys = (from: number): Key[] => [
    {t: 0, v: 0},
    {t: from, v: 0},
    {t: 360, v: 1, ease: 'STD'},
  ];
  const idVis = mul(v.idOn, dock(lateKeys(240)));
  const holdDock = dock(lateKeys(280));
  const readVis = dock([
    {t: 0, v: 1},
    {t: 120, v: 0, ease: 'STD'},
  ]);
  /** Reduce motion: the pose changes while card and ledger are faded out. */
  const POSE_CUT = 180;
  const groupKeys = (from: number, to: number): Key[] =>
    rm
      ? [
          {t: 0, v: from},
          {t: POSE_CUT, v: from},
          {t: POSE_CUT, v: to},
        ]
      : [
          {t: 0, v: from},
          {t: 360, v: to, ease: 'INOUT'},
        ];
  const cardScale = dock(groupKeys(PIN_SCALE, 1));
  const cardDockY = dock(groupKeys(L.pin.cardDy, 0));
  const ledgerDockY = dock(groupKeys(L.pin.ledgerDy, 0));
  const rmDockFade = rm
    ? dock([
        {t: 0, v: 1},
        {t: 120, v: 0, ease: 'STD'},
        {t: 240, v: 0},
        {t: 360, v: 1, ease: 'STD'},
      ])
    : constant(1);
  const ledgerPinVis = L.pin.ledgerVisible ? constant(1) : runVis;
  // Real time 120–360 of the move into the PIN pose: the chips, operators
  // and (hidden) segments appear in place while the group docks.
  const ledgerReveal = kf(
    v.ledgerReveal,
    [
      {t: 120, v: 0},
      {t: 360, v: 1, ease: 'STD'},
    ],
    D,
  );
  // The sheet never slides the whole screen: it fades out where it is with
  // a 24 dp settle (reduce motion: the fade alone), and is parked off screen
  // once invisible so it can never catch a stray touch.
  const sheetY = dock(
    rm
      ? [
          {t: 0, v: 0},
          {t: 160, v: 0},
          {t: 160, v: L.pin.sheetH + 24},
        ]
      : [
          {t: 0, v: 0},
          {t: 160, v: 24, ease: 'STD'},
          {t: 160, v: L.pin.sheetH + 24},
        ],
  );
  const sheetOpacity = dock([
    {t: 0, v: 1},
    {t: 160, v: 0, ease: 'STD'},
  ]);

  // --- iOS session pose ------------------------------------------------------
  const iosY = map(v.iosPose, [0, 1], [0, -L.ios.lift]);

  // --- card -----------------------------------------------------------------
  // One shake, only for a running-pose error (errOn): a PIN-pose error plays
  // the X clock for its vetoes alone.
  const shake = rm
    ? constant(0)
    : mul(
        kf(
          v.X,
          [
            {t: 0, v: 0},
            {t: 50, v: -10, ease: 'INOUT'},
            {t: 126, v: 9, ease: 'INOUT'},
            {t: 202, v: -6, ease: 'INOUT'},
            {t: 277, v: 4, ease: 'INOUT'},
            {t: 353, v: -2, ease: 'INOUT'},
            {t: 420, v: 0, ease: 'INOUT'},
          ],
          X,
        ),
        v.errOn,
      );
  const sheenX = rm
    ? constant(-95)
    : kf(
        v.sheen,
        [
          {t: 0, v: -95},
          {t: 0.7 * DUR.sheen, v: L.card.w + 95, ease: 'INOUT'},
        ],
        DUR.sheen,
      );
  // The light along the card's bottom edge as the change slip passes behind
  // it (the slip is hidden by 440): inside the 640 ms change budget.
  const glows = v.slips.map((clock, k) => {
    const keys: Key[] = rm
      ? [
          {t: 0, v: 0},
          {t: 160, v: 0.6, ease: 'STD'},
          {t: 480, v: 0, ease: 'STD'},
        ]
      : [
          {t: 400, v: 0},
          {t: 520, v: 0.9, ease: 'OUT'},
          {t: 640, v: 0, ease: 'STD'},
        ];
    return mul(kf(clock, keys, DUR.slip), keep(v.armSlip[k], veto200));
  });
  const glowSum = glows.slice(1).reduce<Num>((a, b) => add(a, b), glows[0]);

  // --- money pool ------------------------------------------------------------
  const drop = L.note.drop;
  // The note drops straight from behind the card onto FROM's number line
  // (80–520) and rests there while FROM's layers change UNDER it; at 600 it
  // is swapped out, in one frame, for the chip's own number. The money
  // becomes the number: no dissolve (never a 15 sp and a 20 sp "16"
  // blended), and never an empty number slot on the way.
  const notes = v.notes.map((clock, k) => ({
    translateY: rm
      ? constant(0)
      : kf(
          clock,
          [
            {t: 0, v: -drop},
            {t: NOTE_FALL, v: -drop},
            {t: NOTE_LAND, v: 0, ease: 'INOUT'},
          ],
          DUR.roll,
        ),
    opacity: rm
      ? constant(0)
      : mul(
          kf(
            clock,
            [
              {t: 0, v: 0},
              {t: 40, v: 1},
              {t: NOTE_CUT, v: 1},
              {t: NOTE_CUT + 1, v: 0},
            ],
            DUR.roll,
          ),
          v.claims,
          keep(v.armNote[k], veto160),
        ),
  }));
  // The change goes home in ONE straight move: no lift, no pop — it leaves
  // the CHANGE chip and rises behind the card's bottom edge (hidden by 440).
  const slips = v.slips.map((clock, k) => ({
    translateY: rm
      ? constant(0)
      : kf(
          clock,
          [
            {t: 0, v: 0},
            {t: 440, v: -drop, ease: 'INOUT'},
          ],
          DUR.slip,
        ),
    scale: constant(1),
    opacity: rm
      ? constant(0)
      : mul(
          kf(
            clock,
            // Opaque from its first frame, over CHANGE's own number (which
            // it replaces in that same frame): never two 4s blended.
            [
              {t: 0, v: 0},
              {t: 1, v: 1},
              {t: 420, v: 1},
              {t: 440, v: 0},
            ],
            DUR.slip,
          ),
          keep(v.armSlip[k], veto160),
          v.claims,
        ),
  }));

  // --- ledger ----------------------------------------------------------------
  const chipIn = [0, 1, 2].map(k => ({
    opacity: kf(
      v.ledgerIn,
      [
        {t: 60 * k, v: 0},
        {t: 60 * k + 280, v: 1, ease: 'OUT'},
      ],
      DUR.ledgerIn,
    ),
    translateY: rm
      ? constant(0)
      : kf(
          v.ledgerIn,
          [
            {t: 60 * k, v: 8},
            {t: 60 * k + 280, v: 0, ease: 'OUT'},
          ],
          DUR.ledgerIn,
        ),
  }));
  const opIn = [0, 1].map(j => ({
    opacity: kf(
      v.ledgerIn,
      [
        {t: 60 * j + 30, v: 0},
        {t: 60 * j + 310, v: 1, ease: 'OUT'},
      ],
      DUR.ledgerIn,
    ),
    translateY: rm
      ? constant(0)
      : kf(
          v.ledgerIn,
          [
            {t: 60 * j + 30, v: 8},
            {t: 60 * j + 310, v: 0, ease: 'OUT'},
          ],
          DUR.ledgerIn,
        ),
  }));
  // FROM's pending total stays until the opaque note has landed on it
  // (500), and the filled layer comes up around the resting note.
  const fromCleared = rm
    ? kf(
        v.fromIn,
        [
          {t: 0, v: 0},
          {t: 160, v: 1, ease: 'STD'},
        ],
        DUR.fromIn,
      )
    : kf(
        v.fromIn,
        [
          {t: 500, v: 0},
          {t: 501, v: 1},
        ],
        DUR.fromIn,
      );
  // A burn that was still in flight when the charge failed is vetoed: the
  // FROM chip goes back to what it showed before the burn.
  const fromKept = keep(v.armFrom, veto200);
  const fromFilled = solid(
    mul(
      rm
        ? kf(
            v.fromIn,
            [
              {t: 0, v: 0},
              {t: 160, v: 1, ease: 'STD'},
            ],
            DUR.fromIn,
          )
        : kf(
            v.fromIn,
            [
              {t: 480, v: 0},
              {t: NOTE_CUT, v: 1, ease: 'STD'},
            ],
            DUR.fromIn,
          ),
      v.claims,
      fromKept,
    ),
  );
  // One odometer pair per burn: P holds the total before it, N the total
  // after. Pair k hides the instant pair k+1 starts (their texts match).
  const started = (clock: V) =>
    kf(
      clock,
      [
        {t: 0, v: 0},
        {t: 1, v: 1},
      ],
      DUR.roll,
    );
  // A second note PUSHES the old total down out of the clipped window: from
  // the frame the note's bottom edge touches the number, the number moves
  // with that edge (the note's own INOUT, sampled) — a note never sits on a
  // number, and the old total is gone by the landing.
  const fall = (t: number) =>
    EASE.INOUT(
      Math.min(1, Math.max(0, (t - NOTE_FALL) / (NOTE_LAND - NOTE_FALL))),
    );
  const touch = Math.max(0, 1 - (NOTE_H / 2 + GLYPH_HALF) / Math.max(1, drop));
  const tTouch =
    NOTE_FALL + (NOTE_LAND - NOTE_FALL) * easeInverse('INOUT', touch);
  const pushKeys: Key[] = [{t: tTouch, v: 0}];
  for (let i = 1; i <= 12; i++) {
    const t = tTouch + ((NOTE_LAND - tTouch) * i) / 12;
    pushKeys.push({t, v: drop * (fall(t) - touch)});
  }
  pushKeys.push({t: NOTE_LAND + 20, v: ODO});
  const odo = v.notes.map((clock, k) => {
    const next = v.notes[k + 1];
    const alive = next
      ? mul(started(clock), inv(started(next)), v.claims)
      : mul(started(clock), v.claims);
    // Vetoed mid-roll: P (the total before this burn) comes back, N goes.
    const kept = keep(v.armNote[k], veto160);
    const back = (p: Num) => inv(mul(inv(p), kept));
    return rm
      ? {
          p: mul(
            back(
              kf(
                clock,
                [
                  {t: 0, v: 1},
                  {t: 160, v: 0, ease: 'STD'},
                ],
                DUR.roll,
              ),
            ),
            alive,
          ),
          pY: constant(0),
          n: mul(
            kf(
              clock,
              [
                {t: 0, v: 0},
                {t: 160, v: 1, ease: 'STD'},
              ],
              DUR.roll,
            ),
            alive,
            kept,
          ),
          nY: constant(0),
        }
      : {
          // P leaves under the landed note; N is in place under it, so the
          // swap at NOTE_CUT shows the new total, at rest, in one frame.
          p: mul(
            back(
              kf(
                clock,
                [
                  {t: NOTE_LAND + 20, v: 1},
                  {t: NOTE_LAND + 21, v: 0},
                ],
                DUR.roll,
              ),
            ),
            alive,
          ),
          pY: mul(kf(clock, pushKeys, DUR.roll), kept),
          n: mul(
            kf(
              clock,
              [
                {t: 500, v: 0},
                {t: 501, v: 1},
              ],
              DUR.roll,
            ),
            alive,
            kept,
          ),
          nY: constant(0),
        };
  });
  const split = (
    keys: Key[],
    rmKeys: Key[] = [
      {t: 0, v: 0},
      {t: 160, v: 1, ease: 'STD'},
    ],
  ) => kf(v.split, rm ? rmKeys : keys, DUR.split);
  // A split still in flight at an error is vetoed whole: ghosts fade, the
  // landing layers fade, the pending numbers come back.
  const splitKept = mul(v.claims, keep(v.armSplit, veto200));
  // FROM CARD records the spend: its number goes the instant the split
  // starts — under ghost A, which sits exactly on it — and comes back grey
  // (spent) once A has slid clear of it. Never a "1" peeking out from under
  // a moving note.
  const fromSpent = solid(
    mul(
      split(
        [
          {t: 0, v: 0},
          {t: 1, v: 1},
        ],
        [
          {t: 0, v: 0},
          {t: 160, v: 1, ease: 'STD'},
        ],
      ),
      splitKept,
    ),
  );
  const fromSpentNum = rm
    ? constant(1)
    : kf(
        v.split,
        [
          {t: 310, v: 0},
          {t: 430, v: 1, ease: 'STD'},
        ],
        DUR.split,
      );
  // Each chip turns "settling" UNDER its landing note (the dashed edge and
  // tint come up around it), and the note is swapped for the chip's number
  // in one frame at its cut — the burn's hand-off, mirrored.
  const paidSettling = solid(
    mul(
      split([
        {t: 440, v: 0},
        {t: 560, v: 1, ease: 'STD'},
      ]),
      splitKept,
    ),
  );
  const changeSettling = solid(
    mul(
      split([
        {t: 480, v: 0},
        {t: 600, v: 1, ease: 'STD'},
      ]),
      splitKept,
    ),
  );
  // The change write lifts the slip off CHANGE's number, and the number
  // stays as a 35 % placeholder (dashed edge kept): the ledger never reads
  // "12 + [ ]" while the card is being written. The confirming read lays
  // "4 ✓" over it; a failure brings it back to full strength (not home).
  const changeNum = rm
    ? constant(1)
    : inv(
        mul(
          kf(
            v.slips[0],
            [
              {t: 0, v: 0},
              {t: 1, v: 0.65},
            ],
            DUR.slip,
          ),
          keep(v.armChange, veto160),
          v.claims,
        ),
      );
  // A pending (grey) number stays until the note that claims it has covered
  // it, then clears under that note: never an empty chip, never two numbers.
  // Ghost B crosses PAID on its way to CHANGE (it occludes the 12 briefly,
  // as one note passing over another would).
  const pendingKeep = (keys: Key[]) => inv(mul(split(keys), splitKept));
  const underA = [
    {t: 460, v: 0},
    {t: 461, v: 1},
  ];
  const paidPending3 = pendingKeep(underA);
  const paidPending2 = pendingKeep(underA);
  const changePending = pendingKeep([
    {t: 520, v: 0},
    {t: 521, v: 1},
  ]);
  // The operators light as the money crosses them: → and + as ghost B (it
  // leads) passes each one; with no change, → as ghost A does.
  const opLit3 = [
    mul(
      split([
        {t: 300, v: 0},
        {t: 420, v: 1, ease: 'STD'},
      ]),
      splitKept,
    ),
    mul(
      split([
        {t: 390, v: 0},
        {t: 510, v: 1, ease: 'STD'},
      ]),
      splitKept,
    ),
  ];
  const opLit2 = mul(
    split([
      {t: 330, v: 0},
      {t: 450, v: 1, ease: 'STD'},
    ]),
    splitKept,
  );
  const settlingTint = mul(tintBreathe, fOut, xOut160);
  const paidPaid = solid(
    mul(
      kf(
        v.paid,
        [
          {t: 0, v: 0},
          {t: rm ? 160 : 200, v: 1, ease: 'STD'},
        ],
        DUR.paid,
      ),
      v.claims,
      keep(v.armPaid, veto200),
    ),
  );
  // "4 ✓" plays only once a later phase has confirmed the write (the
  // closing read), so it is never vetoed: a confirmed claim stays.
  const changeHome = solid(
    mul(
      kf(
        v.changeHome,
        [
          {t: 0, v: 0},
          {t: rm ? 160 : 200, v: 1, ease: 'STD'},
        ],
        DUR.changeHome,
      ),
      v.claims,
    ),
  );
  const ghostKeep = mul(keep(v.armSplit, veto160), v.claims);
  // The split says what happens to the 16 BEFORE anything moves: ghost A,
  // opaque on FROM's number, rolls its label 16 → 12 in place (0–120, an
  // odometer clipped by the note); ghost B lies under it already reading
  // "4" and never shows the burnt total. Then both travel (B to CHANGE,
  // twice as far, always ahead — they never cross) and each is swapped for
  // its chip's number at its cut. No note ever carries the full total while
  // a second note is visible.
  const travel = (t1: number, dx: V) =>
    rm
      ? constant(0)
      : mul(
          kf(
            v.split,
            [
              {t: SPLIT_ROLL, v: 0},
              {t: t1, v: 1, ease: 'INOUT'},
            ],
            DUR.split,
          ),
          dx,
        );
  const shown = (cut: number) =>
    rm
      ? constant(0)
      : mul(
          kf(
            v.split,
            [
              {t: 0, v: 0},
              {t: 1, v: 1},
              {t: cut, v: 1},
              {t: cut + 1, v: 0},
            ],
            DUR.split,
          ),
          ghostKeep,
        );
  const ghostA = {
    translateX: travel(GHOST_A.land, v.dxA),
    opacity: shown(GHOST_A.cut),
    from: kf(
      v.split,
      [
        {t: SPLIT_ROLL - 20, v: 1},
        {t: SPLIT_ROLL, v: 0},
      ],
      DUR.split,
    ),
    fromY: rm
      ? constant(0)
      : kf(
          v.split,
          [
            {t: 0, v: 0},
            {t: SPLIT_ROLL, v: -LABEL_ROLL, ease: 'STD'},
          ],
          DUR.split,
        ),
    to: kf(
      v.split,
      [
        {t: 0, v: 0},
        {t: 20, v: 1},
      ],
      DUR.split,
    ),
    toY: rm
      ? constant(0)
      : kf(
          v.split,
          [
            {t: 0, v: LABEL_ROLL},
            {t: SPLIT_ROLL, v: 0, ease: 'STD'},
          ],
          DUR.split,
        ),
  };
  const ghostB = {
    translateX: travel(GHOST_B.land, v.dxB),
    opacity: shown(GHOST_B.cut),
    from: constant(0),
    fromY: constant(0),
    to: constant(1),
    toY: constant(0),
  };

  // --- stepper ---------------------------------------------------------------
  const segmented = kf(
    v.ledgerIn,
    [
      {t: 120, v: 0},
      {t: 400, v: 1, ease: 'OUT'},
    ],
    DUR.ledgerIn,
  );
  const activeFade = mul(fOut, xOut160);
  // A done segment WIPES in from the left (scaleX about its left edge);
  // under reduce motion the same full-width green fades in place.
  const segs = v.fill.map((fill, i) => ({
    active: mul(v.active[i], breathe, activeFade),
    fillScale: rm ? constant(1) : (fill as Num),
    fillX: rm ? constant(0) : mul(add(fill, -1), v.segHalf),
    fillOpacity: rm ? (fill as Num) : constant(1),
    failed: mul(v.failed[i], v.errOn),
  }));

  // --- status block -------------------------------------------------------
  const still = rm ? constant(0) : null;
  const titleFade = mul(fTitle, xOut120);
  const pillFade = mul(fOut, xOut160);
  const titles = v.title.map(p => {
    const s = slot(p, still);
    return {
      opacity: mul(s.opacity, titleFade),
      translateY: rm ? s.translateY : add(s.translateY, fTitleRise),
    };
  });
  const pills = v.pill.map(p => {
    const s = slot(p, still);
    return {opacity: mul(s.opacity, pillFade), translateY: s.translateY};
  });
  const up4 = (clock: V, t0: number, t1: number, dur: number) => ({
    opacity: kf(
      clock,
      [
        {t: t0, v: 0},
        {t: t1, v: 1, ease: 'OUT'},
      ],
      dur,
    ),
    translateY: rm
      ? constant(0)
      : kf(
          clock,
          [
            {t: t0, v: 4},
            {t: t1, v: 0, ease: 'OUT'},
          ],
          dur,
        ),
  });
  const paidTitle = up4(v.F, 120, 240, F);
  const errTitle = up4(v.X, 120, 240, X);
  const errPill = up4(v.X, 160, 320, X);
  const errBody = up4(v.X, 200, 400, X);

  // --- hold pill -------------------------------------------------------------
  // The copy swaps by fade-through (never two pills overprinting); nothing
  // on it moves — the ↑ is static, a stall changes the words only. Its live
  // dot breathes for as long as the card must stay on the phone.
  const holdFade = mul(fHold, xOut160, holdDock);
  // A slow settle (DUR.settleHelpLead into it, natively — no timer) moves
  // the pill itself to "Keep holding — almost done": ONE hold instruction on
  // screen, never a second line saying the same. The next phase moves it
  // back (the settleHelp clock retargets to 0).
  const slowSettle = kf(
    v.settleHelp,
    [
      {t: 0, v: 0},
      {t: 160, v: 1, ease: 'STD'},
    ],
    DUR.settleHelp,
  );
  const keepW = mul(v.holdKeep, inv(slowSettle));
  const stallW = add(v.holdStall, mul(v.holdKeep, slowSettle));
  // The copy swaps by fade-through on a surface that stays opaque: during a
  // swap the two presences ride one timing and sum to ~1, so the surface
  // holds and its width eases from one copy's width to the other's.
  const holdSum = add(add(v.holdW0, keepW), stallW);
  const holdWidth = Animated.divide(
    add(
      add(mul(v.holdW0, v.holdWidths[0]), mul(keepW, v.holdWidths[1])),
      mul(stallW, v.holdWidths[2]),
    ),
    // Never a zero divisor (native division throws); invisible at rest.
    add(holdSum, 1e-6),
  );
  const hold = {
    w0: mul(through(v.holdW0), holdFade),
    keep: mul(through(keepW), holdFade),
    stall: mul(through(stallW), holdFade),
    surface: mul(map(holdSum, [0, 1], [0, 1]), holdFade),
    // Reduce motion draws whole pills that crossfade instead (no morph).
    shiftL: rm
      ? constant(0)
      : map(holdWidth, [0, HOLD_MAX_W], [HOLD_MAX_W / 2, 0]),
    shiftR: rm
      ? constant(0)
      : map(holdWidth, [0, HOLD_MAX_W], [-HOLD_MAX_W / 2, 0]),
    widths: v.holdWidths,
    // Opacity only, so it breathes under reduce motion as well.
    dot: kf(
      v.ambient,
      [
        {t: 0, v: 1},
        {t: A / 2, v: 0.6},
        {t: A, v: 1},
      ],
      A,
    ),
    ringScale: rm
      ? constant(1)
      : kf(
          v.ambient,
          [
            {t: 0, v: 1},
            {t: A / 2, v: 2.6, ease: 'OUT'},
          ],
          A,
        ),
    ringOpacity: rm
      ? constant(0)
      : kf(
          v.ambient,
          [
            {t: 0, v: 0.45},
            {t: A / 2, v: 0, ease: 'OUT'},
          ],
          A,
        ),
  };

  // --- badges ---------------------------------------------------------------
  // The PIN was right: the lock opens (0–120) and leaves (200–360) — inside
  // the 360 ms PIN budget.
  const lock = {
    opacity: mul(
      v.lockIn,
      kf(
        v.lockOut,
        [
          {t: 200, v: 1},
          {t: 360, v: 0, ease: 'IN'},
        ],
        DUR.lockOut,
      ),
      xOut120,
      fHold,
      runVis,
    ),
    scale: rm
      ? constant(1)
      : mul(
          map(v.lockIn, [0, 1], [0.7, 1]),
          kf(
            v.lockOut,
            [
              {t: 200, v: 1},
              {t: 360, v: 0.9, ease: 'IN'},
            ],
            DUR.lockOut,
          ),
        ),
    open: kf(
      v.lockOut,
      [
        {t: 0, v: 0},
        {t: 120, v: 1, ease: 'STD'},
      ],
      DUR.lockOut,
    ),
  };
  const errBadge = {
    opacity: mul(
      xIn([
        {t: 80, v: 0},
        {t: 300, v: 1, ease: 'OUT'},
      ]),
      runVis,
    ),
    scale: rm
      ? constant(1)
      : kf(
          v.X,
          [
            {t: 80, v: 0.6},
            {t: 300, v: 1, ease: 'OUT'},
          ],
          X,
        ),
  };
  // PIN-pose error: the mark replaces the card-read check once the card has
  // docked small again (the last third of the dock).
  const pinErrVis = mul(
    kf(
      v.pinErrClock,
      [
        {t: 240, v: 0},
        {t: 360, v: 1, ease: 'STD'},
      ],
      DUR.dock,
    ),
    v.pinErrOn,
  );

  // --- finale ---------------------------------------------------------------
  // The check lands on the dimmed card with no overshoot (.56 → .80, OUT,
  // landed by 360) and rests while the card keeps receding; the flood and
  // the badge's rise take the 480 ms before DUR.handoff (560–1040), so from
  // then on every frame IS Success's first frame — the hand-off lands there
  // with time to spare inside the 1.25 s budget.
  const H = DUR.handoff;
  // Reduce motion: ONE badge, Success's own (80 dp, on its centre), fades in
  // once the hold pill under it has gone; only the green crossfades in
  // beneath it. Never two checks on screen.
  const badge = rm
    ? {
        opacity: constant(0),
        translateY: constant(0),
        scale: constant(FINALE_REST_SCALE),
      }
    : {
        opacity: kf(
          v.F,
          [
            {t: 60, v: 0},
            {t: 180, v: 1, ease: 'STD'},
          ],
          F,
        ),
        translateY: kf(
          v.F,
          [
            {t: FLOOD_AT, v: 0},
            {t: H, v: L.finale.dy, ease: 'INOUT'},
          ],
          F,
        ),
        scale: kf(
          v.F,
          [
            {t: 60, v: 0.56},
            {t: 360, v: FINALE_REST_SCALE, ease: 'OUT'},
            {t: FLOOD_AT, v: FINALE_REST_SCALE},
            {t: H, v: 1, ease: 'INOUT'},
          ],
          F,
        ),
      };
  const flood = rm
    ? {opacity: constant(0), scale: constant(1)}
    : {
        opacity: kf(
          v.F,
          [
            {t: FLOOD_AT - 20, v: 0},
            {t: FLOOD_AT, v: 1},
          ],
          F,
        ),
        scale: kf(
          v.F,
          [
            {t: FLOOD_AT, v: FLOOD_FROM},
            {t: H, v: L.finale.floodEnd, ease: 'INOUT'},
          ],
          F,
        ),
      };
  const rmNodes = rm
    ? {
        overlay: kf(
          v.F,
          [
            {t: FLOOD_AT, v: 0},
            {t: FLOOD_AT + 240, v: 1, ease: 'STD'},
          ],
          F,
        ),
        badge: kf(
          v.F,
          [
            {t: 120, v: 0},
            {t: 280, v: 1, ease: 'STD'},
          ],
          F,
        ),
      }
    : {
        // The flood is a circle scaled ~12.6×; GPU coverage of a magnified
        // round rect can leave the interior a hair under opaque (254/255 on
        // the emulator: the content showed through by one level). Its last
        // 20 ms hand over to a plain full-screen rect, so the final frame is
        // exactly Success's flat #007856, pixel for pixel.
        overlay: kf(
          v.F,
          [
            {t: H - 20, v: 0},
            {t: H, v: 1},
          ],
          F,
        ),
        badge: constant(0),
      };

  return {
    card: {
      translateX: shake,
      translateY: add(cardDockY, iosY),
      scale: cardScale,
      opacity: rmDockFade,
      arcs,
      sheenX,
      sheenOpacity: rm ? constant(0) : mul(v.sheenOn, fOut, xOut160),
      // The card dims as the check lands, then keeps receding — slowly —
      // under the resting check until the flood takes over: the beat
      // between the landing and the flood is held, never frozen.
      dim: kf(
        v.F,
        [
          {t: 0, v: 0},
          {t: 120, v: 0.2, ease: 'STD'},
          {t: FLOOD_AT, v: 0.28, ease: 'STD'},
        ],
        F,
      ),
      glow: map(glowSum, [0, 0.9], [0, 0.9]),
      last4: mul(
        kf(
          v.ledgerIn,
          [
            {t: 0, v: 0},
            {t: 280, v: 1, ease: 'OUT'},
          ],
          DUR.ledgerIn,
        ),
        idVis,
      ),
    },
    ornaments: {translateX: shake, translateY: iosY, opacity: rmDockFade},
    hold,
    lock,
    errBadge,
    readBadge: {opacity: mul(readVis, inv(pinErrVis))},
    pinErrBadge: {opacity: mul(readVis, pinErrVis)},
    pool: {translateY: iosY, notes, slips},
    ledger: {
      translateY: add(ledgerDockY, iosY),
      opacity: mul(ledgerPinVis, rmDockFade, ledgerReveal),
      chipIn,
      opIn,
      fromPending: inv(mul(fromCleared, v.claims, fromKept)),
      fromFilled,
      odo,
      fromSpent,
      fromSpentNum,
      paidPending3,
      paidPending2,
      paidSettling,
      paidTint: settlingTint,
      paidPaid,
      changePending,
      changeSettling,
      changeNum,
      changeTint: settlingTint,
      changeHome,
      opLit3,
      opLit2,
      ghostA,
      ghostB,
    },
    stepper: {
      opacity: mul(runVis, inv(v.iosPose)),
      // Before a plan exists the stepper slot holds one unsegmented pending
      // track — at idle too, so the card-to-title band never opens past
      // 15 % of the screen. It only breathes once a charge is running.
      single: inv(segmented),
      singleActive: mul(v.active[0], breathe, activeFade),
      singleFailed: mul(v.failed[0], v.errOn),
      segmented,
      segs,
    },
    status: {
      opacity: runVis,
      translateY: add(iosY, map(v.iosPose, [0, 1], [0, L.ios.statusDy])),
      titles,
      paid: paidTitle,
      err: {
        opacity: mul(errTitle.opacity, v.errOn),
        translateY: errTitle.translateY,
      },
      pills,
      errPill: {
        opacity: mul(errPill.opacity, v.errOn),
        translateY: errPill.translateY,
      },
      idleHelper: mul(v.idleHelper, runVis),
      errBody: {
        opacity: mul(errBody.opacity, v.errOn),
        translateY: errBody.translateY,
      },
    },
    // Actions swap sequentially (out, then in) on one 200 ms INOUT ramp: a
    // half-faded ink button behind "Cancel" read as a grey pill. Entering a
    // charge is a cut instead (w0): Cancel is there on the first frame.
    actions: {
      opacity: actVis,
      idle: through(v.actIdle),
      run: through(v.actRun),
      err: through(v.actErr),
    },
    sheet: {
      translateY: sheetY,
      opacity: sheetOpacity,
      helper: inv(pinErrVis),
      errHelper: pinErrVis,
    },
    amount: {translateY: iosY},
    flood,
    badge,
    rm: rmNodes,
    dots: {green: v.dotsGreen},
  };
}

// ---------------------------------------------------------------------------
// Text slots

/**
 * Three round-robin text slots per line (title, verbatim pill). Setting the
 * same text again is a no-op; a new text goes into the next slot so a slot
 * that is still fading out is never rewritten (two phases can land ~30 ms
 * apart). `desire` runs during render; `flush` animates after the commit.
 */
export class SlotRing {
  texts: Array<string | null> = [null, null, null];
  active = -1;
  private cursor = -1;
  private pending: {show: number; hide: number; instant: boolean} | null = null;
  /** When each slot's entry ends (JS clock); a slot replaced before then sinks back. */
  private entryEnds: number[] = [0, 0, 0];

  desire(text: string | null, instant = false): void {
    const current = this.active >= 0 ? this.texts[this.active] : null;
    if (text === current) {
      if (instant) {
        // Re-assert the current slot with no motion (a hard reset).
        this.pending = {show: this.active, hide: -1, instant: true};
      }
      return;
    }
    const hide = this.active;
    let show = -1;
    if (text !== null) {
      this.cursor = (this.cursor + 1) % SLOTS;
      show = this.cursor;
      this.texts[show] = text;
    }
    this.active = show;
    const pending = this.pending;
    this.pending = pending
      ? {
          show,
          hide:
            pending.hide >= 0 && pending.hide !== show ? pending.hide : hide,
          instant: instant || pending.instant,
        }
      : {show, hide, instant};
  }

  /** Called from the layout effect after the texts are committed. */
  flush(values: V[], ms: number, ease: EaseName, timeScale: number): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    const t = now();
    values.forEach((value, i) => {
      if (i === pending.show) {
        if (pending.instant) {
          snapTo(value, 1);
        } else {
          value.setValue(0);
          toward(value, 1, ms, ease, timeScale);
        }
        this.entryEnds[i] = pending.instant ? 0 : t + ms / timeScale;
      } else if (i === pending.hide || pending.instant) {
        if (pending.instant) {
          snapTo(value, 2);
        } else if (t < this.entryEnds[i]) {
          // Replaced before it settled (two phases ~30 ms apart): it sinks
          // back the way it came instead of swelling to full strength on
          // its way out over the top.
          toward(value, 0, ms, ease, timeScale);
        } else {
          toward(value, 2, ms, ease, timeScale);
        }
        this.entryEnds[i] = 0;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Conductor

export interface Snapshot {
  mode: Mode;
  pose: Pose;
  stage: StageState;
  stalled: boolean;
  shape: PlanShape | null;
  planKey: string | null;
  pinError: boolean;
  pinLength: number;
  resetKey: number;
  iosSession: boolean;
  /** The preview is off screen: no loops, no timers. */
  paused?: boolean;
}

interface Flight {
  anim: CA;
  start: number;
  end: number;
}

const ORDER: SegName[] = ['card', 'pin', 'pay', 'settle', 'change'];
/** When a change slip has passed fully behind the card (its clock, ms). */
export const SLIP_HIDDEN = 440;

export class Conductor {
  L: ChargeLayout;
  rm = false;
  ts = 1;
  private v: Values;
  private snap: Snapshot | null = null;
  private flights = new Map<V, Flight>();
  private ambientLoop: CA | null = null;
  private sheenLoop: CA | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private burnEnd = 0;
  private ghostALand = 0;
  private ghostBLand = 0;
  private slipHidden = 0;
  private paidPlayed = false;
  private homePlayed = false;
  /** A phase after 'writing change to card' arrived: the change is home. */
  private changeConfirmed = false;
  private lockShown = false;
  private fresh = true;
  private activeSeg: SegName | null = null;
  private dock = {from: 1, to: 1, start: 0, dur: 0};
  private disposed = false;
  /** Which real phases this charge has already turned into gestures. */
  private seen = {hello: false, pin: false, burns: 0, split: false, changes: 0};
  /** What the loops and plan distances were last built with. */
  private applied: {rm: boolean; ts: number; L: ChargeLayout | null} = {
    rm: false,
    ts: 1,
    L: null,
  };

  constructor(values: Values, layout: ChargeLayout) {
    this.v = values;
    this.L = layout;
  }

  /** Called during render with the latest inputs; applied in sync(). */
  configure(layout: ChargeLayout, rm: boolean, timeScale: number): void {
    this.L = layout;
    this.rm = rm;
    this.ts = timeScale;
  }

  // --- primitives ------------------------------------------------------------

  private pres(value: V, to: number, ms: number, ease: EaseName = 'STD'): void {
    toward(value, to, ms, ease, this.ts);
  }

  private gesture(clock: V, duration: number, lead = 0): number {
    const prior = this.flights.get(clock);
    prior?.anim.stop();
    const anim = play(clock, duration, {lead, timeScale: this.ts});
    const t = now();
    const start = t + lead / this.ts;
    this.flights.set(clock, {anim, start, end: start + duration / this.ts});
    return start;
  }

  /** Clock-domain ms until a real-time instant (0 once it has passed). */
  private leadUntil(realTime: number): number {
    return Math.max(0, realTime - now()) * this.ts;
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) {
        fn();
      }
    }, ms / this.ts);
    this.timers.add(timer);
  }

  private seg(name: SegName): number {
    const segments = this.snap?.shape?.segments ?? ORDER;
    const i = segments.indexOf(name);
    return i;
  }

  private fillSeg(name: SegName, to = 1): void {
    const i = this.seg(name);
    if (i >= 0) {
      this.pres(this.v.fill[i], to, DUR.fill);
    }
  }

  private activate(name: SegName | null): void {
    this.v.active.forEach((value, i) => {
      const target = name !== null && i === this.seg(name) ? 1 : 0;
      this.pres(value, target, DUR.fill);
    });
    this.activeSeg = name;
  }

  /** Under reduce motion too: everything on it there is opacity only. */
  private startAmbient(): void {
    if (!this.ambientLoop && !this.snap?.paused) {
      this.ambientLoop = loop(this.v.ambient, DUR.ambient, this.ts);
    }
  }

  private startSheen(): void {
    if (!this.sheenLoop && !this.rm && !this.snap?.paused) {
      this.sheenLoop = loop(this.v.sheen, DUR.sheen, this.ts);
    }
  }

  private stopLoops(which: 'all' | 'sheen' = 'all'): void {
    this.sheenLoop?.stop();
    this.sheenLoop = null;
    if (which === 'all') {
      this.ambientLoop?.stop();
      this.ambientLoop = null;
    }
  }

  private dockPos(t: number): number {
    const {from, to, start, dur} = this.dock;
    if (dur <= 0) {
      return to;
    }
    return from + (to - from) * Math.min(1, Math.max(0, (t - start) / dur));
  }

  private dockTo(target: number): void {
    const t = now();
    const current = this.dockPos(t);
    const ms = DUR.dock * Math.abs(target - current);
    this.pres(this.v.toRun, target, ms, 'LIN');
    this.dock = {from: current, to: target, start: t, dur: ms / this.ts};
  }

  /** Resets gesture clocks while their layers are hidden. */
  private freshClaims(): void {
    if (this.fresh) {
      return;
    }
    const v = this.v;
    for (const clock of [
      v.fromIn,
      v.split,
      v.paid,
      v.changeHome,
      v.lockOut,
      v.settleHelp,
      ...v.notes,
      ...v.slips,
    ]) {
      this.flights.get(clock)?.anim.stop();
      this.flights.delete(clock);
      snapTo(clock, 0);
    }
    for (const arm of this.arms()) {
      arm.setValue(0);
    }
    snapTo(v.claims, 1);
    this.burnEnd = 0;
    this.ghostALand = 0;
    this.ghostBLand = 0;
    this.slipHidden = 0;
    this.paidPlayed = false;
    this.homePlayed = false;
    this.changeConfirmed = false;
    this.lockShown = false;
    this.fresh = true;
  }

  // --- lifecycle -------------------------------------------------------------

  mount(snap: Snapshot): void {
    this.snap = snap;
    this.applied = {rm: this.rm, ts: this.ts, L: this.L};
    warmUp(this.v.all);
    if (snap.shape) {
      this.applyShape(snap.shape);
    }
    if (
      snap.pose === 'run' &&
      snap.mode !== 'complete' &&
      snap.mode !== 'error'
    ) {
      this.startAmbient();
    }
    if (snap.mode === 'running') {
      this.activeSeg = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.flights.forEach(f => f.anim.stop());
    this.flights.clear();
    this.stopLoops();
  }

  private applyShape(shape: PlanShape): void {
    const L = this.L;
    const segCount = shape.segments.length;
    const segW = (L.card.w - 4 * (segCount - 1)) / segCount;
    this.v.segHalf.setValue(segW / 2);
    if (shape.three) {
      this.v.dxA.setValue(L.three.chips[1].cx - L.three.chips[0].cx);
      this.v.dxB.setValue(L.three.chips[2].cx - L.three.chips[0].cx);
    } else {
      this.v.dxA.setValue(L.two.chips[1].cx - L.two.chips[0].cx);
      this.v.dxB.setValue(0);
    }
  }

  /** Called from the stage's layout effect after every commit. */
  sync(next: Snapshot): void {
    const prev = this.snap;
    if (!prev) {
      this.mount(next);
      return;
    }
    this.snap = next;
    this.applyInputs(next);
    if (next.resetKey !== prev.resetKey) {
      this.hardReset(next);
      return;
    }
    if (next.planKey !== prev.planKey && next.shape) {
      this.applyShape(next.shape);
      if (prev.planKey === null) {
        if (next.pose === 'pin') {
          // The plan lands with the PIN pose (every tap-flow PIN card): one
          // move, not two — the chips fade in place on the dock, no rise.
          snapTo(this.v.ledgerIn, 1);
          this.gesture(this.v.ledgerReveal, DUR.dock);
        } else {
          this.gesture(this.v.ledgerIn, DUR.ledgerIn);
        }
      }
    }
    if (next.pose !== prev.pose) {
      this.onPose(next.pose, next);
    }
    if (next.mode !== prev.mode) {
      this.onMode(prev.mode, next);
    }
    if (next.stage !== prev.stage && next.mode === 'running') {
      this.onStage(prev.stage, next.stage);
    }
    if (next.stalled !== prev.stalled && next.mode === 'running') {
      this.onStall(next.stalled);
    }
    if (next.pinLength !== prev.pinLength || next.pinError !== prev.pinError) {
      const green = next.pinLength === 4 && !next.pinError ? 1 : 0;
      this.pres(this.v.dotsGreen, green, 160);
      if (!next.pinError && prev.pinError) {
        this.pres(this.v.pinErrOn, 0, 160);
      }
    }
    if (next.iosSession !== prev.iosSession) {
      // Reduce motion: the iOS session pose is a cut, never a slide.
      if (this.rm) {
        snapTo(this.v.iosPose, next.iosSession ? 1 : 0);
      } else {
        this.pres(this.v.iosPose, next.iosSession ? 1 : 0, 360, 'INOUT');
      }
    }
    if (!!next.paused !== !!prev.paused) {
      if (next.paused) {
        this.timers.forEach(clearTimeout);
        this.timers.clear();
        this.stopLoops();
      } else if (
        next.pose === 'run' &&
        (next.mode === 'idle' || next.mode === 'running')
      ) {
        this.startAmbient();
      }
    }
  }

  /**
   * Reduce motion and the preview's speed change only between charges (the
   * view latches them), so a loop restart there is never seen mid-gesture.
   * A re-measured frame re-derives the plan's native distances.
   */
  private applyInputs(snap: Snapshot): void {
    const applied = this.applied;
    if (applied.L !== this.L && snap.shape) {
      this.applyShape(snap.shape);
    }
    if (applied.rm !== this.rm || applied.ts !== this.ts) {
      const hadAmbient = this.ambientLoop !== null;
      const hadSheen = this.sheenLoop !== null;
      this.stopLoops();
      const wantsAmbient =
        snap.pose === 'run' &&
        (snap.mode === 'idle' || snap.mode === 'running');
      if (hadAmbient || wantsAmbient) {
        this.startAmbient();
      }
      if (hadSheen) {
        this.startSheen();
      }
    }
    this.applied = {rm: this.rm, ts: this.ts, L: this.L};
  }

  private onPose(pose: Pose, snap: Snapshot): void {
    if (pose === 'pin') {
      this.dockTo(0);
      // A cut, not a fade: a plan that lands with the PIN pose snaps the
      // ledger in, and the id must not show on the card while it docks.
      snapTo(this.v.idOn, 0);
      this.pres(this.v.holdW0, 0, 160);
      this.pres(this.v.holdKeep, 0, 160);
      this.pres(this.v.holdStall, 0, 160);
      this.pres(this.v.sheenOn, 0, 160);
      this.pres(this.v.lockIn, 0, 160);
      this.pres(this.v.idleHelper, 0, 120);
      // Cancel is drawn above the sheet: it leaves before the sheet arrives.
      this.pres(this.v.actRun, 0, 160);
      this.activate(null);
      this.stopLoops();
      if (snap.pinError) {
        snapTo(this.v.pinErrOn, 1);
        this.gesture(this.v.pinErrClock, DUR.dock);
      }
    } else {
      this.dockTo(1);
      snapTo(this.v.idOn, 1);
      this.startAmbient();
    }
  }

  private onMode(prev: Mode, snap: Snapshot): void {
    const v = this.v;
    const mode = snap.mode;
    if (mode === 'running') {
      this.w0(prev === 'error');
      return;
    }
    if (mode === 'complete') {
      this.finale();
      return;
    }
    if (mode === 'error') {
      if (snap.pose === 'pin') {
        // The pad is the retry: the reason goes in the sheet helper. Money
        // that was still moving goes back to the last confirmed state, with
        // no shake (errOn stays 0, so only the vetoes ride the X clock).
        this.vetoInFlight();
        this.gesture(this.v.X, DUR.error);
        return;
      }
      this.error();
      return;
    }
    // idle
    if (prev === 'error') {
      this.pres(v.errOn, 0, 160);
      v.failed.forEach(value => this.pres(value, 0, 200));
      // Cancel after a failure: the failed attempt's title and phase stay
      // gone while the error fades; only the idle copy comes in.
      v.title.forEach(value => snapTo(value, 2));
      v.pill.forEach(value => snapTo(value, 2));
    }
    if (snap.pose === 'pin') {
      return;
    }
    this.pres(v.holdW0, 0, 160);
    this.pres(v.holdKeep, 0, 160);
    this.pres(v.holdStall, 0, 160);
    this.pres(v.sheenOn, 0, 160);
    this.pres(v.lockIn, 0, 160);
    this.settleHelpOff();
    v.fill.forEach(value => this.pres(value, 0, 240));
    this.activate(null);
    this.pres(v.claims, 0, 200);
    this.fresh = false;
    // The CTA may rest at 0.5 (hidden: w0 fades it out to there); from 0 its
    // return stays sequential — never a half-faded ink button under Cancel.
    snapTo(v.actIdle, 0);
    this.pres(v.actIdle, 1, DUR.actions, 'INOUT');
    this.pres(v.actRun, 0, DUR.actions, 'INOUT');
    this.pres(v.actErr, 0, DUR.actions, 'INOUT');
    this.pres(v.idleHelper, 1, 160);
    this.pres(v.arcsLive, 1, 240);
    this.startAmbient();
    this.later(200, () => this.stopLoops('sheen'));
  }

  private settleHelpOff(): void {
    const clock = this.v.settleHelp;
    this.flights.get(clock)?.anim.stop();
    this.flights.delete(clock);
    this.pres(clock, 0, 160);
  }

  /** The pill is leaving (paid, error): its copy stays as it is. */
  private settleHelpFreeze(): void {
    const clock = this.v.settleHelp;
    this.flights.get(clock)?.anim.stop();
    this.flights.delete(clock);
  }

  private w0(fromError: boolean): void {
    const v = this.v;
    this.seen = {hello: false, pin: false, burns: 0, split: false, changes: 0};
    if (fromError) {
      this.pres(v.errOn, 0, 160);
      v.failed.forEach(value => this.pres(value, 0, 200));
    }
    if (fromError || !this.fresh) {
      this.pres(v.claims, 0, 200);
      this.fresh = false;
    }
    v.fill.forEach(value => this.pres(value, 0, 240));
    this.activate(null);
    // A new charge has no phase yet: every verbatim slot is hidden, now —
    // never a phase from the last attempt, even one the native side still
    // held (seen once on the emulator after a burst of preview switches),
    // and never the failed phase ghosting back as the error fades on retry.
    v.pill.forEach(value => snapTo(value, 2));
    if (fromError) {
      // The failed attempt's title was only masked by the error; it must
      // not resurface while the error fades. The new title rises in alone.
      v.title.forEach(value => snapTo(value, 2));
    }
    // Cancel is on the FIRST running frame (a cut, in the same commit): there
    // is never a frame that says "Waiting for the card" with no way out of
    // it. The dark CTA under it fades (120 ms STD; its layer is visible only
    // above 0.5, so resting at 0.5 is gone) — 54 dp of ink never vanishes in
    // one frame.
    snapTo(v.idleHelper, 0);
    this.pres(v.actIdle, 0.5, 120, 'STD');
    snapTo(v.actErr, 0);
    snapTo(v.actRun, 1);
    this.pres(v.holdW0, 1, 200);
    this.pres(v.holdKeep, 0, 160);
    this.pres(v.holdStall, 0, 160);
    this.pres(v.sheenOn, 0, 160);
    this.pres(v.lockIn, 0, 160);
    this.pres(v.arcsLive, 1, 240);
    this.startAmbient();
  }

  /**
   * The gesture dispatcher. It works from what the stage state SAYS has
   * happened (stations, burns done, change written) rather than from the last
   * event alone, so two phases landing in one commit still play both
   * gestures, in order, chained by their leads — and a repeated phase (the
   * same 'reading card' five times) is a no-op.
   */
  private onStage(prev: StageState, next: StageState): void {
    const seen = this.seen;
    if (next.station === 0 && next.phase === null) {
      if (seen.hello) {
        // A new session on the same screen: back to "waiting for the card"
        // (a mode change into running has already done this).
        this.w0(false);
      }
      return;
    }
    if (next.station >= 1 && !seen.hello) {
      seen.hello = true;
      this.p1();
    }
    if (next.station >= 2 && !next.pinSkipped && !seen.pin) {
      seen.pin = true;
      this.p2();
    }
    while (seen.burns < next.burnsDone) {
      seen.burns += 1;
      this.p3(seen.burns, Math.max(next.burn?.total ?? 0, next.burnsDone));
    }
    if (next.station >= 4 && !seen.split) {
      seen.split = true;
      this.p4();
    }
    while (seen.changes < next.changeWritten) {
      seen.changes += 1;
      this.p5(seen.changes);
    }
    if (next.event === 'scan') {
      this.p6();
    }
    if (
      next.event !== 'none' &&
      next.event !== 'orbit' &&
      prev.event === 'orbit'
    ) {
      this.settleHelpOff();
    }
  }

  private p1(): void {
    const v = this.v;
    this.freshClaims();
    this.pres(v.sheenOn, 1, 200);
    this.startSheen();
    this.pres(v.holdW0, 0, 160);
    this.pres(v.holdKeep, 1, 160);
    this.activate('card');
    this.pres(v.arcsLive, 0, 240);
  }

  private p2(): void {
    this.fillSeg('card');
    this.activate('pin');
    this.pres(this.v.lockIn, 1, 200, 'OUT');
    this.lockShown = true;
    this.fresh = false;
  }

  private p3(index: number, total: number): void {
    const v = this.v;
    this.fresh = false;
    const shape = this.snap?.shape;
    if (index === 1) {
      this.fillSeg('card');
      if (shape?.pinRequired) {
        this.fillSeg('pin');
      }
      this.activate('pay');
      if (this.lockShown) {
        this.gesture(v.lockOut, DUR.lockOut);
      }
    } else {
      this.fillSeg('pay', (index - 1) / Math.max(1, total));
    }
    const k = index - 1;
    const lead = this.leadUntil(this.burnEnd);
    if (k < POOL) {
      const start = this.gesture(v.notes[k], DUR.roll, lead);
      // The next burn (or the split) starts on the frame this note is
      // swapped for FROM's number: a following note appears as it goes.
      this.burnEnd = start + NOTE_CUT / this.ts;
    }
    if (index === 1) {
      this.gesture(v.fromIn, DUR.fromIn, lead);
    }
  }

  private p4(): void {
    const v = this.v;
    this.fresh = false;
    this.fillSeg('pay');
    this.activate('settle');
    const start = this.gesture(
      v.split,
      DUR.split,
      this.leadUntil(this.burnEnd),
    );
    // Followers start on the frame each ghost is swapped for its chip's
    // number: PAID turns solid after A's cut, the change slip lifts off
    // CHANGE where B was cut.
    this.ghostALand = start + GHOST_A.cut / this.ts;
    this.ghostBLand = start + GHOST_B.cut / this.ts;
    this.gesture(v.settleHelp, DUR.settleHelp, DUR.settleHelpLead);
  }

  private p5(written: number): void {
    const v = this.v;
    this.fresh = false;
    this.settleHelpOff();
    if (written === 1) {
      this.fillSeg('settle');
      this.activate('change');
      if (!this.paidPlayed) {
        this.gesture(v.paid, DUR.paid, this.leadUntil(this.ghostALand));
        this.paidPlayed = true;
      }
    }
    const lead = this.leadUntil(
      written === 1 ? this.ghostBLand : this.slipHidden,
    );
    const k = (written - 1) % POOL;
    const start = this.gesture(v.slips[k], DUR.slip, lead);
    this.slipHidden = start + SLIP_HIDDEN / this.ts;
    // No ✓ yet: the chip says "4 ✓" only once a LATER phase confirms the
    // write (the closing read, in p6). Until then it stays "settling".
  }

  private p6(): void {
    const v = this.v;
    const shape = this.snap?.shape;
    (shape?.segments ?? ORDER).forEach(name => this.fillSeg(name));
    this.activate(null);
    this.settleHelpOff();
    if (!this.paidPlayed) {
      this.gesture(v.paid, DUR.paid, this.leadUntil(this.ghostALand));
      this.paidPlayed = true;
    }
    if (shape && shape.changeSat > 0) {
      // The read after the write confirms it: the change is on the card.
      this.changeConfirmed = this.seen.changes > 0;
      if (this.changeConfirmed && !this.homePlayed) {
        this.gesture(
          v.changeHome,
          DUR.changeHome,
          this.leadUntil(this.slipHidden),
        );
        this.homePlayed = true;
      }
    }
  }

  private onStall(stalled: boolean): void {
    const v = this.v;
    // A late phase changes the words only — no pulse, no swing.
    if (stalled) {
      this.pres(v.holdKeep, 0, 160);
      this.pres(v.holdStall, 1, 160);
    } else {
      this.pres(v.holdStall, 0, 160);
      this.pres(v.holdKeep, 1, 160);
    }
  }

  private finale(): void {
    const v = this.v;
    this.gesture(v.F, DUR.finale);
    markChargeComplete();
    this.landMoneyNow();
    // The inset strips turn green as the flood's edge crosses the frame's
    // top and bottom edges (reduce motion: with the overlay).
    const reach = floodReach(this.L);
    const strip = ([from, to]: [number, number]) => ({
      leadMs: from,
      durationMs: Math.max(16, to - from),
    });
    const withOverlay = {leadMs: FLOOD_AT, durationMs: 240};
    showEdgeTint({
      top: this.rm ? withOverlay : strip(reach.top),
      bottom: this.rm ? withOverlay : strip(reach.bottom),
      timeScale: this.ts,
    });
    this.settleHelpFreeze();
    // Paid: every segment is done, whatever the last phase managed to show.
    (this.snap?.shape?.segments ?? ORDER).forEach(name => this.fillSeg(name));
    this.activate(null);
    this.pres(v.actRun, 0, 1);
    // Whatever pose the finale starts from, nothing that says "hold" or
    // "tap" survives it: the idle copy and buttons leave with the hold pill.
    this.pres(v.idleHelper, 0, 120);
    this.pres(v.actIdle, 0, 120);
    this.pres(v.actErr, 0, 120);
    this.later(200, () => this.stopLoops());
  }

  /**
   * Paid can land while money is still moving (real phases may come 150 ms
   * apart). Every gesture still ahead — in flight, or waiting out its lead —
   * is fast-forwarded to its end over 160 ms, and a written change is
   * confirmed home: the ledger reads 16 → 12 + 4 ✓ before the paid title
   * rises at 120, and nothing is left sliding under the flood.
   */
  private landMoneyNow(): void {
    const v = this.v;
    const t = now();
    const finish = (clock: V) => {
      const anim = toward(clock, 1, 160, 'OUT', this.ts);
      this.flights.set(clock, {anim, start: t, end: t + 160 / this.ts});
    };
    this.flights.forEach((flight, clock) => {
      if (
        clock === v.F ||
        clock === v.X ||
        clock === v.pinErrClock ||
        clock === v.settleHelp ||
        t >= flight.end
      ) {
        return;
      }
      finish(clock);
    });
    const shape = this.snap?.shape;
    if (shape && this.seen.burns > 0 && !this.paidPlayed) {
      finish(v.paid);
      this.paidPlayed = true;
    }
    if (shape && shape.changeSat > 0 && this.seen.changes > 0) {
      this.changeConfirmed = true;
      if (!this.homePlayed) {
        finish(v.changeHome);
        this.homePlayed = true;
      }
    }
  }

  /** Every gesture clock paired with the veto that undoes its claim. */
  private vetoFor(clock: V): V | null {
    const v = this.v;
    if (clock === v.fromIn) {
      return v.armFrom;
    }
    if (clock === v.split) {
      return v.armSplit;
    }
    if (clock === v.paid) {
      return v.armPaid;
    }

    const note = v.notes.indexOf(clock);
    if (note >= 0) {
      return v.armNote[note];
    }
    const slip = v.slips.indexOf(clock);
    return slip >= 0 ? v.armSlip[slip] : null;
  }

  private arms(): V[] {
    const v = this.v;
    return [
      v.armFrom,
      v.armSplit,
      v.armPaid,
      v.armChange,
      ...v.armNote,
      ...v.armSlip,
    ];
  }

  /**
   * The ledger rests on the last CONFIRMED state. Every gesture still in
   * flight is stopped where it is and vetoed on the X clock: its money
   * object fades (160 ms) and its claim fades back (200 ms) — a CHANGE ✓
   * must never sit beside a failed 'writing change to card', and no slip is
   * ever left half-inserted. A gesture still in its lead never began.
   */
  private vetoInFlight(): void {
    const v = this.v;
    const t = now();
    this.flights.forEach((flight, clock) => {
      if (
        clock === v.F ||
        clock === v.X ||
        clock === v.ledgerIn ||
        clock === v.pinErrClock ||
        // Confirmed claims (PAID solid on the change write, "4 ✓" on the
        // closing read) are true whatever fails next: they finish.
        clock === v.paid ||
        clock === v.changeHome
      ) {
        return;
      }
      if (t >= flight.end) {
        return;
      }
      flight.anim.stop();
      this.flights.delete(clock);
      if (t < flight.start) {
        snapTo(clock, 0);
        return;
      }
      this.vetoFor(clock)?.setValue(1);
    });
    // Change that left the chip but was never confirmed by a later phase is
    // not on the card: CHANGE gets its number back, still "settling" — even
    // when the slip itself had long finished rising.
    if (this.seen.changes > 0 && !this.changeConfirmed) {
      v.armChange.setValue(1);
    }
  }

  private error(): void {
    const v = this.v;
    this.vetoInFlight();
    this.settleHelpFreeze();
    snapTo(v.errOn, 1);
    this.gesture(v.X, DUR.error);
    const failed = this.activeSeg !== null ? this.seg(this.activeSeg) : -1;
    if (failed >= 0) {
      this.pres(v.failed[failed], 1, 200);
    }
    this.activate(null);
    this.pres(v.actIdle, 0, DUR.actions, 'INOUT');
    this.pres(v.actRun, 0, DUR.actions, 'INOUT');
    this.pres(v.actErr, 1, DUR.actions, 'INOUT');
    this.later(200, () => this.stopLoops());
  }

  /** The preview's loop restart: straight to the rest pose, no motion. */
  private hardReset(snap: Snapshot): void {
    const v = this.v;
    this.flights.forEach(f => f.anim.stop());
    this.flights.clear();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.stopLoops();
    hideEdgeTint(0);
    const idle = snap.mode === 'idle' && snap.pose === 'run';
    const running = snap.mode === 'running';
    const clocks = [
      v.lockOut,
      v.fromIn,
      v.split,
      v.paid,
      v.changeHome,
      v.settleHelp,
      v.F,
      v.X,
      v.pinErrClock,
      ...v.notes,
      ...v.slips,
    ];
    clocks.forEach(clock => snapTo(clock, 0));
    this.arms().forEach(arm => snapTo(arm, 0));
    snapTo(v.claims, 1);
    snapTo(v.errOn, 0);
    snapTo(v.pinErrOn, 0);
    snapTo(v.sheenOn, 0);
    snapTo(v.lockIn, 0);
    snapTo(v.arcsLive, 1);
    snapTo(v.holdW0, running ? 1 : 0);
    snapTo(v.holdKeep, 0);
    snapTo(v.holdStall, 0);
    snapTo(v.idleHelper, idle ? 1 : 0);
    snapTo(v.actIdle, idle ? 1 : 0);
    snapTo(v.actRun, running ? 1 : 0);
    snapTo(v.actErr, 0);
    snapTo(v.dotsGreen, 0);
    [...v.fill, ...v.active, ...v.failed].forEach(value => snapTo(value, 0));
    snapTo(v.toRun, snap.pose === 'pin' ? 0 : 1);
    snapTo(v.idOn, snap.pose === 'pin' ? 0 : 1);
    this.dock = {
      from: snap.pose === 'pin' ? 0 : 1,
      to: snap.pose === 'pin' ? 0 : 1,
      start: 0,
      dur: 0,
    };
    snapTo(v.ledgerIn, snap.shape ? 1 : 0);
    snapTo(v.ledgerReveal, 1);
    if (snap.shape) {
      this.applyShape(snap.shape);
    }
    this.burnEnd = 0;
    this.ghostALand = 0;
    this.ghostBLand = 0;
    this.slipHidden = 0;
    this.paidPlayed = false;
    this.homePlayed = false;
    this.changeConfirmed = false;
    this.lockShown = false;
    this.fresh = true;
    this.activeSeg = null;
    this.seen = {hello: false, pin: false, burns: 0, split: false, changes: 0};
    if (snap.pose === 'run') {
      this.startAmbient();
    }
  }
}

// ---------------------------------------------------------------------------
// Hook

export interface Engine {
  values: Values;
  nodes: Nodes;
  conductor: Conductor;
  titleRing: SlotRing;
  pillRing: SlotRing;
}

export function useChargeEngine(
  layout: ChargeLayout,
  reduceMotion: boolean,
  timeScale: number,
  initial: InitialState,
): Engine {
  const valuesRef = useRef<Values | null>(null);
  if (valuesRef.current === null) {
    valuesRef.current = createValues(initial);
  }
  const values = valuesRef.current;
  const nodes = useMemo(
    () => buildNodes(values, layout, reduceMotion),
    [values, layout, reduceMotion],
  );
  const conductorRef = useRef<Conductor | null>(null);
  if (conductorRef.current === null) {
    conductorRef.current = new Conductor(values, layout);
  }
  const conductor = conductorRef.current;
  conductor.configure(layout, reduceMotion, timeScale);
  const ringsRef = useRef<{title: SlotRing; pill: SlotRing} | null>(null);
  if (ringsRef.current === null) {
    ringsRef.current = {title: new SlotRing(), pill: new SlotRing()};
  }
  useEffect(() => () => conductor.dispose(), [conductor]);
  return {
    values,
    nodes,
    conductor,
    titleRing: ringsRef.current.title,
    pillRing: ringsRef.current.pill,
  };
}
