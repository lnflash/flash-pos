import React, {useState} from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {CurrencyPicker, PrimaryButton} from '../components';

// assets
import Logo from '../assets/icons/blink-logo-icon.png';

type Props = StackScreenProps<RootStackType, 'Auth'>;

const Auth: React.FC<Props> = ({navigation}) => {
  const [username, setUsername] = useState<string>('');

  const onStart = () => {
    if (username) {
      navigation.navigate('Main', {username});
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
          <CurrencyPicker btnStyle={{paddingVertical: 10}} />
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
