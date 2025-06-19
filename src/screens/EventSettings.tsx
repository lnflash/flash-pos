import React, {useState, useCallback} from 'react';
import {TextInput} from 'react-native';
import styled from 'styled-components/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';
import {Icon} from '@rneui/themed';
import axios from 'axios';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {
  selectRewardConfig,
  selectEventConfig,
  updateEventConfig,
  activateEvent,
  deactivateEvent,
  resetEventTracking,
} from '../store/slices/rewardSlice';

// utils
import {toastShow} from '../utils/toast';
import {sanitizeMerchantRewardId} from '../utils/validation';

// env
import {BTC_PAY_SERVER} from '@env';

type Props = StackNavigationProp<RootStackType, 'EventSettings'>;

const EventSettings = () => {
  const navigation = useNavigation<Props>();
  const dispatch = useAppDispatch();
  const rewardConfig = useAppSelector(selectRewardConfig);
  const eventConfig = useAppSelector(selectEventConfig);

  // Local state for event configuration with safe defaults
  // Note: eventRewardLimit is handled by eventBudgetSats in this implementation
  // const [eventRewardLimit, setEventRewardLimit] = useState(
  //   eventConfig.eventRewardLimit.toString(),
  // );
  const [eventRewardRate, setEventRewardRate] = useState(
    ((eventConfig.eventRewardRate ?? 0.05) * 100).toString(),
  );
  const [eventCustomerLimit, setEventCustomerLimit] = useState(
    (eventConfig.eventCustomerLimit ?? 100).toString(),
  );
  const [eventMerchantRewardId, setEventMerchantRewardId] = useState(
    eventConfig.eventMerchantRewardId || '',
  );
  const [eventCustomerRewardLimit, setEventCustomerRewardLimit] = useState(
    (eventConfig.eventCustomerRewardLimit ?? 1).toString(),
  );
  const [eventMinPurchaseAmount, setEventMinPurchaseAmount] = useState(
    (eventConfig.eventMinPurchaseAmount ?? 500).toString(),
  );
  const [eventBudgetSats, setEventBudgetSats] = useState(
    (eventConfig.eventBudgetSats ?? 100000).toString(),
  );
  const [eventDisplayName, setEventDisplayName] = useState(
    eventConfig.eventDisplayName || 'Special Event',
  );
  const [eventDisplayMessage, setEventDisplayMessage] = useState(
    eventConfig.eventDisplayMessage || 'Earn extra rewards!',
  );

  const [isEventMerchantIdValid, setIsEventMerchantIdValid] = useState(false);
  const [isTestingEventMerchantId, setIsTestingEventMerchantId] =
    useState(false);

  // Autosave function for individual fields
  const autoSaveField = useCallback(
    (field: string, value: any) => {
      const newConfig: any = {};

      switch (field) {
        case 'eventRewardLimit':
          newConfig.eventRewardLimit = parseInt(value, 10);
          if (
            isNaN(newConfig.eventRewardLimit) ||
            newConfig.eventRewardLimit < 1
          ) {
            toastShow({
              message: 'Event reward limit must be at least 1 point',
              type: 'error',
            });
            return;
          }
          if (newConfig.eventRewardLimit > 1000000) {
            toastShow({
              message: 'Event reward limit cannot exceed 1,000,000 points',
              type: 'error',
            });
            return;
          }
          break;

        case 'eventRewardRate':
          newConfig.eventRewardRate = parseFloat(value) / 100;
          if (
            isNaN(newConfig.eventRewardRate) ||
            newConfig.eventRewardRate < 0 ||
            newConfig.eventRewardRate > 1
          ) {
            toastShow({
              message: 'Event reward rate must be between 0% and 100%',
              type: 'error',
            });
            return;
          }
          break;

        case 'eventCustomerLimit':
          newConfig.eventCustomerLimit = parseInt(value, 10);
          if (
            isNaN(newConfig.eventCustomerLimit) ||
            newConfig.eventCustomerLimit < 1
          ) {
            toastShow({
              message: 'Event customer limit must be at least 1',
              type: 'error',
            });
            return;
          }
          if (newConfig.eventCustomerLimit > 10000) {
            toastShow({
              message: 'Event customer limit cannot exceed 10,000',
              type: 'error',
            });
            return;
          }
          break;

        case 'eventCustomerRewardLimit':
          newConfig.eventCustomerRewardLimit = parseInt(value, 10);
          if (
            isNaN(newConfig.eventCustomerRewardLimit) ||
            newConfig.eventCustomerRewardLimit < 1
          ) {
            toastShow({
              message: 'Customer reward limit must be at least 1',
              type: 'error',
            });
            return;
          }
          break;

        case 'eventMinPurchaseAmount':
          newConfig.eventMinPurchaseAmount = parseInt(value, 10);
          if (
            isNaN(newConfig.eventMinPurchaseAmount) ||
            newConfig.eventMinPurchaseAmount < 0
          ) {
            toastShow({
              message: 'Minimum purchase amount cannot be negative',
              type: 'error',
            });
            return;
          }
          break;

        case 'eventBudgetSats':
          newConfig.eventBudgetSats = parseInt(value, 10);
          if (
            isNaN(newConfig.eventBudgetSats) ||
            newConfig.eventBudgetSats < 1
          ) {
            toastShow({
              message: 'Event budget must be at least 1 point',
              type: 'error',
            });
            return;
          }
          break;

        case 'eventMerchantRewardId':
        case 'eventDisplayName':
        case 'eventDisplayMessage':
          newConfig[field] = value;
          break;

        default:
          return;
      }

      dispatch(updateEventConfig(newConfig));
      toastShow({
        message: 'Setting saved automatically',
        type: 'success',
      });
    },
    [dispatch],
  );

  const testEventMerchantRewardId = useCallback(async () => {
    if (!eventMerchantRewardId.trim()) {
      toastShow({
        message: 'Please enter an Event Merchant Reward ID first',
        type: 'error',
      });
      return;
    }

    setIsTestingEventMerchantId(true);

    try {
      const sanitizedId = sanitizeMerchantRewardId(eventMerchantRewardId);

      if (!sanitizedId) {
        toastShow({
          message: 'Invalid Event Merchant Reward ID format',
          type: 'error',
        });
        setIsTestingEventMerchantId(false);
        return;
      }

      const response = await axios.get(
        `${BTC_PAY_SERVER}/pull-payments/${sanitizedId}`,
      );

      if (response.status === 200) {
        setIsEventMerchantIdValid(true);
        toastShow({
          message: 'Event Merchant Reward ID is valid ✅',
          type: 'success',
        });
      }
    } catch (error: any) {
      setIsEventMerchantIdValid(false);
      toastShow({
        message: `Invalid Event Merchant Reward ID: ${
          error.response?.status === 404 ? 'Not found' : 'Connection error'
        }`,
        type: 'error',
      });
    } finally {
      setIsTestingEventMerchantId(false);
    }
  }, [eventMerchantRewardId]);

  const handleActivateEvent = () => {
    dispatch(activateEvent());
    toastShow({
      message: 'Event activated successfully',
      type: 'success',
    });
  };

  const handleDeactivateEvent = () => {
    dispatch(deactivateEvent());
    toastShow({
      message: 'Event deactivated',
      type: 'info',
    });
  };

  const handleResetEvent = () => {
    dispatch(resetEventTracking());
    toastShow({
      message: 'Event tracking reset',
      type: 'success',
    });
  };

  const onGoBack = () => {
    navigation.goBack();
  };

  // Calculate progress percentages with safe defaults
  const rewardProgress =
    (eventConfig.eventBudgetSats ?? 0) > 0
      ? ((eventConfig.eventTotalRewardsGiven ?? 0) /
          (eventConfig.eventBudgetSats ?? 1)) *
        100
      : 0;
  const customerProgress =
    (eventConfig.eventCustomerLimit ?? 0) > 0
      ? ((eventConfig.eventCustomersRewarded ?? 0) /
          (eventConfig.eventCustomerLimit ?? 1)) *
        100
      : 0;

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
        <HeaderTitle>Event Settings</HeaderTitle>
        <HeaderSpacer />
      </Header>

      <ScrollWrapper showsVerticalScrollIndicator={false}>
        <ContentWrapper>
          {/* Event Status Display */}
          {eventConfig.eventModeEnabled && (
            <StatusContainer>
              <StatusHeader>
                <StatusTitle>Event Status</StatusTitle>
                {eventConfig.eventActive ? (
                  <ActiveBadge>
                    <ActiveBadgeText>ACTIVE</ActiveBadgeText>
                  </ActiveBadge>
                ) : (
                  <InactiveBadge>
                    <InactiveBadgeText>INACTIVE</InactiveBadgeText>
                  </InactiveBadge>
                )}
              </StatusHeader>

              {eventConfig.eventActive && (
                <>
                  <ProgressRow>
                    <ProgressLabel>Rewards Given:</ProgressLabel>
                    <ProgressValue>
                      {(
                        eventConfig.eventTotalRewardsGiven ?? 0
                      ).toLocaleString()}{' '}
                      /{' '}
                      {(eventConfig.eventBudgetSats ?? 100000).toLocaleString()}{' '}
                      points
                    </ProgressValue>
                  </ProgressRow>
                  <ProgressBar>
                    <ProgressFill
                      width={Math.min(rewardProgress, 100)}
                      warning={rewardProgress >= 80}
                    />
                  </ProgressBar>

                  <ProgressRow>
                    <ProgressLabel>Customers Rewarded:</ProgressLabel>
                    <ProgressValue>
                      {eventConfig.eventCustomersRewarded ?? 0} /{' '}
                      {eventConfig.eventCustomerLimit ?? 100}
                    </ProgressValue>
                  </ProgressRow>
                  <ProgressBar>
                    <ProgressFill
                      width={Math.min(customerProgress, 100)}
                      warning={customerProgress >= 80}
                    />
                  </ProgressBar>
                </>
              )}

              <ActionRow>
                {!eventConfig.eventActive ? (
                  <ActionButton onPress={handleActivateEvent}>
                    <ActionButtonText>Activate Event</ActionButtonText>
                  </ActionButton>
                ) : (
                  <DeactivateButton onPress={handleDeactivateEvent}>
                    <DeactivateButtonText>
                      Deactivate Event
                    </DeactivateButtonText>
                  </DeactivateButton>
                )}
                {((eventConfig.eventTotalRewardsGiven ?? 0) > 0 ||
                  (eventConfig.eventCustomersRewarded ?? 0) > 0) && (
                  <ResetButton onPress={handleResetEvent}>
                    <ResetButtonText>Reset Tracking</ResetButtonText>
                  </ResetButton>
                )}
              </ActionRow>
            </StatusContainer>
          )}

          <SectionTitle>Basic Settings</SectionTitle>

          {/* Event Display Name */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Event Name</ConfigLabel>
              <ConfigInput
                value={eventDisplayName}
                onChangeText={setEventDisplayName}
                onBlur={() =>
                  autoSaveField('eventDisplayName', eventDisplayName)
                }
                placeholder="Special Event"
                maxLength={50}
              />
            </ConfigRow>
            <ConfigHint>Customer-facing event name</ConfigHint>
          </ConfigContainer>

          {/* Event Display Message */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Event Message</ConfigLabel>
              <ConfigInput
                value={eventDisplayMessage}
                onChangeText={setEventDisplayMessage}
                onBlur={() =>
                  autoSaveField('eventDisplayMessage', eventDisplayMessage)
                }
                placeholder="Earn extra rewards!"
                maxLength={100}
              />
            </ConfigRow>
            <ConfigHint>Message shown to customers</ConfigHint>
          </ConfigContainer>

          {/* Event Reward Rate */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Event Reward Rate (%)</ConfigLabel>
              <ConfigInput
                value={eventRewardRate}
                onChangeText={setEventRewardRate}
                onBlur={() => autoSaveField('eventRewardRate', eventRewardRate)}
                placeholder="5.0"
                keyboardType="decimal-pad"
                maxLength={5}
              />
            </ConfigRow>
            <ConfigHint>
              Overrides normal{' '}
              {((rewardConfig.rewardRate ?? 0.02) * 100).toFixed(1)}% rate
              (0-100%)
              {'\n'}Default: 5%
            </ConfigHint>
          </ConfigContainer>

          <SectionTitle>Customer Limits</SectionTitle>

          {/* Event Customer Limit */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Total Customer Limit</ConfigLabel>
              <ConfigInput
                value={eventCustomerLimit}
                onChangeText={setEventCustomerLimit}
                onBlur={() =>
                  autoSaveField('eventCustomerLimit', eventCustomerLimit)
                }
                placeholder="100"
                keyboardType="number-pad"
                maxLength={5}
              />
            </ConfigRow>
            <ConfigHint>
              Max customers before auto-deactivation (1-10,000)
              {'\n'}Default: 100 customers
            </ConfigHint>
          </ConfigContainer>

          {/* Customer Reward Limit */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Per-Customer Reward Limit</ConfigLabel>
              <ConfigInput
                value={eventCustomerRewardLimit}
                onChangeText={setEventCustomerRewardLimit}
                onBlur={() =>
                  autoSaveField(
                    'eventCustomerRewardLimit',
                    eventCustomerRewardLimit,
                  )
                }
                placeholder="1"
                keyboardType="number-pad"
                maxLength={3}
              />
            </ConfigRow>
            <ConfigHint>
              Max rewards per individual customer
              {'\n'}Default: 1 reward per customer
            </ConfigHint>
          </ConfigContainer>

          <SectionTitle>Budget Controls</SectionTitle>

          {/* Event Budget */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Event Budget (points)</ConfigLabel>
              <ConfigInput
                value={eventBudgetSats}
                onChangeText={setEventBudgetSats}
                onBlur={() => autoSaveField('eventBudgetSats', eventBudgetSats)}
                placeholder="100000"
                keyboardType="number-pad"
                maxLength={7}
              />
            </ConfigRow>
            <ConfigHint>
              Total budget before auto-deactivation
              {'\n'}Default: 100,000 points
              {'\n'} Warning at{' '}
              {((eventConfig.eventBudgetWarningPercent ?? 0.8) * 100).toFixed(
                0,
              )}
              %
            </ConfigHint>
          </ConfigContainer>

          <SectionTitle>Transaction Filters</SectionTitle>

          {/* Minimum Purchase Amount */}
          <ConfigContainer>
            <ConfigRow>
              <ConfigLabel>Minimum Purchase (points)</ConfigLabel>
              <ConfigInput
                value={eventMinPurchaseAmount}
                onChangeText={setEventMinPurchaseAmount}
                onBlur={() =>
                  autoSaveField(
                    'eventMinPurchaseAmount',
                    eventMinPurchaseAmount,
                  )
                }
                placeholder="500"
                keyboardType="number-pad"
                maxLength={7}
              />
            </ConfigRow>
            <ConfigHint>
              Minimum purchase to qualify for rewards
              {'\n'}Default: 500 points (0 = no minimum)
            </ConfigHint>
          </ConfigContainer>

          <SectionTitle>Advanced Settings</SectionTitle>

          {/* Event Merchant Reward ID */}
          <ConfigContainer>
            <MerchantIdLabelRow>
              <ConfigLabel>Event Merchant Reward ID</ConfigLabel>
              {isEventMerchantIdValid && <ValidIcon>✅</ValidIcon>}
            </MerchantIdLabelRow>
            <MerchantIdInput
              value={eventMerchantRewardId}
              onChangeText={setEventMerchantRewardId}
              onBlur={() =>
                autoSaveField('eventMerchantRewardId', eventMerchantRewardId)
              }
              placeholder="Enter Event Pull Payment ID"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={50}
            />
            <TestButtonContainer>
              <TestButton
                onPress={testEventMerchantRewardId}
                disabled={
                  isTestingEventMerchantId || !eventMerchantRewardId.trim()
                }
                valid={isEventMerchantIdValid}>
                <TestButtonText
                  disabled={
                    isTestingEventMerchantId || !eventMerchantRewardId.trim()
                  }
                  valid={isEventMerchantIdValid}>
                  {isTestingEventMerchantId
                    ? 'Testing...'
                    : isEventMerchantIdValid
                    ? '✅ Tested & Valid'
                    : 'Test Event Reward ID'}
                </TestButtonText>
              </TestButton>
            </TestButtonContainer>
            <ConfigHint>
              Optional: Override default Merchant Reward ID for this event
              {eventMerchantRewardId || !rewardConfig.merchantRewardId
                ? ''
                : `\nUsing default: ${rewardConfig.merchantRewardId}`}
            </ConfigHint>
          </ConfigContainer>
        </ContentWrapper>
      </ScrollWrapper>
    </Wrapper>
  );
};

export default EventSettings;

// Styled components
const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
`;

const Header = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: #007856;
  padding-horizontal: 16px;
  padding-top: 48px;
  padding-bottom: 16px;
`;

const BackButton = styled.TouchableOpacity`
  padding: 8px;
`;

const HeaderTitle = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
`;

const HeaderSpacer = styled.View`
  width: 40px;
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

const StatusContainer = styled.View`
  background-color: #f8f9fa;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
  border-width: 1px;
  border-color: #e0e0e0;
`;

const StatusHeader = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
`;

const StatusTitle = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  color: #000000;
`;

const ActiveBadge = styled.View`
  background-color: #28a745;
  padding-horizontal: 12px;
  padding-vertical: 4px;
  border-radius: 16px;
`;

const ActiveBadgeText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
`;

const InactiveBadge = styled.View`
  background-color: #6c757d;
  padding-horizontal: 12px;
  padding-vertical: 4px;
  border-radius: 16px;
`;

const InactiveBadgeText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
`;

const ProgressRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
`;

const ProgressLabel = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #5a5a5a;
`;

const ProgressValue = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Bold';
  color: #000000;
`;

const ProgressBar = styled.View`
  height: 8px;
  background-color: #e0e0e0;
  border-radius: 4px;
  margin-bottom: 16px;
  overflow: hidden;
`;

const ProgressFill = styled.View<{width: number; warning?: boolean}>`
  height: 100%;
  width: ${props => props.width}%;
  background-color: ${props => (props.warning ? '#ff9800' : '#28a745')};
  border-radius: 4px;
`;

const ActionRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  margin-top: 8px;
  gap: 8px;
`;

const ActionButton = styled.TouchableOpacity`
  flex: 1;
  background-color: #007856;
  padding: 12px;
  border-radius: 8px;
  align-items: center;
`;

const ActionButtonText = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
`;

const DeactivateButton = styled(ActionButton)`
  background-color: #dc3545;
`;

const DeactivateButtonText = styled(ActionButtonText)``;

const ResetButton = styled(ActionButton)`
  background-color: #6c757d;
`;

const ResetButtonText = styled(ActionButtonText)``;

const SectionTitle = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Bold';
  color: #000000;
  margin-top: 24px;
  margin-bottom: 12px;
`;

const ConfigContainer = styled.View`
  margin-bottom: 20px;
`;

const ConfigRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
`;

const ConfigLabel = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #000000;
  flex: 1;
`;

const ConfigInput = styled(TextInput)`
  flex: 0.4;
  background-color: #f2f2f4;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 16px;
  font-family: 'Outfit-Regular';
  color: #000000;
  text-align: right;
`;

const ConfigHint = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #6c757d;
  line-height: 16px;
`;

const MerchantIdLabelRow = styled.View`
  flex-direction: row;
  align-items: center;
  margin-bottom: 8px;
`;

const ValidIcon = styled.Text`
  font-size: 16px;
  margin-left: 8px;
`;

const MerchantIdInput = styled(TextInput)`
  background-color: #f2f2f4;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #000000;
  margin-bottom: 8px;
`;

const TestButtonContainer = styled.View`
  margin-bottom: 8px;
`;

const TestButton = styled.TouchableOpacity<{
  disabled?: boolean;
  valid?: boolean;
}>`
  background-color: ${props =>
    props.valid ? '#28a745' : props.disabled ? '#cccccc' : '#007856'};
  padding: 12px;
  border-radius: 8px;
  align-items: center;
`;

const TestButtonText = styled.Text<{disabled?: boolean; valid?: boolean}>`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: ${props => (props.disabled ? '#666666' : '#ffffff')};
`;
