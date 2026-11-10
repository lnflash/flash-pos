import React, {useCallback, useEffect, useState} from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
// Leaf import, like CashuCardDebug: the `../components` barrel pulls in the
// printer and currency-picker modules, which this screen has no need of.
import PrimaryButton from '../components/buttons/PrimaryButton';
import SecondaryButton from '../components/buttons/SecondaryButton';
import {
  CARD_ART,
  CARD_PALETTE,
  CardArtV2,
} from '../components/cashu/charge/cardArtV2';

// hooks
import {useRealtimePrice} from '../hooks';

// services
import type {CardInfo} from '../services/cashuCard';
import {
  canTopUp,
  owedPiecesFor,
  refreshWaitingTopUps,
  toWaitingTopUp,
  topUpErrorCopy,
  type WaitingTopUp,
} from '../services/cashuTopUp';

// utils
import {formatSatAmount} from '../utils/satCurrency';

type Props = StackScreenProps<RootStackType, 'CashuCardBalance'>;

const {width: screenWidth} = Dimensions.get('window');
/** The card at the art's own size where it fits, narrower on small phones. */
const CARD_W = Math.min(CARD_ART.width, screenWidth - 40);
const CARD_H = (CARD_W * CARD_ART.height) / CARD_ART.width;
const CARD_RADIUS = (CARD_ART.radius * CARD_W) / CARD_ART.width;

const rowButtonStyle = {flex: 1, width: undefined, marginBottom: 0};
const rowGap = {width: 12};

/**
 * A waiting top-up's line: paid ones load on the card's tap, open ones show
 * the invoice, and a refund under way (ENG-855) is finished by the mint.
 */
const waitingLabel = (t: WaitingTopUp): string =>
  t.state === 'waiting'
    ? `Top-up invoice open · ${formatSatAmount(t.amountSat)}`
    : t.state === 'refunding'
    ? `Refund in progress · ${formatSatAmount(t.amountSat)}`
    : `Load waiting top-up · ${formatSatAmount(t.amountSat)}`;

const PIN_LABEL: Record<CardInfo['pinState'], string> = {
  unset: 'Not set',
  set: 'Set',
  blocked: 'Blocked',
  unknown: 'Unknown',
};

/**
 * A Flashcard v2's balance, read off the card on the keypad (see
 * hooks/useKeypadCardReader.ts). The v2 sibling of FlashcardBalance: that
 * screen shows a v1 BoltCard's balance from the BTCPay page; this one shows
 * what the card itself reported — its count of unspent slot amounts.
 */
