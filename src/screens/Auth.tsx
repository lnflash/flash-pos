import React, {useState} from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';
import {KeyboardAwareScrollView} from 'react-native-keyboard-aware-scroll-view';
import {CurrencyPicker, PrimaryButton} from '../components';
import Logo from '../assets/icons/logo.png';
import client from '../graphql/ApolloClient';
import {AccountDefaultWallets} from '../graphql/queries';
import {useAppDispatch} from '../store/hooks';
import {useActivityIndicator} from '../hooks';
import {setUserData} from '../store/slices/userSlice';

type Props = StackScreenProps<RootStackType, 'Auth'>;

const Auth: React.FC<Props> = ({navigation}) => {
  const dispatch = useAppDispatch();
  const {toggleLoading} = useActivityIndicator();

  const [value, setValue] = useState('');
  const [err, setErr] = useState<string>();

  const onStart = async () => {
    if (!value) return;

    toggleLoading(true);
    try {
      const res = await client.query({
        query: AccountDefaultWallets,
        variables: {username: value},
      });

      dispatch(
        setUserData({
          username: value,
          walletId: res.data.accountDefaultWallet.id,
          walletCurrency: res.data.accountDefaultWallet.walletCurrency,
        }),
      );
      navigation.replace('Home');
    } catch (error: any) {
      setErr(error.message);
    } finally {
      toggleLoading(false);
    }
  };

  return (
    <Wrapper>
      <KeyboardAwareScrollView>
        <InnerWrapper>
          <LogoWrapper>
            <Icon source={Logo} />
            <Title>flash POS</Title>
          </LogoWrapper>
          <Container>
            <Label>Enter your Flash username</Label>
            <Input
              value={value}
              onChangeText={setValue}
              placeholder="Enter your flash username"
            />
            {err && <ErrText>{err}</ErrText>}
          </Container>
          <Container>
            <Label>Select your currency $</Label>
            <CurrencyPicker btnStyle={{paddingVertical: 10}} />
          </Container>
        </InnerWrapper>
      </KeyboardAwareScrollView>
      <BtnWrapper>
        <PrimaryButton btnText="Start" onPress={onStart} />
      </BtnWrapper>
    </Wrapper>
  );
};

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-bottom: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
  margin-top: 30%;
  margin-horizontal: 20px;
`;

const LogoWrapper = styled.View`
  justify-content: center;
  align-items: center;
`;

const Title = styled.Text`
  font-family: 'Outfit-Bold';
  font-size: 28px;
  text-align: center;
  color: #061237;
  margin-bottom: 50px;
  margin-top: 10px;
`;

const Container = styled.View`
  margin-bottom: 20px;
`;

const Label = styled.Text`
  font-family: 'Outfit-SemiBold';
  font-size: 15px;
  color: #000;
  margin-bottom: 5px;
`;

const Input = styled.TextInput`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  border-radius: 10px;
  border: 1px solid #adadad;
  padding-horizontal: 8px;
  padding-vertical: 10px;
`;

const Icon = styled.Image`
  width: 100px;
  height: 100px;
`;

const ErrText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #db254e;
  margin-left: 5px;
`;

const BtnWrapper = styled.View`
  margin-horizontal: 20px;
`;

export default Auth;
