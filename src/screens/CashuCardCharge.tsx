import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView, TextInput} from 'react-native';
import {StackScreenProps} from '@react-navigation/stack';
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
  withCardSession,
} from '../services/cashuCardNfc';
import {chargeCard} from '../services/cashuCharge';
import {runAutoSettlement} from '../services/cashuAutoSettle';

// store
import {useAppSelector} from '../store/hooks';

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
const CashuCardCharge = ({navigation}: Props) => {
  // The keypad stores the amount as a string; a non-numeric entry is treated
  // as no amount rather than NaN-ed into a silent zero charge.
  const satAmount = Number(useAppSelector(state => state.amount.satAmount) ?? 0);
  const {username} = useAppSelector(state => state.user);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [charging, setCharging] = useState(false);
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

  const onCharge = useCallback(async () => {
    if (chargingRef.current || !satAmount || satAmount <= 0) {
      return;
    }
    chargingRef.current = true;
    cancelledRef.current = false;
    setCharging(true);
    setError(null);
    try {
      await withCardSession(
        transceive =>
          chargeCard({
            transceive,
            amountSat: satAmount,
            pin: pin.trim() || undefined,
            mintUrl: FLASH_CASHU_MINT_URL,
          }),
        {
          alertMessage: `Charge ${satAmount} sat — hold the customer's card`,
        },
      );
      // Recorded; settle + sweep in the background. The merchant sees the
      // success screen immediately — the money finishes moving on its own.
      if (username) {
        await runAutoSettlement(username).catch(() => {});
      }
      navigation.replace('Success', {
        title: `Charged ${satAmount} sat — paid by Cashu card`,
      });
    } catch (err) {
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      chargingRef.current = false;
      setCharging(false);
    }
  }, [satAmount, pin, username, navigation]);

  const onCancel = useCallback(() => {
    cancelledRef.current = true;
    cancelCardSession();
  }, []);

  return (
    <Wrapper contentContainerStyle={contentStyle}>
      <Title>Charge by Cashu card</Title>
      <Caption>
        {satAmount > 0
          ? `Customer pays ${satAmount} sat by tapping their card.`
          : 'No amount entered — go back and enter an amount first.'}
      </Caption>

      <Row>
        <Label>NFC available</Label>
        <Value>
          {supported === null ? 'checking…' : supported ? 'yes' : 'no'}
        </Value>
      </Row>

      <FieldLabel>Customer card PIN (leave blank if their card has none)</FieldLabel>
      <PinInput
        value={pin}
        onChangeText={setPin}
        placeholder="customer's card PIN"
        secureTextEntry
        keyboardType="number-pad"
      />

      {error && (
        <ErrorBox>
          <ErrorText>{error}</ErrorText>
        </ErrorBox>
      )}

      {charging ? (
        <>
          <ActivityIndicator style={buttonStyle} />
          <TextButton
            icon="xmark"
            title="Cancel"
            btnStyle={buttonStyle}
            onPress={onCancel}
          />
        </>
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

const FieldLabel = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
  margin-top: 16px;
`;

const PinInput = styled(TextInput)`
  margin-top: 6px;
  border-width: 1px;
  border-color: #ececf1;
  border-radius: 8px;
  padding: 10px;
  font-size: 15px;
  color: #1f2328;
`;

const buttonStyle = {marginTop: 20};

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
