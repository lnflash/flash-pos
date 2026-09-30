import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Dimensions, ScrollView} from 'react-native';

const width = Dimensions.get('screen').width;
import {StackScreenProps} from '@react-navigation/stack';
import * as Animatable from 'react-native-animatable';
import styled from 'styled-components/native';

// components
// Leaf imports, not the barrel — this screen ships in release builds and must
// not drag the printer or currency-picker native modules into its graph.
import TextButton from '../components/buttons/TextButton';

// services
import {
  cancelCardSession,
  describeCardFailure,
  isUserCancel,
  isCardReadingSupported,
  setCardSessionMessage,
  withCardSession,
} from '../services/cashuCardNfc';
import {
  executeCharge,
  readAndPlan,
  type PurchasePlan,
} from '../services/cashuCharge';
import PinPad from '../components/cashu/PinPad';
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
} from '../components/cashu/PinPad';
import SparkStage, {ProgressRail} from '../components/cashu/charge/SparkStage';
import {
  INITIAL_STAGE,
  STATION_COUNT,
  friendlyLabel,
  mapPhase,
  type StageState,
} from '../components/cashu/charge/phaseToStation';
import {useStallTimer} from '../components/cashu/charge/useStallTimer';
import {runAutoSettlement} from '../services/cashuAutoSettle';

// utils
import {formatSatAmount} from '../utils/satCurrency';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {addTransaction} from '../store/slices/transactionHistorySlice';
import {resetInvoice} from '../store/slices/invoiceSlice';

// env
import {FLASH_CASHU_MINT_URL} from '@env';

const contentStyle = {padding: 20};
const STAGE_WIDTH = width - 40;
/** The pad's exit animation; the stage only expands once it is gone. */
const PAD_EXIT_MS = 260;
/**
 * The "lift the card" frame is held at least this long after the charge
 * resolves so the arrival is seen even when settlement is instant.
 */
const LIFT_HOLD_MS = 900;

type Props = StackScreenProps<RootStackType, 'CashuCardCharge'>;

type Planned = {
  plan: PurchasePlan;
  unspent: unknown[];
  cardPubkey: string;
  pinRequired: boolean;
};

/**
 * Production charge screen: the merchant arrived here from the invoice screen
 * with an amount already entered; the customer taps their Cashu card and
 * enters its PIN if it has one. Burns exactly enough of the card, makes
 * change from the till onto the card, then hands off to the auto-pipeline
 * (settle → sweep to the merchant's wallet) and shows the success screen.
 *
 * Works offline: PIN verify, burns, and change are on-card plus the local
 * till — the network only appears in the settle/sweep after the tap.
 *
 * The Spark Run stage is decoration on top of the phase text: every hop is
 * pinned to a real phase, and the verbatim string stays on screen as the
 * trust surface.
 */
