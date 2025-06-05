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
} from '../store/slices/pinSlice';

// env
import {FLASH_LN_ADDRESS} from '@env';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Profile = () => {
  const navigation = useNavigation<Props>();

  const dispatch = useAppDispatch();
  const {username} = useAppSelector(state => state.user);
  const {transactions} = useAppSelector(state => state.transactionHistory);

  // PIN management
  const hasPin = useAppSelector(selectHasPin);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinModalMode, setPinModalMode] = useState<
    'setup' | 'verify' | 'change'
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
    setPinError(''); // Clear any previous errors
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

  const handlePinSuccess = (pin: string, oldPin?: string) => {
    if (pinModalMode === 'setup') {
      dispatch(setPin(pin));
      setPinModalVisible(false);
      navigation.navigate('RewardsSettings');
    } else if (pinModalMode === 'change') {
      if (oldPin) {
        dispatch(changePin({oldPin, newPin: pin}));
        setPinModalVisible(false);
        // Could add success toast here
      }
    } else {
      // Clear any previous authentication state first
      dispatch(clearAuthentication());

      // Then verify the PIN
      dispatch(authenticatePin(pin));

      // Check if authentication was successful
      setTimeout(() => {
        const currentState = store.getState();
        if (currentState.pin.isAuthenticated) {
          setPinModalVisible(false);
          navigation.navigate('RewardsSettings');
        } else {
          setPinError('Incorrect PIN. Please try again.');
        }
      }, 100);
    }
  };

  const handlePinCancel = () => {
    setPinModalVisible(false);
    setPinError(''); // Clear error when canceling
  };

  const onChangePinPress = () => {
    setPinError('');
    setPinModalMode('change');
    setPinModalVisible(true);
  };

  const onRemovePinPress = () => {
    // Show confirmation before removing PIN
    const handleRemovePin = () => {
      dispatch(removePin());
      // Could add success toast here
    };

    // For now, just remove it directly - could add Alert confirmation
    handleRemovePin();
  };

  const onViewPaycode = () => {
    navigation.navigate('Paycode');
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

        {/* PayCode Navigation */}
        <Container activeOpacity={0.5} onPress={onViewPaycode}>
          <Icon name={'qr-code-outline'} type="ionicon" />
          <Column>
            <Key>PayCode</Key>
            <Value>Merchant QR code</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
        </Container>

        <Label style={{marginTop: 20}}>Settings</Label>

        {/* Reward Settings Navigation */}
        <Container activeOpacity={0.5} onPress={onViewRewardSettings}>
          <Icon name={'diamond-outline'} type="ionicon" />
          <Column>
            <Key>Reward Settings</Key>
            <Value>Configure reward rules</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
        </Container>

        <Label style={{marginTop: 20}}>Security</Label>

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

      <PinModal
        visible={pinModalVisible}
        mode={pinModalMode}
        title={
          pinModalMode === 'setup'
            ? 'Set PIN for Settings'
            : pinModalMode === 'change'
            ? 'Change PIN'
            : 'Enter PIN'
        }
        subtitle={
          pinModalMode === 'setup'
            ? 'Create a 4-digit PIN to protect reward settings'
            : pinModalMode === 'change'
            ? 'Enter your current PIN, then set a new one'
            : 'Enter your PIN to access reward settings'
        }
        onSuccess={handlePinSuccess}
        onCancel={handlePinCancel}
        externalError={pinError}
        onClearError={() => setPinError('')}
      />
    </Wrapper>
  );
};

export default Profile;

const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
  padding-horizontal: 10px;
  padding-top: 20px;
  padding-bottom: 120px;
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
