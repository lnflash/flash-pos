import React from 'react';
import {Animated, Pressable, StyleSheet, Text, View} from 'react-native';

import PinPad, {PIN_MAX_LENGTH, PIN_MIN_LENGTH} from '../PinPad';
import {SHEET_RADIUS, type ChargeLayout} from './geometry';
import {COLOR, ELEVATION, MAX_FONT_SCALE, TYPE} from './tokens';
import type {Nodes} from './useChargeEngine';

/**
 * The PIN sheet: the same screen, transformed — the card shrinks above it,
 * the sheet owns the bottom. Dots turn green at four digits and the helper
 * says what happens next, so "hold" and "lift" never share the screen.
 */
export interface PinSheetProps {
  layout: ChargeLayout;
  n: Nodes['sheet'];
  green: Nodes['dots']['green'];
  pin: string;
  errorText: string | null;
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onConfirm: () => void;
}

const DOT = 14;

function Dots({pin, green}: {pin: string; green: PinSheetProps['green']}) {
  const count = Math.min(PIN_MAX_LENGTH, Math.max(PIN_MIN_LENGTH, pin.length));
  return (
    <View style={styles.dots} testID="pin-dots">
      {Array.from({length: count}, (_, i) => {
        const filled = i < pin.length;
        return (
          <View
            key={i}
            style={[styles.dot, filled ? styles.dotFilled : styles.dotEmpty]}>
            {filled ? (
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  styles.dotGreen,
                  {opacity: green},
                ]}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function PinSheet({
  layout: L,
  n,
  green,
  pin,
  errorText,
  onDigit,
  onBackspace,
  onClear,
  onConfirm,
}: PinSheetProps) {
  const helper =
    pin.length === PIN_MIN_LENGTH ? 'Now hold the card to the phone again' : '';
  return (
    <View
      style={[styles.sheet, {top: L.pin.sheetTop, height: L.pin.sheetH}]}
      testID="pin-sheet">
      <Text
        style={[TYPE.sheetTitle, styles.title]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}>
        Enter the card PIN
      </Text>
      <Dots pin={pin} green={green} />
      <View style={styles.helperSlot}>
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.center, {opacity: n.helper}]}>
          {pin.length > PIN_MIN_LENGTH ? (
            <Pressable
              accessibilityRole="button"
              onPress={onConfirm}
              hitSlop={14}
              style={styles.center}>
              <Text
                style={[TYPE.textButton, styles.chargeNow]}
                maxFontSizeMultiplier={MAX_FONT_SCALE}>
                Charge now
              </Text>
            </Pressable>
          ) : (
            <Text
              style={TYPE.helper}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={1}>
              {helper}
            </Text>
          )}
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.center,
            {opacity: n.errHelper},
          ]}>
          <Text
            style={[TYPE.helper, styles.errorText]}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            numberOfLines={1}>
            {errorText ?? ''}
          </Text>
        </Animated.View>
      </View>
      <View style={[styles.pad, {height: L.pin.rowHeight * 4}]}>
        <PinPad
          tone="ink"
          rowHeight={L.pin.rowHeight}
          onDigit={onDigit}
          onBackspace={onBackspace}
          onClear={onClear}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: COLOR.white,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingHorizontal: 24,
    ...ELEVATION.sheet,
  },
  title: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: 24,
    height: 26,
    textAlign: 'center',
  },
  dots: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 66,
    height: DOT,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    marginHorizontal: 6,
    overflow: 'hidden',
  },
  dotEmpty: {
    borderWidth: 1.5,
    borderColor: COLOR.disabledGrey,
    backgroundColor: COLOR.white,
  },
  dotFilled: {backgroundColor: COLOR.ink},
  dotGreen: {backgroundColor: COLOR.green},
  helperSlot: {position: 'absolute', left: 24, right: 24, top: 92, height: 20},
  center: {alignItems: 'center', justifyContent: 'center'},
  chargeNow: {fontFamily: 'Outfit-SemiBold', color: COLOR.ink},
  errorText: {color: COLOR.red},
  pad: {position: 'absolute', left: 24, right: 24, top: 128},
});

export default React.memo(PinSheet);
