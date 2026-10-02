import React, {
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {NavigationContext} from '@react-navigation/native';
import {SafeAreaFrameContext} from 'react-native-safe-area-context';

import ChargeView, {
  type Flow,
  type PlanSummary,
} from '../components/cashu/charge/ChargeView';
import {snapTo, toward} from '../components/cashu/charge/motion';
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  type Scenario,
  type ScriptStep,
} from '../components/cashu/charge/previewScript';
import {
  INITIAL_STAGE,
  mapPhase,
  type StageState,
} from '../components/cashu/charge/phaseToStation';
import {COLOR} from '../components/cashu/charge/tokens';
import type {Mode} from '../components/cashu/charge/useChargeEngine';
import {usePhaseScript} from '../components/cashu/charge/usePhaseScript';
import {
  STALL_MS,
  useStallTimer,
} from '../components/cashu/charge/useStallTimer';
import {hideEdgeTint} from '../utils/edgeTint';
import {HANDOFF_MS, handOffToSuccess} from '../utils/chargeHandoff';
import {formatSatAmount} from '../utils/satCurrency';
import SealCheck from '../components/icons/SealCheck';
import {SUCCESS_BADGE_SIZE, successBadgeCenter} from '../utils/successBadge';

/**
 * DEV ONLY — registered under __DEV__ in src/routes/index.tsx and reached
 * from the __DEV__ row in Settings. Replays the card charge's exact phase
 * strings on real timings through the production ChargeView, so the
 * choreography can be recorded and judged with no card, NFC or mint. It
 * imports no NFC, charge or settlement service and dispatches no redux.
 * Only its "→ Success" hand-off proof (off by default) leaves the screen: it
 * takes the production hand-off to Success with `preview: true`, so Success
 * also skips its NFC toggle, store reads and writes, and printing.
 */

interface PreviewState {
  scenario: Scenario;
  mode: Mode;
  stage: StageState;
  seq: number;
  plan: PlanSummary | null;
  flow: Flow;
  pin: string;
  error: string | null;
  resetKey: number;
}

type PreviewAction =
  | {type: 'step'; step: ScriptStep}
  | {type: 'scenario'; scenario: Scenario};

function initial(scenario: Scenario, resetKey = 0): PreviewState {
  return {
    scenario,
    mode: 'idle',
    stage: INITIAL_STAGE,
    seq: 0,
    plan: scenario.plan,
    flow: scenario.flow,
    pin: '',
    error: null,
    resetKey,
  };
}

/** The same mapping CashuCardCharge applies, minus the NFC session. */
export function previewReducer(
  state: PreviewState,
  action: PreviewAction,
): PreviewState {
  if (action.type === 'scenario') {
    return initial(action.scenario, state.resetKey + 1);
  }
  const {step} = action;
  switch (step.kind) {
    case 'mode':
      return step.mode === 'running'
        ? {...state, mode: 'running', stage: INITIAL_STAGE, error: null}
        : {...state, mode: 'idle'};
    case 'phase': {
      // A phase means something only while a charge runs — exactly as in
      // CashuCardCharge, where phases come from the live card session. A
      // stray one can never animate over the idle screen.
      if (state.mode !== 'running') {
        return state;
      }
      const seq = state.seq + 1;
      const next = mapPhase(state.stage, {text: step.text, seq});
      if (next.event === 'thump' && step.text === state.stage.phase) {
        // A repeated identical phase changes nothing on screen: the same
        // state object means React does not even re-render.
        return state;
      }
      return {...state, seq, stage: next};
    }
    case 'plan':
      return {...state, plan: step.plan};
    case 'flow':
      return {...state, flow: step.flow};
    case 'pin':
      return {...state, pin: state.pin + step.digit};
    case 'complete':
      return state.mode === 'running' ? {...state, mode: 'complete'} : state;
    case 'error':
      return state.mode === 'running'
        ? {...state, mode: 'error', error: step.message}
        : state;
    case 'reset':
      return initial(state.scenario, state.resetKey + 1);
    default:
      return state;
  }
}

const SPEEDS = [1, 0.5, 0.25];

function useFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(
    () => navigation?.isFocused?.() ?? true,
  );
  useEffect(() => {
    if (!navigation?.addListener) {
      return;
    }
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  return focused;
}

const Chip = ({
  label,
  on,
  onPress,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    style={[styles.chip, on && styles.chipOn]}>
    <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
  </Pressable>
);

const ChargeAnimationPreview = () => {
  const navigation = useContext(NavigationContext);
  const [state, dispatch] = useReducer(previewReducer, DEFAULT_SCENARIO, s =>
    initial(s),
  );
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [reduce, setReduce] = useState(false);
  const [jsLoad, setJsLoad] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  /**
   * Hand-off proof (off by default): at the finale's hand-off frame, take the
   * production path to Success — the same single reset CashuCardCharge
   * dispatches — so the no-cut hand-off can be recorded without a card.
   */
  const [toSuccess, setToSuccess] = useState(false);
  const toSuccessRef = useRef(toSuccess);
  toSuccessRef.current = toSuccess;
  const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handedOffRef = useRef(false);
  /** Bumped on every scenario pick: the script restarts with the stage. */
  const [runKey, setRunKey] = useState(0);
  const focused = useFocused();
  // The reset after a finale covers the stage with its own last frame —
  // green AND the badge where Success puts it — so nothing pops on the cut.
  const frame = useContext(SafeAreaFrameContext);
  const badgeSpot =
    frame && frame.width > 0 && frame.height > 0
      ? {
          left: successBadgeCenter(frame).x - SUCCESS_BADGE_SIZE / 2,
          top: successBadgeCenter(frame).y - SUCCESS_BADGE_SIZE / 2,
        }
      : null;
  const overlay = useRef(new Animated.Value(0)).current;
  const [overlayColor, setOverlayColor] = useState<string>(COLOR.green);
  const modeRef = useRef(state.mode);
  modeRef.current = state.mode;
  const loadRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jsLoadRef = useRef(jsLoad);
  jsLoadRef.current = jsLoad;

  const stopLoad = useCallback(() => {
    if (loadRef.current) {
      clearInterval(loadRef.current);
      loadRef.current = null;
    }
  }, []);
  const startLoad = useCallback(() => {
    if (loadRef.current || !jsLoadRef.current) {
      return;
    }
    // Busy-waits the JS thread 80 ms of every 100 ms: the recording must
    // stay smooth, which proves the stage runs on the native driver only.
    loadRef.current = setInterval(() => {
      const until = Date.now() + 80;
      while (Date.now() < until) {
        // spin
      }
    }, 100);
  }, []);

  const clearTimers = useCallback(() => {
    if (fadeRef.current) {
      clearTimeout(fadeRef.current);
      fadeRef.current = null;
    }
    if (handoffRef.current) {
      clearTimeout(handoffRef.current);
      handoffRef.current = null;
    }
  }, []);

  const onStep = useCallback(
    (step: ScriptStep) => {
      // A reset still fading through white lands BEFORE any later step:
      // under JS load a late timer can bring the next steps in together,
      // and a reset applied after "running" would leave the stage idle while
      // the script played on (and the finale would run over "Ready to charge").
      if (fadeRef.current && step.kind !== 'reset') {
        clearTimeout(fadeRef.current);
        fadeRef.current = null;
        dispatch({type: 'step', step: {t: step.t, kind: 'reset'}});
        toward(overlay, 0, 75, 'STD', speed);
      }
      if (step.kind === 'phase' && step.text.startsWith('burning')) {
        startLoad();
      }
      if (step.kind === 'complete' || step.kind === 'error') {
        stopLoad();
      }
      if (
        step.kind === 'complete' &&
        modeRef.current === 'running' &&
        toSuccessRef.current &&
        navigation
      ) {
        const amountSat = state.scenario.amountSat;
        handoffRef.current = setTimeout(() => {
          handoffRef.current = null;
          // Success now owns the green insets (it holds the edge tint):
          // leaving must not take them away from it.
          handedOffRef.current = true;
          handOffToSuccess(navigation, {
            title: `Charged ${formatSatAmount(amountSat)} — paid by eCash card`,
            amountText: formatSatAmount(amountSat),
            preview: true,
          });
        }, HANDOFF_MS / speed);
      }
      if (step.kind === 'reset') {
        stopLoad();
        // The strips fade with the overlay, at the preview's speed.
        hideEdgeTint(modeRef.current === 'complete' ? 300 / speed : 0);
        if (modeRef.current === 'complete') {
          // The flood's last frame IS a green screen: cover with the same
          // green, reset underneath, then lift it.
          setOverlayColor(COLOR.green);
          snapTo(overlay, 1);
          dispatch({type: 'step', step});
          toward(overlay, 0, 300, 'STD', speed);
          return;
        }
        setOverlayColor(COLOR.page);
        toward(overlay, 1, 75, 'STD', speed);
        fadeRef.current = setTimeout(() => {
          fadeRef.current = null;
          dispatch({type: 'step', step});
          toward(overlay, 0, 75, 'STD', speed);
        }, 75 / speed);
        return;
      }
      dispatch({type: 'step', step});
    },
    [overlay, speed, startLoad, stopLoad, navigation, state.scenario],
  );

  usePhaseScript(state.scenario, {
    speed,
    loop,
    active: focused,
    runKey,
    onStep,
  });

  // Blur or unmount: stop everything, park the stage at idle — and drop the
  // green insets, unless they were handed to Success with the stage.
  useEffect(() => {
    if (focused) {
      return;
    }
    stopLoad();
    clearTimers();
    if (!handedOffRef.current) {
      hideEdgeTint(0);
    }
    snapTo(overlay, 0);
    dispatch({type: 'step', step: {t: 0, kind: 'reset'}});
  }, [focused, stopLoad, clearTimers, overlay]);
  useEffect(
    () => () => {
      stopLoad();
      clearTimers();
      if (!handedOffRef.current) {
        hideEdgeTint(0);
      }
    },
    [stopLoad, clearTimers],
  );

  const station = state.stage.station;
  const stalled = useStallTimer(
    state.stage.seq,
    state.mode === 'running' && station > 0 && station !== 4,
    STALL_MS / speed,
  );

  const pickScenario = (scenario: Scenario) => {
    setRunKey(k => k + 1);
    stopLoad();
    // A reset still fading, or a pending hand-off, belongs to the old run.
    clearTimers();
    hideEdgeTint(0);
    snapTo(overlay, 0);
    dispatch({type: 'scenario', scenario});
  };

  const noop = useCallback(() => {}, []);
  const tag = (
    <View style={styles.tag} testID="preview-tag">
      <Text style={styles.tagText}>PREVIEW</Text>
    </View>
  );

  return (
    <View style={styles.root}>
      <ChargeView
        amountSat={state.scenario.amountSat}
        stage={state.stage}
        mode={state.mode}
        flow={state.flow}
        plan={state.plan}
        pin={state.pin}
        error={state.error}
        stalled={stalled}
        nfcSupported
        onBack={() => navigation?.goBack?.()}
        onCharge={noop}
        onCancel={noop}
        onRetry={noop}
        onPinDigit={noop}
        onPinBackspace={noop}
        onPinClear={noop}
        onPinConfirm={noop}
        onHeaderLongPress={() => setBarHidden(false)}
        reduceMotion={reduce}
        timeScale={speed}
        resetKey={state.resetKey}
        paused={!focused}
        headerRight={tag}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {backgroundColor: overlayColor, opacity: overlay},
          ]}>
          {overlayColor === COLOR.green && badgeSpot ? (
            <View style={[styles.badge, badgeSpot]}>
              <SealCheck size={50} />
            </View>
          ) : null}
        </Animated.View>
        {barHidden ? null : (
          <View style={styles.bar} testID="preview-bar">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.scrollRow}>
              {SCENARIOS.map(s => (
                <Chip
                  key={s.id}
                  testID={`scenario-${s.id}`}
                  label={s.label}
                  on={s.id === state.scenario.id}
                  onPress={() => pickScenario(s)}
                />
              ))}
            </ScrollView>
            <View style={styles.barRow}>
              {SPEEDS.map(x => (
                <Chip
                  key={x}
                  label={`${x}×`}
                  on={speed === x}
                  onPress={() => {
                    // The script restarts from its first step: so does the stage.
                    setSpeed(x);
                    pickScenario(state.scenario);
                  }}
                />
              ))}
              <Chip
                label="Loop"
                on={loop}
                onPress={() => {
                  setLoop(v => !v);
                  pickScenario(state.scenario);
                }}
              />
              <Chip
                label="Reduce"
                on={reduce}
                onPress={() => setReduce(v => !v)}
              />
              <Chip
                label="JS load"
                on={jsLoad}
                onPress={() => setJsLoad(v => !v)}
              />
              <Chip
                testID="preview-to-success"
                label="→ Success"
                on={toSuccess}
                onPress={() => setToSuccess(v => !v)}
              />
              <Chip
                testID="preview-hide"
                label="Hide"
                on={false}
                onPress={() => setBarHidden(true)}
              />
            </View>
          </View>
        )}
      </ChargeView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: COLOR.page},
  tag: {
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: COLOR.pill,
    justifyContent: 'center',
  },
  tagText: {
    fontFamily: 'Outfit-SemiBold',
    fontSize: 13,
    lineHeight: 16,
    color: COLOR.text2,
    includeFontPadding: false,
  },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 8,
    backgroundColor: '#fffffff0',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLOR.hairline,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  scrollRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    flexWrap: 'wrap',
  },
  chip: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    marginRight: 8,
    marginVertical: 2,
    backgroundColor: COLOR.pill,
    justifyContent: 'center',
  },
  chipOn: {backgroundColor: COLOR.ink},
  badge: {
    position: 'absolute',
    width: SUCCESS_BADGE_SIZE,
    height: SUCCESS_BADGE_SIZE,
    borderRadius: SUCCESS_BADGE_SIZE / 2,
    backgroundColor: COLOR.white,
    padding: 15,
  },
  chipText: {fontFamily: 'Outfit-Medium', fontSize: 13, color: COLOR.pillText},
  chipTextOn: {color: COLOR.white},
});

export default ChargeAnimationPreview;
