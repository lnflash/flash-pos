import React, {useState} from 'react';
import styled from 'styled-components/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';

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

import {Account, Security, Settings, Transactions} from '../components/profile';


export type PinMode = 'setup' | 'verify' | 'change' | 'remove';

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
  const [pinError, setPinError] = useState('');
  const [pinModalMode, setPinModalMode] = useState<PinMode>('verify');
  const [isViewRewardSettings, setIsViewRewardSettings] = useState(false);

  const onLogout = () => {
    dispatch(resetUserData());
    dispatch(resetAmount());
    navigation.replace('Auth');
  };

  const onViewRewardSettings = () => {
    setPinError('');
    setIsViewRewardSettings(true);
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
      if (isViewRewardSettings) {
        setIsViewRewardSettings(false);
        navigation.navigate('RewardsSettings');
      }
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
          if (isViewRewardSettings) {
            setIsViewRewardSettings(false);
            navigation.navigate('RewardsSettings');
          }
        } else {
          setPinError('Incorrect PIN. Please try again.');
        }
      }, 100);
    }
  };

  const handlePinCancel = () => {
    setPinError('');
    dispatch(clearResults());
    setPinModalVisible(false);
  };

  const handlePinActions = (mode: PinMode) => {
    setPinError('');
    dispatch(clearResults());
    setPinModalMode(mode);
    setPinModalVisible(true);
  };


  const onViewEventSettings = () => {
    navigation.navigate('EventSettings');
  };

  return (
    <ScrollWrapper showsVerticalScrollIndicator={false}>
      <Account />
      <Settings onViewRewardSettings={onViewRewardSettings} eventModeEnabled={eventModeEnabled} onViewEventSettings={onViewEventSettings} />

      <Security hasPin={hasPin} handlePinActions={handlePinActions} />
      <Transactions />
      <TextButton
        title="Logout"
        btnStyle={{marginTop: 20, marginBottom: 150}}
        onPress={onLogout}
      />
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
    </ScrollWrapper>
  );
};

export default Profile;

const ScrollWrapper = styled.ScrollView`
  flex-grow: 1;
  background-color: #ffffff;
  padding-top: 20px;
  padding-horizontal: 16px;
`;
