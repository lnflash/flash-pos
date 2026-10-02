import React from 'react';
import {Animated, StyleSheet} from 'react-native';

import {map} from './cashu/charge/motion';
import {edgeTintBottom, edgeTintTop} from '../utils/edgeTint';

// Each strip's clock runs linearly across exactly the frames in which the
// flood's edge sweeps across its side of the frame (geometry-derived).
const topOpacity = map(edgeTintTop, [0, 1], [0, 1]);
const bottomOpacity = map(edgeTintBottom, [0, 1], [0, 1]);

/**
 * Two green strips behind the navigator, visible only through the status-
 * and gesture-bar insets, so the card charge's flood (and the Success screen
 * it becomes) is truly edge to edge. Opacity 0 everywhere else.
 */
const EdgeTint = () => (
  <>
    <Animated.View
      pointerEvents="none"
      style={[styles.strip, styles.top, {opacity: topOpacity}]}
    />
    <Animated.View
      pointerEvents="none"
      style={[styles.strip, styles.bottom, {opacity: bottomOpacity}]}
    />
  </>
);

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 160,
    backgroundColor: '#007856',
  },
  top: {top: 0},
  bottom: {bottom: 0},
});

export default EdgeTint;
