import React, {useState} from 'react';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';
import {Icon} from '@rneui/themed';

// components
import {TextButton, PinModal} from '../components';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {store} from '../store';
import {resetUserData} from '../store/slices/userSlice';
import {resetAmount} from '../store/slices/amountSlice';
import {
  selectHasPin,
  setPin,
  authenticatePin,
  removePin,
  changePin,
  clearAuthentication,
  clearResults,
  verifyPinOnly,
} from '../store/slices/pinSlice';
import {selectEventModeEnabled} from '../store/slices/rewardSlice';

// env
import {FLASH_LN_ADDRESS} from '@env';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Profile = () => {
  const navigation = useNavigation<Props>();

  const dispatch = useAppDispatch();
  const {username} = useAppSelector(state => state.user);
  const {transactions} = useAppSelector(state => state.transactionHistory);
  const eventModeEnabled = useAppSelector(selectEventModeEnabled);

  // PIN management
  const hasPin = useAppSelector(selectHasPin);

  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinModalMode, setPinModalMode] = useState<
    'setup' | 'verify' | 'change' | 'remove'
  >('verify');
  const [pinError, setPinError] = useState('');

  const onLogout = () => {
    dispatch(resetUserData());
    dispatch(resetAmount());
    navigation.replace('Auth');
  };

  const onViewTransactionHistory = () => {
    navigation.navigate('TransactionHistory');
  };

  const onViewRewardSettings = () => {
    setPinError('');
    dispatch(clearResults());

    if (!hasPin) {
      // First time setup - create PIN
      setPinModalMode('setup');
      setPinModalVisible(true);
    } else {
      // PIN exists - always require verification for security
      setPinModalMode('verify');
      setPinModalVisible(true);
    }
  };

  const handleVerifyOldPin = async (oldPin: string): Promise<boolean> => {
    return new Promise(resolve => {
      dispatch(verifyPinOnly(oldPin));

      // Wait for the verification result
      setTimeout(() => {
        const currentState = store.getState();
        const result = currentState.pin.lastVerificationResult;
        resolve(result === 'success');
      }, 100);
    });
  };

  const handlePinSuccess = (pin: string, oldPin?: string) => {
    dispatch(clearResults());

    if (pinModalMode === 'setup') {
      dispatch(setPin(pin));
      setPinModalVisible(false);
      navigation.navigate('RewardsSettings');
    } else if (pinModalMode === 'change') {
      if (oldPin) {
        dispatch(changePin({oldPin, newPin: pin}));

        // Check if the change was successful
        setTimeout(() => {
          const currentState = store.getState();
          if (currentState.pin.lastOperationResult === 'success') {
            setPinModalVisible(false);
            setPinError('');
            // Could add success toast here
          } else {
            setPinError('Failed to change PIN. Please try again.');
          }
        }, 100);
      }
    } else if (pinModalMode === 'remove') {
      // Remove mode - verify PIN first, then remove if correct
      dispatch(clearAuthentication());
      dispatch(authenticatePin(pin));

      // Check if authentication was successful
      setTimeout(() => {
        const currentState = store.getState();
        if (currentState.pin.isAuthenticated) {
          // PIN is correct, proceed with removal
          dispatch(removePin());
          setPinModalVisible(false);
          setPinError('');
          // Could add success toast here
        } else {
          setPinError('Incorrect PIN. Cannot remove PIN protection.');
        }
      }, 100);
    } else {
      // Verify mode - clear any previous authentication state first
      dispatch(clearAuthentication());

      // Then verify the PIN
      dispatch(authenticatePin(pin));

      // Check if authentication was successful
      setTimeout(() => {
        const currentState = store.getState();
        if (currentState.pin.isAuthenticated) {
          setPinModalVisible(false);
          setPinError('');
          navigation.navigate('RewardsSettings');
        } else {
          setPinError('Incorrect PIN. Please try again.');
        }
      }, 100);
    }
  };

  const handlePinCancel = () => {
    setPinModalVisible(false);
    setPinError('');
    dispatch(clearResults());
  };

  const onChangePinPress = () => {
    setPinError('');
    dispatch(clearResults());
    setPinModalMode('change');
    setPinModalVisible(true);
  };

  const onRemovePinPress = () => {
    // Show PIN verification modal before removing PIN
    setPinError('');
    dispatch(clearResults());
    setPinModalMode('remove');
    setPinModalVisible(true);
  };

  const onViewPaycode = () => {
    navigation.navigate('Paycode');
  };

  const onViewEventSettings = () => {
    navigation.navigate('EventSettings');
  };

  const lnAddress = `${username}@${FLASH_LN_ADDRESS}`;

  return (
    <Wrapper>
      <ScrollWrapper showsVerticalScrollIndicator={false}>
        <InnerWrapper>
          <FirstLabel>Account</FirstLabel>
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
          <Label>Settings</Label>
          {/* Reward Settings Navigation */}
          <Container activeOpacity={0.5} onPress={onViewRewardSettings}>
            <Icon name={'diamond-outline'} type="ionicon" />
            <Column>
              <Key>Reward Settings</Key>
              <Value>Configure reward rules</Value>
            </Column>
            <Icon name={'chevron-forward-outline'} type="ionicon" />
          </Container>
          {/* Event Settings Navigation - Only show when Event Mode is enabled */}
          {eventModeEnabled && (
            <Container activeOpacity={0.5} onPress={onViewEventSettings}>
              <Icon name={'calendar-outline'} type="ionicon" />
              <Column>
                <Key>Event Settings</Key>
                <Value>Configure event rewards</Value>
              </Column>
              <Icon name={'chevron-forward-outline'} type="ionicon" />
            </Container>
          )}
          <Label>Security</Label>
          {/* PIN Management */}
          {hasPin ? (
            <>
              <Container activeOpacity={0.5} onPress={onChangePinPress}>
                <Icon name={'key-outline'} type="ionicon" />
                <Column>
                  <Key>Change PIN</Key>
                  <Value>Modify your admin PIN</Value>
                </Column>
                <Icon name={'chevron-forward-outline'} type="ionicon" />
              </Container>

              <Container activeOpacity={0.5} onPress={onRemovePinPress}>
                <Icon name={'trash-outline'} type="ionicon" />
                <Column>
                  <Key>Remove PIN</Key>
                  <Value>Disable PIN protection</Value>
                </Column>
                <Icon name={'chevron-forward-outline'} type="ionicon" />
              </Container>
            </>
          ) : (
            <Container activeOpacity={0.5} onPress={onViewRewardSettings}>
              <Icon name={'lock-closed-outline'} type="ionicon" />
              <Column>
                <Key>Set Admin PIN</Key>
                <Value>Protect your settings</Value>
              </Column>
              <Icon name={'chevron-forward-outline'} type="ionicon" />
            </Container>
          )}
          <Label>Transactions</Label>
          <Container activeOpacity={0.5} onPress={onViewTransactionHistory}>
            <Icon name={'receipt-outline'} type="ionicon" />
            <Column>
              <Key>Transaction History</Key>
              <Value>{transactions.length} transactions</Value>
            </Column>
            <Icon name={'chevron-forward-outline'} type="ionicon" />
          </Container>
          {/* Logout Button */}
          <LogoutButtonWrapper>
            <TextButton title="Logout" onPress={onLogout} />
          </LogoutButtonWrapper>
        </InnerWrapper>
      </ScrollWrapper>

      <PinModal
        visible={pinModalVisible}
        mode={pinModalMode}
        title={
          pinModalMode === 'setup'
            ? 'Set PIN for Settings'
            : pinModalMode === 'change'
            ? 'Change PIN'
            : pinModalMode === 'remove'
            ? 'Remove PIN Protection'
            : 'Enter PIN'
        }
        subtitle={
          pinModalMode === 'setup'
            ? 'Create a 4-digit PIN to protect reward settings'
            : pinModalMode === 'change'
            ? 'Enter your current PIN, then set a new one'
            : pinModalMode === 'remove'
            ? 'Enter your current PIN to remove PIN protection'
            : 'Enter your PIN to access reward settings'
        }
        onSuccess={handlePinSuccess}
        onCancel={handlePinCancel}
        externalError={pinError}
        onClearError={() => setPinError('')}
        onVerifyOldPin={
          pinModalMode === 'change' ? handleVerifyOldPin : undefined
        }
      />
    </Wrapper>
  );
};

export default Profile;

const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
`;

const ScrollWrapper = styled.ScrollView`
  flex: 1;
  padding-horizontal: 16px;
  padding-top: 20px;
`;

const InnerWrapper = styled.View`
  max-width: 500px;
  align-self: center;
  width: 100%;
  padding-bottom: 120px;
`;

const Label = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Bold';
  color: #000000;
  margin-bottom: 8px;
  margin-top: 20px;
`;

const FirstLabel = styled(Label)`
  margin-top: 0px;
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
  margin-right: 12px;
`;

const Key = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #000000;
  flex-wrap: wrap;
  margin-bottom: 2px;
`;

const Value = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #5a5a5a;
  flex-wrap: wrap;
  line-height: 18px;
`;

const LogoutButtonWrapper = styled.View`
  margin-top: 32px;
  margin-bottom: 40px;
`;
