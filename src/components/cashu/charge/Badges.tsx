import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';

import {BADGE, READ_BADGE, type ChargeLayout} from './geometry';
import {ErrorGlyph, LockGlyph, ReadCheck} from './icons';
import {COLOR, ELEVATION} from './tokens';
import type {Nodes} from './useChargeEngine';

/**
 * The card's corner badges: the PIN lock (closed, then open on the first
 * burn), the error "!", and — in the PIN pose — the green "card read" check
 * on the small card's corner (swapped for the error mark when the PIN
 * attempt failed).
 */
export interface BadgesProps {
  layout: ChargeLayout;
  lock: Nodes['lock'];
  errBadge: Nodes['errBadge'];
  readBadge: Nodes['readBadge'];
  pinErrBadge: Nodes['pinErrBadge'];
}

function Badges({
  layout: L,
  lock,
  errBadge,
  readBadge,
  pinErrBadge,
}: BadgesProps) {
  const at = (cx: number, cy: number, size: number) => ({
    left: cx - size / 2,
    top: cy - size / 2,
    width: size,
    height: size,
  });
  return (
    <>
      <Animated.View
        testID="lock-badge"
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.badge,
          styles.white,
          at(L.badge.cx, L.badge.cy, BADGE),
          {opacity: lock.opacity, transform: [{scale: lock.scale}]},
        ]}>
        <View style={[StyleSheet.absoluteFill, styles.circle, styles.white]}>
          <LockGlyph />
        </View>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.circle,
            styles.tint,
            {opacity: lock.open},
          ]}>
          <LockGlyph open />
        </Animated.View>
      </Animated.View>
      <Animated.View
        testID="error-badge"
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.badge,
          styles.white,
          at(L.badge.cx, L.badge.cy, BADGE),
          {opacity: errBadge.opacity, transform: [{scale: errBadge.scale}]},
        ]}>
        <ErrorGlyph />
      </Animated.View>
      <Animated.View
        testID="read-badge"
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.abs,
          at(L.pin.readBadge.cx, L.pin.readBadge.cy, READ_BADGE),
          {opacity: readBadge.opacity},
        ]}>
        <ReadCheck />
      </Animated.View>
      <Animated.View
        testID="pin-error-badge"
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.abs,
          at(L.pin.readBadge.cx, L.pin.readBadge.cy, READ_BADGE),
          {opacity: pinErrBadge.opacity},
        ]}>
        <ErrorGlyph size={READ_BADGE} />
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  abs: {position: 'absolute'},
  badge: {position: 'absolute', borderRadius: BADGE / 2, ...ELEVATION.badge},
  circle: {
    borderRadius: BADGE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLOR.hairline,
  },
  // The error badge is white too: its glyph draws the red disc inside a
  // white ring, so red never sits on the green card.
  white: {backgroundColor: COLOR.white},
  tint: {backgroundColor: COLOR.greenTint, borderColor: COLOR.greenTint},
});

export default React.memo(Badges);
