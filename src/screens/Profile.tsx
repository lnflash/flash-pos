import React from 'react';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';
import {Icon} from '@rneui/themed';

// components
import {TextButton} from '../components';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {resetUserData} from '../store/slices/userSlice';
import {resetAmount} from '../store/slices/amountSlice';

// env
import {FLASH_LN_ADDRESS} from '@env';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Profile = () => {
  const navigation = useNavigation<Props>();

  const dispatch = useAppDispatch();
  const {username} = useAppSelector(state => state.user);

  const onLogout = () => {
    dispatch(resetUserData());
    dispatch(resetAmount());
    navigation.replace('Auth');
  };

  const lnAddress = `${username}@${FLASH_LN_ADDRESS}`;

  return (
    <Wrapper>
      <InnerWrapper>
        <Label>Account</Label>
        <Container
          activeOpacity={0.5}
          onPress={() => Clipboard.setString(lnAddress)}>
          <Icon name={'at-outline'} type="ionicon" />
          <Column>
            <Key>Your Lightning address</Key>
            <Value>{lnAddress}</Value>
          </Column>
          <Icon name={'copy-outline'} type="ionicon" />
        </Container>
      </InnerWrapper>
      <TextButton title="Logout" onPress={onLogout} />
    </Wrapper>
  );
};

export default Profile;

const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
  padding-horizontal: 10px;
  padding-top: 20px;
  padding-bottom: 100px;
`;

const InnerWrapper = styled.View`
  flex: 1;
`;

const Label = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Bold';
  color: #000000;
  margin-bottom: 5px;
`;

const Container = styled.TouchableOpacity`
  flex-direction: row;
  background-color: #f2f2f4;
  border-radius: 12px;
  overflow: hidden;
  align-items: center;
  justify-content: space-between;
  padding: 10px;
`;

const Column = styled.View`
  flex: 1;
  margin-left: 5px;
`;

const Key = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #000000;
`;

const Value = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Regular';
  color: #5a5a5a;
`;
