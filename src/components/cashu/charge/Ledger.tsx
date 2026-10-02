import React from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';
import Svg, {Rect} from 'react-native-svg';

import {
  CHIP_CAPTION_H,
  CHIP_CAPTION_TOP,
  CHIP_NUMBER_H,
  CHIP_NUMBER_TOP,
  LEDGER_H,
  NOTE_H,
  NOTE_W,
  type ChargeLayout,
  type ChipSpot,
} from './geometry';
import {HomeCheck, OpArrow, OpPlus} from './icons';
import {COLOR, ELEVATION, MAX_FONT_SCALE, RADIUS, TYPE} from './tokens';
import type {Nodes, Num, PlanShape} from './useChargeEngine';

/**
 * FROM CARD → PAID + CHANGE, printed under the card with its edges on the
 * card's edges. Every chip state is a pre-rendered opaque layer: the lower
 * layer stays at 1 and only the upper one fades in, so a chip never dips
 * through transparent mid-change.
 */

type ChipName = 'from' | 'paid' | 'change';
const CAPTION: Record<ChipName, string> = {
  from: 'FROM CARD',
  paid: 'PAID',
  change: 'CHANGE',
};

/** Seam-free dashes: a whole number of periods round the rounded rect. */
export function dashFor(w: number, h: number): string {
  const r = RADIUS.chip - 0.75;
  const straight = 2 * (w - 1.5 - 2 * r) + 2 * (h - 1.5 - 2 * r);
  const perimeter = straight + 2 * Math.PI * r;
  const period = perimeter / Math.max(1, Math.round(perimeter / 9));
  return `5 ${(period - 5).toFixed(3)}`;
}

const Caption = ({
  name,
  tracking,
  color = COLOR.text2,
}: {
  name: ChipName;
  tracking: number;
  color?: string;
}) => (
  <Text
    style={[TYPE.chipCaption, styles.caption, {letterSpacing: tracking, color}]}
    maxFontSizeMultiplier={MAX_FONT_SCALE}
    numberOfLines={1}>
    {CAPTION[name]}
  </Text>
);

const Number = ({
  value,
  color,
  opacity,
}: {
  value: string;
  color: string;
  opacity?: Num;
}) => (
  <Animated.Text
    style={[
      TYPE.chipNumber,
      styles.number,
      {color},
      opacity !== undefined ? {opacity} : null,
    ]}
    maxFontSizeMultiplier={MAX_FONT_SCALE}
    numberOfLines={1}>
    {value}
  </Animated.Text>
);

/** A border drawn as its own layer, so content never shifts by its width. */
const Edge = ({width, color}: {width: number; color: string}) => (
  <View
    pointerEvents="none"
    style={[
      StyleSheet.absoluteFill,
      styles.edge,
      {borderWidth: width, borderColor: color},
    ]}
  />
);

const Dashed = ({w}: {w: number}) => (
  <Svg width={w} height={LEDGER_H} style={StyleSheet.absoluteFill}>
    <Rect
      x={0.75}
      y={0.75}
      width={w - 1.5}
      height={LEDGER_H - 1.5}
      rx={RADIUS.chip - 0.75}
      stroke={COLOR.green}
      strokeWidth={1.5}
      strokeDasharray={dashFor(w, LEDGER_H)}
      fill="none"
    />
  </Svg>
);

interface ChipProps {
  spot: ChipSpot;
  entry: {opacity: Num; translateY: Num};
  tracking: number;
}

