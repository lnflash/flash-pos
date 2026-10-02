import React from 'react';
import {Animated, StyleSheet, Text, type TextStyle} from 'react-native';
import Svg, {
  Defs,
  G,
  LinearGradient,
  Mask,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import {CARD_ART, CardArtV2} from './cardArtV2';
import type {ChargeLayout} from './geometry';
import {CARD, COLOR, TYPE} from './tokens';
import {ARC_REST, type Nodes} from './useChargeEngine';

/**
 * The customer's eCash card — the visual twin of the one held behind the
 * top of the phone: Flash Card v2 "Bearer", drawn by the shared card art
 * (one <Svg>, drawn once). On top of it, inside the card's clip, only what
 * the charge animates: the chip-side contactless arcs, the masked id, the
 * sheen, the change glow and the finale dim. Mounted once; nothing in here
 * re-renders during a charge.
 */

const ARC = CARD_ART.chipArcs;
const ARC_BOX = `${ARC.box.x} ${ARC.box.y} ${ARC.box.w} ${ARC.box.h}`;
/**
 * Each arc node rests at ARC_REST and pulses up to 1: this peak makes the
 * resting arc read exactly the printed card's 60 %.
 */
const ARC_PEAK = ARC.restOpacity / ARC_REST;

/**
 * Every <Svg> here fills a sized parent: react-native-svg truncates a
 * numeric width or height to whole dp, which shrank the arcs by up to 6 %.
 */
const Arc = React.memo(({d}: {d: string}) => (
  <Svg width="100%" height="100%" viewBox={ARC_BOX}>
    <Path
      d={d}
      stroke={CARD.orange}
      strokeWidth={ARC.width}
      strokeOpacity={ARC_PEAK}
      strokeLinecap="round"
      fill="none"
    />
  </Svg>
));

const SHEEN_W = 70;
const GLOW_H = 14;
/** The glow fades in over this many dp from the slash's tip. */
const GLOW_FADE = 16;

/** A soft raking light: the card is matte, so never a gloss streak. */
const SheenArt = React.memo(() => (
  <Svg width="100%" height="100%">
    <Defs>
      <LinearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
        <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.08} />
        <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
      </LinearGradient>
    </Defs>
    <Rect x="0" y="0" width="100%" height="100%" fill="url(#sheen)" />
  </Svg>
));

/**
 * The change slip's light: an app signal, so app green, never card art. It
 * starts at the slash's tip and fades in over GLOW_FADE, so the green never
 * mixes with the card's orange (over the slash it read olive). The fade is a
 * mask, drawn once into the glow's bitmap with the rest of it.
 */
const GlowArt = React.memo(() => (
  <Svg width="100%" height="100%">
    <Defs>
      <LinearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={COLOR.green} stopOpacity={0} />
        <Stop offset="1" stopColor={COLOR.green} stopOpacity={0.35} />
      </LinearGradient>
      <LinearGradient
        id="glowIn"
        gradientUnits="userSpaceOnUse"
        x1={0}
        y1={0}
        x2={GLOW_FADE}
        y2={0}>
        <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
        <Stop offset="1" stopColor="#ffffff" stopOpacity={1} />
      </LinearGradient>
      <Mask id="glowMask">
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glowIn)" />
      </Mask>
    </Defs>
    <G mask="url(#glowMask)">
      <Rect x="0" y="0" width="100%" height="12" fill="url(#glow)" />
      <Rect x="0" y="12" width="100%" height="2" fill={COLOR.green} />
    </G>
  </Svg>
));

/**
 * The masked id sits in the physical card's empty top-right slot as part of
 * the card: it scales with it (TYPE.cardId is its size at k = 1) and never
 * with the font scale, so at every size it stays quieter than FLASH (its cap
 * is ~0.78 of FLASH's) instead of reading as a printed card number. Its ink
 * ends on FLASH's right edge (Android sets no trailing letter-space) and its
 * row is centred on the chip's mid-line. The card's accessibilityLabel
 * carries the id for screen readers.
 */
const CHIP_MID = CARD_ART.plate.y + CARD_ART.plate.h / 2;
const ID_ROW = 28;

export function cardIdStyle(k: number): TextStyle {
  const {fontSize = 12, lineHeight = 16, letterSpacing = 0} = TYPE.cardId;
  return {
    ...TYPE.cardId,
    fontSize: fontSize * k,
    lineHeight: lineHeight * k,
    letterSpacing: letterSpacing * k,
  };
}

export interface EcashCardProps {
  layout: ChargeLayout;
  n: Nodes['card'];
  last4: string | null;
}

function EcashCard({layout, n, last4}: EcashCardProps) {
  const {w, h, k} = layout.card;
  const box = {
    left: ARC.box.x * k,
    top: ARC.box.y * k,
    width: ARC.box.w * k,
    height: ARC.box.h * k,
  };
  const idStyle = React.useMemo(() => cardIdStyle(k), [k]);
  const glowLeft = CARD_ART.slash.tipX * k;
  return (
    <>
      <CardArtV2 staticArcs={false} />
      {ARC.d.map((d, i) => (
        <Animated.View
          key={d}
          testID={`card-arc-${i}`}
          style={[styles.abs, box, {opacity: n.arcs[i]}]}>
          <Arc d={d} />
        </Animated.View>
      ))}
      <Animated.View
        testID="card-id-row"
        pointerEvents="none"
        style={[
          styles.abs,
          styles.idRow,
          {
            right: (CARD_ART.width - CARD_ART.flash.inkRight) * k,
            top: (CHIP_MID - ID_ROW / 2) * k,
            height: ID_ROW * k,
            opacity: n.last4,
          },
        ]}>
        <Text
          testID="card-id"
          style={idStyle}
          maxFontSizeMultiplier={1}
          numberOfLines={1}>
          {last4 ? `•••• ${last4}` : ''}
        </Text>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.abs,
          styles.sheen,
          {
            top: -h / 2,
            height: 2 * h,
            opacity: n.sheenOpacity,
            transform: [{translateX: n.sheenX}, {rotate: '18deg'}],
          },
        ]}>
        <SheenArt />
      </Animated.View>
      <Animated.View
        testID="card-glow"
        pointerEvents="none"
        style={[
          styles.abs,
          styles.glow,
          {left: glowLeft, width: w - glowLeft, opacity: n.glow},
        ]}>
        <GlowArt />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.dim, {opacity: n.dim}]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  abs: {position: 'absolute'},
  /** 70 dp band, centred on x = 0 before its translateX. */
  sheen: {left: -SHEEN_W / 2, width: SHEEN_W},
  glow: {bottom: 0, height: GLOW_H},
  idRow: {justifyContent: 'center'},
  dim: {backgroundColor: CARD.dim},
});

export default React.memo(EcashCard);
