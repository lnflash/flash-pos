import React, {useState, useEffect} from 'react';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';
import {Icon} from '@rneui/themed';

// components
import {TextButton, PinModal} from '../components';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {resetUserData} from '../store/slices/userSlice';
import {resetAmount} from '../store/slices/amountSlice';
import {
  selectHasPin,
  selectIsAuthenticated,
  setPin,
  authenticatePin,
  checkSession,
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
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinModalMode, setPinModalMode] = useState<'setup' | 'verify'>(
    'verify',
  );

  // Check session on mount
  useEffect(() => {
    dispatch(checkSession());
  }, [dispatch]);

  const onLogout = () => {
    dispatch(resetUserData());
    dispatch(resetAmount());
    navigation.replace('Auth');
  };

  const onViewTransactionHistory = () => {
    navigation.navigate('TransactionHistory');
  };

  const onViewRewardSettings = () => {
    if (!hasPin) {
      // First time setup - create PIN
      setPinModalMode('setup');
      setPinModalVisible(true);
    } else if (!isAuthenticated) {
      // PIN exists but not authenticated - verify PIN
      setPinModalMode('verify');
      setPinModalVisible(true);
    } else {
      // Already authenticated - go to settings
      navigation.navigate('RewardsSettings');
    }
  };

  const handlePinSuccess = (pin: string) => {
    if (pinModalMode === 'setup') {
      dispatch(setPin(pin));
    } else {
      dispatch(authenticatePin(pin));
    }
    setPinModalVisible(false);
    navigation.navigate('RewardsSettings');
  };

  const handlePinCancel = () => {
    setPinModalVisible(false);
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

        {/* PayCode Navigation */}
        <Container activeOpacity={0.5} onPress={onViewPaycode}>
          <Icon name={'qr-code-outline'} type="ionicon" />
          <Column>
            <Key>PayCode</Key>
            <Value>Merchant QR code</Value>
          </Column>
          <Icon name={'chevron-forward-outline'} type="ionicon" />
        </Container>

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
        title={pinModalMode === 'setup' ? 'Set PIN for Settings' : 'Enter PIN'}
        subtitle={
          pinModalMode === 'setup'
            ? 'Create a 4-digit PIN to protect reward settings'
            : 'Enter your PIN to access reward settings'
        }
        onSuccess={handlePinSuccess}
        onCancel={handlePinCancel}
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