const FromChip = ({
  spot,
  entry,
  tracking,
  n,
  shape,
}: ChipProps & {n: Nodes['ledger']; shape: PlanShape}) => {
  const total = String(shape.totals[shape.totals.length - 1] ?? 0);
  return (
    <Animated.View
      testID="chip-from"
      style={[
        styles.chip,
        {
          left: spot.x,
          width: spot.w,
          opacity: entry.opacity,
          transform: [{translateY: entry.translateY}],
        },
      ]}>
      <View style={[StyleSheet.absoluteFill, styles.pending]}>
        <Edge width={1} color={COLOR.hairline} />
        <Caption name="from" tracking={tracking} />
      </View>
      <Number value={total} color={COLOR.pendingNum} opacity={n.fromPending} />
      {/* Filled: the money arrived — white, the same hairline, and the
          number turns ink. No dark keyline beside the hairline chips. */}
      <Animated.View
        testID="chip-from-filled"
        style={[
          StyleSheet.absoluteFill,
          styles.white,
          {opacity: n.fromFilled},
        ]}>
        <Edge width={1} color={COLOR.hairline} />
        <Caption name="from" tracking={tracking} />
      </Animated.View>
      <View style={styles.window} pointerEvents="none">
        {shape.burns.slice(0, n.odo.length).map((_, k) => (
          <React.Fragment key={k}>
            <Animated.Text
              style={[
                TYPE.chipNumber,
                styles.roll,
                {
                  color: COLOR.ink,
                  opacity: n.odo[k].p,
                  transform: [{translateY: n.odo[k].pY}],
                },
              ]}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={1}>
              {k === 0 ? '' : String(shape.totals[k - 1])}
            </Animated.Text>
            <Animated.Text
              testID={`odo-${k}`}
              style={[
                TYPE.chipNumber,
                styles.roll,
                {
                  color: COLOR.ink,
                  opacity: n.odo[k].n,
                  transform: [{translateY: n.odo[k].nY}],
                },
              ]}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={1}>
              {String(shape.totals[k])}
            </Animated.Text>
          </React.Fragment>
        ))}
      </View>
      <Animated.View
        testID="chip-from-spent"
        style={[StyleSheet.absoluteFill, styles.white, {opacity: n.fromSpent}]}>
        <Edge width={1} color={COLOR.hairline} />
        <Number
          value={total}
          color={COLOR.text2}
          opacity={n.fromSpentNum}
        />
        <Caption name="from" tracking={tracking} />
      </Animated.View>
    </Animated.View>
  );
};

const SettlingLayer = ({
  w,
  value,
  name,
  tracking,
  opacity,
  tint,
  numberOpacity,
}: {
  w: number;
  value: string;
  name: ChipName;
  tracking: number;
  opacity: Num;
  tint: Num;
  /** CHANGE: the number lifts off the chip as the change slip. */
  numberOpacity?: Num;
}) => (
  <Animated.View
    testID={`chip-${name}-settling`}
    style={[StyleSheet.absoluteFill, styles.white, {opacity}]}>
    <Animated.View style={[styles.tint, {opacity: tint}]} />
    <Dashed w={w} />
    <Number value={value} color={COLOR.green} opacity={numberOpacity} />
    <Caption name={name} tracking={tracking} />
  </Animated.View>
);

const PaidChip = ({
  spot,
  entry,
  tracking,
  n,
  shape,
}: ChipProps & {n: Nodes['ledger']; shape: PlanShape}) => {
  const value = String(shape.paidSat);
  return (
    <Animated.View
      testID="chip-paid"
      style={[
        styles.chip,
        {
          left: spot.x,
          width: spot.w,
          opacity: entry.opacity,
          transform: [{translateY: entry.translateY}],
        },
      ]}>
      <View style={[StyleSheet.absoluteFill, styles.pending]}>
        <Edge width={1} color={COLOR.hairline} />
        <Caption name="paid" tracking={tracking} />
      </View>
      <Number
        value={value}
        color={COLOR.pendingNum}
        opacity={shape.three ? n.paidPending3 : n.paidPending2}
      />
      <SettlingLayer
        w={spot.w}
        value={value}
        name="paid"
        tracking={tracking}
        opacity={n.paidSettling}
        tint={n.paidTint}
      />
      {/* The green is a square fill clipped round by its parent: Android
          draws a rounded background a level light (#017957 measured on the
          device); a clipped plain fill is exactly #007856. */}
      <Animated.View
        testID="chip-paid-paid"
        style={[StyleSheet.absoluteFill, styles.paid, {opacity: n.paidPaid}]}>
        <View style={[StyleSheet.absoluteFill, styles.paidFill]} />
        <Number value={value} color={COLOR.white} />
        <Caption name="paid" tracking={tracking} color={COLOR.white} />
      </Animated.View>
    </Animated.View>
  );
};

