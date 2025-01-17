import React, {useEffect, useState} from 'react';
import styled from 'styled-components/native';
import {Picker} from '@react-native-picker/picker';

// hooks
import {useQuery} from '@apollo/client';
import {useActivityIndicator} from '../hooks/useActivityIndicator';

// gql
import {CurrencyList} from '../graphql/queries';
import {PrimaryButton} from '../components';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';

// assets
import Logo from '../assets/icons/blink-logo-icon.png';

const Auth = () => {
  const {loading, error, data} = useQuery<CurrencyList>(CurrencyList);
  const {toggleLoading} = useActivityIndicator();
  const navigation =
    useNavigation<StackNavigationProp<RootStackType, 'Main'>>();

  const [username, setUsername] = useState<string>('');
  const [currency, setCurrency] = useState('JMD');

  useEffect(() => {
    toggleLoading(loading);
  }, [loading, data]);

  const onStart = () => {
    if (username && currency) {
      navigation.navigate('Main', {username, currency});
    }
  };

  return (
    <Wrapper>
      <InnerWrapper>
        <LogoWrapper>
          <Icon source={Logo} />
          <Title>flash POS</Title>
        </LogoWrapper>
        <Container>
          <Label>Enter your Flash username</Label>
          <Input
            value={username}
            onChangeText={setUsername}
            placeholder="Enter your flash username"
          />
        </Container>
        <Container>
          <Label>Select your currency $</Label>
          <PickerWrapper>
            <Picker
              selectedValue={currency}
              onValueChange={itemValue => setCurrency(itemValue)}>
              {data?.currencyList.map(currency => (
                <Picker.Item
                  key={currency.id}
                  label={`${currency.id} - ${currency.name} ${currency.flag}`}
                  value={currency.id}
                />
              ))}
            </Picker>
          </PickerWrapper>
        </Container>
      </InnerWrapper>
      <PrimaryButton btnText="Start" onPress={onStart} />
    </Wrapper>
  );
};

export default Auth;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-bottom: 30px;
  padding-horizontal: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
  justify-content: center;
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
  font-size: 16px;
  color: #000;
  margin-bottom: 5px;
`;

const Input = styled.TextInput`
  font-size: 16px;
  border-radius: 10px;
  border: 1px solid #adadad;
  padding-horizontal: 8px;
  padding-vertical: 15px;
`;

const PickerWrapper = styled.View`
  border-radius: 10px;
  border: 1px solid #adadad;
`;
const Icon = styled.Image`
  width: 100px;
  height: 100px;
`;
