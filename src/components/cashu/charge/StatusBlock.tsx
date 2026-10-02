import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';

import {
  HELPER_H,
  PAID_TITLE_H,
  PILL_H,
  TITLE_H,
  type ChargeLayout,
} from './geometry';
import {COLOR, MAX_FONT_SCALE, TYPE} from './tokens';
import type {Nodes, SlotRing} from './useChargeEngine';

/**
 * One status title, the verbatim phase in a pill (the trust surface — the
 * exact string executeCharge emitted), and a helper line. Titles and pills
 * live in three round-robin slots that crossfade with a 4 dp rise; the
 * layout never reflows. Every layer is pre-mounted; the ones that are not
 * the current state are hidden from accessibility, so a screen reader hears
 * exactly what is on screen.
 */
export interface StatusTexts {
  paidTitle: string;
  errorTitle: string;
  errorPhase: string;
  errorBody: string;
  idleHelper: string;
  notice: string | null;
}

/** Which layers are the current state (for accessibility only). */
export interface StatusShown {
  title: boolean;
  pill: boolean;
  paid: boolean;
  error: boolean;
  idle: boolean;
}

export interface StatusBlockProps {
  layout: ChargeLayout;
  n: Nodes['status'];
  titleRing: SlotRing;
  pillRing: SlotRing;
  texts: StatusTexts;
  shown: StatusShown;
  /** Re-render key: the rings mutate during render. */
  version: string;
}

/** One line of 15/20 helper copy. */
const HELPER_LINE = 20;

const a11y = (on: boolean) => (on ? 'auto' : 'no-hide-descendants');

const Pill = ({text, dot}: {text: string; dot: string}) => (
  <View style={styles.pill}>
    <View style={[styles.dot, {backgroundColor: dot}]} />
    <Animated.Text
      style={TYPE.pill}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      numberOfLines={1}>
      {text}
    </Animated.Text>
  </View>
);

function StatusBlock({
  layout: L,
  n,
  titleRing,
  pillRing,
  texts,
  shown,
}: StatusBlockProps) {
  const pillTop = L.pillTop - L.titleTop;
  const helperTop = L.helperTop - L.titleTop;
  const height = helperTop + HELPER_H;
  return (
    <Animated.View
      testID="status-block"
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[
        styles.block,
        {
          left: L.textX,
          width: L.textW,
          top: L.titleTop,
          height,
          opacity: n.opacity,
          transform: [{translateY: n.translateY}],
        },
      ]}>
      {titleRing.texts.map((text, i) => {
        const live = shown.title && i === titleRing.active;
        return (
          <Animated.Text
            key={`t${i}`}
            testID={live ? 'phase-title' : undefined}
            importantForAccessibility={a11y(live)}
            accessibilityRole={live ? 'header' : undefined}
            style={[
              TYPE.title,
              styles.line,
              {
                height: TITLE_H,
                opacity: n.titles[i].opacity,
                transform: [{translateY: n.titles[i].translateY}],
              },
            ]}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            numberOfLines={1}>
            {text ?? ''}
          </Animated.Text>
        );
      })}
      <Animated.Text
        testID="paid-title"
        importantForAccessibility={a11y(shown.paid)}
        style={[
          TYPE.paidTitle,
          styles.line,
          {
            top: L.paidTitleTop - L.titleTop,
            height: PAID_TITLE_H,
            opacity: n.paid.opacity,
            transform: [{translateY: n.paid.translateY}],
          },
        ]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        numberOfLines={1}>
        {texts.paidTitle}
      </Animated.Text>
      <Animated.Text
        testID="error-title"
        importantForAccessibility={a11y(shown.error)}
        style={[
          TYPE.errorTitle,
          styles.line,
          {
            height: TITLE_H,
            opacity: n.err.opacity,
            transform: [{translateY: n.err.translateY}],
          },
        ]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        numberOfLines={1}>
        {texts.errorTitle}
      </Animated.Text>
      {pillRing.texts.map((text, i) => {
        const live = shown.pill && i === pillRing.active;
        return (
          <Animated.View
            key={`p${i}`}
            testID={live ? 'phase-raw' : undefined}
            importantForAccessibility={a11y(live)}
            style={[
              styles.pillRow,
              {
                top: pillTop,
                opacity: n.pills[i].opacity,
                transform: [{translateY: n.pills[i].translateY}],
              },
            ]}>
            {text ? <Pill text={text} dot={COLOR.green} /> : null}
          </Animated.View>
        );
      })}
      <Animated.View
        testID="error-pill"
        importantForAccessibility={a11y(shown.error)}
        style={[
          styles.pillRow,
          {
            top: pillTop,
            opacity: n.errPill.opacity,
            transform: [{translateY: n.errPill.translateY}],
          },
        ]}>
        {texts.errorPhase ? (
          <Pill text={texts.errorPhase} dot={COLOR.red} />
        ) : null}
      </Animated.View>
      <Animated.Text
        testID="idle-helper"
        importantForAccessibility={a11y(shown.idle)}
        style={[
          TYPE.helper,
          styles.line,
          styles.helperLine,
          {top: pillTop + (PILL_H - HELPER_LINE) / 2, opacity: n.idleHelper},
        ]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        numberOfLines={1}>
        {texts.idleHelper}
      </Animated.Text>
      <Animated.Text
        testID="error-body"
        importantForAccessibility={a11y(shown.error)}
        style={[
          TYPE.helper,
          styles.line,
          styles.errorBody,
          {
            top: helperTop,
            height: HELPER_H,
            opacity: n.errBody.opacity,
            transform: [{translateY: n.errBody.translateY}],
          },
        ]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        textBreakStrategy="balanced"
        numberOfLines={2}>
        {texts.errorBody}
      </Animated.Text>
      {texts.notice ? (
        <Animated.Text
          testID="nfc-notice"
          importantForAccessibility={a11y(shown.idle)}
          style={[
            TYPE.helper,
            styles.line,
            {top: helperTop, height: HELPER_H, opacity: n.idleHelper},
          ]}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          textBreakStrategy="balanced"
          numberOfLines={2}>
          {texts.notice}
        </Animated.Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  block: {position: 'absolute'},
  line: {position: 'absolute', left: 0, right: 0, top: 0, textAlign: 'center'},
  pillRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: PILL_H,
    alignItems: 'center',
  },
  pill: {
    height: PILL_H,
    borderRadius: PILL_H / 2,
    backgroundColor: COLOR.pill,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {width: 6, height: 6, borderRadius: 3, marginRight: 6},
  errorBody: {color: COLOR.ink},
  helperLine: {height: HELPER_LINE},
});

export default React.memo(StatusBlock);
