import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

import {COLOR} from './tokens';

/**
 * Every glyph on the charge stage: one <Svg> each, drawn on its own viewBox
 * and centred within ±0.4 dp. No emoji, no icon font, no black keylines.
 */

export const BackArrow = React.memo(({color = COLOR.ink}: {color?: string}) => (
  <Svg width={24} height={24} viewBox="0 0 24 24">
    <Path
      d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"
      fill={color}
    />
  </Svg>
));

export const UpArrow = React.memo(() => (
  <Svg width={12} height={12} viewBox="0 0 12 12">
    <Path
      d="M6 10V2.5M2.5 6L6 2.5L9.5 6"
      stroke={COLOR.ink}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
));

export const LockGlyph = React.memo(({open = false}: {open?: boolean}) => {
  const color = open ? COLOR.green : COLOR.ink;
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path
        d={
          open
            ? 'M8 10.5V7.5a4 4 0 0 1 7.75-1.4'
            : 'M8 10.5V7.5a4 4 0 0 1 8 0v3'
        }
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      <Rect x={5} y={10.5} width={14} height={10} rx={2.5} fill={color} />
      <Circle cx={12} cy={15.5} r={1.3} fill={COLOR.white} />
    </Svg>
  );
});

/**
 * The error mark: a red disc inside a white ring, so the red never touches
 * the green card it sits on. The "!" is the 28-unit glyph scaled 0.82 about
 * the centre (its ink spans 8.26–19.74: centred on 14).
 */
export const ErrorGlyph = React.memo(({size = 28}: {size?: number}) => (
  <Svg width={size} height={size} viewBox="0 0 28 28">
    <Circle cx={14} cy={14} r={14} fill={COLOR.white} />
    <Circle cx={14} cy={14} r={11.25} fill={COLOR.red} />
    <Rect
      x={12.975}
      y={8.26}
      width={2.05}
      height={7.38}
      rx={1.025}
      fill={COLOR.white}
    />
    <Circle cx={14} cy={18.51} r={1.23} fill={COLOR.white} />
  </Svg>
));

export const ReadCheck = React.memo(() => (
  <Svg width={20} height={20} viewBox="0 0 20 20">
    <Circle cx={10} cy={10} r={10} fill={COLOR.green} />
    <Path
      d="M6 10.2l2.6 2.6L14 7.4"
      stroke={COLOR.white}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
));

export const HomeCheck = React.memo(() => (
  <Svg width={14} height={14} viewBox="0 0 14 14">
    <Path
      d="M3 7.2l2.6 2.6L11 4.4"
      stroke={COLOR.green}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
));

/** The ledger's "→" operator. */
export const OpArrow = React.memo(({color}: {color: string}) => (
  <Svg width={12} height={10} viewBox="0 0 12 10">
    <Path
      d="M1 5h10M7 1.25L10.75 5 7 8.75"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
));

/** The ledger's "+" operator. */
export const OpPlus = React.memo(({color}: {color: string}) => (
  <Svg width={10} height={10} viewBox="0 0 10 10">
    <Path
      d="M5 1v8M1 5h8"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      fill="none"
    />
  </Svg>
));
