import React from 'react';
import {Animated, StyleSheet} from 'react-native';

import {NOTE_H, NOTE_W, type ChargeLayout} from './geometry';
import {COLOR, ELEVATION, MAX_FONT_SCALE, RADIUS, TYPE} from './tokens';
import type {Nodes, PlanShape} from './useChargeEngine';

/**
 * The notes that leave the card and the change slips that go back. They sit
 * BELOW the card in z-order, so a note emerges from behind the card's bottom
 * edge (in its shadow) and a slip disappears behind it. Pre-mounted pools:
 * gestures never mount, unmount or re-key a view.
 */
export interface MoneyPoolProps {
  layout: ChargeLayout;
  n: Nodes['pool'];
  shape: PlanShape | null;
  /** Reduce motion: money changes state in place, nothing travels. */
  reduceMotion?: boolean;
}

function MoneyPool({
  layout: L,
  n,
  shape,
  reduceMotion = false,
}: MoneyPoolProps) {
  if (!shape || reduceMotion) {
    return null;
  }
  const spots = shape.three ? L.three : L.two;
  const fromX = spots.chips[0].cx - NOTE_W / 2;
  const changeX = shape.three ? L.three.chips[2].cx - NOTE_W / 2 : 0;
  return (
    <Animated.View
      pointerEvents="none"
      collapsable={false}
      style={[
        StyleSheet.absoluteFill,
        {transform: [{translateY: n.translateY}]},
      ]}>
      {shape.burns.slice(0, n.notes.length).map((amount, k) => (
        <Animated.View
          key={`note-${k}`}
          testID={`note-${k}`}
          style={[
            styles.money,
            styles.note,
            {
              left: fromX,
              top: L.note.landTop,
              opacity: n.notes[k].opacity,
              transform: [{translateY: n.notes[k].translateY}],
            },
          ]}>
          <Animated.Text
            style={[TYPE.note, styles.label]}
            maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {String(amount)}
          </Animated.Text>
        </Animated.View>
      ))}
      {shape.three
        ? shape.pieces.slice(0, n.slips.length).map((amount, k) => (
            <Animated.View
              key={`slip-${k}`}
              testID={`slip-${k}`}
              style={[
                styles.money,
                styles.slip,
                {
                  left: changeX,
                  top: L.note.landTop,
                  opacity: n.slips[k].opacity,
                  transform: [
                    {translateY: n.slips[k].translateY},
                    {scale: n.slips[k].scale},
                  ],
                },
              ]}>
              <Animated.Text
                style={[TYPE.note, styles.label, styles.slipLabel]}
                maxFontSizeMultiplier={MAX_FONT_SCALE}>
                {String(amount)}
              </Animated.Text>
            </Animated.View>
          ))
        : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  money: {
    position: 'absolute',
    width: NOTE_W,
    height: NOTE_H,
    borderRadius: RADIUS.note,
    borderWidth: 1,
    ...ELEVATION.note,
  },
  note: {backgroundColor: COLOR.white, borderColor: COLOR.noteBorder},
  slip: {backgroundColor: COLOR.greenTint, borderColor: COLOR.slipBorder},
  label: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 4,
    height: 18,
    textAlign: 'center',
  },
  slipLabel: {color: COLOR.green},
});

export default React.memo(MoneyPool);
