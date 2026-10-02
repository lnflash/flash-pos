import {PixelRatio} from 'react-native';

import {
  SUCCESS_BADGE_SIZE,
  successBadgeCenter,
} from '../../../utils/successBadge';

/**
 * The charge screen is laid out ONCE, from the frame, and never reflows:
 * every state change after mount is an opacity or transform of a layer that
 * already exists. All y values are frame y (the stack card's own frame —
 * the root SafeAreaView already took the status and gesture bars).
 */

export interface Frame {
  width: number;
  height: number;
}

export interface LayoutOptions {
  platform?: string;
  /** Defaults to the device's; tests pin it. */
  pixelRatio?: number;
}

export const HEADER_H = 64;
export const ACTION_H = 56;
export const ACTION_BOTTOM = 24;
export const AMOUNT_H = 60;
export const LEDGER_H = 56;
export const STEPPER_H = 4;
export const TITLE_H = 26;
export const PAID_TITLE_H = 28;
export const PILL_H = 28;
export const HELPER_H = 40;
export const HOLD_H = 30;
export const NOTE_W = 52;
export const NOTE_H = 28;
export const BADGE = 28;
export const READ_BADGE = 20;
export const FINALE_BADGE = SUCCESS_BADGE_SIZE;
export const FINALE_REST_SCALE = 0.8;
export const PIN_SCALE = 0.44;
export const SHEET_RADIUS = 24;
/** Chip interior: number first (the money line), caption under it. */
export const CHIP_NUMBER_TOP = 7;
export const CHIP_NUMBER_H = 24;
export const CHIP_CAPTION_TOP = 34;
export const CHIP_CAPTION_H = 14;
/** The card artboard: 320 units wide, the card band is 202 units tall. */
export const ART_W = 320;
export const ART_H = 202;

interface Gaps {
  /** amount → card */
  a: number;
  /** card → ledger: the lane the notes fall through */
  lane: number;
  /** ledger → stepper */
  c: number;
  /** stepper → title */
  d: number;
  /** title → pill */
  e: number;
}

const REGULAR: Gaps = {a: 36, lane: 40, c: 28, d: 20, e: 8};
const COMPACT: Gaps = {a: 24, lane: 24, c: 16, d: 12, e: 8};
/** Room under the pill for the two-line helper plus 8 clear of the action. */
const MIN_BOTTOM_BAND = 60;
/** The group sits a touch low: the customer's hand wraps the top. */
const DOWN_BIAS = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChipSpot {
  x: number;
  w: number;
  cx: number;
}

export interface LedgerShape {
  chips: ChipSpot[];
  /** Operator centres: "→" then "+". */
  ops: number[];
}

export interface ChargeLayout {
  W: number;
  H: number;
  pixelRatio: number;
  tier: 'regular' | 'compact' | 'tight';
  header: number;
  gaps: Gaps;
  /** The centred text column. */
  textX: number;
  textW: number;
  amountTop: number;
  card: Rect & {cx: number; cy: number; k: number};
  ledgerTop: number;
  /** Frame y of the chips' number line (where money docks). */
  numberCy: number;
  three: LedgerShape;
  two: LedgerShape;
  captionTracking: number;
  stepperTop: number;
  titleTop: number;
  paidTitleTop: number;
  pillTop: number;
  helperTop: number;
  actionTop: number;
  actionCy: number;
  /**
   * The running "Cancel" (48 dp hit box): right under the helper slot, not
   * on the bottom edge — in W0 the verbatim pill is still hidden, and from
   * the bottom slot the title-to-Cancel gap read as an empty 15 % band.
   */
  cancelTop: number;
  holdTop: number;
  /** Lock and error badges: the card's top-right corner, inset 6. */
  badge: {cx: number; cy: number};
  note: {parkTop: number; landTop: number; drop: number};
  finale: {
    cx: number;
    cy: number;
    successY: number;
    dy: number;
    floodEnd: number;
  };
  pin: {
    cardDy: number;
    ledgerDy: number;
    ledgerVisible: boolean;
    sheetTop: number;
    sheetH: number;
    rowHeight: number;
    readBadge: {cx: number; cy: number};
  };
  ios: {lift: number; statusDy: number};
  /** The empty bands (dp) above and below the centred group. */
  bands: {top: number; bottom: number};
}

function stackHeight(g: Gaps, Hc: number): number {
  return (
    AMOUNT_H +
    g.a +
    Hc +
    g.lane +
    LEDGER_H +
    g.c +
    STEPPER_H +
    g.d +
    TITLE_H +
    g.e +
    PILL_H
  );
}

function ledgerShape(
  cardX: number,
  Wc: number,
  count: 2 | 3,
  opGap: number,
): LedgerShape {
  const w = (Wc - opGap * (count - 1)) / count;
  const chips: ChipSpot[] = [];
  const ops: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = cardX + i * (w + opGap);
    chips.push({x, w, cx: x + w / 2});
    if (i < count - 1) {
      ops.push(x + w + opGap / 2);
    }
  }
  return {chips, ops};
}

