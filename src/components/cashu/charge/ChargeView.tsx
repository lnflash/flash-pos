import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  Dimensions,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import {SafeAreaFrameContext} from 'react-native-safe-area-context';

import PrimaryButton from '../../buttons/PrimaryButton';
import ChargeStage from './ChargeStage';
import {chargeLayout, HEADER_H, type Frame} from './geometry';
import {BackArrow} from './icons';
import {changePieces, parseFailure, pinFailureText, runningTotals} from './money';
import type {StageState} from './phaseToStation';
import PinSheet from './PinSheet';
import {COLOR, DUR, MAX_FONT_SCALE, TYPE} from './tokens';
import {useReduceMotion} from '../../../utils/reduceMotion';
import {
  floodReach,
  type Mode,
  type Nodes,
  type PlanShape,
  type Pose,
  type SegName,
} from './useChargeEngine';

/**
 * The charge screen's presentation, shared verbatim by the production screen
 * (CashuCardCharge, which owns every NFC and service call) and the DEV-only
 * preview — so what gets recorded is what ships. No redux, no navigation, no
 * services in here.
 */

export interface PlanSummary {
  /** Every unspent note on the card. */
  notes: number[];
  /** The notes this charge burns, in burn order. */
  burnSlots: number[];
  changeSat: number;
  last4: string | null;
  pinRequired: boolean;
}

export type Flow = 'tap' | 'pin' | 'done';

export interface ChargeViewProps {
  amountSat: number;
  stage: StageState;
  mode: Mode;
  flow: Flow;
  plan: PlanSummary | null;
  pin: string;
  error: string | null;
  stalled: boolean;
  nfcSupported: boolean | null;
  onBack: () => void;
  onCharge: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onPinDigit: (d: string) => void;
  onPinBackspace: () => void;
  onPinClear: () => void;
  onPinConfirm: () => void;
  onOpenNfcSettings?: () => void;
  onHeaderLongPress?: () => void;
  /** Overrides the system setting (the preview's toggle). */
  reduceMotion?: boolean;
  /** 0.5 plays everything at half speed (the preview's slow motion). */
  timeScale?: number;
  platform?: string;
  /** Preview only: a new key snaps the stage to its rest pose. */
  resetKey?: number;
  /** Preview only: off screen, so every loop and timer stops. */
  paused?: boolean;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}

export function planShape(plan: PlanSummary, amountSat: number): PlanShape {
  const three = plan.changeSat > 0;
  const segments: SegName[] = ['card'];
  if (plan.pinRequired) {
    segments.push('pin');
  }
  segments.push('pay', 'settle');
  if (three) {
    segments.push('change');
  }
  return {
    three,
    pinRequired: plan.pinRequired,
    segments,
    burns: plan.burnSlots,
    totals: runningTotals(plan.burnSlots),
    changeSat: plan.changeSat,
    pieces: changePieces(plan.changeSat),
    paidSat: amountSat,
  };
}


/**
 * The status bar over a white screen reads dark; once the flood has reached
 * the status-bar inset (its strip half in, `lightAt` ms into the finale) it
 * turns light, and stays light on Success. Pushed as a stack entry so leaving
 * the screen restores whatever was there before. One native call per mode
 * change, no render.
 */
function useChargeStatusBar(
  mode: Mode,
  timeScale: number,
  lightAt: number,
): void {
  const entryRef = useRef<ReturnType<typeof StatusBar.pushStackEntry> | null>(
    null,
  );
  useEffect(() => {
    const entry = StatusBar.pushStackEntry({
      barStyle: 'dark-content',
      animated: true,
    });
    entryRef.current = entry;
    return () => {
      StatusBar.popStackEntry(entryRef.current ?? entry);
      entryRef.current = null;
    };
  }, []);
  useEffect(() => {
    const set = (barStyle: 'dark-content' | 'light-content') => {
      if (entryRef.current) {
        entryRef.current = StatusBar.replaceStackEntry(entryRef.current, {
          barStyle,
          animated: true,
        });
      }
    };
    if (mode !== 'complete') {
      set('dark-content');
      return;
    }
    const timer = setTimeout(() => set('light-content'), lightAt / timeScale);
    return () => clearTimeout(timer);
  }, [mode, timeScale, lightAt]);
}

