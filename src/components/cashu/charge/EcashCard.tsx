import React from 'react';
import {Animated, StyleSheet} from 'react-native';
import Svg, {
  Defs,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import {ART_H, ART_W, type ChargeLayout} from './geometry';
import {COLOR, MAX_FONT_SCALE, TYPE} from './tokens';
import type {Nodes} from './useChargeEngine';

/**
 * The Flash bolt, as vector: the brand's own on-dark artwork (Flashy's
 * flash-bolt-on-dark.svg, viewBox 0 0 236.5 366) with only its green offset
 * and yellow face. logo.png carries a black offset layer that reads as a
 * black sticker keyline on the dark card, and the on-dark file's white back
 * layer reads as a white one; the green offset alone is the mark on dark.
 * Vector, so it is drawn inside the card's one <Svg>: crisp at any density
 * and never a late-decoding Image.
 */
const BOLT_GREEN =
  'M103,355c-11.8-3.1-21.4-11.1-26.8-22-5.1-10.1-6-22.6-1.5-33.1l15.3-33,17.8-37.6c.3-.7-.1-1.6-.4-2.1s-1-.9-1.9-.9h-40.8c-9,0-17.4-2.6-24.7-7.9-5-3.6-9.1-8.1-12.3-13.4-5.6-9.4-7.3-21.3-4.3-31.8l4.3-14.8L59.7,46.4c4.3-20.8,21.7-34.8,42.9-34.2,14.7.4,28.3,8.2,35.6,21,5.7,10,6.7,21.9,3.5,32.9l-6.6,22.7-15.4,51.9c-.2.8-.3,1.5.2,2.1s1,1.1,1.9,1.1h53.6c5.7,0,11,1.7,16,4,13.5,6.2,22.4,19.3,23.8,34,.8,8.4-.9,16.3-4.6,23.7l-8.2,17.8-50.5,108.9c-8.4,18.2-29.3,27.9-48.8,22.7Z';
const BOLT_YELLOW =
  'M124.1,342.8c-11.8-3.1-21.4-11.1-26.8-22-5.1-10.1-6-22.6-1.5-33.1l15.3-33,17.8-37.6c.3-.7-.1-1.6-.4-2.1s-1-.9-1.9-.9h-40.8c-9,0-17.4-2.6-24.7-7.9-5-3.6-9.1-8.1-12.3-13.4-5.6-9.4-7.3-21.3-4.3-31.8l4.3-14.8,32.1-112C85.2,13.5,102.6-.5,123.8,0c14.7.4,28.3,8.2,35.6,21,5.7,10,6.7,21.9,3.5,32.9l-6.6,22.7-15.4,51.9c-.2.8-.3,1.5.2,2.1s1,1.1,1.9,1.1h53.6c5.7,0,11,1.7,16,4,13.5,6.2,22.4,19.3,23.8,34,.8,8.4-.9,16.3-4.6,23.7l-8.2,17.8-50.5,108.9c-8.4,18.2-29.3,27.9-48.8,22.7Z';
/** Ink of the two layers in bolt units (measured): x 21.9–236.5, y 0–356.4. */
const BOLT_INK = {x: 21.9, w: 214.6, h: 356.4};
/** The mark's ink: 32 artboard units tall, its left edge on the card's x = 20. */
const BOLT_SCALE = 32 / BOLT_INK.h;
export const BOLT_INK_W = BOLT_INK.w * BOLT_SCALE;
const BOLT_X = 20 - BOLT_INK.x * BOLT_SCALE;
/** Artboard y of the logo row's top: 20 units under the card's top edge (59). */
const BOLT_Y = 79;

/**
 * The customer's eCash card — the visual twin of the one held behind the
 * top of the phone. One <Svg> for the art (never a nested <Svg x y>: Android
 * ignores the offset), React Native children for the logo and text, and
 * three overlays inside the card's clip: the sheen, the change glow and the
 * finale dim. Mounted once; nothing in here re-renders during a charge.
 */

/** Etched streamlines: something for the sheen to rake, at zero runtime. */
const STREAMLINES = Array.from({length: 8}, (_, k) => {
  const o = 20 * k;
  return `M -10 ${153 + o} C 60 ${103 + o}, 120 ${203 + o}, 190 ${
    133 + o
  } C 260 ${63 + o}, 290 ${63 + o}, 332 ${113 + o}`;
}).join(' ');

export const CardArt = React.memo(
  ({width, height}: {width: number; height: number}) => (
    <Svg width={width} height={height} viewBox={`0 59 ${ART_W} ${ART_H}`}>
      <Defs>
        <LinearGradient
          id="cardBase"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="59"
          x2="320"
          y2="261">
          <Stop offset="0" stopColor={COLOR.cardTop} />
          <Stop offset="1" stopColor={COLOR.cardBottom} />
        </LinearGradient>
        <RadialGradient
          id="cardHi"
          gradientUnits="userSpaceOnUse"
          cx="56"
          cy="67"
          fx="56"
          fy="67"
          r="250">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.1} />
          <Stop offset="0.55" stopColor="#ffffff" stopOpacity={0.03} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
        <LinearGradient
          id="cardGold"
          gradientUnits="userSpaceOnUse"
          x1="20"
          y1="131.5"
          x2="61"
          y2="162.5">
          <Stop offset="0" stopColor={COLOR.chipGoldA} />
          <Stop offset="1" stopColor={COLOR.chipGoldB} />
        </LinearGradient>
      </Defs>
      <Rect
        x="0"
        y="59"
        width="320"
        height="202"
        rx="16.25"
        fill="url(#cardBase)"
      />
      <Path
        d={STREAMLINES}
        stroke="#ffffff"
        strokeOpacity={0.05}
        strokeWidth={0.8}
        fill="none"
      />
      <Rect
        x="0"
        y="59"
        width="320"
        height="202"
        rx="16.25"
        fill="url(#cardHi)"
      />
      <Rect
        x="0.5"
        y="59.5"
        width="319"
        height="201"
        rx="15.75"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.08}
        strokeWidth={1}
      />
      <G>
        <Rect
          x="20"
          y="131.5"
          width="41"
          height="31"
          rx="6"
          fill="url(#cardGold)"
          stroke={COLOR.chipEdge}
          strokeOpacity={0.35}
          strokeWidth={0.75}
        />
        <Path
          d="M33.67 131.5V162.5 M47.33 131.5V162.5 M20 141.83H33.67 M47.33 141.83H61 M20 152.17H33.67 M47.33 152.17H61"
          stroke={COLOR.chipLine}
          strokeOpacity={0.55}
          strokeWidth={0.9}
          fill="none"
        />
      </G>
      <G
        transform={`translate(${BOLT_X} ${BOLT_Y}) scale(${BOLT_SCALE})`}>
        <Path d={BOLT_GREEN} fill={COLOR.boltGreen} />
        <Path d={BOLT_YELLOW} fill={COLOR.boltYellow} />
      </G>
    </Svg>
  ),
);