const ChangeChip = ({
  spot,
  entry,
  tracking,
  n,
  shape,
}: ChipProps & {n: Nodes['ledger']; shape: PlanShape}) => {
  const value = String(shape.changeSat);
  return (
    <Animated.View
      testID="chip-change"
      style={[
        styles.chip,
        {
          left: spot.x,
          width: spot.w,
          opacity: entry.opacity,
          transform: [{translateY: entry.translateY}],
        },
      ]}>
      <View style={[StyleSheet.absoluteFill, styles.pending]}>
        <Edge width={1} color={COLOR.hairline} />
        <Caption name="change" tracking={tracking} />
      </View>
      <Number
        value={value}
        color={COLOR.pendingNum}
        opacity={n.changePending}
      />
      <SettlingLayer
        w={spot.w}
        value={value}
        name="change"
        tracking={tracking}
        opacity={n.changeSettling}
        tint={n.changeTint}
        numberOpacity={n.changeNum}
      />
      <Animated.View
        testID="chip-change-home"
        style={[StyleSheet.absoluteFill, styles.home, {opacity: n.changeHome}]}>
        <Edge width={1.5} color={COLOR.green} />
        <View style={styles.homeRow}>
          <Text
            style={[TYPE.chipNumber, {color: COLOR.green}]}
            maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {value}
          </Text>
          <View style={styles.homeCheck}>
            <HomeCheck />
          </View>
        </View>
        <Caption name="change" tracking={tracking} />
      </Animated.View>
    </Animated.View>
  );
};

const Operator = ({
  cx,
  glyph,
  entry,
  lit,
}: {
  cx: number;
  glyph: 'arrow' | 'plus';
  entry: {opacity: Num; translateY: Num};
  lit: Num;
}) => {
  const w = glyph === 'arrow' ? 12 : 10;
  const Glyph = glyph === 'arrow' ? OpArrow : OpPlus;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.op,
        {
          left: cx - w / 2,
          width: w,
          opacity: entry.opacity,
          transform: [{translateY: entry.translateY}],
        },
      ]}>
      <Glyph color={COLOR.text2} />
      <Animated.View style={[StyleSheet.absoluteFill, {opacity: lit}]}>
        <Glyph color={COLOR.green} />
      </Animated.View>
    </Animated.View>
  );
};

const Ghost = ({
  left,
  top,
  g,
  from,
  to,
  testID,
}: {
  left: number;
  top: number;
  g: Nodes['ledger']['ghostA'];
  from: string;
  to: string;
  testID: string;
}) => (
  <Animated.View
    testID={testID}
    pointerEvents="none"
    style={[
      styles.note,
      {left, top, opacity: g.opacity, transform: [{translateX: g.translateX}]},
    ]}>
    <View style={styles.noteClip} pointerEvents="none">
      {from === to ? (
        // Exact bill: the note pays the whole of itself — nothing to roll.
        <Text
          style={[TYPE.note, styles.noteText]}
          maxFontSizeMultiplier={MAX_FONT_SCALE}>
          {from}
        </Text>
      ) : (
        <>
          <Animated.Text
            style={[
              TYPE.note,
              styles.noteText,
              {opacity: g.from, transform: [{translateY: g.fromY}]},
            ]}
            maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {from}
          </Animated.Text>
          <Animated.Text
            style={[
              TYPE.note,
              styles.noteText,
              {opacity: g.to, transform: [{translateY: g.toY}]},
            ]}
            maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {to}
          </Animated.Text>
        </>
      )}
    </View>
  </Animated.View>
);

export interface LedgerProps {
  layout: ChargeLayout;
  n: Nodes['ledger'];
  shape: PlanShape | null;
  /** Reduce motion: the split happens in place, no ghosts travel. */
  reduceMotion?: boolean;
}