export function chargeLayout(
  frame: Frame,
  options: LayoutOptions = {},
): ChargeLayout {
  const pr = options.pixelRatio ?? PixelRatio.get();
  const snap = (v: number) => Math.round(v * pr) / pr;
  /** Edges snap, widths derive from them: a row of chips ends on the card's edge. */
  const snapShape = (s: LedgerShape): LedgerShape => ({
    chips: s.chips.map(c => {
      const x0 = snap(c.x);
      const x1 = snap(c.x + c.w);
      return {x: x0, w: x1 - x0, cx: snap((x0 + x1) / 2)};
    }),
    ops: s.ops.map(snap),
  });
  const W = frame.width;
  const H = frame.height;
  const actionTop = snap(H - ACTION_BOTTOM - ACTION_H);
  const bandH = actionTop - HEADER_H;

  let Wc = Math.min(320, W - 80);
  let Hc = (Wc * ART_H) / ART_W;
  let gaps = REGULAR;
  let tier: ChargeLayout['tier'] = 'regular';
  const margin = () => (bandH - stackHeight(gaps, Hc)) / 2;
  if (margin() < MIN_BOTTOM_BAND) {
    gaps = COMPACT;
    tier = 'compact';
  }
  if (margin() < MIN_BOTTOM_BAND) {
    tier = 'tight';
    const rest = stackHeight(gaps, 0);
    const fitHc = bandH - 2 * MIN_BOTTOM_BAND - rest;
    Wc = Math.max(240, Math.min(Wc, (fitHc * ART_W) / ART_H));
    Hc = (Wc * ART_H) / ART_W;
  }
  const m = margin();
  const bias =
    tier === 'regular'
      ? Math.max(0, Math.min(DOWN_BIAS, m - MIN_BOTTOM_BAND))
      : 0;
  const G0 = HEADER_H + Math.max(16, m) + bias;

  // Every top is snapped, and everything below it is derived from the
  // snapped value — so a translate computed here lands on the same device
  // pixel Yoga puts the target view on.
  const cardX = snap((W - Wc) / 2);
  const cardW = snap(cardX + Wc) - cardX;
  const cardH = snap(Hc);
  const amountTop = snap(G0);
  const cardTop = snap(amountTop + AMOUNT_H + gaps.a);
  const cardBottom = cardTop + cardH;
  const ledgerTop = snap(cardBottom + gaps.lane);
  const stepperTop = snap(ledgerTop + LEDGER_H + gaps.c);
  const titleTop = snap(stepperTop + STEPPER_H + gaps.d);
  const pillTop = snap(titleTop + TITLE_H + gaps.e);
  const helperTop = snap(pillTop + PILL_H + 12);
  const numberCy = snap(ledgerTop + CHIP_NUMBER_TOP + CHIP_NUMBER_H / 2);

  const chipTry = (cardW - 40) / 3;
  const opGap = chipTry < 84 ? 14 : 20;
  const captionTracking = chipTry < 84 ? 0.2 : 0.6;

  const cardCx = snap(cardX + cardW / 2);
  const cardCy = snap(cardTop + cardH / 2);
  const success = successBadgeCenter(frame, pr);
  const corners: Array<[number, number]> = [
    [0, 0],
    [W, 0],
    [0, H],
    [W, H],
  ];
  const dmax = Math.max(
    ...corners.map(([x, y]) => Math.hypot(x - cardCx, y - cardCy)),
  );

  const parkTop = snap(cardBottom - 2 - NOTE_H);
  const landTop = snap(numberCy - NOTE_H / 2);

  // PIN pose: the same nodes, transformed — the card shrinks to sit 20 under
  // the amount and the ledger follows 16 under it, clear of the sheet.
  const smallH = cardH * PIN_SCALE;
  const smallW = cardW * PIN_SCALE;
  const smallTop = amountTop + AMOUNT_H + 20;
  const pinCardDy = snap(smallTop + smallH / 2 - cardCy);
  const pinLedgerTop = smallTop + smallH + 16;
  const rowHeight = H >= 760 ? 64 : 56;
  const sheetH = 24 + 26 + 16 + 14 + 12 + 20 + 16 + rowHeight * 4 + 16;
  const sheetTop = snap(H - sheetH);
  const ledgerVisible = pinLedgerTop + LEDGER_H <= sheetTop - 8;

  const textW = snap(Math.min(W - 48, 400));
  const iosLift = Math.max(0, cardTop - (HEADER_H + 80));

  return {
    W,
    H,
    pixelRatio: pr,
    tier,
    header: HEADER_H,
    gaps,
    textX: snap((W - textW) / 2),
    textW,
    amountTop,
    card: {
      x: cardX,
      y: cardTop,
      w: cardW,
      h: cardH,
      cx: cardCx,
      cy: cardCy,
      k: cardW / ART_W,
    },
    ledgerTop,
    numberCy,
    three: snapShape(ledgerShape(cardX, cardW, 3, opGap)),
    two: snapShape(ledgerShape(cardX, cardW, 2, opGap)),
    captionTracking,
    stepperTop,
    titleTop,
    paidTitleTop: snap(titleTop - (PAID_TITLE_H - TITLE_H) / 2),
    pillTop,
    helperTop,
    actionTop,
    actionCy: snap(actionTop + ACTION_H / 2),
    cancelTop: snap(Math.min(actionTop + 4, helperTop + HELPER_H + 8)),
    holdTop: snap(cardTop - HOLD_H / 2),
    badge: {cx: snap(cardX + cardW - 6), cy: snap(cardTop + 6)},
    note: {
      parkTop,
      landTop,
      drop: snap(landTop - parkTop),
    },
    finale: {
      cx: cardCx,
      cy: cardCy,
      successY: success.y,
      dy: snap(success.y - cardCy),
      floodEnd: (dmax + 2) / (FINALE_BADGE / 2),
    },
    pin: {
      cardDy: pinCardDy,
      ledgerDy: snap(pinLedgerTop - ledgerTop),
      ledgerVisible,
      sheetTop,
      sheetH,
      rowHeight,
      readBadge: {
        cx: snap(cardCx + smallW / 2),
        cy: snap(cardCy + pinCardDy - smallH / 2),
      },
    },
    ios: {
      lift: snap(iosLift),
      statusDy: snap(ledgerTop + LEDGER_H + 16 - titleTop),
    },
    bands: {
      top: amountTop - HEADER_H,
      bottom: actionTop - (pillTop + PILL_H),
    },
  };
}
