import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Linking, Platform} from 'react-native';
import {StackScreenProps} from '@react-navigation/stack';

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
import {runAutoSettlement} from '../services/cashuAutoSettle';

// components
// Leaf imports, not the barrel — this screen ships in release builds and must
// not drag the printer or currency-picker native modules into its graph.
import {PIN_MAX_LENGTH, PIN_MIN_LENGTH} from '../components/cashu/PinPad';
import ChargeView, {
  type PlanSummary,
} from '../components/cashu/charge/ChargeView';
import {last4FromPubkey} from '../components/cashu/charge/money';
import {
  INITIAL_STAGE,
  friendlyLabel,
  mapPhase,
  type StageState,
} from '../components/cashu/charge/phaseToStation';
import {useStallTimer} from '../components/cashu/charge/useStallTimer';

// utils
import {formatSatAmount} from '../utils/satCurrency';
import {HANDOFF_MS, handOffToSuccess} from '../utils/chargeHandoff';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {addTransaction} from '../store/slices/transactionHistorySlice';
import {resetInvoice} from '../store/slices/invoiceSlice';

// env
import {FLASH_CASHU_MINT_URL} from '@env';

/**
 * The paid frame is held this long after the charge resolves: the finale's
 * check lands, the green floods the screen, and from here on its frame IS
 * the Success screen's first — the navigator then swaps with no animation,
 * leaving the rest of the 1.2 s finale for Success's mount (on screen well
 * inside 1.25 s of complete).
 */
export const LIFT_HOLD_MS = HANDOFF_MS;
/** Settlement starts once Success is up: its JS burst never meets the hand-off. */
export const SETTLE_AFTER_HANDOFF_MS = 600;

type Props = StackScreenProps<RootStackType, 'CashuCardCharge'>;

type Planned = {
  plan: PurchasePlan;
  unspent: unknown[];
  cardPubkey: string;
  pinRequired: boolean;
  /** Change from an earlier charge, written onto the card before the burn. */
  owedChange: unknown[];
};

type PreRead = NonNullable<NonNullable<Props['route']['params']>['preRead']>;

