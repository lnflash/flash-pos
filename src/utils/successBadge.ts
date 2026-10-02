import {PixelRatio} from 'react-native';

/**
 * Where the Success screen's check badge sits, as a fraction of the stack
 * frame's height. The card charge's finale lands its badge on exactly this
 * point before handing over, so both screens must use this function — a
 * mismatch shows as a jump at the hand-off.
 */
export const SUCCESS_BADGE_Y = 0.34;
/** The white circle: 50 dp check + 15 dp padding each side. */
export const SUCCESS_BADGE_SIZE = 80;

export function successBadgeCenter(
  frame: {width: number; height: number},
  pixelRatio: number = PixelRatio.get(),
): {x: number; y: number} {
  const snap = (v: number) => Math.round(v * pixelRatio) / pixelRatio;
  return {x: snap(frame.width / 2), y: snap(SUCCESS_BADGE_Y * frame.height)};
}
