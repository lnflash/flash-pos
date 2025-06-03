import React, {useState} from 'react';
import {Alert, TextInput} from 'react-native';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';
import {Icon, Switch} from '@rneui/themed';

// components
import {TextButton} from '../components';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {resetUserData} from '../store/slices/userSlice';
import {resetAmount} from '../store/slices/amountSlice';
import {
  selectRewardConfig,
  updateRewardConfig,
  resetRewardConfig,
} from '../store/slices/rewardSlice';

// utils
import {validateRewardConfig} from '../utils/rewardCalculations';
import {toastShow} from '../utils/toast';

// env
import {FLASH_LN_ADDRESS} from '@env';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Profile = () => {
  const navigation = useNavigation<Props>();

  const dispatch = useAppDispatch();
  const {username} = useAppSelector(state => state.user);
  const {transactions} = useAppSelector(state => state.transactionHistory);
  const rewardConfig = useAppSelector(selectRewardConfig);

  // Local state for reward configuration
  const [rewardRate, setRewardRate] = useState(
    (rewardConfig.rewardRate * 100).toString(),
  );
  const [minimumReward, setMinimumReward] = useState(
    rewardConfig.minimumReward.toString(),
  );
  const [maximumReward, setMaximumReward] = useState(
    rewardConfig.maximumReward.toString(),
  );
  const [defaultReward, setDefaultReward] = useState(
    rewardConfig.defaultReward.toString(),
  );
  const [isEnabled, setIsEnabled] = useState(rewardConfig.isEnabled);

  const onLogout = () => {
    dispatch(resetUserData());
    dispatch(resetAmount());
    navigation.replace('Auth');
  };

  const onViewTransactionHistory = () => {
    navigation.navigate('TransactionHistory');
  };

  const onSaveRewardConfig = () => {
    const newConfig = {
      rewardRate: parseFloat(rewardRate) / 100, // Convert percentage to decimal
      minimumReward: parseInt(minimumReward, 10),
      maximumReward: parseInt(maximumReward, 10),
      defaultReward: parseInt(defaultReward, 10),
      isEnabled,
    };

    // Validate configuration
    const validation = validateRewardConfig(newConfig);

    if (!validation.isValid) {
      Alert.alert('Invalid Configuration', validation.errors.join('\n'), [
        {text: 'OK'},
      ]);
      return;
    }

    // Additional validation for NaN values
    if (
      isNaN(newConfig.rewardRate) ||
      isNaN(newConfig.minimumReward) ||
      isNaN(newConfig.maximumReward) ||
      isNaN(newConfig.defaultReward)
    ) {
      Alert.alert(
        'Invalid Input',
        'Please enter valid numbers for all reward settings.',
        [{text: 'OK'}],
      );
      return;
    }

    dispatch(updateRewardConfig(newConfig));
    toastShow({
      message: 'Reward settings saved successfully!',
      type: 'success',
    });
  };

  const onResetRewardConfig = () => {
    Alert.alert(
      'Reset Reward Settings',
      'Are you sure you want to reset all reward settings to defaults?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            dispatch(resetRewardConfig());
            // Update local state to reflect reset values
            setRewardRate('2.0');
            setMinimumReward('1');
            setMaximumReward('1000');
            setDefaultReward('21');
            setIsEnabled(true);
            toastShow({
              message: 'Reward settings reset to defaults.',
              type: 'success',
            });
          },
        },
      ],
    );
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

        <Label style={{marginTop: 20}}>Reward Settings</Label>

        {/* Rewards System Toggle */}
        <Container activeOpacity={0.7}>
          <Icon name={'diamond-outline'} type="ionicon" />
          <Column>
            <Key>Rewards System</Key>
            <Value>{isEnabled ? 'Enabled' : 'Disabled'}</Value>
          </Column>
          <Switch
            value={isEnabled}
            onValueChange={setIsEnabled}
            color="#007856"
          />
        </Container>

        {/* Reward Rate Configuration */}
        <ConfigContainer>
          <ConfigRow>
            <ConfigLabel>Reward Rate (%)</ConfigLabel>
            <ConfigInput
              value={rewardRate}
              onChangeText={setRewardRate}
              placeholder="2.0"
              keyboardType="decimal-pad"
              maxLength={4}
            />
          </ConfigRow>
          <ConfigHint>Percentage of purchase amount (0-10%)</ConfigHint>
        </ConfigContainer>

        {/* Minimum Reward Configuration */}
        <ConfigContainer>
          <ConfigRow>
            <ConfigLabel>Minimum Reward (sats)</ConfigLabel>
            <ConfigInput
              value={minimumReward}
              onChangeText={setMinimumReward}
              placeholder="1"
              keyboardType="number-pad"
              maxLength={4}
            />
          </ConfigRow>
          <ConfigHint>Minimum sats awarded for any purchase</ConfigHint>
        </ConfigContainer>

        {/* Maximum Reward Configuration */}
        <ConfigContainer>
          <ConfigRow>
            <ConfigLabel>Maximum Reward (sats)</ConfigLabel>
            <ConfigInput
              value={maximumReward}
              onChangeText={setMaximumReward}
              placeholder="1000"
              keyboardType="number-pad"
              maxLength={6}
            />
          </ConfigRow>
          <ConfigHint>Maximum sats awarded to limit costs</ConfigHint>
        </ConfigContainer>

        {/* Default Standalone Reward Configuration */}
        <ConfigContainer>
          <ConfigRow>
            <ConfigLabel>Standalone Reward (sats)</ConfigLabel>
            <ConfigInput
              value={defaultReward}
              onChangeText={setDefaultReward}
              placeholder="21"
              keyboardType="number-pad"
              maxLength={4}
            />
          </ConfigRow>
          <ConfigHint>
            Fixed reward for flashcard taps without purchase
          </ConfigHint>
        </ConfigContainer>

        {/* Action Buttons */}
        <ButtonRow>
          <SaveButton onPress={onSaveRewardConfig}>
            <ButtonText>Save Settings</ButtonText>
          </SaveButton>
          <ResetButton onPress={onResetRewardConfig}>
            <ResetButtonText>Reset</ResetButtonText>
          </ResetButton>
        </ButtonRow>

        <Label style={{marginTop: 20}}>Transactions</Label>
        <Container activeOpacity={0.5} onPress={onViewTransactionHistory}>
          <Icon name={'receipt-outline'} type="ionicon" />
          <Column>
            <Key>Transaction History</Key>
            <Value>{transactions.length} transactions</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
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