const CashuCardCharge = ({navigation, route}: Props) => {
  // The keypad stores the amount as a string; a non-numeric entry is treated
  // as no amount rather than NaN-ed into a silent zero charge.
  const {
    satAmount: satAmountRaw,
    displayAmount,
    currency,
    isPrimaryAmountSats,
    memo,
  } = useAppSelector(state => state.amount);
  const satAmount = Number(satAmountRaw ?? 0);
  const {username} = useAppSelector(state => state.user);
  const dispatch = useAppDispatch();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [charging, setCharging] = useState(false);
  const [stage, setStage] = useState<StageState>(INITIAL_STAGE);
  // Two-phase flow: 'tap' → (plan read; PIN pad if the card has one) → done.
  const [flow, setFlow] = useState<'tap' | 'pin' | 'done'>('tap');
  const [plan, setPlan] = useState<Planned | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The money moved: tell the customer to lift the card before settlement.
  const [complete, setComplete] = useState(false);
  const [settlingLate, setSettlingLate] = useState(false);
  const [padGone, setPadGone] = useState(false);

  const chargingRef = useRef(false);
  const cancelledRef = useRef(false);
  // Distinct from cancelledRef: a Cancel press that lands after the last APDU
  // must NOT suppress a completed charge's Success screen, but a hardware
  // Back during the held "lift the card" frame must not pop two screens off
  // whatever stack the merchant is now on.
  const unmountedRef = useRef(false);
  const seqRef = useRef(0);
  const stageRef = useRef<StageState>(INITIAL_STAGE);

  useEffect(() => {
    isCardReadingSupported().then(setSupported);
  }, []);

  // A pending IsoDep request swallows every BoltCard tap app-wide (see
  // docs/13-cashu-card.md) — leaving mid-read must cancel it.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      unmountedRef.current = true;
      cancelCardSession();
    },
    [],
  );

  /**
   * Every phase is stamped with a sequence number before it reaches the
   * mapper: 'writing change to card' fires once per change proof and
   * 'reading card' fires 5+ times per read, so keying on the string would
   * collapse the repeats and the per-proof coin drop would fire once.
   */
  const onPhase = useCallback((text: string) => {
    const seq = (seqRef.current += 1);
    const next = mapPhase(stageRef.current, {text, seq});
    stageRef.current = next;
    setStage(next);
    setCardSessionMessage(friendlyLabel(next).title);
  }, []);

  /** Per session: a second customer's bolt must start on station 1. */
  const armStage = useCallback(() => {
    stageRef.current = INITIAL_STAGE;
    setStage(INITIAL_STAGE);
    setComplete(false);
    setSettlingLate(false);
  }, []);

  const finish = useCallback(
    async (planned: Planned, customerPin?: string) => {
      await withCardSession(
        transceive =>
          executeCharge({
            transceive,
            amountSat: satAmount,
            plan: planned.plan,
            unspent: planned.unspent as never,
            cardPubkey: planned.cardPubkey,
            pin: customerPin,
            pinRequired: planned.pinRequired,
            mintUrl: FLASH_CASHU_MINT_URL,
            onPhase,
          }),
        {
          alertMessage: 'Finishing the charge — hold the card',
        },
      );
      // The card is done the moment the session resolves: say so now, and
      // let settlement (network) run behind the held frame.
      setComplete(true);
      // The flag flips on the settlement promise itself, so an instant
      // (offline) settlement never flashes "Settling with the mint…" for a
      // frame when the hold timer fires.
      let settled = false;
      const settlement = (
        username
          ? runAutoSettlement(username).catch(() => {})
          : Promise.resolve()
      ).then(() => {
        settled = true;
      });
      const burstDone = new Promise<void>(resolve =>
        setTimeout(() => {
          if (!settled) {
            setSettlingLate(true);
          }
          resolve();
        }, LIFT_HOLD_MS),
      );
      await Promise.all([burstDone, settlement]);
      // Same bookkeeping the lightning path does on payment: history entry,
      // cleared invoice (the QR screen must not resurrect a paid bill), and a
      // stack that lands Back past the invoice.
      dispatch(
        addTransaction({
          id: `cashu_${Date.now()}`,
          timestamp: new Date().toISOString(),
          transactionType: 'ecash',
          paymentMethod: 'card',
          amount: {
            satAmount,
            displayAmount: displayAmount || '0',
            currency,
            isPrimaryAmountSats: isPrimaryAmountSats || false,
          },
          merchant: {username: username || 'Unknown'},
          invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
          memo,
          status: 'completed',
        }),
      );
      dispatch(resetInvoice());
      // The record above must survive either way; only the navigation is
      // conditional on this screen still being mounted.
      if (unmountedRef.current) {
        return;
      }
      navigation.pop(2);
      navigation.navigate('Success', {
        title: `Charged ${formatSatAmount(satAmount)} — paid by eCash card`,
      });
    },
    [
      satAmount,
      username,
      navigation,
      dispatch,
      displayAmount,
      currency,
      isPrimaryAmountSats,
      memo,
      onPhase,
    ],
  );

  // Session 1: the silent read + plan. A PIN-less card completes in this one
  // tap; a PIN card hands off to the pad and re-taps (session 2).
  const onCharge = useCallback(async () => {
    if (chargingRef.current || satAmount <= 0) {
      return;
    }
    chargingRef.current = true;
    cancelledRef.current = false;
    setCharging(true);
    setError(null);
    setFlow('tap');
    armStage();
    // A retry with a different card must not seat the previous card's proofs
    // on the disc or show its change note before the new plan arrives.
    setPlan(null);
    try {
      const planned = await withCardSession(
        transceive => readAndPlan({transceive, amountSat: satAmount, onPhase}),
        {
          alertMessage: `Charge ${formatSatAmount(
            satAmount,
          )} — hold the customer's card`,
        },
      );
      setPlan(planned);
      if (!planned.pinRequired) {
        setFlow('done');
        await finish(planned);
        return;
      }
      // The session closes so the pad can take input; the customer taps
      // again for session 2.
      setFlow('pin');
    } catch (err) {
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      chargingRef.current = false;
      setCharging(false);
    }
  }, [satAmount, finish, onPhase, armStage]);

  // The payment router read and planned the card in its own NFC session and
  // handed the result over: skip session 1 entirely. A PIN card lands straight
  // on the pad; a PIN-less card goes straight to the finish tap.
  const preRead = route.params?.preRead;
  useEffect(() => {
    if (!preRead || chargingRef.current) {
      return;
    }
    navigation.setParams({preRead: undefined});
    const planned = {
      plan: preRead.plan,
      unspent: preRead.unspent,
      cardPubkey: preRead.cardPubkey,
      pinRequired: preRead.pinRequired,
    };
    setPlan(planned);
    if (planned.pinRequired) {
      setFlow('pin');
      return;
    }
    chargingRef.current = true;
    cancelledRef.current = false;
    setCharging(true);
    setError(null);
    setFlow('done');
    armStage();
    finish(planned)
      .catch((err: unknown) => {
        setFlow('tap');
        if (!cancelledRef.current && !isUserCancel(err)) {
          setError(describeCardFailure(err));
        }
      })
      .finally(() => {
        chargingRef.current = false;
        setCharging(false);
      });
  }, [preRead, finish, navigation, armStage]);

  const onPinConfirm = useCallback(async () => {
    console.log(
      '[charge] pin confirm',
      JSON.stringify({chargingRef: chargingRef.current, hasPlan: !!plan, pinLen: pin.length}),
    );
    if (chargingRef.current || !plan) {
      return;
    }
    if (pin.length < PIN_MIN_LENGTH) {
      return;
    }
    chargingRef.current = true;
    cancelledRef.current = false;
    setCharging(true);
    setError(null);
    armStage();
    try {
      await finish(plan, pin);
      setFlow('done');
      setPin('');
    } catch (err) {
      setFlow('pin');
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      chargingRef.current = false;
      setCharging(false);
    }
  }, [plan, pin, finish, armStage]);

  // Auto-commit: pilot cards carry 4-digit PINs, so a full 4-digit entry with
  // a short settle pauses opens session 2 on its own. Typing past four digits
  // cancels the timer — only the button commits those.
  useEffect(() => {
    if (flow !== 'pin' || chargingRef.current || pin.length !== PIN_MIN_LENGTH) {
      return;
    }
    const timer = setTimeout(() => {
      onPinConfirm();
    }, 700);
    return () => clearTimeout(timer);
  }, [flow, pin, onPinConfirm]);

  // Old-arch sequencing: the pad slides out first and only THEN does the
  // stage expand and arm — a JS-driven layout change in the same tick as a
  // native-driven timing start drops the first frame on RN 0.77 Android.
  const padExiting = flow === 'pin' && charging;
  useEffect(() => {
    if (!padExiting) {
      setPadGone(false);
      return;
    }
    const timer = setTimeout(() => setPadGone(true), PAD_EXIT_MS);
    return () => clearTimeout(timer);
  }, [padExiting]);

  const onCancel = useCallback(() => {
    cancelledRef.current = true;
    cancelCardSession();
  }, []);

  const mode = error ? 'error' : complete ? 'complete' : charging ? 'running' : 'idle';
  const docked = flow === 'pin' && !padGone;
  const stalled = useStallTimer(
    stage.seq,
    mode === 'running' && stage.station > 0 && stage.station !== 4,
  );
  const label = friendlyLabel(stage);
  // Memoised on the plan: the stage seats coins whenever this array changes,
  // and a fresh array per phase render would reset them mid-flight.
  const burnCoins = useMemo(
    () =>
      plan
        ? plan.plan.slots.map(
            s =>
              (plan.unspent as {slot: number; amount: number}[]).find(
                p => p.slot === s,
              )?.amount ?? 0,
          )
        : [],
    [plan],
  );
  const progress = complete ? 1 : stage.station / STATION_COUNT;

  return (
    <Wrapper contentContainerStyle={contentStyle}>
      <Animatable.View animation="fadeInDown" duration={500} useNativeDriver>
        <Title>Charge by eCash card</Title>
        <HeroAmount>{satAmount > 0 ? formatSatAmount(satAmount) : '—'}</HeroAmount>
        <Caption>
          {satAmount > 0
            ? 'Customer pays by tapping their card.'
            : 'No amount entered — go back and enter an amount first.'}
        </Caption>
      </Animatable.View>

      <SparkStage
        state={stage}
        mode={mode}
        docked={docked}
        stalled={stalled}
        burnCoins={burnCoins}
        changeSat={plan?.plan.changeSat ?? 0}
        width={STAGE_WIDTH}
      />

      {mode === 'complete' ? (
        <Animatable.View animation="fadeInUp" duration={300} useNativeDriver>
          <PhaseTitle paid testID="phase-title">
            Paid — you can lift the card
          </PhaseTitle>
          {settlingLate && <PhaseDetail>Settling with the mint…</PhaseDetail>}
        </Animatable.View>
      ) : mode === 'running' && stage.phase ? (
        // Keyed on seq, not text: a repeated phase still re-enters, so the
        // merchant SEES each change proof land.
        <Animatable.View key={stage.seq} animation="fadeInUp" duration={300} useNativeDriver>
          <PhaseTitle testID="phase-title">{label.title}</PhaseTitle>
          <PhaseRaw testID="phase-raw">{stage.phase}</PhaseRaw>
          {!!label.detail && <PhaseDetail testID="phase-detail">{label.detail}</PhaseDetail>}
        </Animatable.View>
      ) : mode === 'running' ? (
        <PhaseDetail>Hold the card against the top of the phone</PhaseDetail>
      ) : mode === 'idle' && flow !== 'pin' ? (
        <PhaseDetail>Hold the card against the top of the phone</PhaseDetail>
      ) : null}

      {mode !== 'idle' && flow !== 'pin' && (
        <ProgressRail progress={progress} width={STAGE_WIDTH} />
      )}

      <Row>
        <Label>NFC available</Label>
        <Value>
          {supported === null ? 'checking…' : supported ? 'yes' : 'no'}
        </Value>
      </Row>

      {flow === 'pin' && !padGone ? (
        <Animatable.View
          animation={padExiting ? 'fadeOutDown' : 'fadeInUp'}
          duration={padExiting ? PAD_EXIT_MS : 400}
          useNativeDriver>
          <Results>
            <PadTitle>Enter card PIN</PadTitle>
            <Dots>
              {Array.from({length: Math.max(PIN_MIN_LENGTH, pin.length)}).map(
                (_, i) => (
                  <Animatable.View
                    key={`${i}-${pin.length >= i}`}
                    animation={i === pin.length - 1 ? 'zoomIn' : undefined}
                    duration={220}
                    useNativeDriver>
                    <Dot filled={i < pin.length} />
                  </Animatable.View>
                ),
              )}
            </Dots>
            {charging ? (
              <Animatable.View animation="fadeIn" duration={300} useNativeDriver>
                <AutoHint>Lift the card, then tap again to complete</AutoHint>
              </Animatable.View>
            ) : (
              pin.length === PIN_MIN_LENGTH && (
                <Animatable.View animation="fadeIn" duration={300} useNativeDriver>
                  <AutoHint>Auto-charging — lift the card, then tap again</AutoHint>
                </Animatable.View>
              )
            )}
            <TextButton
              title={charging ? 'Charging…' : 'Charge now'}
              btnStyle={buttonStyle}
              disabled={charging || pin.length < PIN_MIN_LENGTH}
              onPress={onPinConfirm}
            />
            <PinPad
              onDigit={d => setPin(p => (p.length < PIN_MAX_LENGTH ? p + d : p))}
              onBackspace={() => setPin(p => p.slice(0, -1))}
              onClear={() => setPin('')}
            />
          </Results>
        </Animatable.View>
      ) : (
        <Animatable.View animation="fadeInUp" duration={400} useNativeDriver>
          {charging ? (
            <TextButton
              icon="xmark"
              title="Cancel read"
              btnStyle={buttonStyle}
              onPress={onCancel}
            />
          ) : (
            <TextButton
              icon="wifi"
              title={
                satAmount > 0 ? 'Tap card to charge' : 'Enter an amount first'
              }
              btnStyle={buttonStyle}
              disabled={satAmount <= 0}
              onPress={onCharge}
            />
          )}
        </Animatable.View>
      )}

      {error && (
        <Animatable.View animation="shake" duration={500} useNativeDriver>
          <ErrorBox>
            <ErrorText>{error}</ErrorText>
          </ErrorBox>
        </Animatable.View>
      )}
    </Wrapper>
  );
};