/** The stack card's frame, synchronously (no blank first frame on push). */
function useStageFrame(
  locked: boolean,
): [Frame, (e: LayoutChangeEvent) => void] {
  const ctx = useContext(SafeAreaFrameContext);
  const [frame, setFrame] = useState<Frame>(() => {
    if (ctx && ctx.width > 0 && ctx.height > 0) {
      return {width: ctx.width, height: ctx.height};
    }
    const win = Dimensions.get('window');
    const top = Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0;
    return {width: win.width, height: win.height - top};
  });
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    if (lockedRef.current || width <= 0 || height <= 0) {
      return;
    }
    setFrame(prev =>
      Math.abs(prev.width - width) > 0.5 || Math.abs(prev.height - height) > 0.5
        ? {width, height}
        : prev,
    );
  }, []);
  return [frame, onLayout];
}

const ChargeView = (props: ChargeViewProps) => {
  const {
    amountSat,
    stage,
    mode,
    flow,
    plan,
    pin,
    error,
    stalled,
    nfcSupported,
    timeScale = 1,
    platform = Platform.OS,
    resetKey = 0,
  } = props;

  // The layout is measured before a charge and then frozen: nothing reflows
  // while the card is on the phone.
  const [frame, onLayout] = useStageFrame(mode !== 'idle');
  const layout = useMemo(
    () => chargeLayout(frame, {platform}),
    [frame, platform],
  );

  // Reduce motion is latched per charge: a toggle mid-charge applies to the
  // next one.
  const reduceLive = useReduceMotion(props.reduceMotion);
  const [reduceMotion, setReduceMotion] = useState(reduceLive);
  useEffect(() => {
    if (mode === 'idle' && reduceMotion !== reduceLive) {
      setReduceMotion(reduceLive);
    }
  }, [mode, reduceLive, reduceMotion]);

  const pinError = mode === 'error' && flow === 'pin';
  const pose: Pose =
    flow === 'pin' && (mode === 'idle' || mode === 'error') ? 'pin' : 'run';
  const shape = useMemo(
    () => (plan ? planShape(plan, amountSat) : null),
    [plan, amountSat],
  );
  const planKey = plan
    ? `${plan.burnSlots.join(',')}|${plan.changeSat}|${
        plan.pinRequired ? 1 : 0
      }|${amountSat}`
    : null;

  const lightAt = useMemo(() => {
    if (reduceMotion) {
      return DUR.handoff - DUR.flood + 120;
    }
    const [from, to] = floodReach(layout).top;
    return (from + to) / 2;
  }, [layout, reduceMotion]);
  useChargeStatusBar(mode, timeScale, lightAt);

  // Finale: back is swallowed, the reader hears it once.
  useEffect(() => {
    if (mode !== 'complete') {
      return;
    }
    AccessibilityInfo.announceForAccessibility('Paid. You can lift the card.');
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [mode]);

  const complete = mode === 'complete';
  const header = (
    <Pressable
      style={styles.header}
      onLongPress={props.onHeaderLongPress}
      delayLongPress={600}
      accessibilityRole="header">
      <Pressable
        testID="charge-back"
        accessibilityRole="button"
        accessibilityLabel="Back"
        disabled={complete}
        onPress={props.onBack}
        style={styles.back}>
        <BackArrow />
      </Pressable>
      <Text
        style={[TYPE.header, styles.headerTitle]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        numberOfLines={1}>
        Charge by card
      </Text>
      {props.headerRight ? (
        <View style={styles.headerRight}>{props.headerRight}</View>
      ) : null}
    </Pressable>
  );

  const nfcOff = nfcSupported === false;
  const idleAction = nfcOff ? (
    props.onOpenNfcSettings ? (
      <View style={styles.primarySlot}>
        <PrimaryButton
          btnText="Open NFC settings"
          onPress={props.onOpenNfcSettings}
        />
      </View>
    ) : null
  ) : (
    <View style={styles.primarySlot}>
      <PrimaryButton
        btnText="Tap card to charge"
        disabled={amountSat <= 0}
        onPress={props.onCharge}
      />
    </View>
  );
  const cancel = (
    <View style={styles.cancelRow} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        onPress={props.onCancel}
        style={styles.cancel}>
        <Text style={TYPE.textButton} maxFontSizeMultiplier={MAX_FONT_SCALE}>
          Cancel
        </Text>
      </Pressable>
    </View>
  );
  // Two equal buttons, symmetric about the screen's one centred axis.
  const errorAction = (
    <View style={styles.errorRow}>
      <View style={styles.errorHalf}>
        <PrimaryButton
          btnText="Cancel"
          onPress={props.onCancel}
          btnStyle={styles.secondaryBtn}
          textStyle={styles.secondaryText}
        />
      </View>
      <View style={styles.errorGap} />
      <View style={styles.errorHalf}>
        <PrimaryButton btnText="Tap card again" onPress={props.onRetry} />
      </View>
    </View>
  );

  const pinErrorText = pinError
    ? pinFailureText(parseFailure(error).detail) || 'The card stopped responding.'
    : null;
  const renderSheet = useCallback(
    (sheet: Nodes['sheet'], dots: Nodes['dots']) =>
      flow === 'pin' ? (
        <PinSheet
          layout={layout}
          n={sheet}
          green={dots.green}
          pin={pin}
          errorText={pinErrorText}
          onDigit={props.onPinDigit}
          onBackspace={props.onPinBackspace}
          onClear={props.onPinClear}
          onConfirm={props.onPinConfirm}
        />
      ) : null,
    [
      flow,
      layout,
      pin,
      pinErrorText,
      props.onPinDigit,
      props.onPinBackspace,
      props.onPinClear,
      props.onPinConfirm,
    ],
  );

  return (
    <View style={styles.root} onLayout={onLayout} testID="charge-view">
      <ChargeStage
        layout={layout}
        amountSat={amountSat}
        stage={stage}
        mode={mode}
        pose={pose}
        shape={shape}
        planKey={planKey}
        last4={plan?.last4 ?? null}
        pinLength={pin.length}
        pinError={pinError}
        error={error}
        stalled={stalled}
        nfcSupported={nfcSupported}
        reduceMotion={reduceMotion}
        timeScale={timeScale}
        resetKey={resetKey}
        paused={props.paused}
        iosSession={platform === 'ios' && mode === 'running'}
        header={header}
        actions={{
          idle: idleAction,
          run: complete ? undefined : cancel,
          err: errorAction,
        }}
        renderSheet={renderSheet}>
        {props.children}
      </ChargeStage>
    </View>
  );
};

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: COLOR.page, overflow: 'hidden'},
  header: {position: 'absolute', left: 0, right: 0, top: 0, height: HEADER_H},
  back: {
    position: 'absolute',
    left: 4,
    top: 8,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    position: 'absolute',
    left: 64,
    right: 64,
    top: 20,
    height: 24,
    textAlign: 'center',
  },
  headerRight: {
    position: 'absolute',
    right: 16,
    top: 0,
    height: HEADER_H,
    justifyContent: 'center',
  },
  primarySlot: {position: 'absolute', left: 24, right: 24, top: 1.5},
  cancelRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 48,
    alignItems: 'center',
  },
  cancel: {
    width: 120,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorRow: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
  },
  errorHalf: {flex: 1},
  errorGap: {width: 12},
  // Same 53 dp as the primary: the 1.5 dp outline comes out of the padding.
  secondaryBtn: {
    backgroundColor: COLOR.white,
    borderWidth: 1.5,
    borderColor: COLOR.disabledGrey,
    paddingVertical: 13.5,
  },
  secondaryText: {color: COLOR.ink},
});

export default ChargeView;