const ConfigContainer = styled.View`
  background-color: #f2f2f4;
  border-radius: 12px;
  padding: 10px;
  margin-bottom: 8px;
`;

const ConfigRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const ConfigLabel = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #000000;
  flex: 1;
`;

const ConfigInput = styled(TextInput)`
  width: 80px;
  height: 40px;
  background-color: #ffffff;
  border-radius: 8px;
  padding-horizontal: 10px;
  font-size: 16px;
  font-family: 'Outfit-Regular';
  text-align: center;
  border: 1px solid #e0e0e0;
`;

const ConfigHint = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #888888;
  margin-top: 5px;
`;

const ButtonRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  margin-top: 15px;
  margin-bottom: 10px;
`;

const SaveButton = styled.TouchableOpacity`
  background-color: #007856;
  padding: 12px 24px;
  border-radius: 8px;
  flex: 1;
  margin-right: 8px;
`;

const ResetButton = styled.TouchableOpacity`
  background-color: transparent;
  border: 1px solid #007856;
  padding: 12px 24px;
  border-radius: 8px;
  flex: 0.5;
`;

const ButtonText = styled.Text`
  color: #ffffff;
  font-size: 16px;
  font-family: 'Outfit-Medium';
  text-align: center;
`;

const ResetButtonText = styled.Text`
  color: #007856;
  font-size: 16px;
  font-family: 'Outfit-Medium';
  text-align: center;
`;
