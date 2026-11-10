import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Modal, TextInput} from 'react-native';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';
import QRCode from 'react-native-qrcode-svg';

// components
// Leaf imports, like CashuCardBalance: the `../components` barrel pulls in
// the printer and currency-picker modules.
import PinPad from '../components/cashu/PinPad';
import PrimaryButton from '../components/buttons/PrimaryButton';
import SecondaryButton from '../components/buttons/SecondaryButton';

// hooks
import {useRealtimePrice} from '../hooks';
import {useCardSessionRelease} from '../hooks/useCardSessionRelease';

// services
import {
  cancelCardSession,
  isUserCancel,
  withCardSession,
} from '../services/cashuCardNfc';
import {
  beginTopUpRefund,
  getTopUp,
  loadTopUp,
  pollTopUp,
  previewTopUpRefund,
  resumeTopUpRefund,
  roundTopUp,
  startTopUp,
  TopUpError,
  topUpErrorCopy,
  type LoadTopUpResult,
  type TopUpCopy,
  type TopUpEntry,
  type TopUpErrorKind,
  type TopUpRefundPreview,
  type TopUpRefundResult,
} from '../services/cashuTopUp';

// utils
import {formatSatAmount} from '../utils/satCurrency';

type Props = StackScreenProps<RootStackType, 'CashuCardTopUp'>;

type Phase =
  | 'entering'
  | 'invoice'
  | 'paid'
  | 'loading'
  | 'done'
  | 'refundTo'
  | 'refundConfirm'
  | 'refunding'
  | 'refunded'
  | 'error';

/** Where a refund is: waiting for the card, on the card, or with the mint. */
type RefundStage = 'tap' | 'card' | 'paying';

/** How often an open invoice asks the mint whether it was paid. */
export const TOPUP_POLL_MS = 1500;
/** Idle time after the 4th PIN digit before the PIN goes to the card. */
export const PIN_COMMIT_MS = 700;
/** The longest amount the pad takes (100,000 is the cap). */
const MAX_DIGITS = 6;
const PIN_MIN = 4;
const PIN_MAX = 8;

/** What a wallet scans: `LIGHTNING:` and the invoice, upper case (the QR's alphanumeric mode). */
export const invoiceQrText = (bolt11: string): string =>
  `LIGHTNING:${bolt11.toUpperCase()}`;

