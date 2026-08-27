import React from 'react';
import {Icon} from '@rneui/themed';
import {Column, Container, Key, Label, Value, Wrapper} from './styled';

type Props = {
  onViewRewardSettings: () => void;

  eventModeEnabled?: boolean;
  onViewEventSettings?: () => void;

  /** Dev builds only — see the `__DEV__` row below. */
  onViewCashuCardDebug?: () => void;
};

const Settings: React.FC<Props> = ({
  onViewRewardSettings,
  eventModeEnabled,
  onViewEventSettings,
  onViewCashuCardDebug,
}) => {

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

      {eventModeEnabled && onViewEventSettings && (
        <Container activeOpacity={0.5} onPress={onViewEventSettings}>
          <Icon name={'calendar-outline'} type="ionicon" />
          <Column>
            <Key>Event Settings</Key>
            <Value>Configure event rewards</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
        </Container>
      )}

      {/* Cashu card bring-up harness. The screen is only registered under
          __DEV__ (src/routes/index.tsx), so this row must be too — otherwise a
          release build offers a row that dead-ends in an unhandled NAVIGATE. */}
      {__DEV__ && onViewCashuCardDebug && (
        <Container activeOpacity={0.5} onPress={onViewCashuCardDebug}>
          <Icon name={'card-outline'} type="ionicon" />
          <Column>
            <Key>Cashu card (dev)</Key>
            <Value>Read-only NFC bring-up harness</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
        </Container>
      )}
    </Wrapper>
  );
};

export default Settings;
