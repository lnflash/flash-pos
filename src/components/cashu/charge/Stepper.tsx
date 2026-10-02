import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';

import {STEPPER_H, type ChargeLayout} from './geometry';
import {COLOR, RADIUS} from './tokens';
import type {Nodes, PlanShape} from './useChargeEngine';

/**
 * A 4 dp hairline of segments, one per real stage of this card's charge.
 * No labels, no counter: a segment fills only when the next real phase
 * arrives; long waits breathe, they never creep.
 */
export interface StepperProps {
  layout: ChargeLayout;
  n: Nodes['stepper'];
  shape: PlanShape | null;
}

function Stepper({layout: L, n, shape}: StepperProps) {
  const count = shape?.segments.length ?? 0;
  const segW = count > 0 ? (L.card.w - 4 * (count - 1)) / count : 0;
  return (
    <Animated.View
      testID="stepper"
      pointerEvents="none"
      style={[
        styles.row,
        {
          left: L.card.x,
          top: L.stepperTop,
          width: L.card.w,
          opacity: n.opacity,
        },
      ]}>
      <Animated.View
        testID="stepper-single"
        style={[StyleSheet.absoluteFill, styles.segment, {opacity: n.single}]}>
        <View style={[StyleSheet.absoluteFill, styles.track]} />
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.green,
            {opacity: n.singleActive},
          ]}
        />
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.red,
            {opacity: n.singleFailed},
          ]}
        />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, {opacity: n.segmented}]}>
        {Array.from({length: count}, (_, i) => (
          <View
            key={i}
            testID={`segment-${shape?.segments[i]}`}
            style={[
              styles.segment,
              styles.placed,
              {left: i * (segW + 4), width: segW},
            ]}>
            <View style={[StyleSheet.absoluteFill, styles.track]} />
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                styles.green,
                {opacity: n.segs[i].active},
              ]}
            />
            <Animated.View
              testID={`segment-fill-${i}`}
              style={[
                StyleSheet.absoluteFill,
                styles.green,
                {
                  // Wipes from the left; under reduce motion the transform
                  // is the identity and the same layer fades in place.
                  opacity: n.segs[i].fillOpacity,
                  transform: [
                    {translateX: n.segs[i].fillX},
                    {scaleX: n.segs[i].fillScale},
                  ],
                },
              ]}
            />
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                styles.red,
                {opacity: n.segs[i].failed},
              ]}
            />
          </View>
        ))}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {position: 'absolute', height: STEPPER_H},
  segment: {
    height: STEPPER_H,
    borderRadius: RADIUS.segment,
    overflow: 'hidden',
  },
  placed: {position: 'absolute', top: 0},
  track: {backgroundColor: COLOR.track},
  green: {backgroundColor: COLOR.green},
  red: {backgroundColor: COLOR.red},
});

export default React.memo(Stepper);
