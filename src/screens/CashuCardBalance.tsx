import React, {useCallback} from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
// Leaf import, like CashuCardDebug: the `../components` barrel pulls in the
// printer and currency-picker modules, which this screen has no need of.
import PrimaryButton from '../components/buttons/PrimaryButton';
import {
  CARD_ART,
  CARD_PALETTE,
  CardArtV2,
} from '../components/cashu/charge/cardArtV2';

// hooks
import {useRealtimePrice} from '../hooks';

// services
import type {CardInfo} from '../services/cashuCard';

type Props = StackScreenProps<RootStackType, 'CashuCardBalance'>;

const {width: screenWidth} = Dimensions.get('window');
/** The card at the art's own size where it fits, narrower on small phones. */
const CARD_W = Math.min(CARD_ART.width, screenWidth - 40);
const CARD_H = (CARD_W * CARD_ART.height) / CARD_ART.width;
const CARD_RADIUS = (CARD_ART.radius * CARD_W) / CARD_ART.width;

const buttonStyle = {marginTop: 'auto' as const};

const PIN_LABEL: Record<CardInfo['pinState'], string> = {
  unset: 'Not set',
  set: 'Set',
  locked: 'Locked',
  unknown: 'Unknown',
};

/**
 * A Flashcard v2's balance, read off the card on the keypad (see
 * hooks/useKeypadCardReader.ts). The v2 sibling of FlashcardBalance: that
 * screen shows a v1 BoltCard's balance from the BTCPay page; this one shows
 * what the card itself reported — its count of unspent slot amounts.
 */
const CashuCardBalance: React.FC<Props> = ({navigation, route}) => {
  const {summary} = route.params;
  const {satsToCurrency, loading} = useRealtimePrice();
  const {info} = summary;

  const onCharge = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <Wrapper>
      <CardFrame>
        <CardArtV2 />
      </CardFrame>
      <Balance>{summary.balance} sats</Balance>
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

      <PrimaryButton
        btnText="Charge this card"
        btnStyle={buttonStyle}
        onPress={onCharge}
      />
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