function Ledger({layout, n, shape, reduceMotion = false}: LedgerProps) {
  const L = layout;
  if (!shape) {
    return null;
  }
  const spots = shape.three ? L.three : L.two;
  const [fromSpot, paidSpot, changeSpot] = spots.chips;
  const ghostTop = L.note.landTop - L.ledgerTop;
  const total = String(shape.totals[shape.totals.length - 1] ?? 0);
  return (
    <Animated.View
      testID="ledger"
      pointerEvents="none"
      collapsable={false}
      style={[
        styles.ledger,
        {
          top: L.ledgerTop,
          width: L.W,
          opacity: n.opacity,
          transform: [{translateY: n.translateY}],
        },
      ]}>
      <FromChip
        spot={fromSpot}
        entry={n.chipIn[0]}
        tracking={L.captionTracking}
        n={n}
        shape={shape}
      />
      <PaidChip
        spot={paidSpot}
        entry={n.chipIn[1]}
        tracking={L.captionTracking}
        n={n}
        shape={shape}
      />
      {shape.three && changeSpot ? (
        <ChangeChip
          spot={changeSpot}
          entry={n.chipIn[2]}
          tracking={L.captionTracking}
          n={n}
          shape={shape}
        />
      ) : null}
      <Operator
        cx={spots.ops[0]}
        glyph="arrow"
        entry={n.opIn[0]}
        lit={shape.three ? n.opLit3[0] : n.opLit2}
      />
      {shape.three ? (
        <Operator
          cx={spots.ops[1]}
          glyph="plus"
          entry={n.opIn[1]}
          lit={n.opLit3[1]}
        />
      ) : null}
      {shape.three && !reduceMotion ? (
        <Ghost
          testID="ghost-b"
          left={fromSpot.cx - NOTE_W / 2}
          top={ghostTop}
          g={n.ghostB}
          from={total}
          to={String(shape.changeSat)}
        />
      ) : null}
      {reduceMotion ? null : (
        <Ghost
          testID="ghost-a"
          left={fromSpot.cx - NOTE_W / 2}
          top={ghostTop}
          g={n.ghostA}
          from={total}
          to={String(shape.paidSat)}
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ledger: {position: 'absolute', left: 0, height: LEDGER_H},
  chip: {
    position: 'absolute',
    top: 0,
    height: LEDGER_H,
    borderRadius: RADIUS.chip,
  },
  pending: {backgroundColor: COLOR.chipPending, borderRadius: RADIUS.chip},
  white: {backgroundColor: COLOR.white, borderRadius: RADIUS.chip},
  edge: {borderRadius: RADIUS.chip},
  tint: {
    position: 'absolute',
    left: 1.5,
    right: 1.5,
    top: 1.5,
    bottom: 1.5,
    borderRadius: RADIUS.chip - 1.5,
    backgroundColor: COLOR.greenTint,
  },
  paid: {borderRadius: RADIUS.chip, overflow: 'hidden'},
  paidFill: {backgroundColor: COLOR.green},
  home: {backgroundColor: COLOR.greenTint, borderRadius: RADIUS.chip},
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: CHIP_CAPTION_TOP,
    height: CHIP_CAPTION_H,
    textAlign: 'center',
  },
  number: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: CHIP_NUMBER_TOP,
    height: CHIP_NUMBER_H,
    textAlign: 'center',
  },
  window: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: CHIP_NUMBER_TOP,
    height: CHIP_NUMBER_H,
    overflow: 'hidden',
  },
  roll: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: CHIP_NUMBER_H,
    textAlign: 'center',
  },
  homeRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: CHIP_NUMBER_TOP,
    height: CHIP_NUMBER_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeCheck: {marginLeft: 4, width: 14, height: 14},
  op: {
    position: 'absolute',
    top: CHIP_NUMBER_TOP + CHIP_NUMBER_H / 2 - 5,
    height: 10,
  },
  note: {
    position: 'absolute',
    width: NOTE_W,
    height: NOTE_H,
    borderRadius: RADIUS.note,
    backgroundColor: COLOR.white,
    borderWidth: 1,
    borderColor: COLOR.noteBorder,
    ...ELEVATION.note,
  },
  /** Inside the 1 dp border, rounded to match: clips the rolling label. */
  noteClip: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: RADIUS.note - 1,
    overflow: 'hidden',
  },
  noteText: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 4,
    height: 18,
    textAlign: 'center',
  },
});

export default React.memo(Ledger);
