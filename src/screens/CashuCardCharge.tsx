import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Dimensions, ScrollView} from 'react-native';

const width = Dimensions.get('screen').width;
import {StackScreenProps} from '@react-navigation/stack';
import * as Animatable from 'react-native-animatable';
import styled from 'styled-components/native';

// assets
import Icon from 'react-native-vector-icons/FontAwesome6';

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
import {runAutoSettlement} from '../services/cashuAutoSettle';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {addTransaction} from '../store/slices/transactionHistorySlice';
import {resetInvoice} from '../store/slices/invoiceSlice';

// env
import {FLASH_CASHU_MINT_URL} from '@env';

const contentStyle = {padding: 20};

type Props = StackScreenProps<RootStackType, 'CashuCardCharge'>;

/**
 * Production charge screen: the merchant arrived here from the invoice screen
 * with an amount already entered; the customer taps their Cashu card and
 * enters its PIN if it has one. Burns exactly enough of the card, makes
 * change from the till onto the card, then hands off to the auto-pipeline
 * (settle → sweep to the merchant's wallet) and shows the success screen.
 *
 * Works offline: PIN verify, burns, and change are on-card plus the local
 * till — the network only appears in the settle/sweep after the tap.
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
  const [phase, setPhase] = useState<string | null>(null);
  // Two-phase flow: 'tap' → (plan read; PIN pad if the card has one) → done.
  const [flow, setFlow] = useState<'tap' | 'pin' | 'done'>('tap');
  const [plan, setPlan] = useState<{
    plan: PurchasePlan;
    unspent: unknown[];
    cardPubkey: string;
    pinRequired: boolean;
  } | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chargingRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    isCardReadingSupported().then(setSupported);
  }, []);

  // A pending IsoDep request swallows every BoltCard tap app-wide (see
  // docs/13-cashu-card.md) — leaving mid-read must cancel it.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      cancelCardSession();
    },
    [],
  );

  const finish = useCallback(
    async (planned: {plan: PurchasePlan; unspent: unknown[]; cardPubkey: string; pinRequired: boolean}, customerPin?: string) => {
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
            onPhase: setPhase,
          }),
        {
          alertMessage: 'Finishing the charge — hold the card',
        },
      );
      if (username) {
        await runAutoSettlement(username).catch(() => {});
      }
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
      navigation.pop(2);
      navigation.navigate('Success', {
        title: `Charged ${satAmount} sat — paid by Cashu card`,
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
    try {
      const planned = await withCardSession(
        transceive => readAndPlan({transceive, amountSat: satAmount, onPhase: setPhase}),
        {alertMessage: `Charge ${satAmount} sat — hold the customer's card`},
      );
      if (!planned.pinRequired) {
        setFlow('done');
        await finish(planned);
        return;
      }
      // The session closes so the pad can take input; the customer taps
      // again for session 2.
      setPlan(planned);
      setFlow('pin');
    } catch (err) {
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      chargingRef.current = false;
      setCharging(false);
      setPhase(null);
    }
  }, [satAmount, finish]);

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
    if (planned.pinRequired) {
      setPlan(planned);
      setFlow('pin');
      return;
    }
    chargingRef.current = true;
    cancelledRef.current = false;
    setCharging(true);
    setError(null);
    setFlow('done');
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
        setPhase(null);
      });
  }, [preRead, finish, navigation]);

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
      setPhase(null);
    }
  }, [plan, pin, finish]);

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

  const onCancel = useCallback(() => {
    cancelledRef.current = true;
    cancelCardSession();
  }, []);

  return (
    <Wrapper contentContainerStyle={contentStyle}>
      <Animatable.View animation="fadeInDown" duration={500} useNativeDriver>
        <Title>Charge by Cashu card</Title>
        <HeroAmount>{satAmount > 0 ? `${satAmount} sats` : '—'}</HeroAmount>
        <Caption>
          {satAmount > 0
            ? 'Customer pays by tapping their card.'
            : 'No amount entered — go back and enter an amount first.'}
        </Caption>
      </Animatable.View>

      <Animatable.View animation="fadeInUp" duration={500} delay={120} useNativeDriver>
        <Row>
          <Label>NFC available</Label>
          <Value>
            {supported === null ? 'checking…' : supported ? 'yes' : 'no'}
          </Value>
        </Row>

        {charging && phase && (
          <Results>
            <Label>Step</Label>
            {/* The key re-mounts on every phase change: each step animates
                in, so the merchant SEES the payment progressing. */}
            <Animatable.View key={phase} animation="fadeInUp" duration={300} useNativeDriver>
              <Value>{phase}</Value>
            </Animatable.View>
          </Results>
        )}
      </Animatable.View>

      {flow === 'pin' ? (
        <Animatable.View animation="fadeInUp" duration={400} useNativeDriver>
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
            <PulseRing>
              <Animatable.View animation="pulse" iterationCount="infinite" useNativeDriver>
                <Icon name="wifi" size={Math.round(width / 4)} color="#1f2328" />
              </Animatable.View>
              <StepText>{phase || 'Waiting for tap…'}</StepText>
              <TextButton
                icon="xmark"
                title="Cancel read"
                btnStyle={buttonStyle}
                onPress={onCancel}
              />
            </PulseRing>
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
  margin-bottom: 16px;
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

const PulseRing = styled.View`
  align-items: center;
  padding-vertical: 16px;
`;

const StepText = styled.Text`
  font-size: 15px;
  font-family: 'Outfit-Medium';
  color: #1f2328;
  margin-top: 10px;
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
