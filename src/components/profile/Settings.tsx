import React from 'react';
import {Icon} from '@rneui/themed';
import {Column, Container, Key, Label, Value, Wrapper} from './styled';

type Props = {
  onViewRewardSettings: () => void;
};

const Settings: React.FC<Props> = ({onViewRewardSettings}) => {
  return (
    <Wrapper>
      <Label>Settings</Label>
      <Container activeOpacity={0.5} onPress={onViewRewardSettings}>
        <Icon name={'diamond-outline'} type="ionicon" />
        <Column>
          <Key>Reward Settings</Key>
          <Value>Configure reward rules</Value>
        </Column>
        <Icon name={'chevron-forward-outline'} type="ionicon" />
      </Container>
    </Wrapper>
  );
};

export default Settings;