export default CashuCardCharge;

const Wrapper = styled(ScrollView)`
  flex: 1;
  background-color: #ffffff;
`;

const Title = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
`;

const Caption = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
  margin-top: 6px;
  margin-bottom: 8px;
`;

const Row = styled.View`
  margin-top: 12px;
`;

const Label = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
`;

const Value = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
`;

const buttonStyle = {marginTop: 20};

const PadTitle = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
`;

const HeroAmount = styled.Text`
  font-size: 44px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
  margin-top: 8px;
`;

const PhaseTitle = styled.Text<{paid?: boolean}>`
  font-size: 18px;
  font-family: 'Outfit-SemiBold';
  color: ${p => (p.paid ? '#007856' : '#1f2328')};
  margin-top: 4px;
  text-align: center;
`;

const PhaseRaw = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
  margin-top: 2px;
  text-align: center;
`;

const PhaseDetail = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Medium';
  color: #1f2328;
  margin-top: 4px;
  text-align: center;
`;

const Dots = styled.View`
  flex-direction: row;
  justify-content: center;
  margin-top: 12px;
`;

const AutoHint = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Medium';
  color: #db254e;
  margin-top: 8px;
  text-align: center;
`;

const Dot = styled.View<{filled: boolean}>`
  width: 14px;
  height: 14px;
  border-radius: 7px;
  margin-horizontal: 6px;
  background-color: ${props => (props.filled ? '#1f2328' : '#ececf1')};
`;

const Results = styled.View`
  margin-top: 8px;
`;

const ErrorBox = styled.View`
  background-color: #fdf0ef;
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
`;

const ErrorText = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #b3261e;
`;
