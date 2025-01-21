import React from 'react';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';

// components
import {
  Amount,
  Note,
  NumPad,
  PrimaryButton,
  SecondaryButton,
} from '../components';

// hooks
import {useAppDispatch} from '../store/hooks';
import {updateAmount} from '../store/slices/amountSlice';

type Props = NativeStackScreenProps<RootStackType, 'Main'>;

const Main: React.FC<Props> = ({navigation, route}) => {
  const dispatch = useAppDispatch();

  return (
    <Wrapper>
      <BodyWrapper>
        <Amount />
        <Note />
        <NumPad />
      </BodyWrapper>
      <BtnsWrapper>
        <PrimaryButton btnText="Next" onPress={() => {}} />
        <SecondaryButton
          icon={'arrow-rotate-left'}
          btnText="Clear"
          btnStyle={{marginTop: 10}}
          onPress={() => dispatch(updateAmount('clearInput'))}
        />
      </BtnsWrapper>
    </Wrapper>
  );
};

export default Main;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-top: 10px;
  padding-bottom: 30px;
  padding-horizontal: 20px;
`;

const BodyWrapper = styled.View`
  flex: 1;
`;

const BtnsWrapper = styled.View`
  align-items: center;
`;
