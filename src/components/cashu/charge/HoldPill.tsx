import React from 'react';
import {Animated, StyleSheet, View, type LayoutChangeEvent} from 'react-native';

import {HOLD_H, type ChargeLayout} from './geometry';
import {UpArrow} from './icons';
import {COLOR, ELEVATION, MAX_FONT_SCALE, TYPE} from './tokens';
import {HOLD_MAX_W, type Nodes, type Num} from './useChargeEngine';

/**
 * The instruction that straddles the card's top edge — where the physical
 * card is: "Hold the card…" before the card is seen, "Keep the card on the
 * phone" while it is worked, and "Keep holding — almost done" when a phase
 * is late.
 *
 * ONE white surface serves every variant: two half-stadiums that slide
 * together or apart (native transforms), so the pill morphs to the next
 * copy's width while the copy itself swaps by fade-through — the surface
 * never fades over the card, and two pills never overprint. Nothing on the
 * pill travels; its live dot breathes the whole time so a still hand never
 * sees a still screen. Reduce motion: whole pills crossfade instead.
 */
export type HoldVariant = 'w0' | 'keep' | 'stall';

export interface HoldPillProps {
  layout: ChargeLayout;
  n: Nodes['hold'];
  /** The variant that is the current state (for accessibility only). */
  active: HoldVariant | null;
  reduceMotion?: boolean;
}

export const HOLD_COPY: Record<HoldVariant, string> = {
  w0: 'Hold the card to the top of the phone',
  keep: 'Keep the card on the phone',
  stall: 'Keep holding — almost done',
};

const VARIANTS: HoldVariant[] = ['w0', 'keep', 'stall'];
const PAD = 14;

const LiveDot = ({n}: {n: Nodes['hold']}) => (
  <View style={styles.dotBox}>
    <Animated.View
      style={[
        styles.dotShape,
        {opacity: n.ringOpacity, transform: [{scale: n.ringScale}]},
      ]}
    />
    <Animated.View style={[styles.dotShape, {opacity: n.dot}]} />
  </View>
);

/** dot, (↑), copy — the pill's content, at its natural width. */
const Content = ({
  n,
  variant,
  onLayout,
}: {
  n: Nodes['hold'];
  variant: HoldVariant;
  onLayout?: (e: LayoutChangeEvent) => void;
}) => (
  <View style={styles.content} onLayout={onLayout}>
    <LiveDot n={n} />
    {variant === 'w0' ? (
      <View style={styles.arrow}>
        <UpArrow />
      </View>
    ) : null}
    <Animated.Text
      style={[TYPE.hold, styles.text]}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      numberOfLines={1}>
      {HOLD_COPY[variant]}
    </Animated.Text>
  </View>
);

const opacityOf = (n: Nodes['hold'], variant: HoldVariant): Num =>
  variant === 'w0' ? n.w0 : variant === 'keep' ? n.keep : n.stall;

function HoldPill({layout: L, n, active, reduceMotion = false}: HoldPillProps) {
  const a11y = (variant: HoldVariant) =>
    active === variant ? 'auto' : ('no-hide-descendants' as const);

  if (reduceMotion) {
    // Whole pills, crossfaded (fade-through): no surface motion at all.
    return (
      <>
        {VARIANTS.map(variant => (
          <Animated.View
            key={variant}
            testID={`hold-${variant}`}
            pointerEvents="none"
            importantForAccessibility={a11y(variant)}
            style={[
              styles.row,
              {top: L.holdTop, opacity: opacityOf(n, variant)},
            ]}>
            <View style={[styles.pill, styles.surface]}>
              <Content n={n} variant={variant} />
            </View>
          </Animated.View>
        ))}
      </>
    );
  }

  // Measured once, at mount (the copy is pre-mounted, hidden): the native
  // width the surface morphs to for each variant.
  const measure = (i: number) => (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) {
      n.widths[i].setValue(Math.ceil(w) + 2 * PAD);
    }
  };
  // Each half lives in its own clip that ends exactly on the centre line:
  // the halves never overlap (no double coverage while fading) and neither
  // casts its shadow across the other (no seam) — one pill, edge to edge.
  // Each clip fades as one composited layer, so a half's own shadow never
  // shows through it mid-fade.
  const half = HOLD_MAX_W / 2;
  const cx = Math.round((L.W / 2) * L.pixelRatio) / L.pixelRatio;
  return (
    <View
      style={[styles.row, {top: L.holdTop}]}
      pointerEvents="none"
      collapsable={false}>
      <Animated.View
        testID="hold-surface"
        collapsable={false}
        needsOffscreenAlphaCompositing
        style={[
          styles.clip,
          {left: cx - half - BLEED, width: half + BLEED, opacity: n.surface},
        ]}>
        <Animated.View
          style={[
            styles.surface,
            styles.left,
            {
              left: BLEED,
              width: half + OVER,
              transform: [{translateX: n.shiftL}],
            },
          ]}
        />
      </Animated.View>
      <Animated.View
        collapsable={false}
        needsOffscreenAlphaCompositing
        style={[
          styles.clip,
          {left: cx, width: half + BLEED, opacity: n.surface},
        ]}>
        <Animated.View
          style={[
            styles.surface,
            styles.right,
            {
              left: -OVER,
              width: half + OVER,
              transform: [{translateX: n.shiftR}],
            },
          ]}
        />
      </Animated.View>
      {VARIANTS.map((variant, i) => (
        <Animated.View
          key={variant}
          testID={`hold-${variant}`}
          importantForAccessibility={a11y(variant)}
          style={[styles.layer, {opacity: opacityOf(n, variant)}]}>
          <Content n={n} variant={variant} onLayout={measure(i)} />
        </Animated.View>
      ))}
    </View>
  );
}

const R = HOLD_H / 2;
/** Room round a half's outer end for its elevation shadow. */
const BLEED = 10;
/** How far a half runs past the centre line, always clipped away. */
const OVER = 4;

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: HOLD_H,
    alignItems: 'center',
  },
  pill: {
    height: HOLD_H,
    borderRadius: R,
    borderWidth: 1,
    paddingHorizontal: PAD,
    flexDirection: 'row',
    alignItems: 'center',
  },
  surface: {
    backgroundColor: COLOR.white,
    borderColor: COLOR.hairline,
    ...ELEVATION.hold,
  },
  /** A half's clip: bleeds round the outer end for the shadow, cut at the centre. */
  clip: {
    position: 'absolute',
    top: -BLEED,
    height: HOLD_H + 2 * BLEED,
    overflow: 'hidden',
  },
  left: {
    position: 'absolute',
    top: BLEED,
    height: HOLD_H,
    borderTopLeftRadius: R,
    borderBottomLeftRadius: R,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 0,
  },
  right: {
    position: 'absolute',
    top: BLEED,
    height: HOLD_H,
    borderTopRightRadius: R,
    borderBottomRightRadius: R,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderRightWidth: 1,
    borderLeftWidth: 0,
  },
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: HOLD_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {flexDirection: 'row', alignItems: 'center'},
  dotBox: {width: 6, height: 6, marginRight: 8},
  dotShape: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLOR.green,
  },
  arrow: {width: 12, height: 12, marginRight: 6},
  text: {height: 16},
});

export default React.memo(HoldPill);