/** `m:ss` until `expiry` (unix seconds); 0:00 once past. */
export function timeLeft(expiry: number, nowMs: number): string {
  const s = Math.ceil(Math.max(0, expiry * 1000 - nowMs) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const rounded = (sat: number) => {
  try {
    return roundTopUp(sat);
  } catch {
    return null;
  }
};

interface ErrorState {
  kind: TopUpErrorKind;
  copy: TopUpCopy;
  /**
   * Where "Try again" goes: the card's tap for a paid top-up, the refund
   * for one already refunding, else the amount.
   */
  back: 'paid' | 'refunding' | 'entering';
}

const refundedFrom = (e: TopUpEntry): TopUpRefundResult => ({
  amountSat: e.refund?.amountSat ?? 0,
  changeSat: e.refund?.changeSat ?? 0,
  preimage: e.refund?.preimage ?? null,
  destination: e.refund?.destination ?? {kind: 'bolt11', value: ''},
});

const fullWidth = {width: '100%' as const};
const gapTop = {marginTop: 12};

/**
 * Top up a Cashu card at its own mint (ENG-853), from CashuCardBalance.
 *
 * entering → invoice (a bolt11 quote at the card's mint, drawn as a QR and
 * polled) → paid → the card's tap (PIN first on a PIN card) → loading →
 * done. A paid top-up is kept on this phone until it is on the card: Cancel
 * or leaving never drops it, and the card's next balance read offers to load
 * it. Nothing here touches the merchant's money or the settlement queue.
 *
 * Refund (ENG-855), from paid while nothing is minted: refundTo (the holder's
 * invoice or Lightning address) → refundConfirm (the net and the fee) → the
 * card's tap and PIN → refunding (the mint pays, no card needed) → refunded.
 */
const CashuCardTopUp: React.FC<Props> = ({navigation, route}) => {
  const {summary, cardMint, cardUnit, resume} = route.params;
  const {satsToCurrency, loading: priceLoading} = useRealtimePrice();

  const [phase, setPhase] = useState<Phase>(resume ? 'loading' : 'entering');
  const [digits, setDigits] = useState('');
  const [entry, setEntry] = useState<TopUpEntry | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [result, setResult] = useState<LoadTopUpResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [refundInput, setRefundInput] = useState('');
  const [refundNote, setRefundNote] = useState<TopUpCopy | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<TopUpRefundPreview | null>(null);
  const [refundStage, setRefundStage] = useState<RefundStage>('tap');
  const [refunded, setRefunded] = useState<TopUpRefundResult | null>(null);
  // A refunding top-up opened from the balance screen, to finish.
  const [resuming, setResuming] = useState<string | null>(null);

  const creatingRef = useRef(false);
  // A load is running (from the arm to its end) …
  const loadingRef = useRef(false);
  // … and the card is on the phone: leaving is held.
  const holdingRef = useRef(false);
  const leavingRef = useRef(false);
  const unmountedRef = useRef(false);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What a committed PIN is for: the load, or the refund.
  const modeRef = useRef<'load' | 'refund'>('load');

  const sat = Number(digits || '0');
  const round = sat > 0 ? rounded(sat) : null;
  const needsPin = summary.info.pinState === 'set';

  const releaseCardSession = useCardSessionRelease();
  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (pinTimer.current) {
        clearTimeout(pinTimer.current);
      }
    },
    [],
  );

  const fail = useCallback(
    (e: unknown, back: ErrorState['back'], paid: boolean) => {
      const err =
        e instanceof TopUpError
          ? e
          : isUserCancel(e)
          ? new TopUpError('not_loaded')
          : new TopUpError(
              paid ? 'not_loaded' : 'failed',
              e instanceof Error ? e.message : String(e),
            );
      setError({
        kind: err.kind,
        copy: topUpErrorCopy(err, {paid}),
        back: err.kind === 'expired' ? 'entering' : back,
      });
      setPhase('error');
    },
    [],
  );

  // A top-up this phone already holds: back where it stopped.
  useEffect(() => {
    if (!resume) {
      return;
    }
    let live = true;
    getTopUp(resume)
      .then(found => {
        if (!live) {
          return;
        }
        if (!found) {
          fail(
            new TopUpError('failed', 'This top-up is not on this phone.'),
            'entering',
            false,
          );
          return;
        }
        setEntry(found);
        setDigits(String(found.amountSat));
        if (found.state === 'waiting') {
          setPhase('invoice');
        } else if (found.state === 'expired') {
          fail(new TopUpError('expired'), 'entering', false);
        } else if (found.state === 'loaded') {
          setResult({
            amountSat: found.amountSat,
            loadId: found.topupId.slice(0, 8),
          });
          setPhase('done');
        } else if (found.state === 'refunded') {
          setRefunded(refundedFrom(found));
          setPhase('refunded');
        } else if (found.state === 'refunding') {
          // The card's part is done: the mint finishes it, no tap needed.
          setResuming(found.topupId);
        } else {
          setPhase('paid');
        }
      })
      .catch(e => live && fail(e, 'entering', false));
    return () => {
      live = false;
    };
  }, [resume, fail]);

  const onCreate = useCallback(async () => {
    if (creatingRef.current || !round) {
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    try {
      const made = await startTopUp({
        summary,
        cardMint,
        unit: cardUnit,
        sat: round.amountSat,
      });
      if (unmountedRef.current) {
        return;
      }
      setEntry(made);
      setNow(Date.now());
      setPhase('invoice');
    } catch (e) {
      if (!unmountedRef.current) {
        fail(e, 'entering', false);
      }
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [round, summary, cardMint, cardUnit, fail]);

  // The open invoice: ask the mint every 1.5 s while the app is in front,
  // and at once on coming back. The mint's answer is the truth.
  useEffect(() => {
    if (phase !== 'invoice' || !entry) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    const check = async () => {
      if (!live || inFlight || AppState.currentState !== 'active') {
        return;
      }
      inFlight = true;
      try {
        const next = await pollTopUp(entry.topupId);
        if (!live || !next) {
          return;
        }
        if (next.state === 'expired') {
          live = false;
          fail(new TopUpError('expired'), 'entering', false);
        } else if (next.state !== 'waiting') {
          live = false;
          setEntry(next);
          setPhase('paid');
        }
      } catch {
        // A poll that will not run changes nothing; the next one asks again.
      } finally {
        inFlight = false;
      }
    };
    const loop = async () => {
      await check();
      if (live) {
        timer = setTimeout(loop, TOPUP_POLL_MS);
      }
    };
    timer = setTimeout(loop, TOPUP_POLL_MS);
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        check();
      }
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      if (timer) {
        clearTimeout(timer);
      }
      clearInterval(tick);
      // Optional: some AppState stand-ins hand back no subscription.
      sub?.remove();
    };
  }, [phase, entry, fail]);

  const runLoad = useCallback(
    async (withPin?: string) => {
      if (!entry || loadingRef.current) {
        return;
      }
      loadingRef.current = true;
      setConnected(false);
      setPhase('loading');
      try {
        const done = await withCardSession(
          transceive =>
            loadTopUp({
              topupId: entry.topupId,
              transceive,
              pin: withPin,
              // The card is on the phone: from here nothing leaves until
              // the load ends where the merchant can see it.
              onPhase: () => {
                holdingRef.current = true;
                if (!unmountedRef.current) {
                  setConnected(true);
                }
              },
            }),
          {
            alertMessage: `Hold the card to load ${formatSatAmount(
              entry.amountSat,
            )}`,
          },
        );
        if (!unmountedRef.current) {
          setResult(done);
          setPhase('done');
        }
      } catch (e) {
        if (!unmountedRef.current) {
          fail(e, 'paid', true);
        }
      } finally {
        holdingRef.current = false;
        loadingRef.current = false;
        pinRef.current = '';
        if (!unmountedRef.current) {
          setPin('');
        }
      }
    },
    [entry, fail],
  );

  const onLoad = useCallback(() => {
    modeRef.current = 'load';
    if (needsPin) {
      pinRef.current = '';
      setPin('');
      setPinOpen(true);
      return;
    }
    runLoad();
  }, [needsPin, runLoad]);

  // A refund that stopped: back to the paid step when nothing was written,
  // to the refund when the entry is already refunding.
  const failRefund = useCallback(async (e: unknown, topupId: string) => {
    let latest: TopUpEntry | null = null;
    try {
      latest = await getTopUp(topupId);
    } catch {
      latest = null;
    }
    if (unmountedRef.current) {
      return;
    }
    if (latest) {
      setEntry(latest);
    }
    if (latest?.state === 'refunded') {
      setRefunded(refundedFrom(latest));
      setPhase('refunded');
      return;
    }
    const err =
      e instanceof TopUpError
        ? e
        : isUserCancel(e)
        ? new TopUpError('not_loaded')
        : new TopUpError(
            'refund_failed',
            e instanceof Error ? e.message : String(e),
          );
    const refunding = latest?.state === 'refunding';
    setError({
      kind: err.kind,
      copy:
        err.kind === 'not_loaded'
          ? {title: 'Not refunded', body: 'The top-up is paid and waiting.'}
          : topUpErrorCopy(err, {paid: !refunding}),
      back: refunding ? 'refunding' : 'paid',
    });
    setPhase('error');
  }, []);

  // The mint's part of a refund: no card. Runs on resume and after the tap.
  const finishRefund = useCallback(
    async (topupId: string) => {
      loadingRef.current = true;
      setRefundStage('paying');
      setPhase('refunding');
      try {
        const done = await resumeTopUpRefund(topupId);
        if (!unmountedRef.current) {
          setRefunded(done);
          setPhase('refunded');
        }
      } catch (e) {
        if (!unmountedRef.current) {
          await failRefund(e, topupId);
        }
      } finally {
        loadingRef.current = false;
      }
    },
    [failRefund],
  );
  useEffect(() => {
    if (resuming) {
      setResuming(null);
      finishRefund(resuming);
    }
  }, [resuming, finishRefund]);

  const onRefund = useCallback(() => {
    setRefundNote(null);
    setPhase('refundTo');
  }, []);

  const onRefundContinue = useCallback(async () => {
    if (!entry || previewing) {
      return;
    }
    setPreviewing(true);
    setRefundNote(null);
    try {
      const priced = await previewTopUpRefund({
        topupId: entry.topupId,
        destination: refundInput,
      });
      if (!unmountedRef.current) {
        setPreview(priced);
        setPhase('refundConfirm');
      }
    } catch (e) {
      if (!unmountedRef.current) {
        setRefundNote(
          topUpErrorCopy(
            e instanceof TopUpError
              ? e
              : new TopUpError(
                  'refund_failed',
                  e instanceof Error ? e.message : String(e),
                ),
          ),
        );
      }
    } finally {
      if (!unmountedRef.current) {
        setPreviewing(false);
      }
    }
  }, [entry, previewing, refundInput]);

  const runRefund = useCallback(
    async (withPin?: string) => {
      if (!entry || !preview || loadingRef.current) {
        return;
      }
      loadingRef.current = true;
      setRefundStage('tap');
      setPhase('refunding');
      let begun = false;
      try {
        await withCardSession(
          transceive =>
            beginTopUpRefund({
              topupId: entry.topupId,
              destination: preview.destination.value,
              shownNetSat: preview.netSat,
              transceive,
              pin: withPin,
              onPhase: () => {
                holdingRef.current = true;
                if (!unmountedRef.current) {
                  setRefundStage('card');
                }
              },
            }),
          {
            alertMessage: `Hold the card to refund ${formatSatAmount(
              preview.netSat,
            )}`,
          },
        );
        begun = true;
      } catch (e) {
        if (!unmountedRef.current) {
          await failRefund(e, entry.topupId);
        }
      } finally {
        // The card is done with: the melt needs no session.
        holdingRef.current = false;
        loadingRef.current = false;
        pinRef.current = '';
        if (!unmountedRef.current) {
          setPin('');
        }
      }
      if (begun && !unmountedRef.current) {
        await finishRefund(entry.topupId);
      }
    },
    [entry, preview, failRefund, finishRefund],
  );

  const onRefundConfirm = useCallback(() => {
    modeRef.current = 'refund';
    if (needsPin) {
      pinRef.current = '';
      setPin('');
      setPinOpen(true);
      return;
    }
    runRefund();
  }, [needsPin, runRefund]);

  const commitPin = useCallback(
    (value: string) => {
      if (value.length < PIN_MIN) {
        return;
      }
      setPinOpen(false);
      if (modeRef.current === 'refund') {
        runRefund(value);
      } else {
        runLoad(value);
      }
    },
    [runLoad, runRefund],
  );

  // The PIN as typed, read by the commit timer (state lags a render behind).
  const pinRef = useRef('');
  const typePin = useCallback(
    (next: string) => {
      pinRef.current = next;
      setPin(next);
      if (pinTimer.current) {
        clearTimeout(pinTimer.current);
        pinTimer.current = null;
      }
      // Like CashuCardCharge: only an exact 4-digit entry commits on its own.
      // A longer PIN waits for "Load", so a pause mid-entry never sends a
      // short PIN that burns one of the card's tries.
      if (next.length === PIN_MIN) {
        pinTimer.current = setTimeout(() => commitPin(next), PIN_COMMIT_MS);
      }
    },
    [commitPin],
  );
  const onPinDigit = useCallback(
    (d: string) => {
      if (pinRef.current.length < PIN_MAX) {
        typePin(pinRef.current + d);
      }
    },
    [typePin],
  );

  const closePin = useCallback(() => {
    if (pinTimer.current) {
      clearTimeout(pinTimer.current);
      pinTimer.current = null;
    }
    pinRef.current = '';
    setPin('');
    setPinOpen(false);
  }, []);

  const onDone = useCallback(() => {
    leavingRef.current = true;
    const routes = navigation.getState?.()?.routes ?? [];
    const home = routes.find(r => r.name === 'Home') ?? {name: 'Home'};
    navigation.reset({index: 0, routes: [home as never]});
  }, [navigation]);

  // While the card is being loaded, nothing leaves (ENG-645's pattern): the
  // load ends where the merchant can see it. Every other exit releases the
  // card session before the keypad underneath re-arms (ENG-704).
  useEffect(
    () =>
      navigation.addListener('beforeRemove', e => {
        if (holdingRef.current && !leavingRef.current) {
          e.preventDefault();
          return;
        }
        releaseCardSession();
      }),
    [navigation, releaseCardSession],
  );

  const onDigit = useCallback((d: string) => {
    setDigits(prev =>
      prev.length >= MAX_DIGITS || (prev === '' && d === '0') ? prev : prev + d,
    );
  }, []);

  const onRetry = useCallback(() => {
    if (!error) {
      return;
    }
    if (error.kind === 'expired') {
      // A new quote, a new entry; the expired one stays on record.
      setEntry(null);
      setError(null);
      setPhase('entering');
      onCreate();
      return;
    }
    setError(null);
    if (error.back === 'refunding' && entry) {
      finishRefund(entry.topupId);
      return;
    }
    setPhase(error.back === 'paid' && entry ? 'paid' : 'entering');
  }, [error, entry, onCreate, finishRefund]);

  const amountSat = entry?.amountSat ?? round?.amountSat ?? 0;

  if (phase === 'entering') {
    const over = sat > 0 && !round;
    return (
      <Wrapper>
        <Title>Top up card</Title>
        <Amount testID="topup-amount">
          {round ? `Top up ${formatSatAmount(round.amountSat)}` : '0 sats'}
        </Amount>
        <Caption testID="topup-fiat">
          {round && !priceLoading
            ? satsToCurrency(round.amountSat).formattedCurrency
            : ' '}
        </Caption>
        <Caption testID="topup-rounding">
          {over
            ? 'A top-up is at most 100,000 sats.'
            : round && round.amountSat !== sat
            ? `Rounded from ${formatSatAmount(sat)} to fit the card`
            : ' '}
        </Caption>
        <PadBox>
          <PinPad
            tone="ink"
            onDigit={onDigit}
            onBackspace={() => setDigits(prev => prev.slice(0, -1))}
            onClear={() => setDigits('')}
          />
        </PadBox>
        <PrimaryButton
          testID="topup-create"
          btnText={creating ? 'Creating invoice…' : 'Create invoice'}
          btnStyle={fullWidth}
          disabled={!round || creating}
          onPress={onCreate}
        />
        <SecondaryButton
          testID="topup-cancel"
          btnText="Cancel"
          btnStyle={gapTop}
          onPress={() => navigation.goBack()}
        />
      </Wrapper>
    );
  }

  if (phase === 'invoice' && entry) {
    return (
      <Wrapper>
        <Title>{`Top up ${formatSatAmount(entry.amountSat)}`}</Title>
        <QrBox testID="topup-qr">
          <QRCode value={invoiceQrText(entry.bolt11)} size={240} />
        </QrBox>
        <Caption>Scan with a Lightning wallet</Caption>
        {entry.expiry !== null && (
          <Caption testID="topup-expires">
            {`Expires in ${timeLeft(entry.expiry, now)}`}
          </Caption>
        )}
        <Spacer />
        <SecondaryButton
          testID="topup-cancel"
          btnText="Cancel"
          onPress={() => navigation.goBack()}
        />
      </Wrapper>
    );
  }

  const pinSheet = (
    <Modal
      visible={pinOpen}
      transparent
      animationType="slide"
      onRequestClose={closePin}>
      <Sheet testID="pin-sheet">
        <Title>Enter the card's PIN</Title>
        <Dots testID="pin-dots">
          {pin.length ? '•'.repeat(pin.length) : ' '}
        </Dots>
        <PadBox>
          <PinPad
            tone="ink"
            onDigit={onPinDigit}
            onBackspace={() => typePin(pinRef.current.slice(0, -1))}
            onClear={() => typePin('')}
          />
        </PadBox>
        <PrimaryButton
          testID="pin-confirm"
          btnText={modeRef.current === 'refund' ? 'Refund' : 'Load'}
          btnStyle={fullWidth}
          disabled={pin.length < PIN_MIN}
          onPress={() => {
            if (pinTimer.current) {
              clearTimeout(pinTimer.current);
              pinTimer.current = null;
            }
            commitPin(pinRef.current);
          }}
        />
        <SecondaryButton
          testID="pin-cancel"
          btnText="Cancel"
          btnStyle={gapTop}
          onPress={closePin}
        />
      </Sheet>
    </Modal>
  );

  if (phase === 'paid' && entry) {
    return (
      <Wrapper>
        <Title testID="topup-paid">
          {`Hold the card to load ${formatSatAmount(entry.amountSat)}`}
        </Title>
        <Caption>
          Paid. The top-up waits on this phone until it is on the card.
        </Caption>
        <Spacer />
        <PrimaryButton
          testID="topup-load"
          btnText="Load to card"
          onPress={onLoad}
        />
        {entry.minted ? (
          <Caption testID="topup-refund-locked">
            The pieces are locked to this card. Load them.
          </Caption>
        ) : (
          <SecondaryButton
            testID="topup-refund"
            btnText="Refund"
            btnStyle={gapTop}
            onPress={onRefund}
          />
        )}
        <SecondaryButton
          testID="topup-later"
          btnText="Later"
          btnStyle={gapTop}
          onPress={onDone}
        />
        {pinSheet}
      </Wrapper>
    );
  }

  if (phase === 'refundTo' && entry) {
    return (
      <Wrapper>
        <Title testID="topup-refund-title">
          {`Refund ${formatSatAmount(entry.amountSat)}`}
        </Title>
        <Caption>
          The holder's Lightning invoice or address. The mint's fee comes out of
          the refund.
        </Caption>
        <RefundInput
          testID="topup-refund-destination"
          value={refundInput}
          onChangeText={setRefundInput}
          placeholder="lnbc… or name@domain"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        {refundNote && (
          <>
            <Caption testID="topup-refund-note-title">
              {refundNote.title}
            </Caption>
            <Caption testID="topup-refund-note-body">{refundNote.body}</Caption>
          </>
        )}
        <Spacer />
        <PrimaryButton
          testID="topup-refund-continue"
          btnText={previewing ? 'Checking…' : 'Continue'}
          btnStyle={fullWidth}
          disabled={!refundInput.trim() || previewing}
          onPress={onRefundContinue}
        />
        <SecondaryButton
          testID="topup-refund-back"
          btnText="Back"
          btnStyle={gapTop}
          onPress={() => setPhase('paid')}
        />
      </Wrapper>
    );
  }

  if (phase === 'refundConfirm' && entry && preview) {
    return (
      <Wrapper>
        <Title testID="topup-refund-confirm-title">
          {`Refund ${formatSatAmount(preview.netSat)}`}
        </Title>
        <Caption testID="topup-refund-to">{preview.destination.value}</Caption>
        <Caption testID="topup-refund-terms">
          {`The holder gets ${formatSatAmount(
            preview.netSat,
          )}. The mint keeps up to ${formatSatAmount(preview.feeSat)} in fees.`}
        </Caption>
        <Caption>
          Check the destination with the holder: a refund can't be undone.
        </Caption>
        <Spacer />
        <PrimaryButton
          testID="topup-refund-confirm"
          btnText="Refund"
          btnStyle={fullWidth}
          onPress={onRefundConfirm}
        />
        <SecondaryButton
          testID="topup-refund-back"
          btnText="Back"
          btnStyle={gapTop}
          onPress={() => setPhase('refundTo')}
        />
        {pinSheet}
      </Wrapper>
    );
  }

  if (phase === 'refunding') {
    return (
      <Wrapper>
        <Spacer />
        <ActivityIndicator size="large" color="#002118" />
        <Title testID="topup-refunding">
          {refundStage === 'tap'
            ? `Hold the card to the phone to refund ${formatSatAmount(
                preview?.netSat ?? amountSat,
              )}`
            : refundStage === 'card'
            ? 'Checking the card… keep it on the phone'
            : 'Refunding… the mint is paying'}
        </Title>
        <Spacer />
        {refundStage === 'tap' && (
          <SecondaryButton
            testID="topup-tap-cancel"
            btnText="Cancel"
            onPress={() => cancelCardSession()}
          />
        )}
      </Wrapper>
    );
  }

  if (phase === 'refunded' && refunded) {
    return (
      <Wrapper>
        <Spacer />
        <Title testID="topup-refunded">
          {`Refunded ${formatSatAmount(refunded.amountSat)}`}
        </Title>
        <Caption testID="topup-refunded-to">
          {refunded.destination.value}
        </Caption>
        {refunded.changeSat > 0 && (
          <Caption testID="topup-refund-change">
            {`${formatSatAmount(refunded.changeSat)} came back and ${
              refunded.changeSat === 1 ? 'stays' : 'stay'
            } on this phone.`}
          </Caption>
        )}
        <Spacer />
        <PrimaryButton testID="topup-done" btnText="Done" onPress={onDone} />
      </Wrapper>
    );
  }

  if (phase === 'loading') {
    if (resume && !entry) {
      return (
        <Wrapper>
          <Spacer />
          <ActivityIndicator size="large" color="#002118" />
          <Spacer />
        </Wrapper>
      );
    }
    return (
      <Wrapper>
        <Spacer />
        <ActivityIndicator size="large" color="#002118" />
        {connected ? (
          <Title testID="topup-loading">
            Loading… keep the card on the phone
          </Title>
        ) : (
          <Title testID="topup-tap">
            {`Hold the card to the phone to load ${formatSatAmount(amountSat)}`}
          </Title>
        )}
        <Spacer />
        {!connected && (
          // Until the card answers, the wait can be called off (Android has
          // no system sheet with its own Cancel).
          <SecondaryButton
            testID="topup-tap-cancel"
            btnText="Cancel"
            onPress={() => cancelCardSession()}
          />
        )}
      </Wrapper>
    );
  }

  if (phase === 'done' && result) {
    return (
      <Wrapper>
        <Spacer />
        <Title testID="topup-loaded">
          {`Loaded ${formatSatAmount(result.amountSat)}`}
        </Title>
        <Caption testID="topup-load-id">{`Load id ${result.loadId}`}</Caption>
        <Spacer />
        <PrimaryButton testID="topup-done" btnText="Done" onPress={onDone} />
      </Wrapper>
    );
  }

  // error
  return (
    <Wrapper>
      <Spacer />
      <Title testID="topup-error-title">{error?.copy.title ?? ''}</Title>
      <Caption testID="topup-error-body">{error?.copy.body ?? ''}</Caption>
      <Spacer />
      <PrimaryButton
        testID="topup-retry"
        btnText={
          error?.kind === 'expired'
            ? 'New invoice'
            : error?.back === 'paid'
            ? 'Tap card again'
            : 'Try again'
        }
        onPress={onRetry}
      />
      {error?.back === 'refunding' && error.kind === 'refund_failed' && (
        // A destination that will not take the refund (an expired invoice):
        // another one, behind the card and its PIN again.
        <SecondaryButton
          testID="topup-refund-new"
          btnText="Refund to another destination"
          btnStyle={gapTop}
          onPress={() => {
            setError(null);
            setRefundNote(null);
            setPhase('refundTo');
          }}
        />
      )}
      <SecondaryButton
        testID="topup-exit"
        btnText={error?.back === 'entering' ? 'Cancel' : 'Later'}
        btnStyle={gapTop}
        onPress={
          error?.back === 'entering' ? () => navigation.goBack() : onDone
        }
      />
      {amountSat > 0 && error?.back === 'paid' && (
        <Caption>{`${formatSatAmount(
          amountSat,
        )} paid, waiting on this phone`}</Caption>
      )}
    </Wrapper>
  );
};

export default CashuCardTopUp;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding: 24px 20px 40px 20px;
  align-items: center;
`;

const Title = styled.Text`
  font-size: 22px;
  font-family: 'Outfit-SemiBold';
  color: #212121;
  text-align: center;
  margin-top: 12px;
`;

const Amount = styled.Text`
  font-size: 36px;
  font-family: 'Outfit-Regular';
  color: #212121;
  text-align: center;
  margin-top: 16px;
`;

const Caption = styled.Text`
  font-size: 15px;
  font-family: 'Outfit-Regular';
  color: #747474;
  text-align: center;
  margin-top: 8px;
`;

const PadBox = styled.View`
  width: 100%;
  flex: 1;
  margin: 12px 0;
`;

const QrBox = styled.View`
  margin-top: 24px;
  padding: 16px;
  border-radius: 12px;
  background-color: #fff;
  border: 1px solid #ececf1;
`;

const RefundInput = styled(TextInput)`
  width: 100%;
  margin-top: 16px;
  min-height: 80px;
  border-width: 1px;
  border-color: #ececf1;
  border-radius: 8px;
  padding: 12px;
  font-size: 15px;
  font-family: 'Outfit-Regular';
  color: #212121;
`;

const Spacer = styled.View`
  flex: 1;
`;

const Sheet = styled.View`
  flex: 1;
  margin-top: 30%;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  background-color: #fff;
  padding: 20px 20px 40px 20px;
  align-items: center;
`;

const Dots = styled.Text`
  font-size: 32px;
  letter-spacing: 8px;
  color: #002118;
  margin-top: 12px;
  min-height: 40px;
`;
