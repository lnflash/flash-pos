import React, {useContext, useEffect, useMemo, useRef} from 'react';
import {Animated, Dimensions, Platform, StatusBar} from 'react-native';
import {useReduceMotion} from '../utils/reduceMotion';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';
import {SafeAreaFrameContext} from 'react-native-safe-area-context';

// components
import {PrimaryButton, SecondaryButton} from '../components';
import SealCheck from '../components/icons/SealCheck';
import {kf, play} from '../components/cashu/charge/motion';

// hooks
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {usePrint} from '../hooks';
import {useFlashcard} from '../hooks';

// store
import {resetAmount} from '../store/slices/amountSlice';
import {resetInvoice} from '../store/slices/invoiceSlice';

// utils
import {formatSatAmount} from '../utils/satCurrency';
import {SUCCESS_BADGE_SIZE, successBadgeCenter} from '../utils/successBadge';
import {hideEdgeTint, holdEdgeTint} from '../utils/edgeTint';
import {logSuccessFirstFrame} from '../utils/chargeHandoff';

type Props = StackScreenProps<RootStackType, 'Success'>;

const printButtonTextStyle = {color: '#002118'};
const printButtonStyle = {backgroundColor: '#fff'};
const doneButtonTextStyle = {color: '#fff'};
const doneButtonStyle = {borderColor: '#fff', marginTop: 10};

/** The card charge's hand-off entrance: the badge is already in place. */
const ENTRANCE_MS = 360;

interface SuccessViewProps {
  title: string;
  amountText: string;
  handoff: boolean;
  printed: boolean;
  onPrint: () => void;
  onDone: () => void;
}

/**
 * What Success shows, shared by the live screen and the DEV preview's
 * hand-off proof — so the proof records the shipping pixels.
 */
const SuccessView = ({
  title,
  amountText,
  handoff,
  printed,
  onPrint,
  onDone,
}: SuccessViewProps) => {
  // The badge sits on the same point the card charge's finale lands on:
  // both read it from successBadgeCenter on the same stack frame.
  const ctxFrame = useContext(SafeAreaFrameContext);
  const heroTop = useMemo(() => {
    const frame =
      ctxFrame && ctxFrame.height > 0
        ? ctxFrame
        : {
            width: Dimensions.get('window').width,
            height: Dimensions.get('window').height,
          };
    return successBadgeCenter(frame).y - SUCCESS_BADGE_SIZE / 2;
  }, [ctxFrame]);

  // Reduce motion: the hand-off entrance is a fade only (no 8 dp rise).
  const reduceMotion = useReduceMotion();
  const clock = useRef(new Animated.Value(handoff ? 0 : 1)).current;
  const entrance = useMemo(() => {
    const rise = (t0: number) => ({
      opacity: kf(
        clock,
        [
          {t: t0, v: 0},
          {t: t0 + 240, v: 1, ease: 'OUT'},
        ],
        ENTRANCE_MS,
      ),
      transform: [
        {
          translateY: kf(
            clock,
            reduceMotion
              ? [{t: 0, v: 0}]
              : [
                  {t: t0, v: 8},
                  {t: t0 + 240, v: 0, ease: 'OUT'},
                ],
            ENTRANCE_MS,
          ),
        },
      ],
    });
    return {title: rise(0), amount: rise(60), buttons: rise(120)};
  }, [clock, reduceMotion]);

  useEffect(() => {
    if (!handoff) {
      return;
    }
    play(clock, ENTRANCE_MS);
    holdEdgeTint();
    logSuccessFirstFrame();
    // Light icons on the green, for as long as Success is up; leaving
    // restores whatever the stack had before.
    const bar = StatusBar.pushStackEntry({
      barStyle: 'light-content',
      animated: true,
    });
    return () => {
      hideEdgeTint(200);
      StatusBar.popStackEntry(bar);
    };
  }, [handoff, clock]);

  return (
    <Wrapper>
      <Hero style={{top: heroTop}} testID="success-hero">
        <IconWrapper testID="success-badge">
          <SealCheck size={50} />
        </IconWrapper>
        <Animated.View style={entrance.title}>
          <Title>{title}</Title>
        </Animated.View>
        <Animated.View style={entrance.amount}>
          <PrimaryAmount>{amountText}</PrimaryAmount>
        </Animated.View>
      </Hero>
      <Spacer />
      <Animated.View style={entrance.buttons}>
        <BtnsWrapper>
          <PrimaryButton
            icon={printed ? 'rotate' : 'print'}
            btnText={printed ? 'Reprint' : 'Print'}
            iconColor="#002118"
            textStyle={printButtonTextStyle}
            btnStyle={printButtonStyle}
            onPress={onPrint}
          />
          <SecondaryButton
            btnText="Done"
            iconColor="#fff"
            textStyle={doneButtonTextStyle}
            btnStyle={doneButtonStyle}
            onPress={onDone}
          />
        </BtnsWrapper>
      </Animated.View>
    </Wrapper>
  );
};

