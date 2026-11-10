import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Modal} from 'react-native';
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
import {isUserCancel, withCardSession} from '../services/cashuCardNfc';
import {
  getTopUp,
  loadTopUp,
  pollTopUp,
  roundTopUp,
  startTopUp,
  TopUpError,
  topUpErrorCopy,
  type LoadTopUpResult,
  type TopUpCopy,
  type TopUpEntry,
  type TopUpErrorKind,
} from '../services/cashuTopUp';

// utils
import {formatSatAmount} from '../utils/satCurrency';

type Props = StackScreenProps<RootStackType, 'CashuCardTopUp'>;

type Phase = 'entering' | 'invoice' | 'paid' | 'loading' | 'done' | 'error';

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
  /** Where "Try again" goes: the card's tap for a paid top-up, else the amount. */
  back: 'paid' | 'entering';
}

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

  const creatingRef = useRef(false);
  const holdingRef = useRef(false);
  const leavingRef = useRef(false);
  const unmountedRef = useRef(false);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (!entry || holdingRef.current) {
        return;
      }
      holdingRef.current = true;
      setPhase('loading');
      try {
        const done = await withCardSession(
          transceive =>
            loadTopUp({topupId: entry.topupId, transceive, pin: withPin}),
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
        pinRef.current = '';
        if (!unmountedRef.current) {
          setPin('');
        }
      }
    },
    [entry, fail],
  );

  const onLoad = useCallback(() => {
    if (needsPin) {
      pinRef.current = '';
      setPin('');
      setPinOpen(true);
      return;
    }
    runLoad();
  }, [needsPin, runLoad]);

  const commitPin = useCallback(
    (value: string) => {
      if (value.length < PIN_MIN) {
        return;
      }
      setPinOpen(false);
      runLoad(value);
    },
    [runLoad],
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
      if (next.length >= PIN_MIN) {
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
    setPhase(error.back === 'paid' && entry ? 'paid' : 'entering');
  }, [error, entry, onCreate]);

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
        <SecondaryButton
          testID="topup-later"
          btnText="Later"
          btnStyle={gapTop}
          onPress={onDone}
        />
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
            <SecondaryButton
              testID="pin-cancel"
              btnText="Cancel"
              onPress={closePin}
            />
          </Sheet>
        </Modal>
      </Wrapper>
    );
  }

  if (phase === 'loading') {
    return (
      <Wrapper>
        <Spacer />
        <ActivityIndicator size="large" color="#002118" />
        <Title testID="topup-loading">
          {entry ? 'Loading… keep the card on the phone' : 'Loading…'}
        </Title>
        <Spacer />
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
      <SecondaryButton
        testID="topup-exit"
        btnText={error?.back === 'paid' ? 'Later' : 'Cancel'}
        btnStyle={gapTop}
        onPress={error?.back === 'paid' ? onDone : () => navigation.goBack()}
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
