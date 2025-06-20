import React from 'react';
import {Icon} from '@rneui/themed';
import {Column, Container, Key, Label, Value, Wrapper} from './styled';
import {PinMode} from '../../screens/Profile';

type Props = {
  hasPin: boolean;
  handlePinActions: (val: PinMode) => void;
};

const Security: React.FC<Props> = ({hasPin, handlePinActions}) => {
  return (
    <Wrapper>
      <Label>Security</Label>

      {hasPin ? (
        <>
          <Container
            activeOpacity={0.5}
            onPress={() => handlePinActions('change')}>
            <Icon name={'key-outline'} type="ionicon" />
            <Column>
              <Key>Change PIN</Key>
              <Value>Modify your admin PIN</Value>
            </Column>
            <Icon name={'chevron-forward-outline'} type="ionicon" />
          </Container>
          <Container
            activeOpacity={0.5}
            onPress={() => handlePinActions('remove')}>
            <Icon name={'trash-outline'} type="ionicon" />
            <Column>
              <Key>Remove PIN</Key>
              <Value>Disable PIN protection</Value>
            </Column>
            <Icon name={'chevron-forward-outline'} type="ionicon" />
          </Container>
        </>
      ) : (
        <Container
          activeOpacity={0.5}
          onPress={() => handlePinActions('setup')}>
          <Icon name={'lock-closed-outline'} type="ionicon" />
          <Column>
            <Key>Set Admin PIN</Key>
            <Value>Protect your settings</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
        </Container>
      )}
    </Wrapper>
  );
};

export default Security;