/** The live screen: the recorded transaction, printing, NFC off while up. */
const LiveSuccess: React.FC<Props> = ({navigation, route}) => {
  const {print, printSilently, printReceipt, printReceiptHTML} = usePrint();
  const {setNfcEnabled} = useFlashcard();
  const handoff = !!route.params?.handoff;

  const dispatch = useAppDispatch();
  const amountState = useAppSelector(state => state.amount);
  const {lastTransaction} = useAppSelector(state => state.transactionHistory);
  // Show the amount of the transaction that was just recorded, not the live
  // keypad state — whether this screen rendered before or after the keypad's
  // focus effect reset the amount slice was a race (field-found 2026-09-30:
  // "J$0" on a J$1 charge). The record is stable; the slice is only a
  // fallback for a Success without one.
  const {displayAmount, satAmount, currency, isPrimaryAmountSats} =
    lastTransaction?.amount ?? amountState;
  // Sats are unit-last and pluralised ("13 sats"); the fiat layout would have
  // printed the SAT symbol first ("sat 13" — field-found 2026-09-30).
  const amountText =
    route.params?.amountText ??
    (isPrimaryAmountSats
      ? formatSatAmount(satAmount)
      : currency.id === 'SAT'
      ? formatSatAmount(displayAmount)
      : `${currency.symbol} ${displayAmount || 0}`);

  // Track whether receipt has been printed
  const [hasBeenPrinted, setHasBeenPrinted] = React.useState(false);

  // Disable NFC on mount and re-enable on unmount
  useEffect(() => {
    setNfcEnabled(false);

    return () => {
      setNfcEnabled(true);
    };
  }, [setNfcEnabled]);

  // Note: Transaction creation is now handled in the Invoice screen to include reward information
  // This prevents duplicate transactions and ensures reward data is properly recorded

  const onDone = () => {
    dispatch(resetInvoice());
    dispatch(resetAmount());
    navigation.reset({
      index: 0,
      routes: [{name: 'Home'}],
    });
  };

  const onPrintReceipt = () => {
    if (!hasBeenPrinted) {
      // First print - use silent printing
      if (Platform.OS === 'ios') {
        print();
      } else {
        printSilently();
      }
      setHasBeenPrinted(true);
    } else if (lastTransaction) {
      // Subsequent prints - use reprint functionality
      const receiptData: ReceiptData = {
        id: lastTransaction.id,
        timestamp: lastTransaction.timestamp,
        satAmount: lastTransaction.amount.satAmount,
        displayAmount: lastTransaction.amount.displayAmount,
        currency: lastTransaction.amount.currency,
        isPrimaryAmountSats: lastTransaction.amount.isPrimaryAmountSats,
        username: lastTransaction.merchant.username,
        memo: lastTransaction.memo,
        paymentHash: lastTransaction.invoice.paymentHash,
        status: lastTransaction.status,
      };
      if (Platform.OS === 'ios') {
        printReceiptHTML(receiptData);
      } else {
        printReceipt(receiptData);
      }
    }
  };

  return (
    <SuccessView
      title={route.params?.title || 'The invoice has been paid'}
      amountText={amountText}
      handoff={handoff}
      printed={hasBeenPrinted}
      onPrint={onPrintReceipt}
      onDone={onDone}
    />
  );
};

const noop = () => {};

/**
 * DEV ONLY — the charge preview's hand-off proof lands here: the same view
 * and hand-off, but no NFC toggle, no store reads or writes, no printing.
 */
const PreviewSuccess: React.FC<Props> = ({navigation, route}) => (
  <SuccessView
    title={route.params?.title || 'The invoice has been paid'}
    amountText={route.params?.amountText ?? ''}
    handoff={!!route.params?.handoff}
    printed={false}
    onPrint={noop}
    onDone={() => navigation.goBack()}
  />
);

const Success: React.FC<Props> = props =>
  __DEV__ && props.route.params?.preview ? (
    <PreviewSuccess {...props} />
  ) : (
    <LiveSuccess {...props} />
  );

export default Success;

const Wrapper = styled.View`
  flex: 1;
  background-color: #007856;
  padding-bottom: 20px;
  padding-horizontal: 20px;
`;

const Hero = styled.View`
  position: absolute;
  left: 0;
  right: 0;
  padding-horizontal: 20px;
  align-items: center;
`;

const Spacer = styled.View`
  flex: 1;
`;

const IconWrapper = styled.View`
  width: 80px;
  height: 80px;
  background-color: #fff;
  border-radius: 40px;
  padding: 15px;
`;

const Title = styled.Text`
  font-size: 26px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #fff;
  margin-top: 32px;
`;

const PrimaryAmount = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #fff;
`;

const BtnsWrapper = styled.View`
  align-items: center;
`;
