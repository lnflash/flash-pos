import React, {useState, useCallback} from 'react';
import {TextInput, Dimensions} from 'react-native';
import styled from 'styled-components/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';
import {Icon, Switch} from '@rneui/themed';
import axios from 'axios';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {
  selectRewardConfig,
  updateRewardConfig,
} from '../store/slices/rewardSlice';

// utils
import {validateRewardConfig} from '../utils/rewardCalculations';
import {toastShow} from '../utils/toast';
import {sanitizeMerchantRewardId} from '../utils/validation';

// env
import {BTC_PAY_SERVER} from '@env';

const {width: screenWidth} = Dimensions.get('window');

type Props = StackNavigationProp<RootStackType, 'RewardsSettings'>;

const RewardsSettings = () => {
  const navigation = useNavigation<Props>();
  const dispatch = useAppDispatch();
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
  const [merchantRewardId, setMerchantRewardId] = useState(
    rewardConfig.merchantRewardId || '',
  );
  const [isMerchantIdValid, setIsMerchantIdValid] = useState(false);
  const [isTestingMerchantId, setIsTestingMerchantId] = useState(false);
  const [isEnabled, setIsEnabled] = useState(rewardConfig.isEnabled);
  const [showStandaloneRewards, setShowStandaloneRewards] = useState(
    rewardConfig.showStandaloneRewards,
  );

  // Autosave function for individual fields
  const autoSaveField = useCallback(
    (field: string, value: any) => {
      const newConfig = {
        rewardRate:
          field === 'rewardRate'
            ? parseFloat(value) / 100
            : rewardConfig.rewardRate,
        minimumReward:
          field === 'minimumReward'
            ? parseInt(value, 10)
            : rewardConfig.minimumReward,
        maximumReward:
          field === 'maximumReward'
            ? parseInt(value, 10)
            : rewardConfig.maximumReward,
        defaultReward:
          field === 'defaultReward'
            ? parseInt(value, 10)
            : rewardConfig.defaultReward,
        merchantRewardId:
          field === 'merchantRewardId' ? value : rewardConfig.merchantRewardId,
        isEnabled: field === 'isEnabled' ? value : rewardConfig.isEnabled,
        showStandaloneRewards:
          field === 'showStandaloneRewards'
            ? value
            : rewardConfig.showStandaloneRewards,
      };

      // Skip validation and save for boolean fields (switches)
      if (field === 'isEnabled' || field === 'showStandaloneRewards') {
        dispatch(updateRewardConfig(newConfig));
        toastShow({
          message: 'Setting updated automatically',
          type: 'success',
        });
        return;
      }

      // Skip validation for merchantRewardId (string field)
      if (field === 'merchantRewardId') {
        dispatch(updateRewardConfig(newConfig));
        toastShow({
          message: 'Merchant Reward ID saved automatically',
          type: 'success',
        });
        return;
      }

      // Additional validation for NaN values on numeric fields
      const numericValue =
        field === 'rewardRate' ? parseFloat(value) / 100 : parseInt(value, 10);
      if (isNaN(numericValue)) {
        toastShow({
          message: 'Please enter a valid number',
          type: 'error',
        });
        return;
      }

      // Custom validation rules for specific fields
      const validationErrors: string[] = [];

      if (field === 'minimumReward' && numericValue < 10) {
        validationErrors.push('Minimum reward must be at least 10 points');
      }

      if (field === 'maximumReward' && numericValue > 50000) {
        validationErrors.push('Maximum reward cannot exceed 50,000 points');
      }

      if (field === 'defaultReward' && numericValue < 10) {
        validationErrors.push('Standalone reward must be at least 10 points');
      }

      // Check min/max relationship when either is updated
      if (
        field === 'minimumReward' &&
        numericValue > rewardConfig.maximumReward
      ) {
        validationErrors.push(
          'Minimum reward cannot be higher than maximum reward',
        );
      }

      if (
        field === 'maximumReward' &&
        numericValue < rewardConfig.minimumReward
      ) {
        validationErrors.push(
          'Maximum reward cannot be lower than minimum reward',
        );
      }

      // Show validation errors if any
      if (validationErrors.length > 0) {
        toastShow({
          message: validationErrors[0],
          type: 'error',
        });
        return;
      }

      // Validate configuration using existing validation
      const validation = validateRewardConfig(newConfig);

      if (!validation.isValid) {
        toastShow({
          message: validation.errors[0],
          type: 'error',
        });
        return;
      }

      dispatch(updateRewardConfig(newConfig));
      toastShow({
        message: 'Setting saved automatically',
        type: 'success',
      });
    },
    [rewardConfig, dispatch],
  );

  // Individual field blur handlers
  const handleRewardRateBlur = () => {
    if (rewardRate.trim() !== '') {
      autoSaveField('rewardRate', rewardRate);
    }
  };

  const handleMinimumRewardBlur = () => {
    if (minimumReward.trim() !== '') {
      autoSaveField('minimumReward', minimumReward);
    }
  };

  const handleMaximumRewardBlur = () => {
    if (maximumReward.trim() !== '') {
      autoSaveField('maximumReward', maximumReward);
    }
  };

  const handleDefaultRewardBlur = () => {
    if (defaultReward.trim() !== '') {
      autoSaveField('defaultReward', defaultReward);
    }
  };

  const handleMerchantRewardIdBlur = () => {
    autoSaveField('merchantRewardId', merchantRewardId.trim());
    // Reset validation when the ID changes
    setIsMerchantIdValid(false);
  };

  const testMerchantRewardId = useCallback(async () => {
    if (!merchantRewardId.trim()) {
      toastShow({
        message: 'Please enter a Merchant Reward ID first',
        type: 'error',
      });
      return;
    }

    setIsTestingMerchantId(true);

    try {
      const sanitizedId = sanitizeMerchantRewardId(merchantRewardId);
      
      if (!sanitizedId) {
        toastShow({
          message: 'Invalid Merchant Reward ID format. Only letters, numbers, hyphens, and underscores are allowed.',
          type: 'error',
        });
        setIsTestingMerchantId(false);
        return;
      }
      
      const response = await axios.get(
        `${BTC_PAY_SERVER}/pull-payments/${sanitizedId}`,
      );

      if (response.status === 200) {
        setIsMerchantIdValid(true);
        toastShow({
          message: 'Merchant Reward ID is valid ✅',
          type: 'success',
        });
      } else {
        setIsMerchantIdValid(false);
        toastShow({
          message: 'Invalid Merchant Reward ID',
          type: 'error',
        });
      }
    } catch (error: any) {
      setIsMerchantIdValid(false);
      toastShow({
        message: `Invalid Merchant Reward ID: ${
          error.response?.status === 404 ? 'Not found' : 'Connection error'
        }`,
        type: 'error',
      });
    } finally {
      setIsTestingMerchantId(false);
    }
  }, [merchantRewardId]);

  const handleIsEnabledChange = (value: boolean) => {
    // Check if trying to enable rewards without valid merchant ID
    if (value && !isMerchantIdValid) {
      toastShow({
        message:
          'Please test and validate your Merchant Reward ID before enabling rewards',
        type: 'error',
      });
      return;
    }

    setIsEnabled(value);
    autoSaveField('isEnabled', value);
  };

  const handleShowStandaloneRewardsChange = (value: boolean) => {
    setShowStandaloneRewards(value);
    autoSaveField('showStandaloneRewards', value);
  };

  const onGoBack = () => {
    navigation.goBack();
  };

  const navigateToRegisteredCards = () => {
    navigation.navigate('RegisteredRewardCards');
  };

  return (
    <Wrapper>
      <Header>
        <BackButton onPress={onGoBack}>
          <Icon
            name={'chevron-back-outline'}
            type="ionicon"
            color="#ffffff"
            size={24}
          />
        </BackButton>
        <HeaderTitle>Reward Settings</HeaderTitle>
        <HeaderSpacer />
      </Header>

      <ScrollWrapper>
        <ContentWrapper>
          {/* Rewards System Toggle */}
          <Container activeOpacity={0.7}>
            <Icon name={'diamond-outline'} type="ionicon" />
            <Column>
              <Key>Rewards System</Key>
              <Value>
                {isEnabled ? 'Enabled' : 'Disabled'}
                {!isMerchantIdValid && ' (Requires valid Merchant ID)'}
              </Value>
            </Column>
            <Switch
              value={isEnabled}
              onValueChange={handleIsEnabledChange}
              color="#007856"
            />
          </Container>

          {/* Standalone Rewards Toggle */}
          <Container activeOpacity={0.7}>
            <Icon name={'gift-outline'} type="ionicon" />
            <Column>
              <Key>Standalone Rewards Navigation</Key>
              <Value>{showStandaloneRewards ? 'Visible' : 'Hidden'}</Value>
            </Column>
            <Switch
              value={showStandaloneRewards}
              onValueChange={handleShowStandaloneRewardsChange}
              color="#007856"
            />
          </Container>

          {/* Registered Reward Cards Navigation */}
          <Container activeOpacity={0.7} onPress={navigateToRegisteredCards}>
            <Icon name={'card-outline'} type="ionicon" />
            <Column>
              <Key>Registered Reward Cards</Key>
              <Value>View and manage saved cards</Value>
            </Column>
            <Icon
              name={'chevron-forward-outline'}
              type="ionicon"
              color="#007856"
              size={20}
            />
          </Container>

          {/* Reward Rate Configuration */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Reward Rate (%)</ConfigLabel>
              <ConfigInput
                value={rewardRate}
                onChangeText={setRewardRate}
                onBlur={handleRewardRateBlur}
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
              <ConfigLabel>Minimum Reward (points)</ConfigLabel>
              <ConfigInput
                value={minimumReward}
                onChangeText={setMinimumReward}
                onBlur={handleMinimumRewardBlur}
                placeholder="1"
                keyboardType="number-pad"
                maxLength={4}
              />
            </ConfigRow>
            <ConfigHint>
              Minimum points awarded (must be at least 10)
            </ConfigHint>
          </ConfigContainer>

          {/* Maximum Reward Configuration */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Maximum Reward (points)</ConfigLabel>
              <ConfigInput
                value={maximumReward}
                onChangeText={setMaximumReward}
                onBlur={handleMaximumRewardBlur}
                placeholder="1000"
                keyboardType="number-pad"
                maxLength={6}
              />
            </ConfigRow>
            <ConfigHint>
              Maximum points awarded (cannot exceed 50,000)
            </ConfigHint>
          </ConfigContainer>

          {/* Default Standalone Reward Configuration */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Standalone Reward (points)</ConfigLabel>
              <ConfigInput
                value={defaultReward}
                onChangeText={setDefaultReward}
                onBlur={handleDefaultRewardBlur}
                placeholder="21"
                keyboardType="number-pad"
                maxLength={4}
              />
            </ConfigRow>
            <ConfigHint>
              Fixed reward for flashcard taps (must be at least 10)
            </ConfigHint>
          </ConfigContainer>

          {/* Merchant Reward ID Configuration */}
          <ConfigContainer>
            <MerchantIdLabelRow>
              <ConfigLabel>Merchant Reward ID</ConfigLabel>
              {isMerchantIdValid && <ValidIcon>✅</ValidIcon>}
              {!isMerchantIdValid && merchantRewardId.trim() && (
                <InvalidIcon>❌</InvalidIcon>
              )}
            </MerchantIdLabelRow>
            <MerchantIdInput
              value={merchantRewardId}
              onChangeText={setMerchantRewardId}
              onBlur={handleMerchantRewardIdBlur}
              placeholder="Enter Pull Payment ID"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={50}
            />
            <TestButtonContainer>
              <TestButton
                onPress={testMerchantRewardId}
                disabled={isTestingMerchantId || !merchantRewardId.trim()}
                valid={isMerchantIdValid}>
                <TestButtonText
                  disabled={isTestingMerchantId || !merchantRewardId.trim()}
                  valid={isMerchantIdValid}>
                  {isTestingMerchantId
                    ? 'Testing...'
                    : isMerchantIdValid
                    ? '✅ Tested & Valid'
                    : 'Test Merchant Reward ID'}
                </TestButtonText>
              </TestButton>
            </TestButtonContainer>
            <ConfigHint>Must be validated before enabling rewards</ConfigHint>
          </ConfigContainer>
        </ContentWrapper>
      </ScrollWrapper>
    </Wrapper>
  );
};

export default RewardsSettings;

const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
`;

const ScrollWrapper = styled.ScrollView`
  flex: 1;
`;

const ContentWrapper = styled.View`
  padding-horizontal: 16px;
  padding-top: 20px;
  padding-bottom: 40px;
  max-width: 500px;
  align-self: center;
  width: 100%;
`;

const Container = styled.TouchableOpacity`
  flex-direction: row;
  background-color: #f2f2f4;
  border-radius: 12px;
  overflow: hidden;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  margin-bottom: 12px;
  min-height: 60px;
`;

const Column = styled.View`
  flex: 1;
  margin-left: 8px;
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
  padding: 16px;
  margin-bottom: 12px;
`;

const ConfigRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  min-height: 50px;
`;

const ConfigLabel = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #000000;
  flex: 1;
  margin-right: 12px;
  flex-wrap: wrap;
`;

const ConfigInput = styled(TextInput)`
  min-width: ${() => Math.max(screenWidth * 0.25, 100)}px;
  max-width: ${() => Math.min(screenWidth * 0.35, 150)}px;
  height: 44px;
  background-color: #ffffff;
  border-radius: 8px;
  padding-horizontal: 12px;
  font-size: 16px;
  font-family: 'Outfit-Regular';
  text-align: center;
  border: 1px solid #e0e0e0;
  flex-shrink: 0;
`;

const MerchantIdInput = styled(TextInput)`
  width: 100%;
  height: 44px;
  background-color: #ffffff;
  border-radius: 8px;
  padding-horizontal: 12px;
  font-size: 8px;
  font-family: 'Outfit-Regular';
  text-align: left;
  border: 1px solid #e0e0e0;
  margin-top: 8px;
`;

const TestButtonContainer = styled.View`
  margin-top: 12px;
  align-items: flex-start;
`;

const TestButton = styled.TouchableOpacity<{
  disabled?: boolean;
  valid?: boolean;
}>`
  background-color: ${({disabled, valid}) =>
    disabled ? '#e0e0e0' : valid ? '#28a745' : '#007856'};
  border-radius: 8px;
  padding: 12px 16px;
  opacity: ${({disabled}) => (disabled ? 0.6 : 1)};
`;

const TestButtonText = styled.Text<{disabled?: boolean; valid?: boolean}>`
  color: ${({disabled, valid}) =>
    disabled ? '#888888' : valid ? '#ffffff' : '#ffffff'};
  font-size: 14px;
  font-family: 'Outfit-Medium';
  text-align: center;
`;

const MerchantIdLabelRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const ValidIcon = styled.Text`
  font-size: 16px;
  margin-left: 8px;
`;

const InvalidIcon = styled.Text`
  font-size: 16px;
  margin-left: 8px;
`;

const ConfigHint = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #888888;
  margin-top: 8px;
  line-height: 16px;
  flex-wrap: wrap;
`;

const Header = styled.View`
  padding: 20px 16px;
  padding-top: 40px;
  background-color: #007856;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const BackButton = styled.TouchableOpacity`
  padding: 8px;
  margin-left: -8px;
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  align-items: center;
`;

const HeaderTitle = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
  flex: 1;
  text-align: center;
  margin-horizontal: 16px;
`;

const HeaderSpacer = styled.View`
  width: 44px;
`;
