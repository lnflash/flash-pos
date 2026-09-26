import React, {useEffect, useState} from 'react';
import {Dimensions, Modal} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import Icon from 'react-native-vector-icons/FontAwesome6';

const width = Dimensions.get('screen').width;

type CardTapSheetProps = {
  visible: boolean;
  amountSat: number;
  /** Ends the armed NFC session (resolves the router with a user cancel). */
  onCancel: () => void;
};

const EXIT_MS = 260;

/**
 * The Android stand-in for iOS's system NFC sheet: the reader arms with no
 * visible UI, so this bottom sheet is the merchant's only signal that the
 * payment is waiting for a tap. Slides up over the invoice, ripples while
 * waiting, slides away once a tag is read.
 */
const CardTapSheet = ({visible, amountSat, onCancel}: CardTapSheetProps) => {
  // Keeps the sheet mounted through its slide-out before unmounting.
  const [rendered, setRendered] = useState(visible);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      setExiting(false);
      return;
    }
    if (!rendered) {
      return;
    }
    setExiting(true);
    const timer = setTimeout(() => {
      setRendered(false);
      setExiting(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible, rendered]);

  if (!rendered) {
    return null;
  }

  return (
    <Modal transparent animationType="none" onRequestClose={onCancel}>
      <Backdrop animation={exiting ? 'fadeOut' : 'fadeIn'} duration={EXIT_MS} useNativeDriver>
        <Sheet animation={exiting ? 'slideOutDown' : 'slideInUp'} duration={EXIT_MS + 120} useNativeDriver>
          <Grabber />
          <RippleStage>
            {[0, 1, 2].map(i => (
              <Ring
                key={i}
                animation="zoomOut"
                duration={1900}
                delay={i * 620}
                iterationCount="infinite"
                easing="ease-out"
                useNativeDriver
              />
            ))}
            <CardBadge>
              <Animatable.View animation="pulse" iterationCount="infinite" duration={1400} useNativeDriver>
                <Icon name="credit-card" size={Math.round(width / 12)} color="#ffffff" />
              </Animatable.View>
            </CardBadge>
          </RippleStage>
          {amountSat > 0 ? (
            <Amount>{amountSat} sats</Amount>
          ) : (
            <Amount>—</Amount>
          )}
          <Instruction>Hold the customer's card to the reader</Instruction>
          <CancelBtn onPress={onCancel}>
            <CancelText>Cancel</CancelText>
          </CancelBtn>
        </Sheet>
      </Backdrop>
    </Modal>
  );
};

export default CardTapSheet;

const Backdrop = styled(Animatable.View)`
  flex: 1;
  background-color: rgba(15, 17, 21, 0.55);
  justify-content: flex-end;
`;

const Sheet = styled(Animatable.View)`
  background-color: #ffffff;
  border-top-left-radius: 24px;
  border-top-right-radius: 24px;
  align-items: center;
  padding: 14px 24px 34px;
`;

const Grabber = styled.View`
  width: 44px;
  height: 5px;
  border-radius: 3px;
  background-color: #d9dbe1;
  margin-bottom: 18px;
`;

const RippleStage = styled.View`
  width: ${Math.round(width * 0.36)}px;
  height: ${Math.round(width * 0.36)}px;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
`;

const Ring = styled(Animatable.View)`
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 999px;
  border-width: 2px;
  border-color: #db254e;
`;

const CardBadge = styled.View`
  width: ${Math.round(width * 0.17)}px;
  height: ${Math.round(width * 0.17)}px;
  border-radius: 999px;
  background-color: #1f2328;
  align-items: center;
  justify-content: center;
`;

const Amount = styled.Text`
  font-size: 32px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
`;

const Instruction = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
  margin-top: 6px;
  text-align: center;
`;

const CancelBtn = styled.TouchableOpacity`
  margin-top: 18px;
  padding: 8px 22px;
`;

const CancelText = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  color: #db254e;
`;