const CashuCardBalance: React.FC<Props> = ({navigation, route}) => {
  const {summary, owedChangeSat, changeAddedSat, cardMint, cardUnit} =
    route.params;
  const {satsToCurrency, loading} = useRealtimePrice();
  const {info} = summary;

  // Change from an earlier charge (ENG-630): written just now by the keypad
  // read (PIN-less card), waiting for the next charge (PIN card), or both
  // when the keypad read put some of it on the card and the rest stayed owed.
  // Each note keeps a stable testID for the simulator e2e flows.
  const changeNotes = [
    changeAddedSat
      ? {
          testID: 'balance-added',
          text: `Change added · ${formatSatAmount(changeAddedSat)}`,
        }
      : null,
    owedChangeSat
      ? {
          testID: 'balance-owed',
          text: `Change waiting · ${formatSatAmount(
            owedChangeSat,
          )} — added on the next charge`,
        }
      : null,
  ].filter((note): note is {testID: string; text: string} => note !== null);

  const onCharge = useCallback(() => navigation.goBack(), [navigation]);

  // ENG-853: top-ups this phone holds for the card, and the owed change
  // whose slots a top-up may not take. One quote check on arrival promotes
  // a payment that landed after the invoice was cancelled; non-blocking.
  const [waiting, setWaiting] = useState<WaitingTopUp[]>(
    route.params.waitingTopUps ?? [],
  );
  const [owedPieces, setOwedPieces] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    refreshWaitingTopUps(summary.pubkey)
      .then(list => live && setWaiting(list.map(toWaitingTopUp)))
      .catch(() => {});
    owedPiecesFor(summary.pubkey)
      .then(n => live && setOwedPieces(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [summary.pubkey]);

  const refusal = !cardMint
    ? 'no_mint'
    : canTopUp(summary, owedPieces ?? 0, {unit: cardUnit ?? 0});

  const onTopUp = useCallback(() => {
    if (!cardMint) {
      return;
    }
    navigation.replace('CashuCardTopUp', {summary, cardMint, cardUnit});
  }, [navigation, summary, cardMint, cardUnit]);

  const onWaiting = useCallback(
    (t: WaitingTopUp) =>
      navigation.replace('CashuCardTopUp', {
        summary,
        cardMint: cardMint ?? '',
        cardUnit,
        resume: t.topupId,
      }),
    [navigation, summary, cardMint, cardUnit],
  );

  return (
    <Wrapper>
      <CardFrame>
        <CardArtV2 />
      </CardFrame>
      <Balance testID="balance-sat">{summary.balance} sats</Balance>
      <Fiat>
        {loading ? ' ' : satsToCurrency(summary.balance).formattedCurrency}
      </Fiat>

      <Details>
        <Row>
          <Label>Card</Label>
          <Value>{summary.pubkey.slice(0, 8)}</Value>
        </Row>
        <Row>
          <Label>Applet</Label>
          <Value>{summary.appletVersion}</Value>
        </Row>
        <Row>
          <Label>Slots</Label>
          <Value>
            {info.unspent} unspent · {info.spent} spent · {info.empty} free of{' '}
            {info.maxSlots}
          </Value>
        </Row>
        {info.spent > 0 && (
          <Caption>
            Spent slots are freed by the holder's Flash app once settled.
          </Caption>
        )}
        <Row>
          <Label>PIN</Label>
          <Value>{PIN_LABEL[info.pinState] ?? PIN_LABEL.unknown}</Value>
        </Row>
      </Details>
      {changeNotes.map(note => (
        <ChangeNote key={note.testID} testID={note.testID}>
          {note.text}
        </ChangeNote>
      ))}

      <Bottom>
        {waiting.map(t => (
          <WaitingButton
            key={t.topupId}
            testID="balance-topup-waiting"
            accessibilityRole="button"
            onPress={() => onWaiting(t)}>
            <WaitingText>{waitingLabel(t)}</WaitingText>
          </WaitingButton>
        ))}
        {refusal && (
          <TopUpCaption testID="balance-topup-refusal">
            {topUpErrorCopy(refusal).title}
          </TopUpCaption>
        )}
        <ButtonRow>
          <SecondaryButton
            testID="balance-charge"
            btnText="Charge this card"
            btnStyle={rowButtonStyle}
            onPress={onCharge}
          />
          <RowGap style={rowGap} />
          <PrimaryButton
            testID="balance-topup"
            btnText="Top up card"
            btnStyle={rowButtonStyle}
            disabled={refusal !== null}
            onPress={onTopUp}
          />
        </ButtonRow>
      </Bottom>
    </Wrapper>
  );
};

export default CashuCardBalance;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding: 24px 20px 40px 20px;
  align-items: center;
`;

const CardFrame = styled.View`
  width: ${CARD_W}px;
  height: ${CARD_H}px;
  border-radius: ${CARD_RADIUS}px;
  overflow: hidden;
  background-color: ${CARD_PALETTE.base};
`;

const Balance = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  color: #212121;
  text-align: center;
  margin-top: 30px;
`;

const Fiat = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Regular';
  color: #747474;
  text-align: center;
  margin-top: 4px;
`;

const Details = styled.View`
  width: 100%;
  margin-top: 28px;
  padding: 12px 16px;
  border-radius: 12px;
  background-color: #f8f9fa;
`;

const Row = styled.View`
  flex-direction: row;
  justify-content: space-between;
  padding: 6px 0;
`;

const Label = styled.Text`
  font-size: 15px;
  font-family: 'Outfit-Regular';
  color: #747474;
`;

const ChangeNote = styled.Text`
  width: 100%;
  margin-top: 12px;
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #747474;
  text-align: center;
`;

/**
 * Shrinks and wraps under the row's right edge: Yoga's default flex-shrink is
 * 0, and the slot count ("14 unspent · 18 spent · 0 free of 32") is wider
 * than a 375pt phone's Details box leaves beside its label.
 */
const Value = styled.Text`
  flex-shrink: 1;
  margin-left: 12px;
  text-align: right;
  font-size: 15px;
  font-family: 'Outfit-SemiBold';
  color: #212121;
`;

/** Note under the slot row: the POS never clears spent slots itself. */
const Caption = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #747474;
  padding: 0 0 6px 0;
`;

const Bottom = styled.View`
  width: 100%;
  margin-top: auto;
`;

const ButtonRow = styled.View`
  width: 100%;
  flex-direction: row;
  align-items: center;
  margin-top: 12px;
`;

const RowGap = styled.View``;

/** A paid top-up waiting for this card: gold, so the merchant sees it first. */
const WaitingButton = styled.TouchableOpacity`
  width: 100%;
  margin-top: 8px;
  padding: 12px 16px;
  border-radius: 100px;
  background-color: #f5c242;
  align-items: center;
`;

const WaitingText = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-SemiBold';
  color: #212121;
`;

const TopUpCaption = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #747474;
  text-align: center;
  margin-top: 8px;
`;
