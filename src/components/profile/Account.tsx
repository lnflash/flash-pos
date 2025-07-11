import React from 'react';
import {Icon} from '@rneui/themed';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackNavigationProp} from '@react-navigation/stack';
import {Column, Container, Key, Label, Value, Wrapper} from './styled';

// hooks
import {useAppSelector} from '../../store/hooks';
import {useNavigation} from '@react-navigation/native';

// env
import {FLASH_LN_ADDRESS} from '@env';

type NavigationProps = StackNavigationProp<RootStackType, 'Home'>;

const Account = () => {
  const navigation = useNavigation<NavigationProps>();

  const {username} = useAppSelector(state => state.user);

  const lnAddress = `${username}@${FLASH_LN_ADDRESS}`;

  const onViewPaycode = () => {
    navigation.navigate('Paycode');
  };

  return (
    <Wrapper>
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
      {/* PayCode Navigation */}
      <Container activeOpacity={0.5} onPress={onViewPaycode}>
        <Icon name={'qr-code-outline'} type="ionicon" />
        <Column>
          <Key>PayCode</Key>
          <Value>Merchant QR code</Value>
        </Column>
        <Icon name={'chevron-forward-outline'} type="ionicon" />
      </Container>
    </Wrapper>
  );
};

export default Account;
