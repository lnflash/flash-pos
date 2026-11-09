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
 * top of the phone: the Cashu Card face, drawn by the shared card art
 * (one <Svg>, drawn once). On top of it, inside the card's clip, only what
 * the charge animates: the chip-side contactless arcs, the masked id, the
 * sheen, the change glow and the finale dim. Mounted once; nothing in here
 * re-renders during a charge.
 */

const ARC = CARD_ART.chipArcs;
const ARC_BOX = `${ARC.box.x} ${ARC.box.y} ${ARC.box.w} ${ARC.box.h}`;
/**
 * Each arc node rests at ARC_REST and pulses up to 1: this peak makes the
 * resting arc read exactly the art's chipArcs.restOpacity (60 %). The
 * provisioner's PNG draws its arcs opaque; whether the art follows it is the
 * owner's call on flash-mobile#829, which owns the shared art file.
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
      stroke={CARD.ink}
      strokeWidth={ARC.width}
      strokeOpacity={ARC_PEAK}
      strokeLinecap="round"
      fill="none"
    />
  </Svg>
));

const SHEEN_W = 70;
const GLOW_H = 14;
/** The glow fades in over this many dp from the card's left edge. */
const GLOW_FADE = 16;

/** A soft raking light: the card is printed matte, so never a gloss streak. */
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
 * The change slip's light: an app signal, never card art. The face is green
 * from limeMid at the left to greenDeep at the right, so app green would melt
 * into it (1.41:1 on greenDeep): the glow is a white wash over a white rule
 * set on a CARD.ink underlay, which separates from the field at every x (ink
 * on the field 3.08:1 or more, white on ink 12:1). It spans the card's whole
 * width and fades in over GLOW_FADE from the left edge, so it never starts on
 * a hard line at the rounded corner. The fade is a mask, drawn once into the
 * glow's bitmap with the rest of it.
 */
const GlowArt = React.memo(() => (
  <Svg width="100%" height="100%">
    <Defs>
      <LinearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={COLOR.white} stopOpacity={0} />
        <Stop offset="1" stopColor={COLOR.white} stopOpacity={0.35} />
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
      <Rect x="0" y="0" width="100%" height="11" fill="url(#glow)" />
      <Rect x="0" y="11" width="100%" height="1" fill={CARD.ink} />
      <Rect x="0" y="12" width="100%" height="2" fill={COLOR.white} />
    </G>
  </Svg>
));

/**
 * The masked id sits in the face's empty bottom-right slot (CARD_ART.idSlot)
 * as part of the card: it scales with it (TYPE.cardId is its size at k = 1)
 * and never with the font scale. It is the only on-screen confirmation of
 * which card was tapped, so it prints in the mark's ink at full opacity
 * (CARD.id, 4.05:1 on the greenDeep corner it sits on). At 12 dp its cap is
 * ~1.35x the caption's (idSlot.capRef), so it is not quieter than
 * CASHU ECASH CARD; the art's capRef contract would put it at 8.5 dp or less
 * at k = 1, which is the owner's call from the device pass. Its ink ends on
 * the slot's right edge, the caption's left margin mirrored (Android sets no
 * trailing letter-space), and its row is centred on the caption's mid-line.
 * The card's accessibilityLabel carries the id for screen readers.
 */
const ID_SLOT = CARD_ART.idSlot;
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
            right: (CARD_ART.width - ID_SLOT.right) * k,
            top: (ID_SLOT.centerY - ID_ROW / 2) * k,
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
        style={[styles.abs, styles.glow, {width: w, opacity: n.glow}]}>
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
  glow: {left: 0, bottom: 0, height: GLOW_H},
  idRow: {justifyContent: 'center'},
  dim: {backgroundColor: CARD.dim},
});

export default React.memo(EcashCard);
