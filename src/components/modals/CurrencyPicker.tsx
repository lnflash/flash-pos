import React, {useEffect, useState} from 'react';
import {Modal, ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

// gql
import {CurrencyList} from '../../graphql/queries';

// hooks
import {useQuery} from '@apollo/client';
import {useAppDispatch, useAppSelector} from '../../store/hooks';
import {useActivityIndicator} from '../../hooks';

// store
import {setCurrency} from '../../store/slices/amountSlice';

type Props = {
  btnStyle?: ViewStyle;
  showCompleteText?: boolean;
};

const CurrencyPicker: React.FC<Props> = ({btnStyle, showCompleteText}) => {
  const {loading, error, data} = useQuery<CurrencyList>(CurrencyList);

  const dispatch = useAppDispatch();
  const {currency} = useAppSelector(state => state.amount);
  const {toggleLoading} = useActivityIndicator();

  const [visible, setVisible] = useState(false);

  useEffect(() => {
    toggleLoading(loading);
  }, [loading]);

  return (
    <Wrapper>
      <Btn style={btnStyle} onPress={() => setVisible(true)}>
        <BtnText>
          {showCompleteText
            ? `${currency.id} - ${currency.name} ${currency.flag}`
            : currency?.id}
        </BtnText>
        <Icon name={visible ? 'caret-up' : 'caret-down'} size={15} solid />
      </Btn>
      <Modal
        animationType="slide"
        transparent={true}
        visible={visible}
        onRequestClose={() => setVisible(!visible)}>
        <Backdrop onPress={() => setVisible(false)} activeOpacity={0.9}>
          <ModalView>
            <RowWrapper>
              <Close></Close>
              <Title>Currency List</Title>
              <Close onPress={() => setVisible(false)}>
                <Icon name={'xmark'} size={30} solid />
              </Close>
            </RowWrapper>
            <ScrollWrapper>
              {data?.currencyList.map(currency => (
                <ItemBtn
                  key={currency.id}
                  onPress={() => {
                    setVisible(false);
                    dispatch(setCurrency(currency));
                  }}>
                  <ItemText>{`${currency.id} - ${currency.name} ${currency.flag}`}</ItemText>
                </ItemBtn>
              ))}
            </ScrollWrapper>
          </ModalView>
        </Backdrop>
      </Modal>
    </Wrapper>
  );
};

export default CurrencyPicker;

const Wrapper = styled.View``;

const Btn = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #adadad;
  border-radius: 10px;
  padding-vertical: 5px;
  padding-horizontal: 10px;
`;

const BtnText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  margin-right: 10px;
  margin-top: 3px;
`;

const Backdrop = styled.TouchableOpacity`
  flex: 1;
  justify-content: flex-end;
  background-color: rgba(0, 0, 0, 0.5);
`;

const ModalView = styled.View`
  height: 50%;
  background-color: #fff;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  overflow: hidden;
  padding-horizontal: 10px;
`;

const RowWrapper = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
`;

const Title = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Bold';
  align-items: center;
`;

const Close = styled.TouchableOpacity`
  padding: 10px;
`;

const ScrollWrapper = styled.ScrollView``;

const ItemBtn = styled.TouchableOpacity`
  border-bottom-width: 0.5px;
  border-bottom-color: #adadad;
  padding-vertical: 15px;
  padding-horizontal: 10px;
`;

const ItemText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #000;
`;
