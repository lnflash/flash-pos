import React, {useState} from 'react';
import {Modal, ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

// store
import {PrimaryButton} from '../buttons';
import {setMemo} from '../../store/slices/amountSlice';

// hooks
import {useAppDispatch, useAppSelector} from '../../store/hooks';

type Props = {
  btnStyle?: ViewStyle;
};

const Note: React.FC<Props> = ({btnStyle}) => {
  const dispatch = useAppDispatch();
  const {memo} = useAppSelector(state => state.amount);

  const [note, setNote] = useState('');
  const [visible, setVisible] = useState(false);

  return (
    <Wrapper>
      {!!memo ? (
        <NoteWrapper>
          <NoteText numberOfLines={1}>
            Note:{' '}
            <NoteText font="Outfit-Regular" size={13}>
              {memo}
            </NoteText>
          </NoteText>
          <EditBtn onPress={() => setVisible(true)}>
            <Icon name={'pencil'} size={15} solid />
          </EditBtn>
        </NoteWrapper>
      ) : (
        <Btn style={btnStyle} onPress={() => setVisible(true)}>
          <BtnText>Add note</BtnText>
          <Icon name={'pencil'} size={15} solid />
        </Btn>
      )}
      <Modal
        animationType="slide"
        transparent={true}
        visible={visible}
        onRequestClose={() => setVisible(!visible)}>
        <Backdrop onPress={() => setVisible(false)} activeOpacity={0.9}>
          <ModalView>
            <RowWrapper>
              <Close></Close>
              <Title>Note</Title>
              <Close onPress={() => setVisible(false)}>
                <Icon name={'xmark'} size={30} solid />
              </Close>
            </RowWrapper>
            <Input
              value={note}
              onChangeText={setNote}
              placeholder="Add note"
              multiline
            />
            <PrimaryButton
              btnText="Confirm"
              onPress={() => {
                dispatch(setMemo(note));
                setVisible(false);
              }}
            />
          </ModalView>
        </Backdrop>
      </Modal>
    </Wrapper>
  );
};

export default Note;

const Wrapper = styled.View`
  align-items: center;
`;

const Btn = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  background-color: #f0f0f0;
  border: 1px solid #000;
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
  height: 80%;
  background-color: #fff;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  overflow: hidden;
  padding-bottom: 20px;
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

const Input = styled.TextInput`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  flex: 1;
  margin-bottom: 20px;
  border: 1px solid #000;
  border-radius: 10px;
  background-color: #f0f0f0;
  text-align-vertical: top;
  padding-horizontal: 5px;
`;

const NoteWrapper = styled.View`
  flex-direction: row;
  justify-content: center;
  align-items: center;
  margin-horizontal: 30px;
`;

const NoteText = styled.Text<{font?: string; size?: number}>`
  font-size: ${({size}) => size || 14}px;
  font-family: ${({font}) => font || 'Outfit-SemiBold'};
  margin-left: 25px;
`;

const EditBtn = styled.TouchableOpacity`
  padding: 10px;
`;