const ARC_PATHS = [
  'M282.95 90.05A7 7 0 0 1 282.95 99.95',
  'M287.19 85.81A13 13 0 0 1 287.19 104.19',
  'M291.43 81.57A19 19 0 0 1 291.43 108.43',
];

const Arc = React.memo(({d, w, h}: {d: string; w: number; h: number}) => (
  <Svg width={w} height={h} viewBox="276 75 24 40">
    <Path
      d={d}
      stroke="#ffffff"
      strokeWidth={2}
      strokeLinecap="round"
      fill="none"
    />
  </Svg>
));

const SHEEN_W = 70;
const GLOW_H = 14;

const SheenArt = React.memo(({height}: {height: number}) => (
  <Svg width={SHEEN_W} height={height}>
    <Defs>
      <LinearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
        <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.16} />
        <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
      </LinearGradient>
    </Defs>
    <Rect x="0" y="0" width={SHEEN_W} height={height} fill="url(#sheen)" />
  </Svg>
));

const GlowArt = React.memo(({width}: {width: number}) => (
  <Svg width={width} height={GLOW_H}>
    <Defs>
      <LinearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={COLOR.green} stopOpacity={0} />
        <Stop offset="1" stopColor={COLOR.green} stopOpacity={0.35} />
      </LinearGradient>
    </Defs>
    <Rect x="0" y="0" width={width} height="12" fill="url(#glow)" />
    <Rect x="0" y="12" width={width} height="2" fill={COLOR.green} />
  </Svg>
));

const Last4 = React.memo(
  ({
    text,
    opacity,
    left,
    top,
  }: {
    text: string;
    opacity: Animated.AnimatedInterpolation<number> | Animated.Value;
    left: number;
    top: number;
  }) => (
    <Animated.Text
      style={[TYPE.cardLast4, styles.abs, {left, top, opacity}]}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      numberOfLines={1}>
      {text}
    </Animated.Text>
  ),
);

export interface EcashCardProps {
  layout: ChargeLayout;
  n: Nodes['card'];
  last4: string | null;
}

function EcashCard({layout, n, last4}: EcashCardProps) {
  const {w, h, k} = layout.card;
  const edge = 20 * k;
  // The wordmark sits 10 dp right of the bolt's ink, centred on its row.
  const brandLeft = (20 + BOLT_INK_W) * k + 10;
  const rowMid = (BOLT_Y - 59 + 16) * k;
  const arcW = 24 * k;
  const arcH = 40 * k;
  return (
    <>
      <CardArt width={w} height={h} />
      <Animated.Text
        style={[
          TYPE.cardBrand,
          styles.abs,
          {left: brandLeft, top: rowMid - 10, opacity: n.brand},
        ]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        numberOfLines={1}>
        eCash
      </Animated.Text>
      <Last4
        text={last4 ? `•••• ${last4}` : ''}
        opacity={n.last4}
        left={edge}
        top={h - 18 * k - 18}
      />
      {ARC_PATHS.map((d, i) => (
        <Animated.View
          key={d}
          testID={`card-arc-${i}`}
          style={[
            styles.abs,
            {
              left: 276 * k,
              top: 16 * k,
              width: arcW,
              height: arcH,
              opacity: n.arcs[i],
            },
          ]}>
          <Arc d={d} w={arcW} h={arcH} />
        </Animated.View>
      ))}
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
        <SheenArt height={2 * h} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.abs, styles.glow, {width: w, opacity: n.glow}]}>
        <GlowArt width={w} />
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
  dim: {backgroundColor: COLOR.ink},
});

export default React.memo(EcashCard);