function planFromPreRead(preRead: PreRead | undefined): Planned | null {
  return preRead
    ? {
        plan: preRead.plan as PurchasePlan,
        unspent: preRead.unspent,
        cardPubkey: preRead.cardPubkey,
        pinRequired: preRead.pinRequired,
        owedChange: preRead.owedChange ?? [],
      }
    : null;
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

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
 * Everything the customer sees is ChargeView; this screen owns the NFC
 * sessions and the services. Every gesture on the stage is pinned to a real
 * phase, and the verbatim string stays on screen as the trust surface.
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

  // The router may have read the card already: the first frame is then the
  // PIN pad (PIN card) or the charge itself (PIN-less) — never an idle frame.
  const initialPreRead = route.params?.preRead;
  const [supported, setSupported] = useState<boolean | null>(null);
  const [charging, setCharging] = useState(
    () => !!initialPreRead && !initialPreRead.pinRequired,
  );
  const [stage, setStage] = useState<StageState>(INITIAL_STAGE);
  // Two-phase flow: 'tap' → (plan read; PIN pad if the card has one) → done.
  const [flow, setFlow] = useState<'tap' | 'pin' | 'done'>(() =>
    initialPreRead ? (initialPreRead.pinRequired ? 'pin' : 'done') : 'tap',
  );
  const [plan, setPlan] = useState<Planned | null>(() =>
    planFromPreRead(initialPreRead),
  );
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The money moved: tell the customer to lift the card before settlement.
  const [complete, setComplete] = useState(false);

  const chargingRef = useRef(false);
  const cancelledRef = useRef(false);
  // Distinct from cancelledRef: a Cancel press that lands after the last APDU
  // must NOT suppress a completed charge's Success screen, but a hardware
  // Back during the held paid frame must not reset whatever stack the
  // merchant is now on.
  const unmountedRef = useRef(false);
  const seqRef = useRef(0);
  const stageRef = useRef<StageState>(INITIAL_STAGE);
  const changeSatRef = useRef(0);
  changeSatRef.current = plan?.plan.changeSat ?? 0;

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
   * mapper: 'writing change to card' fires once per change proof, so keying
   * on the string would collapse the repeats and the per-proof slip would
   * fire once. A repeated identical 'reading card' (5+ per read) changes
   * nothing on screen, so it does not even re-render.
   */
  const onPhase = useCallback((text: string) => {
    const seq = (seqRef.current += 1);
    const prev = stageRef.current;
    const next = mapPhase(prev, {text, seq});
    stageRef.current = next;
    if (next.event === 'thump' && text === prev.phase) {
      return;
    }
    setStage(next);
    setCardSessionMessage(
      friendlyLabel(next, {changeSat: changeSatRef.current}).title,
    );
  }, []);

  /** Per session: a second customer's charge must start from the top. */
  const armStage = useCallback(() => {
    stageRef.current = INITIAL_STAGE;
    setStage(INITIAL_STAGE);
    setComplete(false);
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
            owedChange: planned.owedChange as never,
            mintUrl: FLASH_CASHU_MINT_URL,
            onPhase,
          }),
        {
          alertMessage: 'Finishing the charge — hold the card',
        },
      );
      // The card is done the moment the session resolves: say so now. The
      // finale starts on this commit; the bookkeeping waits a frame so its
      // JS burst cannot delay the finale's first frame (the finale itself
      // runs on the native driver).
      setComplete(true);
      requestAnimationFrame(() => {
        // Same bookkeeping the lightning path does on payment: history
        // entry and a cleared invoice (the QR screen must not resurrect a
        // paid bill).
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
      });
      await sleep(LIFT_HOLD_MS);
      // Settlement is the merchant's business, not the customer's wait: the
      // drain retries on its own cadence and the banner reports it. It
      // starts once Success is up, so its JS burst never meets the hand-off.
      const settle = () => {
        if (username) {
          runAutoSettlement(username).catch(() => {});
        }
      };
      // The record above survives either way; only the navigation is
      // conditional on this screen still being mounted.
      if (unmountedRef.current) {
        settle();
        return;
      }
      handOffToSuccess(navigation, {
        title: `Charged ${formatSatAmount(satAmount)} — paid by eCash card`,
      });
      setTimeout(settle, SETTLE_AFTER_HANDOFF_MS);
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
    // A retry with a different card must not show the previous card's
    // ledger before the new plan arrives.
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
    const planned = planFromPreRead(preRead)!;
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
      JSON.stringify({
        chargingRef: chargingRef.current,
        hasPlan: !!plan,
        pinLen: pin.length,
      }),
    );
    if (chargingRef.current || !plan) {
      return;
    }
    if (pin.length < PIN_MIN_LENGTH) {
      return;
    }
    chargingRef.current = true;
    cancelledRef.current = false;
    // The auto-commit runs from a timer (no batching): reset the stage
    // first, so the first running frame never shows session 1's phase.
    armStage();
    setError(null);
    setCharging(true);
    try {
      await finish(plan, pin);
      setFlow('done');
      setPin('');
    } catch (err) {
      setFlow('pin');
      if (!cancelledRef.current && !isUserCancel(err)) {
        // The pad is the retry: the reason shows in the sheet and the PIN is
        // re-entered, which re-taps on its own.
        setError(describeCardFailure(err));
        setPin('');
      }
    } finally {
      chargingRef.current = false;
      setCharging(false);
    }
  }, [plan, pin, finish, armStage]);

  // Auto-commit: pilot cards carry 4-digit PINs, so a full 4-digit entry with
  // a short settle pause opens session 2 on its own. Typing past four digits
  // cancels the timer — only "Charge now" commits those.
  useEffect(() => {
    if (
      flow !== 'pin' ||
      error ||
      chargingRef.current ||
      pin.length !== PIN_MIN_LENGTH
    ) {
      return;
    }
    const timer = setTimeout(() => {
      onPinConfirm();
    }, 700);
    return () => clearTimeout(timer);
  }, [flow, pin, error, onPinConfirm]);

  const onCancel = useCallback(() => {
    if (error) {
      setError(null);
      if (flow === 'pin') {
        setPin('');
      }
      return;
    }
    cancelledRef.current = true;
    cancelCardSession();
  }, [error, flow]);

  // A failed charge is re-run from the top: a fresh read re-plans against
  // what the card holds now.
  const onRetry = useCallback(() => {
    setError(null);
    onCharge();
  }, [onCharge]);

  const onPinDigit = useCallback((d: string) => {
    // The first digit after a failed attempt starts a new one.
    setError(null);
    setPin(p => (p.length < PIN_MAX_LENGTH ? p + d : p));
  }, []);
  const onPinBackspace = useCallback(() => setPin(p => p.slice(0, -1)), []);
  const onPinClear = useCallback(() => setPin(''), []);

  const onOpenNfcSettings = useCallback(() => {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.NFC_SETTINGS').catch(() =>
        Linking.openSettings(),
      );
    } else {
      Linking.openSettings();
    }
  }, []);

  const mode = error
    ? 'error'
    : complete
    ? 'complete'
    : charging
    ? 'running'
    : 'idle';
  const stalled = useStallTimer(
    stage.seq,
    mode === 'running' && stage.station > 0 && stage.station !== 4,
  );
  const planSummary = useMemo<PlanSummary | null>(() => {
    if (!plan) {
      return null;
    }
    const unspent = plan.unspent as {slot: number; amount: number}[];
    return {
      notes: unspent.map(p => p.amount),
      burnSlots: plan.plan.slots.map(
        s => unspent.find(p => p.slot === s)?.amount ?? 0,
      ),
      changeSat: plan.plan.changeSat,
      last4: last4FromPubkey(plan.cardPubkey),
      pinRequired: plan.pinRequired,
    };
  }, [plan]);

  return (
    <ChargeView
      amountSat={satAmount}
      stage={stage}
      mode={mode}
      flow={flow}
      plan={planSummary}
      pin={pin}
      error={error}
      stalled={stalled}
      nfcSupported={supported}
      onBack={() => navigation.goBack()}
      onCharge={onCharge}
      onCancel={onCancel}
      onRetry={onRetry}
      onPinDigit={onPinDigit}
      onPinBackspace={onPinBackspace}
      onPinClear={onPinClear}
      onPinConfirm={onPinConfirm}
      onOpenNfcSettings={onOpenNfcSettings}
    />
  );
};

export default CashuCardCharge;
