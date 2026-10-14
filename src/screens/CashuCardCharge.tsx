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
import {
  CARD_NEEDS_UPDATE,
  isCardNeedsUpdate,
  isPinNeededForPayment,
} from '../services/cashuCard';
import {refreshTipHeader} from '../services/blockHeader';
import {runAutoSettlement} from '../services/cashuAutoSettle';
import {isPaidFailure, isRefusedAfterBurn} from '../services/phaseError';

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
  /** The planned pieces whole, as the read took them (`readAndPlan`). */
  pieces?: unknown[];
  cardPubkey: string;
  pinRequired: boolean;
  /** Change from an earlier charge, written onto the card before the burn. */
  owedChange: unknown[];
  pinSet?: boolean;
  refundKey?: string | null;
  requiresOnline?: boolean;
};

type PreRead = NonNullable<NonNullable<Props['route']['params']>['preRead']>;

function planFromPreRead(preRead: PreRead | undefined): Planned | null {
  return preRead
    ? {
        plan: preRead.plan as PurchasePlan,
        unspent: preRead.unspent,
        pieces: preRead.pieces,
        cardPubkey: preRead.cardPubkey,
        pinRequired: preRead.pinRequired,
        owedChange: preRead.owedChange ?? [],
        pinSet: preRead.pinSet,
        refundKey: preRead.refundKey,
        requiresOnline: preRead.requiresOnline,
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
  // The charge failed AFTER the mint swap settled the bill (ENG-642): it is
  // over and paid. The ref is the hard stop — no path may run the charge
  // again for this bill, whatever the UI shows.
  const [settled, setSettled] = useState(false);
  const settledRef = useRef(false);
  // The card has been touched for this bill and the charge has not settled
  // (ENG-645): from `executeCharge`'s `onBurnStart` until it resolves (then
  // through the paid frame to the hand-off) or fails. Every exit is held
  // meanwhile — header arrow, hardware Back, the stack's swipe — since a pop
  // would unmount the screen mid-charge and land on the Invoice with "Pay
  // by Flashcard" live. The ref is what the exits check; the state drives
  // the view.
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  const setHold = useCallback((on: boolean) => {
    holdingRef.current = on;
    setHolding(on);
  }, []);

  // Set just before this screen's own exits (Done, the Success hand-off):
  // `beforeRemove` lets those through.
  const leavingRef = useRef(false);
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
    // The card's clock: the tip header is fetched while the merchant and the
    // customer get ready, so the charge shows it without a network call in
    // the NFC session. Never awaited; a till offline sends no header.
    refreshTipHeader().catch(() => null);
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

  /**
   * The paid bill's bookkeeping, the same the lightning path does on
   * payment: history entry and a cleared invoice (the QR screen must not
   * resurrect a paid bill).
   */
  const recordPaid = useCallback(() => {
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
  }, [
    dispatch,
    satAmount,
    displayAmount,
    currency,
    isPrimaryAmountSats,
    username,
    memo,
  ]);

  // Settlement is the merchant's business, not the customer's wait: the
  // drain retries on its own cadence and the banner reports it.
  const startSettlement = useCallback(() => {
    if (username) {
      runAutoSettlement(username).catch(() => {});
    }
  }, [username]);

  const finish = useCallback(
    async (planned: Planned, customerPin?: string) => {
      setHold(false);
      try {
        await withCardSession(
          transceive =>
            executeCharge({
              transceive,
              amountSat: satAmount,
              plan: planned.plan,
              unspent: planned.unspent as never,
              pieces: planned.pieces as never,
              cardPubkey: planned.cardPubkey,
              pin: customerPin,
              pinRequired: planned.pinRequired,
              pinSet: planned.pinSet,
              refundKey: planned.refundKey,
              requiresOnline: planned.requiresOnline,
              owedChange: planned.owedChange as never,
              mintUrl: FLASH_CASHU_MINT_URL,
              onPhase,
              // The first burn is going out: hold every exit (ENG-645).
              onBurnStart: () => setHold(true),
            }),
          {
            alertMessage: 'Finishing the charge — hold the card',
          },
        );
      } catch (err) {
        // A paid failure (or one the mint refused after the card burned)
        // stays held: `endPaid` takes over and every exit becomes Done. Any
        // other failure is a charge that did not go through, and Back
        // leaves as it did before the tap.
        if (!isPaidFailure(err) && !isRefusedAfterBurn(err)) {
          setHold(false);
        }
        throw err;
      }
      // The card is done the moment the session resolves: say so now. The
      // finale starts on this commit; the bookkeeping waits a frame so its
      // JS burst cannot delay the finale's first frame (the finale itself
      // runs on the native driver).
      setComplete(true);
      requestAnimationFrame(recordPaid);
      await sleep(LIFT_HOLD_MS);
      // Settlement starts once Success is up, so its JS burst never meets
      // the hand-off. The record above survives either way; only the
      // navigation is conditional on this screen still being mounted.
      if (unmountedRef.current) {
        startSettlement();
        return;
      }
      // The hand-off is the held charge's own exit.
      leavingRef.current = true;
      handOffToSuccess(navigation, {
        title: `Charged ${formatSatAmount(satAmount)} — paid by eCash card`,
      });
      setTimeout(startSettlement, SETTLE_AFTER_HANDOFF_MS);
    },
    [satAmount, navigation, onPhase, recordPaid, startSettlement, setHold],
  );

  /**
   * A charge that failed AFTER the mint swap settled the bill (ENG-642) —
   * on the change write, the payment bookkeeping, anything past the point
   * `executeCharge` flags as paid — is over: the customer has paid. Ending
   * here as paid is the only safe answer — the PIN pad (which auto-commits
   * on four digits) or "Tap card again" would run the charge again and burn
   * the card a second time for the same bill. The error body says where the
   * money is (`failureBody`); every way out is Done. Returns false for any
   * failure before the swap, which the caller handles as today.
   */
  const endPaid = useCallback(
    (err: unknown): boolean => {
      // The card burned and the mint refused the swap (`PhaseError.refused`):
      // the bill is NOT paid, so it is not recorded as a sale — but the card
      // has spent, so it ends here like a paid failure, on the refusal with
      // Done, never "Tap card again" (which would burn the card again).
      const refused = isRefusedAfterBurn(err);
      if (!isPaidFailure(err) && !refused) {
        return false;
      }
      const message = describeCardFailure(err);
      settledRef.current = true;
      setSettled(true);
      // The hold hands over to the settled state: every exit is Done now
      // (the header arrow included), no longer refused.
      setHold(false);
      setFlow('done');
      setPin('');
      // A Cancel pressed during the change write does not hide this: the
      // money moved whoever closed the session.
      setError(message);
      if (!refused) {
        recordPaid();
      }
      startSettlement();
      return true;
    },
    [recordPaid, startSettlement, setHold],
  );

  /**
   * The card would not sign without its PIN (`6A94` at SPEND_ALL_SIGN: the
   * no-PIN allowance did not cover the bill after all). Nothing was burned:
   * the charge moves to the PIN pad, with the reason on it, and the PIN
   * re-taps as for any PIN card. Returns false for any other failure.
   */
  const askForPin = useCallback((err: unknown): boolean => {
    if (!isPinNeededForPayment(err)) {
      return false;
    }
    setPlan(p => (p ? {...p, pinRequired: true} : p));
    setFlow('pin');
    setPin('');
    setError(describeCardFailure(err));
    return true;
  }, []);

  // Session 1: the silent read + plan. A PIN-less card completes in this one
  // tap; a PIN card hands off to the pad and re-taps (session 2).
  const onCharge = useCallback(async () => {
    if (chargingRef.current || settledRef.current || satAmount <= 0) {
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
      if (endPaid(err) || askForPin(err)) {
        return;
      }
      // A 0.x card: no PIN pad, no charge — it needs an update (decision 8).
      if (isCardNeedsUpdate(err)) {
        setError(CARD_NEEDS_UPDATE);
        return;
      }
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      chargingRef.current = false;
      setCharging(false);
    }
  }, [satAmount, finish, onPhase, armStage, endPaid, askForPin]);

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
        if (endPaid(err) || askForPin(err)) {
          return;
        }
        setFlow('tap');
        if (!cancelledRef.current && !isUserCancel(err)) {
          setError(describeCardFailure(err));
        }
      })
      .finally(() => {
        chargingRef.current = false;
        setCharging(false);
      });
  }, [preRead, finish, navigation, armStage, endPaid, askForPin]);

  const onPinConfirm = useCallback(async () => {
    console.log(
      '[charge] pin confirm',
      JSON.stringify({
        chargingRef: chargingRef.current,
        hasPlan: !!plan,
        pinLen: pin.length,
      }),
    );
    if (chargingRef.current || settledRef.current || !plan) {
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
      // After the swap the bill is paid: never back to the pad, whose
      // re-entered PIN would run the charge again (ENG-642).
      if (endPaid(err)) {
        return;
      }
      // Before it, the pad is the retry.
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
  }, [plan, pin, finish, armStage, endPaid]);

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
    if (settledRef.current) {
      // Paid: there is no charge left to cancel or to clear back to.
      return;
    }
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

  // The paid-after-swap error's one way out: the bill is settled, so back to
  // a fresh keypad (it clears the amount on focus), as Success's Done does.
  // Home is the existing route object (same key), so it does not remount.
  const onDone = useCallback(() => {
    leavingRef.current = true;
    const routes = navigation.getState?.()?.routes ?? [];
    const home = routes.find(r => r.name === 'Home') ?? {name: 'Home'};
    navigation.reset({index: 0, routes: [home as never]});
  }, [navigation]);

  // Once paid, every exit is Done. The common path here is Keypad → Invoice
  // → "Pay by Flashcard" → router → this screen: a plain pop (edge swipe,
  // a stray goBack) would land on the Invoice with the amount still in the
  // store and "Pay by Flashcard" live — one more tap burns the card again
  // for a bill already paid (ENG-642). While the charge is still in flight
  // after the first burn, a pop is refused outright (ENG-645): the charge
  // ends where the merchant can see it, then Done or the hand-off leaves.
  // Done's own reset and the hand-off pass through.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', e => {
        if (leavingRef.current) {
          return;
        }
        if (settledRef.current) {
          e.preventDefault();
          onDone();
          return;
        }
        if (holdingRef.current) {
          e.preventDefault();
        }
      }),
    [navigation, onDone],
  );

  // The header arrow: Done once paid, nothing while the charge is in flight
  // after the burn (the view disables it too; the ref closes the frame
  // before that render lands), a plain pop otherwise.
  const onBack = useCallback(() => {
    if (settledRef.current) {
      onDone();
      return;
    }
    if (holdingRef.current) {
      return;
    }
    navigation.goBack();
  }, [navigation, onDone]);

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
      changePieces: plan.plan.changePieces,
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
      onBack={onBack}
      onCharge={onCharge}
      onCancel={onCancel}
      onRetry={onRetry}
      onPinDigit={onPinDigit}
      onPinBackspace={onPinBackspace}
      onPinClear={onPinClear}
      onPinConfirm={onPinConfirm}
      onOpenNfcSettings={onOpenNfcSettings}
      settled={settled}
      onDone={onDone}
      holding={holding}
    />
  );
};

export default CashuCardCharge;
